'use strict';
// Member-facing API. Every handler resolves the signed-in user on the server,
// loads their enrollment, and applies schedule + publish gates itself.

const crypto = require('crypto');
const S = require('./schedule');
const C = require('./core');
const H = require('./http');
const { requireUser, ensureProfile, getAuthUser } = require('./identity');
const storage = require('./storage');
const { isValidTimeZone, zonedToUtc } = require('./time');
const env = require('./env');

const { HttpError } = H;

// ------------------------------------------------------------ helpers
async function ctxFor(sql, req, now, opts) {
  const user = await requireUser(req);
  const profile = await ensureProfile(sql, user);
  const ctx = await C.memberContext(sql, user, now, opts);
  return { ...ctx, profile };
}

async function dayByNumber(sql, cohort, n) {
  const num = H.int(n, { min: 1, max: cohort.days_count, field: 'day' });
  const d = (await sql`select * from so_days where cohort_id = ${cohort.id} and day_number = ${num}`)[0];
  if (!d) throw new HttpError(404, 'not_found', 'That day does not exist.');
  return d;
}

async function requireAvailableDay(sql, cohort, n, now) {
  const day = await dayByNumber(sql, cohort, n);
  const state = C.dayState(cohort, day, now);
  if (state === 'locked') throw new HttpError(403, 'day_locked', 'This day has not unlocked yet.');
  if (state === 'preparing') throw new HttpError(403, 'day_preparing', 'This day’s content is being prepared.');
  return day;
}

async function markStarted(sql, userId, cohortId, dayId) {
  await sql`
    insert into so_day_progress (user_id, cohort_id, day_id, started_at) values (${userId}, ${cohortId}, ${dayId}, now())
    on conflict (user_id, cohort_id, day_id) do update set started_at = coalesce(so_day_progress.started_at, now()), updated_at = now()`;
}

// Released resources linked to one day, split by role.
async function dayResources(sql, cohort, day, now) {
  const rows = await sql`
    select r.*, dr.role, dr.sort from so_day_resources dr join so_resources r on r.id = dr.resource_id
    where dr.day_id = ${day.id} order by dr.sort, r.title`;
  if (!rows.length) return { practice: null, templates: [] };
  const ids = rows.map(r => r.id);
  const links = await sql`
    select dr.resource_id, d.day_number, d.status, d.title from so_day_resources dr join so_days d on d.id = dr.day_id
    where dr.resource_id = any(${ids}) order by d.day_number`;
  const released = rows.filter(r => C.resourceReleased(cohort, r, links.filter(l => l.resource_id === r.id), now));
  const rel = r => links.filter(l => l.resource_id === r.id && C.dayState(cohort, l, now) === 'available').map(l => l.day_number);
  const practiceRow = released.find(r => r.role === 'practice');
  return {
    practice: practiceRow ? { row: practiceRow, out: C.resourceOut(practiceRow, { transcript: practiceRow.transcript || null }) } : null,
    templates: released.filter(r => r.role !== 'practice').map(r => C.resourceOut(r, { related_days: rel(r), role: r.role })),
  };
}

// The single day representation used by Today, /app/day/N and admin preview.
async function buildDay(sql, cohort, day, now, userId) {
  const sched = S.schedule(cohort);
  const weeks = await C.loadWeeks(sql, cohort.id);
  const header = C.dayHeader(cohort, sched, weeks, day);
  const state = C.dayState(cohort, day, now);
  if (state !== 'available') return C.dayPreview(cohort, sched, weeks, day, now);

  const res = await dayResources(sql, cohort, day, now);
  let journal = null, progress = null, playback = 0;
  if (userId) {
    const j = (await sql`select body, revision, prompt_snapshot, prompt_version, updated_at from so_journal_entries
                         where user_id = ${userId} and cohort_id = ${cohort.id} and day_id = ${day.id}`)[0];
    if (j) journal = { body: j.body, revision: j.revision, prompt_snapshot: j.prompt_snapshot, prompt_version: j.prompt_version, updated_at: j.updated_at };
    const p = (await sql`select started_at, completed_at from so_day_progress
                         where user_id = ${userId} and cohort_id = ${cohort.id} and day_id = ${day.id}`)[0];
    progress = { started_at: p ? p.started_at : null, completed_at: p ? p.completed_at : null };
    if (res.practice) {
      const pb = (await sql`select position_seconds from so_playback where user_id = ${userId} and resource_id = ${res.practice.row.id}`)[0];
      playback = pb ? pb.position_seconds : 0;
    }
  }
  const calls = await C.loadMemberCalls(sql, cohort, now);
  const call = calls.find(c => c.cohort_date === header.date && c.state !== 'canceled' && c.state !== 'ended')
    || null;
  const week = weeks.find(w => w.week_number === header.week);
  return {
    ...header,
    state,
    title: day.title,
    purpose: day.purpose || null,
    content: day.content || null,
    reflection_prompt: day.reflection_prompt || null,
    prompt_version: day.prompt_version,
    action_title: day.action_title || null,
    action_body: day.action_body || null,
    practice: res.practice ? { ...res.practice.out, position_seconds: playback } : null,
    templates: res.templates,
    week_assignment: week ? week.assignment || null : null,
    journal,
    progress,
    call,
    is_sample: !!day.is_sample,
  };
}

async function calendarDays(sql, cohort, now, userId) {
  const sched = S.schedule(cohort);
  const weeks = await C.loadWeeks(sql, cohort.id);
  const days = await sql`select * from so_days where cohort_id = ${cohort.id} order by day_number`;
  const progress = userId ? await sql`select day_id, started_at, completed_at from so_day_progress
                                     where user_id = ${userId} and cohort_id = ${cohort.id}` : [];
  const pmap = new Map(progress.map(p => [p.day_id, p]));
  return days.map(d => {
    const state = C.dayState(cohort, d, now);
    if (state !== 'available') {
      const pv = C.dayPreview(cohort, sched, weeks, d, now);
      return { ...pv, status: state === 'locked' ? 'upcoming' : 'preparing' };
    }
    const p = pmap.get(d.id);
    const status = p && p.completed_at ? 'complete' : p && p.started_at ? 'in_progress' : 'available';
    return { ...C.dayHeader(cohort, sched, weeks, d), state, title: d.title, preview_summary: d.preview_summary || d.purpose || null, status };
  });
}

async function loadAnnouncements(sql, cohort, now) {
  return sql`select id, title, body, pinned, coalesce(publish_at, created_at) as posted_at from so_announcements
             where cohort_id = ${cohort.id} and status = 'published' and (publish_at is null or publish_at <= ${now})
             order by pinned desc, coalesce(publish_at, created_at) desc limit 5`;
}

async function homePayload(sql, cohort, now, userId, access) {
  const sched = S.schedule(cohort);
  const phase = S.phase(cohort, now);
  const calls = await C.loadMemberCalls(sql, cohort, now);
  let today = null;
  const cur = S.currentDay(cohort, now);
  if (cur) {
    const day = (await sql`select * from so_days where cohort_id = ${cohort.id} and day_number = ${cur}`)[0];
    if (day) today = await buildDay(sql, cohort, day, now, userId);
  }
  let hasIntro = false;
  if (userId) hasIntro = !!(await sql`select 1 from so_introductions where user_id = ${userId} and cohort_id = ${cohort.id}`)[0];
  let completedCount = 0;
  if (userId) completedCount = (await sql`select count(*)::int as n from so_day_progress where user_id = ${userId}
                                          and cohort_id = ${cohort.id} and completed_at is not null`)[0].n;
  return {
    now: now.toISOString(),
    phase,
    cohort: {
      name: cohort.name, timezone: cohort.timezone, start_date: sched.start_date, end_date: sched.end_date,
      starts_at: sched.starts_at.toISOString(), ends_at: sched.ends_at.toISOString(),
      intro_opens_at: new Date(cohort.intro_opens_at).toISOString(), days_count: cohort.days_count,
    },
    intros_open: S.introsOpen(cohort, now),
    has_intro: hasIntro,
    current_day: cur,
    unlocked_through: S.unlockedThrough(cohort, now),
    today,
    next_call: C.nextCall(calls),
    replays_available: calls.some(c => c.replay),
    completed_count: completedCount,
    announcements: await loadAnnouncements(sql, cohort, now),
    access: access ? { active: access.active, ends_at: access.ends_at ? access.ends_at.toISOString() : null } : null,
  };
}

// ----------------------------------------------------------- handlers
const routes = {};

routes['GET me'] = async ({ sql, req, now }) => {
  const user = await getAuthUser(req);
  if (!user) return { signed_in: false };
  const profile = await ensureProfile(sql, user);
  const cohort = await C.loadCohort(sql);
  const enrollment = await C.loadEnrollment(sql, user.id, cohort.id);
  const access = S.accessStatus(cohort, enrollment, now);
  return {
    signed_in: true,
    email: user.email,
    display_name: profile.display_name,
    timezone: profile.timezone,
    avatar_url: await avatarUrl(profile.avatar_path),
    is_admin: profile.role === 'admin',
    enrolled: !!enrollment,
    access: { active: access.active, reason: access.reason },
    review_state: enrollment ? enrollment.review_state : null,
    test_enrollment: !!(enrollment && enrollment.is_test),
  };
};

routes['GET home'] = async ({ sql, req, now }) => {
  const ctx = await ctxFor(sql, req, now);
  C.recordEvent(sql, 'welcome_viewed', { userId: ctx.user.id, cohortId: ctx.cohort.id });
  const out = await homePayload(sql, ctx.cohort, now, ctx.user.id, ctx.access);
  out.test_enrollment = !!ctx.enrollment.is_test;
  out.review_state = ctx.enrollment.review_state;
  return out;
};

routes['GET calendar'] = async ({ sql, req, now }) => {
  const ctx = await ctxFor(sql, req, now);
  return {
    now: now.toISOString(), timezone: ctx.cohort.timezone,
    current_day: S.currentDay(ctx.cohort, now),
    weeks: await C.loadWeeks(sql, ctx.cohort.id),
    days: await calendarDays(sql, ctx.cohort, now, ctx.user.id),
  };
};

routes['GET day/:n'] = async ({ sql, req, now, params }) => {
  const ctx = await ctxFor(sql, req, now);
  const day = await dayByNumber(sql, ctx.cohort, params.n);
  const out = await buildDay(sql, ctx.cohort, day, now, ctx.user.id);
  if (out.state === 'available') C.recordEvent(sql, 'day_opened', { userId: ctx.user.id, cohortId: ctx.cohort.id, dayNumber: day.day_number });
  return { now: now.toISOString(), current_day: S.currentDay(ctx.cohort, now), day: out };
};

routes['PUT journal/:n'] = async ({ sql, req, now, params }) => {
  const ctx = await ctxFor(sql, req, now);
  const day = await requireAvailableDay(sql, ctx.cohort, params.n, now);
  const b = H.body(req);
  if (typeof b.body !== 'string') throw new HttpError(400, 'invalid_input', 'Reflection text is required.');
  if (b.body.length > 20000) throw new HttpError(400, 'too_long', 'Reflections can be up to 20,000 characters.');
  const text = b.body.replace(/\u0000/g, '');
  const base = b.base_revision === null || b.base_revision === undefined ? null : H.int(b.base_revision, { min: 0, field: 'revision' });
  await H.rateLimit(sql, `journal:${ctx.user.id}`, 240, 600);

  const result = await sql.begin(async tx => {
    const existing = (await tx`select * from so_journal_entries where user_id = ${ctx.user.id} and cohort_id = ${ctx.cohort.id}
                               and day_id = ${day.id} for update`)[0];
    if (!existing) {
      if (base) return { conflict: true, server: null };
      const ins = await tx`
        insert into so_journal_entries (user_id, cohort_id, day_id, body, prompt_snapshot, prompt_version)
        values (${ctx.user.id}, ${ctx.cohort.id}, ${day.id}, ${text}, ${day.reflection_prompt}, ${day.prompt_version})
        on conflict (user_id, cohort_id, day_id) do nothing returning *`;
      if (!ins[0]) {
        const cur = (await tx`select * from so_journal_entries where user_id = ${ctx.user.id} and cohort_id = ${ctx.cohort.id} and day_id = ${day.id}`)[0];
        return { conflict: true, server: cur };
      }
      return { entry: ins[0] };
    }
    if (base !== existing.revision) return { conflict: true, server: existing };
    if (existing.body === text) return { entry: existing };
    const up = await tx`update so_journal_entries set body = ${text}, revision = revision + 1, updated_at = now()
                        where id = ${existing.id} returning *`;
    return { entry: up[0] };
  });

  if (result.conflict) {
    const s = result.server;
    throw new HttpError(409, 'journal_conflict', 'This reflection was changed somewhere else.', {
      server: s ? { body: s.body, revision: s.revision, updated_at: s.updated_at } : null,
    });
  }
  if (text.trim()) await markStarted(sql, ctx.user.id, ctx.cohort.id, day.id);
  return { revision: result.entry.revision, updated_at: result.entry.updated_at };
};

routes['GET journal'] = async ({ sql, req, now }) => {
  const ctx = await ctxFor(sql, req, now);
  const rows = await sql`
    select j.body, j.revision, j.prompt_snapshot, j.updated_at, d.day_number, d.title
    from so_journal_entries j join so_days d on d.id = j.day_id
    where j.user_id = ${ctx.user.id} and j.cohort_id = ${ctx.cohort.id} and length(trim(j.body)) > 0
    order by d.day_number`;
  const notes = await sql`select id, title, body, revision, created_at, updated_at from so_journal_notes
                          where user_id = ${ctx.user.id} and cohort_id = ${ctx.cohort.id} order by updated_at desc`;
  const excerpt = b => (b.length > 220 ? `${b.slice(0, 220).trimEnd()}…` : b);
  return {
    entries: rows.map(r => ({
      day_number: r.day_number, title: r.title, question: r.prompt_snapshot,
      excerpt: excerpt(r.body), updated_at: r.updated_at,
    })),
    notes: notes.map(n => ({ id: n.id, title: n.title, excerpt: excerpt(n.body), created_at: n.created_at, updated_at: n.updated_at })),
  };
};

// ----------------------------------------------- free journal entries
// Entries members write on their own, without a daily prompt. Private.
async function ownNote(sql, ctx, id) {
  const nid = H.uuid(id, 'entry');
  const n = (await sql`select * from so_journal_notes where id = ${nid} and user_id = ${ctx.user.id} and cohort_id = ${ctx.cohort.id}`)[0];
  if (!n) throw new HttpError(404, 'not_found', 'That journal entry was not found.');
  return n;
}
const noteOut = n => ({ id: n.id, title: n.title, body: n.body, revision: n.revision, created_at: n.created_at, updated_at: n.updated_at });

routes['POST journal/notes'] = async ({ sql, req, now }) => {
  const ctx = await ctxFor(sql, req, now);
  const b = H.body(req);
  const title = H.text(b.title, { max: 140, field: 'Title' }) || null;
  if (b.body !== undefined && typeof b.body !== 'string') throw new HttpError(400, 'invalid_input', 'Entry text must be text.');
  const body = String(b.body || '').replace(/\u0000/g, '');
  if (body.length > 20000) throw new HttpError(400, 'too_long', 'Entries can be up to 20,000 characters.');
  await H.rateLimit(sql, `notes:${ctx.user.id}`, 60, 3600);
  const n = (await sql`insert into so_journal_notes (user_id, cohort_id, title, body) values (${ctx.user.id}, ${ctx.cohort.id}, ${title}, ${body}) returning *`)[0];
  return { note: noteOut(n) };
};

routes['GET journal/notes/:id'] = async ({ sql, req, now, params }) => {
  const ctx = await ctxFor(sql, req, now);
  return { note: noteOut(await ownNote(sql, ctx, params.id)) };
};

// Same conflict protection as daily reflections: a stale tab can't overwrite newer text.
routes['PUT journal/notes/:id'] = async ({ sql, req, now, params }) => {
  const ctx = await ctxFor(sql, req, now);
  const cur = await ownNote(sql, ctx, params.id);
  const b = H.body(req);
  if (typeof b.body !== 'string') throw new HttpError(400, 'invalid_input', 'Entry text is required.');
  if (b.body.length > 20000) throw new HttpError(400, 'too_long', 'Entries can be up to 20,000 characters.');
  const title = b.title === undefined ? cur.title : (H.text(b.title, { max: 140, field: 'Title' }) || null);
  const base = H.int(b.base_revision, { min: 0, field: 'revision' });
  await H.rateLimit(sql, `journal:${ctx.user.id}`, 240, 600);
  const rows = await sql`update so_journal_notes set body = ${b.body.replace(/\u0000/g, '')}, title = ${title}, revision = revision + 1, updated_at = now()
                         where id = ${cur.id} and revision = ${base} returning *`;
  if (!rows[0]) {
    const latest = await ownNote(sql, ctx, params.id);
    throw new HttpError(409, 'journal_conflict', 'This entry was changed somewhere else.', { server: { body: latest.body, revision: latest.revision, updated_at: latest.updated_at } });
  }
  return { revision: rows[0].revision, updated_at: rows[0].updated_at };
};

routes['DELETE journal/notes/:id'] = async ({ sql, req, now, params }) => {
  const ctx = await ctxFor(sql, req, now);
  const n = await ownNote(sql, ctx, params.id);
  await sql`delete from so_journal_notes where id = ${n.id}`;
  return { ok: true };
};

routes['GET journal/export'] = async ({ sql, req, now, res }) => {
  const ctx = await ctxFor(sql, req, now);
  const rows = await sql`
    select j.body, j.prompt_snapshot, j.updated_at, d.day_number, d.title
    from so_journal_entries j join so_days d on d.id = j.day_id
    where j.user_id = ${ctx.user.id} and j.cohort_id = ${ctx.cohort.id} and length(trim(j.body)) > 0
    order by d.day_number`;
  const out = [`# ${ctx.cohort.name} — My Journal`, '', `Exported ${now.toISOString().slice(0, 10)}`, ''];
  for (const r of rows) {
    out.push(`## Day ${r.day_number}: ${r.title}`, '', `> ${r.prompt_snapshot || ''}`, '', r.body, '');
  }
  const notes = await sql`select title, body, created_at from so_journal_notes
                          where user_id = ${ctx.user.id} and cohort_id = ${ctx.cohort.id} and length(trim(body)) > 0 order by created_at`;
  if (notes.length) out.push('# My own entries', '');
  for (const n of notes) out.push(`## ${n.title || 'Untitled entry'} (${new Date(n.created_at).toISOString().slice(0, 10)})`, '', n.body, '');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="smooth-operators-journal.md"');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 200;
  res.end(out.join('\n'));
  return H.HANDLED;
};

routes['POST progress/:n'] = async ({ sql, req, now, params }) => {
  const ctx = await ctxFor(sql, req, now);
  const day = await requireAvailableDay(sql, ctx.cohort, params.n, now);
  const b = H.body(req);
  if (typeof b.completed !== 'boolean') throw new HttpError(400, 'invalid_input', 'completed must be true or false.');
  const rows = await sql`
    insert into so_day_progress (user_id, cohort_id, day_id, completed_at)
    values (${ctx.user.id}, ${ctx.cohort.id}, ${day.id}, ${b.completed ? now : null})
    on conflict (user_id, cohort_id, day_id) do update
      set completed_at = ${b.completed ? now : null}, updated_at = now()
    returning started_at, completed_at`;
  if (b.completed) C.recordEvent(sql, 'day_completed', { userId: ctx.user.id, cohortId: ctx.cohort.id, dayNumber: day.day_number });
  return { progress: rows[0] };
};

// Shared release check for a single resource.
async function releasedResource(sql, cohort, id, now) {
  const rid = H.uuid(id, 'resource');
  const r = (await sql`select * from so_resources where id = ${rid} and cohort_id = ${cohort.id}`)[0];
  if (!r) throw new HttpError(404, 'not_found', 'That resource is not available.');
  const links = await sql`select dr.role, d.day_number, d.status, d.title from so_day_resources dr join so_days d on d.id = dr.day_id
                          where dr.resource_id = ${rid} order by d.day_number`;
  let ok = C.resourceReleased(cohort, r, links, now);
  if (!ok && r.kind === 'replay' && r.status === 'published') {
    ok = !!(await sql`select 1 from so_calls where replay_resource_id = ${rid} and replay_published and cohort_id = ${cohort.id}`)[0];
  }
  // Same response for missing and unreleased, so locked IDs can't be probed.
  if (!ok) throw new HttpError(404, 'not_found', 'That resource is not available.');
  return { r, links };
}

routes['POST playback'] = async ({ sql, req, now }) => {
  const ctx = await ctxFor(sql, req, now);
  const b = H.body(req);
  const { r, links } = await releasedResource(sql, ctx.cohort, b.resource_id, now);
  const pos = H.int(Math.floor(Number(b.position_seconds) || 0), { min: 0, max: 24 * 3600, field: 'position' });
  await sql`insert into so_playback (user_id, resource_id, position_seconds) values (${ctx.user.id}, ${r.id}, ${pos})
            on conflict (user_id, resource_id) do update set position_seconds = ${pos}, updated_at = now()`;
  if (r.kind === 'practice') {
    for (const l of links.filter(x => x.role === 'practice' && C.dayState(ctx.cohort, x, now) === 'available')) {
      const d = (await sql`select id from so_days where cohort_id = ${ctx.cohort.id} and day_number = ${l.day_number}`)[0];
      if (d) await markStarted(sql, ctx.user.id, ctx.cohort.id, d.id);
    }
  }
  return { ok: true };
};

routes['GET library'] = async ({ sql, req, now }) => {
  const ctx = await ctxFor(sql, req, now);
  const all = await C.loadResourcesWithDays(sql, ctx.cohort.id);
  const items = all
    .filter(r => (r.kind === 'template' || r.kind === 'practice') && C.resourceReleased(ctx.cohort, r, r.links, now))
    .map(r => C.resourceOut(r, {
      related_days: [...new Set(r.links.filter(l => C.dayState(ctx.cohort, l, now) === 'available').map(l => l.day_number))],
    }));
  return {
    templates: items.filter(i => i.kind === 'template'),
    practices: items.filter(i => i.kind === 'practice')
      .sort((a, b) => (a.related_days[0] || 99) - (b.related_days[0] || 99)),
  };
};

routes['GET resource/:id'] = async ({ sql, req, now, params }) => {
  const ctx = await ctxFor(sql, req, now);
  const { r, links } = await releasedResource(sql, ctx.cohort, params.id, now);
  const pb = (await sql`select position_seconds from so_playback where user_id = ${ctx.user.id} and resource_id = ${r.id}`)[0];
  return {
    resource: C.resourceOut(r, {
      transcript: r.transcript || null,
      position_seconds: pb ? pb.position_seconds : 0,
      related_days: links.filter(l => C.dayState(ctx.cohort, l, now) === 'available').map(l => ({ day_number: l.day_number, title: l.title })),
    }),
  };
};

routes['GET resource/:id/access'] = async ({ sql, req, now, params, query }) => {
  const ctx = await ctxFor(sql, req, now);
  const { r } = await releasedResource(sql, ctx.cohort, params.id, now);
  C.recordEvent(sql, 'resource_opened', { userId: ctx.user.id, cohortId: ctx.cohort.id, refId: r.id });
  if (r.source_type === 'link') {
    if (!r.external_url) throw new HttpError(404, 'not_found', 'That resource is not available.');
    return { url: r.external_url, kind: 'link' };
  }
  if (!r.storage_path) throw new HttpError(404, 'not_found', 'That file has not been uploaded yet.');
  const stream = r.mime_type && /^(audio|video)\//.test(r.mime_type) && query.download !== '1';
  const url = await storage.signedDownloadUrl(r.storage_path, stream ? 3600 : 300, stream ? null : (r.file_name || 'download'));
  return { url, kind: stream ? 'stream' : 'download', expires_in: stream ? 3600 : 300 };
};

routes['GET calls'] = async ({ sql, req, now }) => {
  const ctx = await ctxFor(sql, req, now);
  const calls = await C.loadMemberCalls(sql, ctx.cohort, now);
  const challenges = await sql`select id, call_id, body, working_on, stuck_on, help_wanted, share_permission, status, created_at from so_call_challenges
                               where user_id = ${ctx.user.id} and cohort_id = ${ctx.cohort.id} order by created_at desc`;
  const content = await C.loadContent(sql);
  return {
    now: now.toISOString(), cohort_timezone: ctx.cohort.timezone, calls, challenges,
    recording_policy: content.isPublished('calls.recording_policy') ? content.get('calls.recording_policy') : null,
    intros_open: S.introsOpen(ctx.cohort, now),
  };
};

function icsEscape(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsDate(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }

routes['GET calls/:id/ics'] = async ({ sql, req, now, params, res }) => {
  const ctx = await ctxFor(sql, req, now);
  const id = H.uuid(params.id, 'call');
  const call = (await sql`select * from so_calls where id = ${id} and cohort_id = ${ctx.cohort.id} and status = 'scheduled'`)[0];
  if (!call) throw new HttpError(404, 'not_found', 'That call is not available.');
  const t = C.callTimes(ctx.cohort, call);
  const link = env.appUrl(req, '/app/calls-help');
  // Times are written in UTC (Z), which every calendar converts to the viewer's zone exactly.
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Omi Bell//Smooth Operators//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${call.id}@smoothoperators.omibell.com`, `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(t.starts)}`, `DTEND:${icsDate(t.ends)}`,
    `SUMMARY:${icsEscape(`${ctx.cohort.name}: ${call.title}`)}`,
    `DESCRIPTION:${icsEscape(`${call.description || 'Bring a challenge you’re working through. We’ll think it through together.'}\n\nJoin from your cohort space: ${link}`)}`,
    `URL:${link}`, 'END:VEVENT', 'END:VCALENDAR',
  ];
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="solutions-seat.ics"');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 200;
  res.end(lines.join('\r\n') + '\r\n');
  return H.HANDLED;
};

routes['POST calls/:id/join'] = async ({ sql, req, now, params }) => {
  const ctx = await ctxFor(sql, req, now);
  const id = H.uuid(params.id, 'call');
  const call = (await sql`select * from so_calls where id = ${id} and cohort_id = ${ctx.cohort.id} and status = 'scheduled'`)[0];
  if (!call) throw new HttpError(404, 'not_found', 'That call is not available.');
  const state = C.callState(ctx.cohort, call, now);
  if (state !== 'joinable') throw new HttpError(409, 'not_joinable', state === 'ended' ? 'This call has ended.' : 'The join link opens shortly before the call starts.');
  if (!call.meeting_url) throw new HttpError(409, 'no_link', 'The meeting link hasn’t been added yet. Please contact support.');
  // A click is recorded as a click, not as verified attendance.
  C.recordEvent(sql, 'call_link_clicked', { userId: ctx.user.id, cohortId: ctx.cohort.id, refId: call.id });
  return { url: call.meeting_url };
};

routes['POST challenges'] = async ({ sql, req, now }) => {
  const ctx = await ctxFor(sql, req, now);
  const b = H.body(req);
  const workingOn = H.text(b.working_on, { max: 800, required: true, field: 'What you’re working on', multiline: true });
  const stuckOn = H.text(b.stuck_on, { max: 800, required: true, field: 'Where you’re stuck', multiline: true });
  const helpWanted = H.text(b.help_wanted, { max: 800, required: true, field: 'The help or decision you want', multiline: true });
  if (typeof b.share_permission !== 'boolean') throw new HttpError(400, 'invalid_input', 'Tell us whether we may discuss this with the cohort.');
  let callId = null;
  if (b.call_id) {
    callId = H.uuid(b.call_id, 'call');
    const ok = (await sql`select 1 from so_calls where id = ${callId} and cohort_id = ${ctx.cohort.id} and status = 'scheduled'`)[0];
    if (!ok) throw new HttpError(404, 'not_found', 'That call is not available.');
  }
  await H.rateLimit(sql, `challenge:${ctx.user.id}`, 10, 3600);
  const rows = await sql`insert into so_call_challenges (cohort_id, call_id, user_id, working_on, stuck_on, help_wanted, share_permission)
                         values (${ctx.cohort.id}, ${callId}, ${ctx.user.id}, ${workingOn}, ${stuckOn}, ${helpWanted}, ${b.share_permission})
                         returning id, call_id, working_on, stuck_on, help_wanted, share_permission, status, created_at`;
  return { challenge: rows[0] };
};

routes['DELETE challenges/:id'] = async ({ sql, req, now, params }) => {
  const ctx = await ctxFor(sql, req, now);
  const id = H.uuid(params.id, 'challenge');
  const rows = await sql`delete from so_call_challenges where id = ${id} and user_id = ${ctx.user.id} returning id`;
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Not found.');
  return { ok: true };
};

// ------------------------------------------------------ introductions
function requireIntrosOpen(ctx) {
  if (!S.introsOpen(ctx.cohort, ctx.now)) throw new HttpError(403, 'intros_not_open', 'Introductions open soon.');
}

async function photoUrl(path) {
  if (!path) return null;
  try { return await storage.signedDownloadUrl(path, 3600); } catch { return null; }
}

function introOut(i, url, mine) {
  return {
    id: i.id, preferred_name: i.preferred_name, business_name: i.business_name,
    business_description: i.business_description, operating_challenge: i.operating_challenge,
    website_url: i.website_url, photo_url: url, is_mine: mine,
    ...(mine ? { moderation_state: i.moderation_state } : {}),
  };
}

routes['GET introductions'] = async ({ sql, req, now }) => {
  const ctx = await ctxFor(sql, req, now);
  requireIntrosOpen(ctx);
  // Only introductions from members of THIS cohort with active access.
  const rows = await sql`
    select i.* from so_introductions i
    join so_enrollments e on e.user_id = i.user_id and e.cohort_id = i.cohort_id and e.access_state = 'active' and e.review_state = 'approved'
    where i.cohort_id = ${ctx.cohort.id} and (i.moderation_state = 'visible' or i.user_id = ${ctx.user.id})
    order by i.created_at`;
  const out = [];
  for (const r of rows) out.push(introOut(r, await photoUrl(r.photo_path), r.user_id === ctx.user.id));
  return { introductions: out };
};

routes['GET introductions/mine'] = async ({ sql, req, now }) => {
  const ctx = await ctxFor(sql, req, now);
  requireIntrosOpen(ctx);
  const r = (await sql`select * from so_introductions where user_id = ${ctx.user.id} and cohort_id = ${ctx.cohort.id}`)[0];
  return { introduction: r ? introOut(r, await photoUrl(r.photo_path), true) : null };
};

routes['PUT introductions/mine'] = async ({ sql, req, now }) => {
  const ctx = await ctxFor(sql, req, now);
  requireIntrosOpen(ctx);
  const b = H.body(req);
  const v = {
    preferred_name: H.text(b.preferred_name, { max: 80, required: true, field: 'Preferred name' }),
    business_name: H.text(b.business_name, { max: 120, required: true, field: 'Business name' }),
    business_description: H.text(b.business_description, { max: 600, required: true, field: 'What your business does', multiline: true }),
    operating_challenge: H.text(b.operating_challenge, { max: 600, required: true, field: 'Operating challenge', multiline: true }),
    website_url: H.optionalUrl(b.website_url, { field: 'Website' }),
  };
  let photo = null;
  const existing = (await sql`select photo_path from so_introductions where user_id = ${ctx.user.id} and cohort_id = ${ctx.cohort.id}`)[0];
  if (b.photo_path === null || b.photo_path === '') photo = null;
  else if (b.photo_path === undefined) photo = existing ? existing.photo_path : null;
  else {
    if (typeof b.photo_path !== 'string' || !b.photo_path.startsWith(`intros/${ctx.user.id}/`) || b.photo_path.includes('..')) {
      throw new HttpError(400, 'invalid_input', 'Invalid photo.');
    }
    photo = b.photo_path;
  }
  await H.rateLimit(sql, `intro:${ctx.user.id}`, 30, 3600);
  const rows = await sql`
    insert into so_introductions (user_id, cohort_id, preferred_name, business_name, business_description, operating_challenge, website_url, photo_path)
    values (${ctx.user.id}, ${ctx.cohort.id}, ${v.preferred_name}, ${v.business_name}, ${v.business_description}, ${v.operating_challenge}, ${v.website_url}, ${photo})
    on conflict (user_id, cohort_id) do update set
      preferred_name = excluded.preferred_name, business_name = excluded.business_name,
      business_description = excluded.business_description, operating_challenge = excluded.operating_challenge,
      website_url = excluded.website_url, photo_path = excluded.photo_path, updated_at = now()
    returning *`;
  if (existing && existing.photo_path && existing.photo_path !== photo) await storage.removeObjects([existing.photo_path]);
  return { introduction: introOut(rows[0], await photoUrl(rows[0].photo_path), true) };
};

routes['DELETE introductions/mine'] = async ({ sql, req, now }) => {
  const ctx = await ctxFor(sql, req, now);
  const rows = await sql`delete from so_introductions where user_id = ${ctx.user.id} and cohort_id = ${ctx.cohort.id} returning photo_path`;
  if (rows[0] && rows[0].photo_path) await storage.removeObjects([rows[0].photo_path]);
  return { ok: true };
};

routes['POST introductions/photo-upload'] = async ({ sql, req, now }) => {
  const ctx = await ctxFor(sql, req, now);
  requireIntrosOpen(ctx);
  const b = H.body(req);
  storage.checkUpload('photo', b.mime_type, b.size);
  await H.rateLimit(sql, `photo:${ctx.user.id}`, 10, 3600);
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[b.mime_type];
  const path = `intros/${ctx.user.id}/${crypto.randomUUID()}.${ext}`;
  return { upload_url: await storage.signedUploadUrl(path), photo_path: path };
};

// -------------------------------------------------------------- account
async function avatarUrl(path) {
  if (!path) return null;
  try { return await storage.signedDownloadUrl(path, 3600); } catch { return null; }
}

// Refund requests are open until the moment the cohort's first day begins
// (Jan 4 at 12:00 AM cohort time = through Jan 3 at 11:59 PM).
function refundDeadline(cohort) {
  return zonedToUtc(S.schedule(cohort).start_date, '00:00', cohort.timezone);
}

async function accountBilling(sql, user, cohort, now) {
  const e = await C.loadEnrollment(sql, user.id, cohort.id);
  const p = e && e.purchase_id ? (await sql`select * from so_purchases where id = ${e.purchase_id}`)[0] : null;
  const deadline = refundDeadline(cohort);
  const out = {
    enrolled: !!e, review_state: e ? e.review_state : null,
    cohort: { name: cohort.name, start_date: S.schedule(cohort).start_date, timezone: cohort.timezone },
    payment: p && p.paid_at ? { amount_cents: p.amount_paid_cents || p.amount_cents, paid_at: p.paid_at, receipt_url: p.receipt_url || null, status: p.status } : null,
    refund: { deadline: deadline.toISOString(), state: 'none', can_request: false, requested_at: null },
  };
  if (!p || !p.paid_at) return out;
  const attempt = (await sql`select status, updated_at from so_refund_attempts where purchase_id = ${p.id} order by created_at desc limit 1`)[0];
  const req = (await sql`select * from so_refund_requests where purchase_id = ${p.id} and status = 'open' order by created_at desc limit 1`)[0];
  if (['refunded', 'partially_refunded'].includes(p.status)) out.refund.state = 'refunded';
  else if (attempt && attempt.status !== 'failed') out.refund.state = 'processing';
  else if (req) { out.refund.state = 'requested'; out.refund.requested_at = req.created_at; }
  else if (now < deadline && p.status === 'paid') { out.refund.state = 'available'; out.refund.can_request = true; }
  else out.refund.state = 'closed';
  return out;
}

routes['GET account'] = async ({ sql, req, now }) => {
  const user = await requireUser(req);
  const p = await ensureProfile(sql, user);
  const cohort = await C.loadCohort(sql);
  return {
    email: user.email, display_name: p.display_name, timezone: p.timezone, email_prefs: p.email_prefs || {},
    avatar_url: await avatarUrl(p.avatar_path), member_since: p.created_at,
    ...(await accountBilling(sql, user, cohort, now)),
  };
};

const PREF_KEYS = ['intros_open', 'cohort_begins', 'daily_content', 'upcoming_calls'];
routes['PUT account'] = async ({ sql, req }) => {
  const user = await requireUser(req);
  await ensureProfile(sql, user);
  const b = H.body(req);
  const name = H.text(b.display_name, { max: 80, field: 'Display name' }) || null;
  let tz = b.timezone ? H.text(b.timezone, { max: 64, field: 'Timezone' }) : null;
  if (tz && !isValidTimeZone(tz)) throw new HttpError(400, 'invalid_input', 'Unknown timezone.');
  const prefs = {};
  for (const k of PREF_KEYS) prefs[k] = !!(b.email_prefs && b.email_prefs[k] === true);
  const rows = await sql`update so_profiles set display_name = ${name}, timezone = ${tz}, email_prefs = ${sql.json(prefs)}, updated_at = now()
                         where user_id = ${user.id} returning display_name, timezone, email_prefs`;
  return rows[0];
};

routes['POST account/avatar-upload'] = async ({ sql, req }) => {
  const user = await requireUser(req);
  await ensureProfile(sql, user);
  const b = H.body(req);
  storage.checkUpload('photo', b.mime_type, b.size);
  await H.rateLimit(sql, `avatar:${user.id}`, 20, 3600);
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[b.mime_type];
  const path = `avatars/${user.id}/${crypto.randomUUID()}.${ext}`;
  return { upload_url: await storage.signedUploadUrl(path), avatar_path: path };
};

routes['PUT account/avatar'] = async ({ sql, req }) => {
  const user = await requireUser(req);
  const prof = await ensureProfile(sql, user);
  const path = H.body(req).avatar_path;
  if (typeof path !== 'string' || !path.startsWith(`avatars/${user.id}/`) || path.includes('..') || path.length > 200) {
    throw new HttpError(400, 'invalid_input', 'Invalid photo.');
  }
  await sql`update so_profiles set avatar_path = ${path}, updated_at = now() where user_id = ${user.id}`;
  if (prof.avatar_path && prof.avatar_path !== path) await storage.removeObjects([prof.avatar_path]);
  return { avatar_url: await avatarUrl(path) };
};

routes['DELETE account/avatar'] = async ({ sql, req }) => {
  const user = await requireUser(req);
  const prof = await ensureProfile(sql, user);
  await sql`update so_profiles set avatar_path = null, updated_at = now() where user_id = ${user.id}`;
  if (prof.avatar_path) await storage.removeObjects([prof.avatar_path]);
  return { avatar_url: null };
};

routes['POST account/refund-request'] = async ({ sql, req, now }) => {
  const user = await requireUser(req);
  await ensureProfile(sql, user);
  const cohort = await C.loadCohort(sql);
  const reason = H.text(H.body(req).reason, { max: 2000, field: 'Reason', multiline: true }) || null;
  const billing = await accountBilling(sql, user, cohort, now);
  if (billing.refund.state === 'requested') return { refund: billing.refund };
  if (!billing.refund.can_request) {
    throw new HttpError(409, 'refund_unavailable', billing.refund.state === 'closed'
      ? 'Refund requests closed when the cohort began.' : 'There’s no payment on this account to refund.');
  }
  await H.rateLimit(sql, `refundreq:${user.id}`, 5, 3600);
  const e = await C.loadEnrollment(sql, user.id, cohort.id);
  await sql.begin(async tx => {
    const th = (await tx`insert into so_support_threads (user_id, cohort_id, category, subject)
                         values (${user.id}, ${cohort.id}, 'billing_refund', 'Refund request') returning id`)[0];
    await tx`insert into so_support_messages (thread_id, author_type, author, body)
             values (${th.id}, 'member', ${user.email}, ${`I’d like to request a refund.${reason ? `\n\n${reason}` : ''}`})`;
    await tx`insert into so_refund_requests (user_id, cohort_id, purchase_id, reason, thread_id)
             values (${user.id}, ${cohort.id}, ${e.purchase_id}, ${reason}, ${th.id})`;
  });
  return { refund: (await accountBilling(sql, user, cohort, now)).refund };
};

routes['DELETE account/refund-request'] = async ({ sql, req, now }) => {
  const user = await requireUser(req);
  const cohort = await C.loadCohort(sql);
  const rows = await sql`update so_refund_requests set status = 'withdrawn', updated_at = now()
                         where user_id = ${user.id} and cohort_id = ${cohort.id} and status = 'open' returning thread_id`;
  for (const r of rows) {
    if (!r.thread_id) continue;
    await sql`insert into so_support_messages (thread_id, author_type, author, body) values (${r.thread_id}, 'member', ${user.email}, 'I’ve withdrawn my refund request.')`;
    await sql`update so_support_threads set status = 'resolved', last_message_at = now(), updated_at = now() where id = ${r.thread_id}`;
  }
  return { refund: (await accountBilling(sql, user, cohort, now)).refund };
};

async function deleteAuthUser(id) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new HttpError(503, 'auth_not_configured', 'Account deletion isn’t available right now.');
  let res;
  try {
    res = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/admin/users/${id}`, {
      method: 'DELETE', headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000),
    });
  } catch { res = null; }
  if (!res || (!res.ok && res.status !== 404)) throw new HttpError(503, 'auth_unreachable', 'We couldn’t delete your account just now. Please try again.');
}

// Members with no payment are removed completely. Members who paid keep their
// payment and enrollment records (needed for tax and refunds); everything
// personal is erased now, access ends, and the team is told in the inbox.
routes['POST account/delete'] = async ({ sql, req }) => {
  const user = await requireUser(req);
  const prof = await ensureProfile(sql, user);
  if (String(H.body(req).confirm || '').trim().toUpperCase() !== 'DELETE') {
    throw new HttpError(400, 'invalid_input', 'Type DELETE to confirm.');
  }
  await H.rateLimit(sql, `delete:${user.id}`, 5, 3600);
  const files = (await sql`select photo_path from so_introductions where user_id = ${user.id} and photo_path is not null`).map(r => r.photo_path);
  if (prof.avatar_path) files.push(prof.avatar_path);
  const paid = (await sql`select 1 from so_purchases where user_id = ${user.id} limit 1`).length > 0;
  if (!paid) {
    await deleteAuthUser(user.id);
  } else {
    await sql.begin(async tx => {
      await tx`delete from so_journal_entries where user_id = ${user.id}`;
      await tx`delete from so_journal_notes where user_id = ${user.id}`;
      await tx`delete from so_introductions where user_id = ${user.id}`;
      await tx`delete from so_day_progress where user_id = ${user.id}`;
      await tx`delete from so_playback where user_id = ${user.id}`;
      await tx`delete from so_call_challenges where user_id = ${user.id}`;
      await tx`update so_profiles set display_name = null, timezone = null, avatar_path = null, email_prefs = '{}'::jsonb,
               deleted_at = now(), updated_at = now() where user_id = ${user.id}`;
      await tx`update so_enrollments set access_state = 'revoked', updated_at = now() where user_id = ${user.id} and access_state = 'active'`;
      const cohort = await C.loadCohort(tx);
      const th = (await tx`insert into so_support_threads (user_id, cohort_id, category, subject)
                           values (${user.id}, ${cohort.id}, 'account_access', 'Account deleted by member') returning id`)[0];
      await tx`insert into so_support_messages (thread_id, author_type, author, body) values (${th.id}, 'member', ${user.email},
               'I deleted my account from My Account. My journal, introduction, progress and photo were erased and my access ended. Payment and enrollment records were kept.')`;
    });
  }
  await storage.removeObjects(files);
  return { deleted: true, mode: paid ? 'erased' : 'removed' };
};

routes['GET faqs'] = async ({ sql, req, now }) => {
  const ctx = await ctxFor(sql, req, now, { requireAccess: false });
  const rows = await sql`select id, question, answer from so_faqs where status = 'published' and audience in ('members', 'both')
                         and (cohort_id is null or cohort_id = ${ctx.cohort.id}) order by sort, question`;
  const content = await C.loadContent(sql);
  return {
    faqs: rows,
    support: {
      email: content.isPublished('support.email') ? content.get('support.email') : null,
      note: content.isPublished('support.note') ? content.get('support.note') : null,
    },
  };
};

// Client-reported funnel events (whitelisted, no free text).
const CLIENT_EVENTS = new Set(['landing_cta_clicked']);
routes['POST events'] = async ({ sql, req }) => {
  const b = H.body(req);
  if (!CLIENT_EVENTS.has(b.name)) throw new HttpError(400, 'invalid_input', 'Unknown event.');
  await H.rateLimit(sql, `event:${H.clientIp(req)}`, 60, 600);
  const user = await getAuthUser(req).catch(() => null);
  await C.recordEvent(sql, b.name, { userId: user ? user.id : null });
  return { ok: true };
};

// Application status for any enrolled member, whatever their review state:
// decision, refund status, receipt and their own submitted answers. No cohort content.
routes['GET application'] = async ({ sql, req, now }) => {
  const user = await requireUser(req);
  await ensureProfile(sql, user);
  const cohort = await C.loadCohort(sql);
  const e = await C.loadEnrollment(sql, user.id, cohort.id);
  const intakeMod = require('./intake');
  const intake = await intakeMod.loadIntake(sql, user.id, cohort.id);
  const p = e && e.purchase_id ? (await sql`select * from so_purchases where id = ${e.purchase_id}`)[0] : null;
  const refund = p ? (await sql`select status, amount_cents, updated_at from so_refund_attempts where purchase_id = ${p.id}
                                order by created_at desc limit 1`)[0] : null;
  const content = await C.loadContent(sql);
  const sched = S.schedule(cohort);
  return {
    enrolled: !!e,
    review_state: e ? e.review_state : null,
    reviewed_at: e ? e.reviewed_at : null,
    review_turnaround: cohort.review_turnaround,
    cohort: { name: cohort.name, start_date: sched.start_date, end_date: sched.end_date, timezone: cohort.timezone },
    intake: intake ? { status: intake.status, submitted_at: intake.submitted_at, version: intake.version, answers: intakeMod.answersOut(intake) } : null,
    payment: p ? { amount_cents: p.amount_paid_cents, currency: p.currency, paid_at: p.paid_at, status: p.status, receipt_url: p.receipt_url, tier: p.price_tier } : null,
    refund: refund ? { status: refund.status, amount_cents: refund.amount_cents, updated_at: refund.updated_at } : null,
    refund_policy: content.get('purchase.refund_policy'),
    support_email: content.isPublished('support.email') ? content.get('support.email') : null,
  };
};

module.exports = { routes, buildDay, calendarDays, homePayload, dayByNumber };
