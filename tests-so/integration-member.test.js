'use strict';
// Member experience: lifecycle states, content gates, journal, library, calls,
// introductions, and admin boundaries.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./support/harness');

let h, A, B;
test.before(async () => {
  h = await boot();
  A = await h.enroll('member-a@example.com');
  B = await h.enroll('member-b@example.com');
});
test.after(async () => { await h.close(); });

const admin = (m, p, body) => h.api(m, p, { token: h.adminToken, body });
async function publishDay(n, extra = {}) {
  const r = await admin('PUT', `admin/days/${n}`, { is_sample: false, status: 'published', preview_published: true, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.day;
}

test('before introductions open: countdown state, no intro form, no cohort feed', async () => {
  // Seed defaults: today (Nov 2026) is before Dec 1.
  await h.setCohort({ intro_opens_at: new Date(Date.now() + 5 * 86400000), start_date: '2027-01-04' });
  const home = await h.api('GET', 'home', { token: A.token });
  assert.equal(home.status, 200);
  assert.equal(home.body.phase, 'pre_intros');
  assert.equal(home.body.intros_open, false);
  assert.equal(home.body.cohort.starts_at, '2027-01-04T08:00:00.000Z');
  assert.equal(home.body.today, null);
  assert.equal((await h.api('GET', 'introductions', { token: A.token })).status, 403);
  assert.equal((await h.api('PUT', 'introductions/mine', { token: A.token, body: { preferred_name: 'x' } })).status, 403);
});

test('at introduction opening: members introduce themselves and only see their own cohort', async () => {
  await h.setCohort({ intro_opens_at: new Date(Date.now() - 1000) });
  const home = await h.api('GET', 'home', { token: A.token });
  assert.equal(home.body.phase, 'intros_open');
  const bad = await h.api('PUT', 'introductions/mine', { token: A.token, body: { preferred_name: 'Ada' } });
  assert.equal(bad.status, 400);
  const put = await h.api('PUT', 'introductions/mine', { token: A.token, body: {
    preferred_name: 'Ada', business_name: 'Ada Ops <script>', business_description: 'We run events.', operating_challenge: 'Everything routes through me.',
    website_url: 'javascript:alert(1)',
  } });
  assert.equal(put.status, 400, 'non-https website rejected');
  const ok = await h.api('PUT', 'introductions/mine', { token: A.token, body: {
    preferred_name: 'Ada', business_name: 'Ada Ops', business_description: 'We run events.', operating_challenge: 'Everything routes through me.',
    website_url: 'https://ada.example.com',
  } });
  assert.equal(ok.status, 200);

  // A member of a different cohort with an introduction must not appear.
  const other = await h.mocks.signIn('other-cohort@example.com');
  await h.sql`insert into so_profiles (user_id, email) values (${other.user.id}, 'other-cohort@example.com')`;
  const c2 = (await h.sql`insert into so_cohorts (slug, name, start_date, intro_opens_at, regular_price_cents)
                          values ('other', 'Other', '2027-06-01', now(), 100000) returning id`)[0];
  await h.sql`insert into so_enrollments (user_id, cohort_id) values (${other.user.id}, ${c2.id})`;
  await h.sql`insert into so_introductions (user_id, cohort_id, preferred_name, business_name, business_description, operating_challenge)
              values (${other.user.id}, ${c2.id}, 'Zed', 'Elsewhere Co', 'x', 'y')`;

  const list = await h.api('GET', 'introductions', { token: B.token });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.introductions.map(i => i.preferred_name), ['Ada']);
  assert.doesNotMatch(list.text, /Elsewhere Co|member-a@example\.com/);
  // Admin moderation hides it from others but not from the author.
  const id = list.body.introductions[0].id;
  assert.equal((await admin('PUT', `admin/introductions/${id}`, { moderation_state: 'hidden' })).status, 200);
  assert.equal((await h.api('GET', 'introductions', { token: B.token })).body.introductions.length, 0);
  assert.equal((await h.api('GET', 'introductions', { token: A.token })).body.introductions.length, 1);
  await admin('PUT', `admin/introductions/${id}`, { moderation_state: 'visible' });
  // Non-members cannot read introductions.
  const stranger = await h.mocks.signIn('stranger@example.com');
  assert.equal((await h.api('GET', 'introductions', { token: stranger.token })).status, 403);
});

test('live cohort: Today is the current cohort day; unpublished days never leak drafts', async () => {
  await h.setLiveDay(3);
  const home = await h.api('GET', 'home', { token: A.token });
  assert.equal(home.body.phase, 'live');
  assert.equal(home.body.current_day, 3);
  assert.equal(home.body.today.state, 'preparing', 'unlocked but unpublished');
  assert.equal(home.body.today.reflection_prompt, undefined);
  assert.doesNotMatch(home.text, /What can people count on you for/);
});

test('publishing requires final content; locked days stay locked even when published', async () => {
  const sample = await admin('PUT', 'admin/days/1', { status: 'published' });
  assert.equal(sample.status, 400);
  assert.equal(sample.body.error, 'not_final');
  for (const n of [1, 2, 3]) await publishDay(n);
  await publishDay(5, { reflection_prompt: 'SECRET-DAY-5-QUESTION', content: 'SECRET-DAY-5-BODY' });

  const cal = await h.api('GET', 'calendar', { token: A.token });
  assert.equal(cal.status, 200);
  const d5 = cal.body.days.find(d => d.day_number === 5);
  assert.equal(d5.status, 'upcoming');
  assert.ok(d5.title, 'approved preview title shown');
  assert.equal(d5.reflection_prompt, undefined);
  assert.doesNotMatch(cal.text, /SECRET-DAY-5/);
  assert.doesNotMatch(cal.text, /storage_path|external_url/);
  const d4 = cal.body.days.find(d => d.day_number === 4);
  assert.equal(d4.title, null, 'unapproved preview hides the provisional title');

  const locked = await h.api('GET', 'day/5', { token: A.token });
  assert.equal(locked.status, 200);
  assert.equal(locked.body.day.state, 'locked');
  assert.doesNotMatch(locked.text, /SECRET-DAY-5/);
  const write = await h.api('PUT', 'journal/5', { token: A.token, body: { body: 'early', base_revision: null } });
  assert.equal(write.status, 403);
  assert.equal((await h.api('POST', 'progress/5', { token: A.token, body: { completed: true } })).status, 403);
});

test('Today and the historical day page share one record: content, journal and completion', async () => {
  const first = await h.api('PUT', 'journal/3', { token: A.token, body: { body: 'My reflection for day 3', base_revision: null } });
  assert.equal(first.status, 200);
  assert.equal(first.body.revision, 1);
  const done = await h.api('POST', 'progress/3', { token: A.token, body: { completed: true } });
  assert.ok(done.body.progress.completed_at);

  const today = (await h.api('GET', 'home', { token: A.token })).body.today;
  const direct = (await h.api('GET', 'day/3', { token: A.token })).body.day;
  assert.equal(today.day_number, 3);
  assert.deepEqual(today, direct);
  assert.equal(direct.journal.body, 'My reflection for day 3');

  const journal = await h.api('GET', 'journal', { token: A.token });
  assert.equal(journal.body.entries.length, 1);
  assert.equal(journal.body.entries[0].day_number, 3);
  assert.equal(journal.body.entries[0].question, direct.reflection_prompt);

  // Completion is reversible.
  const undo = await h.api('POST', 'progress/3', { token: A.token, body: { completed: false } });
  assert.equal(undo.body.progress.completed_at, null);
  const cal = await h.api('GET', 'calendar', { token: A.token });
  assert.equal(cal.body.days.find(d => d.day_number === 3).status, 'in_progress');
  assert.equal(cal.body.days.find(d => d.day_number === 1).status, 'available', 'missed days stay available');
});

test('journal conflicts: a stale tab cannot silently overwrite newer writing', async () => {
  const tab1 = await h.api('PUT', 'journal/2', { token: A.token, body: { body: 'v1', base_revision: null } });
  const tab1b = await h.api('PUT', 'journal/2', { token: A.token, body: { body: 'v2 from tab 1', base_revision: tab1.body.revision } });
  assert.equal(tab1b.body.revision, 2);
  const stale = await h.api('PUT', 'journal/2', { token: A.token, body: { body: 'stale tab 2', base_revision: 1 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.server.body, 'v2 from tab 1');
  // Choosing to keep the newer local text resubmits against the server revision.
  const keep = await h.api('PUT', 'journal/2', { token: A.token, body: { body: 'stale tab 2', base_revision: stale.body.server.revision } });
  assert.equal(keep.status, 200);
  // Two "first saves" racing: one wins, the other gets a conflict, nothing is lost.
  const [x, y] = await Promise.all([
    h.api('PUT', 'journal/1', { token: A.token, body: { body: 'race A', base_revision: null } }),
    h.api('PUT', 'journal/1', { token: A.token, body: { body: 'race B', base_revision: null } }),
  ]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
});

test('journal prompts keep the version the member answered', async () => {
  await admin('PUT', 'admin/days/3', { reflection_prompt: 'A revised question for day 3?' });
  const day = (await h.api('GET', 'day/3', { token: A.token })).body.day;
  assert.equal(day.reflection_prompt, 'A revised question for day 3?');
  assert.notEqual(day.journal.prompt_snapshot, day.reflection_prompt);
  assert.match(day.journal.prompt_snapshot, /count on you/);
});

test('members cannot read each other’s journals; admin views never include journal text', async () => {
  const bDay = (await h.api('GET', 'day/3', { token: B.token })).body.day;
  assert.equal(bDay.journal, null);
  assert.equal((await h.api('GET', 'journal', { token: B.token })).body.entries.length, 0);
  const exp = await h.api('GET', 'journal/export', { token: B.token });
  assert.doesNotMatch(exp.text, /My reflection for day 3/);
  const expA = await h.api('GET', 'journal/export', { token: A.token });
  assert.match(expA.text, /My reflection for day 3/);
  for (const p of ['admin/overview', 'admin/enrollments', 'admin/purchases', 'admin/audit', 'admin/introductions', 'admin/challenges']) {
    const r = await admin('GET', p);
    assert.equal(r.status, 200, p);
    assert.doesNotMatch(r.text, /My reflection for day 3|race A|race B|v2 from tab 1/, p);
  }
});

test('admin routes require the server-verified admin role', async () => {
  assert.equal((await h.api('GET', 'admin/overview')).status, 403);
  assert.equal((await h.api('GET', 'admin/overview', { token: A.token })).status, 403);
  await h.sql`update so_profiles set role = 'admin' where email = 'member-b@example.com'`;
  assert.equal((await h.api('GET', 'admin/overview', { token: B.token })).status, 200);
  await h.sql`update so_profiles set role = 'member' where email = 'member-b@example.com'`;
});

test('library: uploaded template used on two days appears once; gates apply to files', async () => {
  const create = await admin('POST', 'admin/resources', { kind: 'template', title: 'Decision Rights Template', purpose: 'Define who decides', pillar: 'standards' });
  assert.equal(create.status, 200);
  const id = create.body.resource.id;
  assert.equal((await admin('PUT', `admin/resources/${id}`, { status: 'published' })).status, 400, 'no file yet');
  const bad = await admin('POST', `admin/resources/${id}/upload-url`, { file_name: 'x.exe', mime_type: 'application/x-msdownload', size: 10 });
  assert.equal(bad.status, 400);
  const up = await admin('POST', `admin/resources/${id}/upload-url`, { file_name: 'Decision Rights.pdf', mime_type: 'application/pdf', size: 1234 });
  assert.equal(up.status, 200);
  assert.ok(up.body.storage_path.startsWith(`resources/${id}/`));
  await fetch(up.body.upload_url, { method: 'PUT', body: 'pdf-bytes' });
  const conf = await admin('POST', `admin/resources/${id}/file`, { storage_path: up.body.storage_path, file_name: 'Decision Rights.pdf', mime_type: 'application/pdf', size: 1234 });
  assert.equal(conf.status, 200);
  assert.equal(conf.body.resource.storage_path, undefined, 'storage path never leaves the server');
  assert.equal((await admin('PUT', `admin/resources/${id}`, { status: 'published' })).status, 200);

  // Linked to day 2 (unlocked) and day 5 (locked).
  await admin('PUT', 'admin/days/2', { links: [{ resource_id: id, role: 'template' }] });
  await admin('PUT', 'admin/days/5', { links: [{ resource_id: id, role: 'template' }] });
  const lib = await h.api('GET', 'library', { token: A.token });
  assert.equal(lib.body.templates.filter(t => t.id === id).length, 1);
  assert.deepEqual(lib.body.templates.find(t => t.id === id).related_days, [2]);
  assert.doesNotMatch(lib.text, /storage_path|resources\//);
  const access = await h.api('GET', `resource/${id}/access`, { token: A.token });
  assert.equal(access.status, 200);
  assert.match(access.body.url, /token=/);
  assert.equal(access.body.kind, 'download');

  // A template only linked to a locked day is not released.
  const locked = await admin('POST', 'admin/resources', { kind: 'template', title: 'Future KPI sheet', source_type: 'link', external_url: 'https://docs.example.com/kpi' });
  await admin('PUT', `admin/resources/${locked.body.resource.id}`, { status: 'published' });
  await admin('PUT', 'admin/days/6', { links: [{ resource_id: locked.body.resource.id, role: 'template' }] });
  const lid = locked.body.resource.id;
  assert.equal((await h.api('GET', `resource/${lid}/access`, { token: A.token })).status, 404);
  assert.doesNotMatch((await h.api('GET', 'library', { token: A.token })).text, /Future KPI sheet|docs\.example\.com/);
  // Non-members cannot fetch released files either.
  const stranger = await h.mocks.signIn('stranger2@example.com');
  assert.equal((await h.api('GET', `resource/${id}/access`, { token: stranger.token })).status, 403);
});

test('guided practice: transcript required to publish; playback position saved; counts as started', async () => {
  const p = await admin('POST', 'admin/resources', { kind: 'practice', title: 'Arrive breath', practice_type: 'breathwork', duration_seconds: 300 });
  const id = p.body.resource.id;
  const up = await admin('POST', `admin/resources/${id}/upload-url`, { file_name: 'arrive.mp3', mime_type: 'audio/mpeg', size: 5000 });
  await admin('POST', `admin/resources/${id}/file`, { storage_path: up.body.storage_path, file_name: 'arrive.mp3', mime_type: 'audio/mpeg', size: 5000 });
  assert.equal((await admin('PUT', `admin/resources/${id}`, { status: 'published' })).status, 400, 'transcript required');
  assert.equal((await admin('PUT', `admin/resources/${id}`, { status: 'published', transcript: 'Breathe in. Breathe out.' })).status, 200);
  await admin('PUT', 'admin/days/1', { links: [{ resource_id: id, role: 'practice' }] });
  const day = (await h.api('GET', 'day/1', { token: B.token })).body.day;
  assert.equal(day.practice.id, id);
  assert.equal(day.practice.transcript, 'Breathe in. Breathe out.');
  const access = await h.api('GET', `resource/${id}/access`, { token: B.token });
  assert.equal(access.body.kind, 'stream');
  await h.api('POST', 'playback', { token: B.token, body: { resource_id: id, position_seconds: 42 } });
  assert.equal((await h.api('GET', 'day/1', { token: B.token })).body.day.practice.position_seconds, 42);
  const cal = await h.api('GET', 'calendar', { token: B.token });
  assert.equal(cal.body.days.find(d => d.day_number === 1).status, 'in_progress');
  const lib = await h.api('GET', 'library', { token: B.token });
  assert.equal(lib.body.practices.length, 1);
});

test('calls: banner, join window, calendar file, replay and challenges come from one record', async () => {
  const none = await h.api('GET', 'calls', { token: A.token });
  assert.equal(none.body.calls.length, 0);
  assert.equal((await h.api('GET', 'home', { token: A.token })).body.next_call, null);

  const startsSoon = new Date(Date.now() + 10 * 60000).toISOString();
  const c = await admin('POST', 'admin/calls', { title: 'Solutions Seat', starts_at: startsSoon, duration_minutes: 60, meeting_url: 'https://meet.example.com/abc', join_window_minutes: 15, status: 'scheduled' });
  assert.equal(c.status, 200);
  const later = await admin('POST', 'admin/calls', { title: 'Solutions Seat 2', starts_at: new Date(Date.now() + 3 * 86400000).toISOString(), meeting_url: 'https://meet.example.com/later', status: 'scheduled' });

  const calls = await h.api('GET', 'calls', { token: A.token });
  assert.equal(calls.body.calls.length, 2);
  assert.equal(calls.body.calls[0].state, 'joinable');
  assert.equal(calls.body.calls[1].state, 'upcoming');
  assert.doesNotMatch(calls.text, /meet\.example\.com/, 'meeting links are only handed out on join');
  assert.equal((await h.api('GET', 'home', { token: A.token })).body.next_call.id, c.body.call.id);
  const join = await h.api('POST', `calls/${c.body.call.id}/join`, { token: A.token });
  assert.equal(join.body.url, 'https://meet.example.com/abc');
  assert.equal((await h.api('POST', `calls/${later.body.call.id}/join`, { token: A.token })).status, 409);

  const ics = await h.api('GET', `calls/${c.body.call.id}/ics`, { token: A.token });
  const dt = startsSoon.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  assert.match(ics.text, new RegExp(`DTSTART:${dt}`));
  assert.match(ics.text, /BEGIN:VEVENT/);

  const missing = await h.api('POST', 'challenges', { token: A.token, body: { call_id: c.body.call.id, working_on: 'Invoicing' } });
  assert.equal(missing.status, 400);
  const ch = await h.api('POST', 'challenges', { token: A.token, body: { call_id: c.body.call.id, working_on: 'How do I hand off invoicing?',
    stuck_on: 'Nobody else knows the follow-up rules', help_wanted: 'A first handoff step', share_permission: true } });
  assert.equal(ch.status, 200);
  assert.equal((await h.api('GET', 'calls', { token: B.token })).body.challenges.length, 0, 'challenges are private to the author and admin');
  assert.match((await admin('GET', 'admin/challenges')).text, /hand off invoicing/);

  // Replay appears only once published.
  const rep = await admin('POST', 'admin/resources', { kind: 'replay', title: 'Replay 1', source_type: 'link', external_url: 'https://video.example.com/r1' });
  await admin('PUT', `admin/resources/${rep.body.resource.id}`, { status: 'published' });
  await admin('PUT', `admin/calls/${c.body.call.id}`, { title: 'Solutions Seat', starts_at: startsSoon, meeting_url: 'https://meet.example.com/abc', status: 'scheduled', replay_resource_id: rep.body.resource.id, replay_published: false });
  assert.equal((await h.api('GET', 'calls', { token: A.token })).body.calls[0].replay, null);
  assert.equal((await h.api('GET', `resource/${rep.body.resource.id}/access`, { token: A.token })).status, 404);
  await admin('PUT', `admin/calls/${c.body.call.id}`, { title: 'Solutions Seat', starts_at: startsSoon, meeting_url: 'https://meet.example.com/abc', status: 'scheduled', replay_resource_id: rep.body.resource.id, replay_published: true });
  assert.equal((await h.api('GET', 'calls', { token: A.token })).body.calls[0].replay.id, rep.body.resource.id);
  assert.equal((await h.api('GET', `resource/${rep.body.resource.id}/access`, { token: A.token })).body.url, 'https://video.example.com/r1');
});

test('admin preview uses a simulated clock and writes nothing', async () => {
  const counts = async () => (await h.sql`select (select count(*) from so_purchases) p, (select count(*) from so_enrollments) e,
    (select count(*) from so_journal_entries) j, (select count(*) from so_day_progress) d, (select count(*) from so_cohorts) c`)[0];
  const before = await counts();
  const c = await h.cohort();
  const { zonedToUtc, addDays, toDateStr } = require('../api/_lib/so/time');
  const day10 = zonedToUtc(addDays(toDateStr(c.start_date), 9), '12:00', c.timezone).toISOString();
  const home = await admin('GET', `admin/preview?view=home&at=${encodeURIComponent(day10)}`);
  assert.equal(home.body.home.current_day, 10);
  const pre = await admin('GET', `admin/preview?view=home&at=${encodeURIComponent('2020-01-01T00:00:00Z')}`);
  assert.equal(pre.body.home.phase, 'pre_intros');
  const draft = await admin('GET', `admin/preview?view=day&n=12&drafts=1&at=${encodeURIComponent(day10)}`);
  assert.equal(draft.body.day.state, 'locked', 'simulated clock still enforces unlocks');
  const offer = await admin('GET', `admin/preview?view=offer&at=${encodeURIComponent('2026-11-30T12:00:00Z')}`);
  assert.equal(offer.body.price.amount_cents, 99900);
  assert.deepEqual(await counts(), before);
  // Members cannot use it.
  assert.equal((await h.api('GET', `admin/preview?view=home&at=${encodeURIComponent(day10)}`, { token: A.token })).status, 403);
});

test('schedule changes show an impact preview, reset owner confirmation, and are audited', async () => {
  const prev = await admin('POST', 'admin/cohort/preview', { unlock_time: '06:00', timezone: 'America/New_York' });
  assert.equal(prev.status, 200);
  assert.ok(prev.body.impact.rows.find(r => r.label.startsWith('Day 1')).changed);
  assert.equal(prev.body.impact.enrolled_members >= 2, true);
  const c0 = await h.cohort();
  assert.equal(c0.timezone, 'America/Los_Angeles', 'preview does not save');

  const confirm = await admin('PUT', 'admin/cohort', { confirm_settings: true });
  assert.ok(confirm.body.cohort.settings_confirmed_at);
  const change = await admin('PUT', 'admin/cohort', { price_cutoff_local: '2026-12-01T00:00', intro_price_cents: 99900 });
  assert.equal(change.status, 200);
  const unchanged = change.body.timing_changed.length === 0;
  const moved = await admin('PUT', 'admin/cohort', { unlock_time: '05:00' });
  assert.deepEqual(moved.body.timing_changed, ['unlock_time']);
  assert.equal(moved.body.cohort.settings_confirmed_at, null, 'changing timing requires re-confirmation');
  assert.ok(unchanged, 'same cutoff expressed in local time is not a change');
  await admin('PUT', 'admin/cohort', { unlock_time: '00:00' });
  const bad = await admin('PUT', 'admin/cohort', { timezone: 'Not/AZone' });
  assert.equal(bad.status, 400);
  const audit = await admin('GET', 'admin/audit');
  assert.ok(audit.body.entries.filter(e => e.action === 'cohort_updated').length >= 3);
});

test('after the cohort: calm completion state; access follows the configured policy', async () => {
  await h.setCohort({ start_date: '2026-09-01', intro_opens_at: new Date('2026-08-01T00:00:00Z') });
  const home = await h.api('GET', 'home', { token: A.token });
  assert.equal(home.body.phase, 'complete');
  assert.equal(home.body.current_day, null);
  assert.equal((await h.api('GET', 'day/1', { token: A.token })).body.day.state, 'available', 'past days stay available');
  await h.setCohort({ access_policy: 'until_date', access_ends_at: new Date(Date.now() - 1000) });
  const ended = await h.api('GET', 'home', { token: A.token });
  assert.equal(ended.status, 403);
  assert.equal(ended.body.reason, 'access_period_ended');
  await h.setCohort({ access_policy: 'unset', access_ends_at: null });
});

test('rate limiting and input validation on member writes', async () => {
  const long = await h.api('PUT', 'journal/1', { token: A.token, body: { body: 'x'.repeat(20001), base_revision: 1 } });
  assert.equal(long.status, 400);
  const bad = await h.api('POST', 'challenges', { token: A.token, body: { working_on: '', stuck_on: 'x', help_wanted: 'y', share_permission: true } });
  assert.equal(bad.status, 400);
  const weird = await h.api('GET', 'resource/not-a-uuid/access', { token: A.token });
  assert.equal(weird.status, 404);
});
