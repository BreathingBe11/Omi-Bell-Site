'use strict';
// Admin API. Every route calls requireAdmin() first (server-verified role).
// Admin views never include journal text: completion analytics are counts only.

const crypto = require('crypto');
const S = require('./schedule');
const C = require('./core');
const H = require('./http');
const T = require('./time');
const storage = require('./storage');
const stripe = require('./stripe');
const env = require('./env');
const { requireAdmin } = require('./identity');
const { SITE_CONTENT, SITE_CONTENT_KEYS } = require('./content');
const member = require('./member');
const payments = require('./payments');

const { HttpError } = H;
const routes = {};
const admin = (fn, perm = 'settings') => async ctx => { ctx.admin = await requireAdmin(ctx.req, ctx.sql, perm); return fn(ctx); };
// Shared cohort selector (?cohort=<id>); defaults to the active cohort.
async function cohortFor(sql, query) {
  if (query && query.cohort && /^[0-9a-f-]{36}$/i.test(query.cohort)) {
    const c = (await sql`select * from so_cohorts where id = ${query.cohort}`)[0];
    if (c) return c;
  }
  return C.loadCohort(sql);
}

const iso = d => (d ? new Date(d).toISOString() : null);
function localStr(d, tz) {
  if (!d) return null;
  const p = T.localParts(new Date(d), tz);
  const z = n => String(n).padStart(2, '0');
  return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
}
function fromLocal(v, tz, field) {
  if (v === null || v === '' || v === undefined) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(String(v));
  if (!m || !T.isDateStr(m[1]) || !T.isTimeStr(m[2])) throw new HttpError(400, 'invalid_input', `${field} must be a date and time.`);
  return T.zonedToUtc(m[1], m[2], tz);
}

// --------------------------------------------------------------- cohort
function cohortOut(c) {
  const sched = S.schedule(c);
  const tz = c.timezone;
  return {
    id: c.id, name: c.name, start_date: sched.start_date, end_date: sched.end_date, days_count: c.days_count,
    timezone: tz, unlock_time: T.toTimeStr(c.unlock_time),
    intro_opens_at: iso(c.intro_opens_at), intro_opens_local: localStr(c.intro_opens_at, tz),
    enrollment_opens_at: iso(c.enrollment_opens_at), enrollment_opens_local: localStr(c.enrollment_opens_at, tz),
    enrollment_closes_at: iso(c.enrollment_closes_at), enrollment_closes_local: localStr(c.enrollment_closes_at, tz),
    regular_price_cents: c.regular_price_cents, intro_price_cents: c.intro_price_cents,
    price_cutoff_at: iso(c.price_cutoff_at), price_cutoff_local: localStr(c.price_cutoff_at, tz),
    checkout_ttl_minutes: c.checkout_ttl_minutes,
    access_policy: c.access_policy, access_ends_at: iso(c.access_ends_at), access_ends_local: localStr(c.access_ends_at, tz),
    refund_access_action: c.refund_access_action, dispute_access_action: c.dispute_access_action,
    call_join_window_minutes: c.call_join_window_minutes, sales_enabled: c.sales_enabled, seat_limit: c.seat_limit,
    review_turnaround: c.review_turnaround, send_refund_completed_email: c.send_refund_completed_email,
    settings_confirmed_at: iso(c.settings_confirmed_at), settings_confirmed_by: c.settings_confirmed_by,
    schedule: {
      starts_at: sched.starts_at.toISOString(), ends_at: sched.ends_at.toISOString(),
      days: sched.days.map(d => ({ day_number: d.day_number, date: d.date, unlock_at: d.unlock_at.toISOString() })),
    },
  };
}

const TIMING_FIELDS = ['start_date', 'timezone', 'unlock_time', 'intro_opens_at', 'enrollment_opens_at', 'enrollment_closes_at',
  'regular_price_cents', 'intro_price_cents', 'price_cutoff_at', 'checkout_ttl_minutes', 'access_policy', 'access_ends_at', 'days_count', 'seat_limit', 'review_turnaround'];

function parseCohortChanges(current, b) {
  const tz = b.timezone !== undefined ? H.text(b.timezone, { max: 64, field: 'Timezone' }) : current.timezone;
  if (!T.isValidTimeZone(tz)) throw new HttpError(400, 'invalid_input', 'Timezone must be an IANA name such as America/Los_Angeles.');
  const next = { ...current, timezone: tz };
  if (b.name !== undefined) next.name = H.text(b.name, { max: 120, required: true, field: 'Name' });
  if (b.start_date !== undefined) {
    if (!T.isDateStr(b.start_date)) throw new HttpError(400, 'invalid_input', 'Start date must be YYYY-MM-DD.');
    next.start_date = b.start_date;
  }
  if (b.days_count !== undefined) next.days_count = H.int(b.days_count, { min: 1, max: 60, field: 'Days' });
  if (b.unlock_time !== undefined) {
    if (!T.isTimeStr(b.unlock_time)) throw new HttpError(400, 'invalid_input', 'Unlock time must be HH:MM.');
    next.unlock_time = b.unlock_time.slice(0, 5);
  }
  // Local times are interpreted in the (possibly new) cohort timezone.
  const localFields = [
    ['intro_opens_local', 'intro_opens_at', 'Introductions open'],
    ['enrollment_opens_local', 'enrollment_opens_at', 'Enrollment opens'],
    ['enrollment_closes_local', 'enrollment_closes_at', 'Enrollment closes'],
    ['price_cutoff_local', 'price_cutoff_at', 'Price cutoff'],
    ['access_ends_local', 'access_ends_at', 'Access ends'],
  ];
  for (const [lk, col, label] of localFields) if (b[lk] !== undefined) next[col] = fromLocal(b[lk], tz, label);
  if (!next.intro_opens_at) throw new HttpError(400, 'invalid_input', 'Introductions opening time is required.');
  if (b.regular_price_cents !== undefined) next.regular_price_cents = H.int(b.regular_price_cents, { min: 100, max: 10000000, field: 'Regular price' });
  if (b.intro_price_cents !== undefined) next.intro_price_cents = H.int(b.intro_price_cents, { min: 100, max: 10000000, field: 'Intro price', nullable: true });
  if (next.intro_price_cents && next.intro_price_cents >= next.regular_price_cents) throw new HttpError(400, 'invalid_input', 'The introductory price must be lower than the regular price.');
  if (next.intro_price_cents && !next.price_cutoff_at) throw new HttpError(400, 'invalid_input', 'An introductory price needs a cutoff time.');
  if (b.checkout_ttl_minutes !== undefined) next.checkout_ttl_minutes = H.int(b.checkout_ttl_minutes, { min: 30, max: 1440, field: 'Checkout expiry' });
  if (b.access_policy !== undefined) next.access_policy = H.oneOf(b.access_policy, ['unset', 'until_date', 'indefinite'], 'Access policy');
  if (next.access_policy === 'until_date' && !next.access_ends_at) throw new HttpError(400, 'invalid_input', 'Choose when access ends.');
  if (next.access_policy !== 'until_date') next.access_ends_at = null;
  if (b.refund_access_action !== undefined) next.refund_access_action = H.oneOf(b.refund_access_action, ['suspend', 'keep'], 'Refund action');
  if (b.dispute_access_action !== undefined) next.dispute_access_action = H.oneOf(b.dispute_access_action, ['suspend', 'keep'], 'Dispute action');
  if (b.call_join_window_minutes !== undefined) next.call_join_window_minutes = H.int(b.call_join_window_minutes, { min: 0, max: 240, field: 'Join window' });
  if (b.sales_enabled !== undefined) next.sales_enabled = b.sales_enabled === true;
  if (b.review_turnaround !== undefined) next.review_turnaround = H.text(b.review_turnaround, { max: 200, required: true, field: 'Review turnaround' });
  if (b.send_refund_completed_email !== undefined) next.send_refund_completed_email = b.send_refund_completed_email === true;
  if (b.seat_limit !== undefined) next.seat_limit = H.int(b.seat_limit, { min: 1, max: 10000, field: 'Seat limit', nullable: true });
  return next;
}

function changedTiming(a, b) {
  const norm = (k, v) => {
    if (v === null || v === undefined) return null;
    if (k === 'start_date') return T.toDateStr(v);
    if (k === 'unlock_time') return T.toTimeStr(v);
    if (v instanceof Date || /_at$/.test(k)) return new Date(v).toISOString();
    return String(v);
  };
  return TIMING_FIELDS.filter(k => norm(k, a[k]) !== norm(k, b[k]));
}

routes['GET admin/cohort'] = admin(async ({ query, sql }) => {
  const c = await cohortFor(sql, query);
  return { cohort: cohortOut(c), weeks: await C.loadWeeks(sql, c.id), stripe_mode: env.stripeMode() };
}, 'view');

async function impact(sql, before, after, now) {
  const a = cohortOut(before), b = cohortOut(after);
  const enrolled = (await sql`select count(*)::int as n from so_enrollments where cohort_id = ${before.id} and access_state = 'active'`)[0].n;
  const fmt = (label, x, y) => ({ label, before: x, after: y, changed: x !== y });
  const pa = S.priceAt(before, now), pb = S.priceAt(after, now);
  return {
    enrolled_members: enrolled,
    rows: [
      fmt('Day 1 unlocks (UTC)', a.schedule.days[0].unlock_at, b.schedule.days[0].unlock_at),
      fmt(`Final day unlocks (UTC)`, a.schedule.days.at(-1).unlock_at, b.schedule.days.at(-1).unlock_at),
      fmt('Cohort ends (UTC)', a.schedule.ends_at, b.schedule.ends_at),
      fmt('Introductions open (UTC)', a.intro_opens_at, b.intro_opens_at),
      fmt('Intro price ends (UTC)', a.price_cutoff_at, b.price_cutoff_at),
      fmt('Enrollment closes (UTC)', a.enrollment_closes_at || a.schedule.ends_at, b.enrollment_closes_at || b.schedule.ends_at),
      fmt('Current phase', S.phase(before, now), S.phase(after, now)),
      fmt('Days unlocked right now', String(S.unlockedThrough(before, now)), String(S.unlockedThrough(after, now))),
      fmt('Price charged right now', `$${pa.amount_cents / 100}`, `$${pb.amount_cents / 100}`),
      fmt('Access policy', a.access_policy, b.access_policy),
    ],
    notes: [
      'Existing journal entries keep the question they answered.',
      'Checkout sessions already open keep their quoted price until they expire.',
      enrolled ? `${enrolled} enrolled member(s) will see the new schedule immediately.` : 'No members are enrolled yet.',
    ],
  };
}

routes['POST admin/cohort/preview'] = admin(async ({ query, sql, req, now }) => {
  const before = await cohortFor(sql, query);
  const after = parseCohortChanges(before, H.body(req));
  return { impact: await impact(sql, before, after, now), cohort: cohortOut(after) };
});

routes['PUT admin/cohort'] = admin(async ({ query, sql, req, admin: who, now }) => {
  const before = await cohortFor(sql, query);
  const b = H.body(req);
  const after = parseCohortChanges(before, b);
  const timing = changedTiming(before, after);
  let confirmedAt = before.settings_confirmed_at, confirmedBy = before.settings_confirmed_by;
  if (timing.length) { confirmedAt = null; confirmedBy = null; }
  if (b.confirm_settings === true) { confirmedAt = now; confirmedBy = who.actor; }
  if (b.confirm_settings === false) { confirmedAt = null; confirmedBy = null; }
  const rows = await sql`
    update so_cohorts set name = ${after.name}, start_date = ${T.toDateStr(after.start_date)}, days_count = ${after.days_count},
      timezone = ${after.timezone}, unlock_time = ${T.toTimeStr(after.unlock_time)},
      intro_opens_at = ${after.intro_opens_at}, enrollment_opens_at = ${after.enrollment_opens_at},
      enrollment_closes_at = ${after.enrollment_closes_at}, regular_price_cents = ${after.regular_price_cents},
      intro_price_cents = ${after.intro_price_cents}, price_cutoff_at = ${after.price_cutoff_at},
      checkout_ttl_minutes = ${after.checkout_ttl_minutes}, access_policy = ${after.access_policy},
      access_ends_at = ${after.access_ends_at}, refund_access_action = ${after.refund_access_action},
      dispute_access_action = ${after.dispute_access_action}, call_join_window_minutes = ${after.call_join_window_minutes},
      sales_enabled = ${after.sales_enabled}, seat_limit = ${after.seat_limit},
      review_turnaround = ${after.review_turnaround}, send_refund_completed_email = ${after.send_refund_completed_email}, settings_confirmed_at = ${confirmedAt}, settings_confirmed_by = ${confirmedBy},
      updated_at = now()
    where id = ${before.id} returning *`;
  await C.audit(sql, who.actor, 'cohort_updated', 'cohort', before.id, cohortOut(before), cohortOut(rows[0]));
  return { cohort: cohortOut(rows[0]), timing_changed: timing };
});

routes['PUT admin/weeks/:n'] = admin(async ({ query, sql, req, params, admin: who }) => {
  const c = await cohortFor(sql, query);
  const n = H.int(params.n, { min: 1, max: 9, field: 'week' });
  const b = H.body(req);
  const pillar = H.oneOf(b.pillar, ['standards', 'systems', 'scorecards'], 'Pillar');
  const title = H.text(b.title, { max: 120, required: true, field: 'Title' });
  const assignment = H.text(b.assignment, { max: 600, field: 'Assignment', multiline: true }) || null;
  const rows = await sql`insert into so_weeks (cohort_id, week_number, pillar, title, assignment) values (${c.id}, ${n}, ${pillar}, ${title}, ${assignment})
                         on conflict (cohort_id, week_number) do update set pillar = excluded.pillar, title = excluded.title, assignment = excluded.assignment
                         returning *`;
  await C.audit(sql, who.actor, 'week_updated', 'week', n, null, rows[0]);
  return { week: rows[0] };
});

// ------------------------------------------------------------ overview
routes['GET admin/overview'] = admin(async ({ query, sql, now }) => {
  const cohort = await cohortFor(sql, query);
  const content = await C.loadContent(sql);
  const sales = await C.salesReadiness(sql, cohort, content, now);
  const sched = S.schedule(cohort);
  const days = await sql`select * from so_days where cohort_id = ${cohort.id} order by day_number`;
  const resources = await C.loadResourcesWithDays(sql, cohort.id);
  const rmap = new Map(resources.map(r => [r.id, r]));
  const links = await sql`select dr.* from so_day_resources dr join so_days d on d.id = dr.day_id where d.cohort_id = ${cohort.id}`;
  const completion = await sql`select d.day_number, count(p.completed_at)::int as completed, count(p.started_at)::int as started
                               from so_days d left join so_day_progress p on p.day_id = d.id
                               where d.cohort_id = ${cohort.id} group by d.day_number order by d.day_number`;
  const cmap = new Map(completion.map(r => [r.day_number, r]));
  const dayRows = days.map(d => {
    const unlock = sched.days[d.day_number - 1];
    const issues = C.dayReadiness(d, links.filter(l => l.day_id === d.id), rmap);
    const msToUnlock = unlock ? unlock.unlock_at.getTime() - now.getTime() : null;
    return {
      day_number: d.day_number, title: d.title, status: d.status, is_sample: d.is_sample,
      unlock_at: unlock ? unlock.unlock_at.toISOString() : null,
      state: C.dayState(cohort, d, now),
      issues,
      alert: issues.length > 0 && msToUnlock !== null && msToUnlock < 7 * 86400000,
      completed: (cmap.get(d.day_number) || {}).completed || 0,
      started: (cmap.get(d.day_number) || {}).started || 0,
    };
  });
  const enroll = await sql`select access_state, is_test, count(*)::int as n from so_enrollments where cohort_id = ${cohort.id} group by 1, 2`;
  const purchases = await sql`select status, count(*)::int as n from so_purchases where cohort_id = ${cohort.id} group by 1`;
  const review = await sql`select count(*)::int as n from so_purchases where cohort_id = ${cohort.id} and needs_review is not null`;
  const failedHooks = await sql`select count(*)::int as n from so_webhook_events where status = 'failed'`;
  const events = await sql`select name, count(*)::int as n from so_events where cohort_id = ${cohort.id} or cohort_id is null group by 1`;
  const revenue = await sql`select coalesce(sum(amount_paid_cents), 0)::int as cents from so_purchases
                            where cohort_id = ${cohort.id} and status in ('paid', 'partially_refunded') and livemode`;
  const unpublishedResources = resources.filter(r => r.links.length && r.status !== 'published').length;
  const sampleResources = resources.filter(r => r.is_sample).length;
  return {
    now: now.toISOString(),
    phase: S.phase(cohort, now),
    current_day: S.currentDay(cohort, now),
    price: S.priceAt(cohort, now),
    sales,
    config: {
      database: true,
      supabase_auth: env.supabaseConfigured(),
      storage: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
      stripe_mode: env.stripeMode(),
      stripe_webhook: !!process.env.STRIPE_WEBHOOK_SECRET,
      email_mode: env.emailMode(),
      resend: !!process.env.RESEND_API_KEY,
      test_checkout_allowed: env.testCheckoutAllowed(),
      production_deploy: env.isProductionDeploy(),
    },
    content_release: {
      days: dayRows,
      unpublished_linked_resources: unpublishedResources,
      sample_resources: sampleResources,
      calls_scheduled: (await sql`select count(*)::int as n from so_calls where cohort_id = ${cohort.id} and status = 'scheduled'`)[0].n,
    },
    enrollments: enroll,
    purchases,
    needs_review: review[0].n,
    failed_webhooks: failedHooks[0].n,
    funnel: Object.fromEntries(events.map(e => [e.name, e.n])),
    live_revenue_cents: revenue[0].cents,
    seats: { limit: cohort.seat_limit, taken: await payments.seatsTaken(sql, cohort, now) },
    pending_reviews: (await sql`select count(*)::int as n from so_enrollments where cohort_id = ${cohort.id}
                                and access_state = 'active' and review_state = 'pending'`)[0].n,
  };
});

// ---------------------------------------------------------------- days
function dayAdminOut(d, links, tz) {
  return { ...d, links: links || [], publish_local: tz ? localStr(d.publish_at, tz) : null };
}

routes['GET admin/days'] = admin(async ({ query, sql }) => {
  const c = await cohortFor(sql, query);
  const days = await sql`select * from so_days where cohort_id = ${c.id} order by day_number`;
  const links = await sql`select dr.*, r.title, r.kind from so_day_resources dr join so_resources r on r.id = dr.resource_id
                          join so_days d on d.id = dr.day_id where d.cohort_id = ${c.id} order by dr.sort`;
  return { days: days.map(d => dayAdminOut(d, links.filter(l => l.day_id === d.id))) };
});

routes['GET admin/days/:n'] = admin(async ({ query, sql, params }) => {
  const c = await cohortFor(sql, query);
  const d = await member.dayByNumber(sql, c, params.n);
  const links = await sql`select dr.*, r.title, r.kind from so_day_resources dr join so_resources r on r.id = dr.resource_id where dr.day_id = ${d.id} order by dr.sort`;
  return { day: dayAdminOut(d, links, c.timezone) };
});

routes['PUT admin/days/:n'] = admin(async ({ query, sql, req, params, admin: who }) => {
  const c = await cohortFor(sql, query);
  const d = await member.dayByNumber(sql, c, params.n);
  const b = H.body(req);
  const v = {
    title: H.text(b.title ?? d.title, { max: 160, required: true, field: 'Title' }),
    preview_summary: H.text(b.preview_summary ?? d.preview_summary, { max: 400, field: 'Preview summary', multiline: true }) || null,
    purpose: H.text(b.purpose ?? d.purpose, { max: 300, field: 'Purpose' }) || null,
    content: H.text(b.content ?? d.content, { max: 20000, field: 'Content', multiline: true }) || null,
    reflection_prompt: H.text(b.reflection_prompt ?? d.reflection_prompt, { max: 600, field: 'Reflection', multiline: true }) || null,
    action_title: H.text(b.action_title ?? d.action_title, { max: 200, field: 'Action title' }) || null,
    action_body: H.text(b.action_body ?? d.action_body, { max: 4000, field: 'Action', multiline: true }) || null,
  };
  const previewPublished = b.preview_published === undefined ? d.preview_published : b.preview_published === true;
  const publishAt = b.publish_local !== undefined ? fromLocal(b.publish_local, c.timezone, 'Scheduled publish time') : d.publish_at;
  const isSample = b.is_sample === undefined ? d.is_sample : b.is_sample === true;
  const status = b.status === undefined ? d.status : H.oneOf(b.status, ['draft', 'published'], 'Status');
  if (status === 'published') {
    if (isSample) throw new HttpError(400, 'not_final', 'Mark this day’s content as reviewed and final before publishing it to members.');
    if (!v.reflection_prompt || !(v.action_title || v.action_body)) throw new HttpError(400, 'incomplete', 'A published day needs a reflection question and a practical action.');
  }
  // A changed question gets a new version; existing journal entries keep the original.
  const promptChanged = (v.reflection_prompt || '') !== (d.reflection_prompt || '');

  const updated = await sql.begin(async tx => {
    const rows = await tx`
      update so_days set title = ${v.title}, preview_summary = ${v.preview_summary}, purpose = ${v.purpose}, content = ${v.content},
        reflection_prompt = ${v.reflection_prompt}, prompt_version = prompt_version + ${promptChanged ? 1 : 0},
        action_title = ${v.action_title}, action_body = ${v.action_body}, preview_published = ${previewPublished},
        is_sample = ${isSample}, status = ${status}, publish_at = ${publishAt},
        published_at = case when ${status} = 'published' then coalesce(published_at, now()) else null end,
        updated_at = now()
      where id = ${d.id} returning *`;
    if (b.links !== undefined) {
      if (!Array.isArray(b.links) || b.links.length > 20) throw new HttpError(400, 'invalid_input', 'Invalid resource links.');
      await tx`delete from so_day_resources where day_id = ${d.id}`;
      let practiceSeen = false;
      for (const [i, l] of b.links.entries()) {
        const rid = H.uuid(l.resource_id, 'resource');
        const role = H.oneOf(l.role, ['practice', 'template', 'supporting'], 'Role');
        if (role === 'practice') { if (practiceSeen) throw new HttpError(400, 'invalid_input', 'Only one guided practice per day.'); practiceSeen = true; }
        const r = (await tx`select kind from so_resources where id = ${rid} and cohort_id = ${c.id}`)[0];
        if (!r) throw new HttpError(400, 'invalid_input', 'Unknown resource.');
        if (role === 'practice' && r.kind !== 'practice') throw new HttpError(400, 'invalid_input', 'The guided practice must be a practice resource.');
        await tx`insert into so_day_resources (day_id, resource_id, role, sort) values (${d.id}, ${rid}, ${role}, ${i})`;
      }
    }
    return rows[0];
  });
  if (d.status !== updated.status || promptChanged) {
    await C.audit(sql, who.actor, d.status !== updated.status ? `day_${updated.status}` : 'day_prompt_changed', 'day', d.day_number,
      { status: d.status, prompt_version: d.prompt_version }, { status: updated.status, prompt_version: updated.prompt_version });
  }
  const links = await sql`select dr.*, r.title, r.kind from so_day_resources dr join so_resources r on r.id = dr.resource_id where dr.day_id = ${d.id} order by dr.sort`;
  return { day: dayAdminOut(updated, links, c.timezone) };
});

// ----------------------------------------------------------- resources
function resourceAdminOut(r) {
  const { storage_path, ...rest } = r;
  return { ...rest, has_file: !!storage_path, file_kind: C.fileKind(r) };
}

routes['GET admin/resources'] = admin(async ({ query, sql }) => {
  const c = await cohortFor(sql, query);
  const all = await C.loadResourcesWithDays(sql, c.id);
  return { resources: all.map(r => ({ ...resourceAdminOut(r), links: r.links.map(l => ({ day_number: l.day_number, role: l.role })) })) };
});

function parseResource(b, current = {}) {
  const pick = k => (b[k] !== undefined ? b[k] : current[k]);
  const out = {
    kind: H.oneOf(pick('kind'), ['template', 'practice', 'replay', 'other'], 'Type'),
    title: H.text(pick('title'), { max: 160, required: true, field: 'Title' }),
    purpose: H.text(pick('purpose'), { max: 300, field: 'Purpose' }) || null,
    description: H.text(pick('description'), { max: 2000, field: 'Description', multiline: true }) || null,
    pillar: pick('pillar') ? H.oneOf(pick('pillar'), ['standards', 'systems', 'scorecards'], 'Pillar') : null,
    source_type: H.oneOf(pick('source_type') || 'file', ['file', 'link'], 'Source'),
    external_url: H.optionalUrl(pick('external_url'), { field: 'Link' }),
    practice_type: pick('practice_type') ? H.oneOf(pick('practice_type'), ['breathwork', 'meditation', 'sound_healing'], 'Practice type') : null,
    duration_seconds: H.int(pick('duration_seconds'), { min: 0, max: 6 * 3600, field: 'Duration', nullable: true }),
    transcript: H.text(pick('transcript'), { max: 100000, field: 'Transcript', multiline: true }) || null,
    release_mode: H.oneOf(pick('release_mode') || 'with_day', ['with_day', 'at_time', 'immediately'], 'Release'),
    release_at: b.release_at !== undefined ? H.isoDate(b.release_at, { field: 'Release time', nullable: true }) : (current.release_at || null),
    status: H.oneOf(pick('status') || 'draft', ['draft', 'published'], 'Status'),
    is_sample: pick('is_sample') === true,
  };
  if (out.release_mode === 'at_time' && !out.release_at) throw new HttpError(400, 'invalid_input', 'Choose a release time.');
  if (out.status === 'published') {
    if (out.is_sample) throw new HttpError(400, 'not_final', 'Sample placeholders cannot be published to members.');
    if (out.source_type === 'link' && !out.external_url) throw new HttpError(400, 'incomplete', 'Add the link before publishing.');
    if (out.source_type === 'file' && !current.storage_path) throw new HttpError(400, 'incomplete', 'Upload the file before publishing.');
    if (out.kind === 'practice' && !out.transcript) throw new HttpError(400, 'incomplete', 'Published practices need a transcript.');
  }
  return out;
}

routes['POST admin/resources'] = admin(async ({ query, sql, req, admin: who }) => {
  const c = await cohortFor(sql, query);
  const v = parseResource({ ...H.body(req), status: 'draft' });
  const rows = await sql`insert into so_resources ${sql({ ...v, cohort_id: c.id })} returning *`;
  await C.audit(sql, who.actor, 'resource_created', 'resource', rows[0].id, null, { title: v.title, kind: v.kind });
  return { resource: resourceAdminOut(rows[0]) };
});

routes['PUT admin/resources/:id'] = admin(async ({ query, sql, req, params, admin: who }) => {
  const c = await cohortFor(sql, query);
  const id = H.uuid(params.id, 'resource');
  const cur = (await sql`select * from so_resources where id = ${id} and cohort_id = ${c.id}`)[0];
  if (!cur) throw new HttpError(404, 'not_found', 'Unknown resource.');
  const v = parseResource(H.body(req), cur);
  const rows = await sql`update so_resources set ${sql({ ...v, updated_at: new Date() })} where id = ${id} returning *`;
  if (cur.status !== v.status) await C.audit(sql, who.actor, `resource_${v.status}`, 'resource', id, null, { title: v.title });
  return { resource: resourceAdminOut(rows[0]) };
});

routes['DELETE admin/resources/:id'] = admin(async ({ query, sql, params, admin: who }) => {
  const c = await cohortFor(sql, query);
  const id = H.uuid(params.id, 'resource');
  const rows = await sql`delete from so_resources where id = ${id} and cohort_id = ${c.id} returning storage_path, title`;
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Unknown resource.');
  if (rows[0].storage_path) await storage.removeObjects([rows[0].storage_path]);
  await C.audit(sql, who.actor, 'resource_deleted', 'resource', id, { title: rows[0].title }, null);
  return { ok: true };
});

// Upload: the server issues a signed upload URL for a path it chooses; the
// browser PUTs the file straight to private storage, then confirms here.
routes['POST admin/resources/:id/upload-url'] = admin(async ({ query, sql, req, params }) => {
  const c = await cohortFor(sql, query);
  const id = H.uuid(params.id, 'resource');
  const r = (await sql`select * from so_resources where id = ${id} and cohort_id = ${c.id}`)[0];
  if (!r) throw new HttpError(404, 'not_found', 'Unknown resource.');
  const b = H.body(req);
  storage.checkUpload(r.kind, b.mime_type, b.size);
  const path = `resources/${id}/v${r.version + 1}-${crypto.randomUUID().slice(0, 8)}-${storage.safeFileName(b.file_name)}`;
  return { upload_url: await storage.signedUploadUrl(path), storage_path: path };
});

routes['POST admin/resources/:id/file'] = admin(async ({ query, sql, req, params, admin: who }) => {
  const c = await cohortFor(sql, query);
  const id = H.uuid(params.id, 'resource');
  const r = (await sql`select * from so_resources where id = ${id} and cohort_id = ${c.id}`)[0];
  if (!r) throw new HttpError(404, 'not_found', 'Unknown resource.');
  const b = H.body(req);
  if (typeof b.storage_path !== 'string' || !b.storage_path.startsWith(`resources/${id}/`) || b.storage_path.includes('..')) {
    throw new HttpError(400, 'invalid_input', 'Invalid upload.');
  }
  storage.checkUpload(r.kind, b.mime_type, b.size);
  const rows = await sql`update so_resources set storage_path = ${b.storage_path}, file_name = ${storage.safeFileName(b.file_name)},
                         mime_type = ${b.mime_type}, file_size = ${b.size}, source_type = 'file', version = version + 1, updated_at = now()
                         where id = ${id} returning *`;
  // Same resource id, new file: every day link keeps pointing at it.
  if (r.storage_path && r.storage_path !== b.storage_path) await storage.removeObjects([r.storage_path]);
  await C.audit(sql, who.actor, 'resource_file_replaced', 'resource', id, { version: r.version }, { version: rows[0].version });
  return { resource: resourceAdminOut(rows[0]) };
});

routes['GET admin/resources/:id/access'] = admin(async ({ query, sql, params }) => {
  const c = await cohortFor(sql, query);
  const id = H.uuid(params.id, 'resource');
  const r = (await sql`select * from so_resources where id = ${id} and cohort_id = ${c.id}`)[0];
  if (!r) throw new HttpError(404, 'not_found', 'Unknown resource.');
  if (r.source_type === 'link') return { url: r.external_url };
  if (!r.storage_path) throw new HttpError(404, 'not_found', 'No file uploaded.');
  return { url: await storage.signedDownloadUrl(r.storage_path, 300) };
});

// -------------------------------------------------------------- calls
function parseCall(b, cohortTz) {
  const startsAt = b.starts_local ? fromLocal(b.starts_local, cohortTz, 'Start time') : H.isoDate(b.starts_at, { field: 'Start time' });
  return {
    title: H.text(b.title || 'Solutions Seat', { max: 160, required: true, field: 'Title' }),
    description: H.text(b.description, { max: 2000, field: 'Description', multiline: true }) || null,
    starts_at: startsAt,
    duration_minutes: H.int(b.duration_minutes ?? 60, { min: 5, max: 480, field: 'Duration' }),
    meeting_url: H.optionalUrl(b.meeting_url, { field: 'Meeting link' }),
    join_window_minutes: H.int(b.join_window_minutes, { min: 0, max: 240, field: 'Join window', nullable: true }),
    replay_resource_id: b.replay_resource_id ? H.uuid(b.replay_resource_id, 'replay') : null,
    replay_published: b.replay_published === true,
    status: H.oneOf(b.status || 'draft', ['draft', 'scheduled', 'canceled'], 'Status'),
  };
}

routes['GET admin/calls'] = admin(async ({ query, sql }) => {
  const c = await cohortFor(sql, query);
  const calls = await sql`select * from so_calls where cohort_id = ${c.id} order by starts_at`;
  return { calls: calls.map(x => ({ ...x, starts_local: localStr(x.starts_at, c.timezone) })), timezone: c.timezone };
}, 'view');

routes['POST admin/calls'] = admin(async ({ query, sql, req, admin: who }) => {
  const c = await cohortFor(sql, query);
  const v = parseCall(H.body(req), c.timezone);
  if (v.replay_published && !v.replay_resource_id) throw new HttpError(400, 'invalid_input', 'Choose the replay before publishing it.');
  const rows = await sql`insert into so_calls ${sql({ ...v, cohort_id: c.id })} returning *`;
  await C.audit(sql, who.actor, 'call_created', 'call', rows[0].id, null, { starts_at: v.starts_at, status: v.status });
  return { call: rows[0] };
});

routes['PUT admin/calls/:id'] = admin(async ({ query, sql, req, params, admin: who }) => {
  const c = await cohortFor(sql, query);
  const id = H.uuid(params.id, 'call');
  const cur = (await sql`select * from so_calls where id = ${id} and cohort_id = ${c.id}`)[0];
  if (!cur) throw new HttpError(404, 'not_found', 'Unknown call.');
  const v = parseCall(H.body(req), c.timezone);
  if (v.replay_published && !v.replay_resource_id) throw new HttpError(400, 'invalid_input', 'Choose the replay before publishing it.');
  const rows = await sql`update so_calls set ${sql({ ...v, updated_at: new Date() })} where id = ${id} returning *`;
  await C.audit(sql, who.actor, 'call_updated', 'call', id, { starts_at: cur.starts_at, status: cur.status }, { starts_at: v.starts_at, status: v.status });
  return { call: rows[0] };
});

routes['DELETE admin/calls/:id'] = admin(async ({ query, sql, params, admin: who }) => {
  const c = await cohortFor(sql, query);
  const id = H.uuid(params.id, 'call');
  const rows = await sql`delete from so_calls where id = ${id} and cohort_id = ${c.id} returning id`;
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Unknown call.');
  await C.audit(sql, who.actor, 'call_deleted', 'call', id, null, null);
  return { ok: true };
});

// ------------------------------------------------------ introductions
routes['GET admin/introductions'] = admin(async ({ query, sql }) => {
  const c = await cohortFor(sql, query);
  const rows = await sql`select i.*, p.email from so_introductions i join so_profiles p on p.user_id = i.user_id
                         where i.cohort_id = ${c.id} order by i.created_at`;
  const out = [];
  for (const r of rows) {
    let photo = null;
    if (r.photo_path) { try { photo = await storage.signedDownloadUrl(r.photo_path, 600); } catch { photo = null; } }
    const { photo_path, ...rest } = r;
    out.push({ ...rest, photo_url: photo });
  }
  return { introductions: out };
});

routes['PUT admin/introductions/:id'] = admin(async ({ query, sql, req, params, admin: who }) => {
  const id = H.uuid(params.id, 'introduction');
  const state = H.oneOf(H.body(req).moderation_state, ['visible', 'hidden'], 'Visibility');
  const rows = await sql`update so_introductions set moderation_state = ${state}, updated_at = now() where id = ${id} returning id, moderation_state`;
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Unknown introduction.');
  await C.audit(sql, who.actor, `introduction_${state}`, 'introduction', id, null, null);
  return { introduction: rows[0] };
});

routes['DELETE admin/introductions/:id'] = admin(async ({ query, sql, params, admin: who }) => {
  const id = H.uuid(params.id, 'introduction');
  const rows = await sql`delete from so_introductions where id = ${id} returning photo_path`;
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Unknown introduction.');
  if (rows[0].photo_path) await storage.removeObjects([rows[0].photo_path]);
  await C.audit(sql, who.actor, 'introduction_deleted', 'introduction', id, null, null);
  return { ok: true };
});

// --------------------------------------------------- enrollments/payments
routes['GET admin/enrollments'] = admin(async ({ query, sql }) => {
  const c = await cohortFor(sql, query);
  // Counts only. Journal text is never selected here.
  const rows = await sql`
    select e.id, e.user_id, e.access_state, e.source, e.is_test, e.activated_at, e.access_ends_at, e.admin_note,
           e.confirmation_email_sent_at, p.email, p.display_name,
           pu.status as purchase_status, pu.amount_cents, pu.amount_paid_cents, pu.price_tier, pu.needs_review, pu.livemode,
           (select count(*)::int from so_day_progress dp where dp.user_id = e.user_id and dp.cohort_id = e.cohort_id and dp.completed_at is not null) as days_completed,
           exists (select 1 from so_introductions i where i.user_id = e.user_id and i.cohort_id = e.cohort_id) as has_intro
    from so_enrollments e join so_profiles p on p.user_id = e.user_id
    left join so_purchases pu on pu.id = e.purchase_id
    where e.cohort_id = ${c.id} order by e.activated_at desc`;
  return { enrollments: rows };
}, 'finance');

routes['GET admin/purchases'] = admin(async ({ query, sql }) => {
  const c = await cohortFor(sql, query);
  const rows = await sql`
    select pu.id, pu.status, pu.price_tier, pu.amount_cents, pu.amount_paid_cents, pu.currency, pu.quoted_at, pu.expires_at,
           pu.paid_at, pu.refunded_at, pu.livemode, pu.needs_review, pu.created_at,
           (pu.stripe_session_id is not null) as has_session, p.email
    from so_purchases pu join so_profiles p on p.user_id = pu.user_id
    where pu.cohort_id = ${c.id} order by pu.created_at desc limit 500`;
  return { purchases: rows };
}, 'finance');

routes['POST admin/purchases/:id/reconcile'] = admin(async ({ query, sql, params, admin: who }) => {
  const id = H.uuid(params.id, 'purchase');
  const p = (await sql`select * from so_purchases where id = ${id}`)[0];
  if (!p) throw new HttpError(404, 'not_found', 'Unknown purchase.');
  if (!p.stripe_session_id) throw new HttpError(409, 'no_session', 'This purchase never reached the payment provider.');
  const session = await stripe.retrieveCheckoutSession(p.stripe_session_id);
  const r = await payments.applySession(sql, session);
  const after = (await sql`select status from so_purchases where id = ${id}`)[0];
  await C.audit(sql, who.actor, 'purchase_reconciled', 'purchase', id, { status: p.status }, { status: after.status });
  return { status: after.status, provider: { status: session.status, payment_status: session.payment_status }, result: r.state || null };
}, 'finance');

routes['PUT admin/enrollments/:id'] = admin(async ({ query, sql, req, params, admin: who }) => {
  const c = await cohortFor(sql, query);
  const id = H.uuid(params.id, 'enrollment');
  const cur = (await sql`select * from so_enrollments where id = ${id} and cohort_id = ${c.id}`)[0];
  if (!cur) throw new HttpError(404, 'not_found', 'Unknown enrollment.');
  const b = H.body(req);
  const state = b.access_state !== undefined ? H.oneOf(b.access_state, ['active', 'suspended', 'refunded', 'disputed', 'revoked'], 'Access') : cur.access_state;
  const ends = b.access_ends_local !== undefined ? fromLocal(b.access_ends_local, c.timezone, 'Access ends') : cur.access_ends_at;
  const note = b.admin_note !== undefined ? (H.text(b.admin_note, { max: 500, field: 'Note', multiline: true }) || null) : cur.admin_note;
  const rows = await sql`update so_enrollments set access_state = ${state}, access_ends_at = ${ends}, admin_note = ${note}, updated_at = now()
                         where id = ${id} returning *`;
  await C.audit(sql, who.actor, 'enrollment_updated', 'enrollment', id,
    { access_state: cur.access_state, access_ends_at: cur.access_ends_at }, { access_state: state, access_ends_at: ends });
  return { enrollment: rows[0] };
});

routes['POST admin/enrollments/manual'] = admin(async ({ query, sql, req, admin: who }) => {
  const c = await cohortFor(sql, query);
  const b = H.body(req);
  const email = H.text(b.email, { max: 200, required: true, field: 'Email' }).toLowerCase();
  const note = H.text(b.note, { max: 500, required: true, field: 'Reason', multiline: true });
  const p = (await sql`select user_id from so_profiles where email = ${email}`)[0];
  if (!p) throw new HttpError(404, 'no_account', 'That person needs to sign in once (at /smoothoperators/login) before access can be granted.');
  // Granting access by hand is itself the approval.
  const rows = await sql`insert into so_enrollments (user_id, cohort_id, source, access_state, admin_note, review_state, reviewed_at, reviewed_by)
                         values (${p.user_id}, ${c.id}, 'manual', 'active', ${note}, 'approved', now(), ${who.actor})
                         on conflict (user_id, cohort_id) do update set access_state = 'active', admin_note = excluded.admin_note,
                           review_state = 'approved', reviewed_at = now(), reviewed_by = excluded.reviewed_by, updated_at = now()
                         returning *`;
  await C.audit(sql, who.actor, 'enrollment_granted_manually', 'enrollment', rows[0].id, null, { email, note });
  return { enrollment: rows[0] };
});

// -------------------------------------------------------- site content
routes['GET admin/content'] = admin(async ({ query, sql }) => {
  const rows = await sql`select * from so_site_content`;
  const map = new Map(rows.map(r => [r.key, r]));
  return {
    content: SITE_CONTENT.map(c => {
      const r = map.get(c.key);
      return { ...c, value: r ? r.value : null, status: r ? r.status : null, updated_at: r ? r.updated_at : null, updated_by: r ? r.updated_by : null };
    }),
  };
});

routes['PUT admin/content/:key'] = admin(async ({ query, sql, req, params, admin: who }) => {
  const key = String(params.key);
  if (!SITE_CONTENT_KEYS.has(key)) throw new HttpError(404, 'not_found', 'Unknown content key.');
  const def = SITE_CONTENT.find(c => c.key === key);
  const b = H.body(req);
  let value = H.text(b.value, { max: 60000, field: def.label, multiline: true });
  const status = H.oneOf(b.status, ['draft', 'published'], 'Status');
  if (key === 'support.email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new HttpError(400, 'invalid_input', 'Enter a valid email address.');
  if (key === 'about.photo_url' && value) value = H.optionalUrl(value, { field: 'Photo URL', allowRelative: true });
  if (status === 'published' && !value && def.default === '') throw new HttpError(400, 'invalid_input', 'Write the text before publishing it.');
  const before = (await sql`select value, status from so_site_content where key = ${key}`)[0] || null;
  const rows = await sql`insert into so_site_content (key, value, status, updated_by) values (${key}, ${value}, ${status}, ${who.actor})
                         on conflict (key) do update set value = excluded.value, status = excluded.status, updated_at = now(), updated_by = excluded.updated_by
                         returning *`;
  await C.audit(sql, who.actor, 'content_updated', 'content', key, before, { status, length: value.length });
  return { content: rows[0] };
});

routes['DELETE admin/content/:key'] = admin(async ({ query, sql, params, admin: who }) => {
  const key = String(params.key);
  if (!SITE_CONTENT_KEYS.has(key)) throw new HttpError(404, 'not_found', 'Unknown content key.');
  await sql`delete from so_site_content where key = ${key}`;
  await C.audit(sql, who.actor, 'content_reset', 'content', key, null, null);
  return { ok: true };
});

// ----------------------------------------------------------------- FAQs
function parseFaq(b) {
  const v = {
    question: H.text(b.question, { max: 300, required: true, field: 'Question' }),
    answer: H.text(b.answer, { max: 4000, field: 'Answer', multiline: true }),
    sort: H.int(b.sort ?? 0, { min: -1000, max: 1000, field: 'Order' }),
    audience: H.oneOf(b.audience || 'both', ['public', 'members', 'both'], 'Audience'),
    status: H.oneOf(b.status || 'draft', ['draft', 'published'], 'Status'),
  };
  if (v.status === 'published' && !v.answer) throw new HttpError(400, 'invalid_input', 'Add an approved answer before publishing.');
  return v;
}
routes['GET admin/faqs'] = admin(async ({ query, sql }) => ({ faqs: await sql`select * from so_faqs order by sort, question` }));
routes['POST admin/faqs'] = admin(async ({ query, sql, req }) => {
  const c = await cohortFor(sql, query);
  return { faq: (await sql`insert into so_faqs ${sql({ ...parseFaq(H.body(req)), cohort_id: c.id })} returning *`)[0] };
});
routes['PUT admin/faqs/:id'] = admin(async ({ query, sql, req, params }) => {
  const id = H.uuid(params.id, 'faq');
  const rows = await sql`update so_faqs set ${sql({ ...parseFaq(H.body(req)), updated_at: new Date() })} where id = ${id} returning *`;
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Unknown FAQ.');
  return { faq: rows[0] };
});
routes['DELETE admin/faqs/:id'] = admin(async ({ query, sql, params }) => {
  const id = H.uuid(params.id, 'faq');
  await sql`delete from so_faqs where id = ${id}`;
  return { ok: true };
});

// ------------------------------------------------------------- preview
// Read-only lifecycle preview with a simulated clock. It builds the same
// payloads members get, with no member data, and never writes anything.
routes['GET admin/preview'] = admin(async ({ sql, query }) => {
  const c = await cohortFor(sql, query);
  const at = H.isoDate(query.at, { field: 'Preview time' });
  const view = H.oneOf(query.view || 'home', ['home', 'calendar', 'day', 'offer'], 'View');
  const drafts = query.drafts === '1';
  if (view === 'offer') {
    return { at: at.toISOString(), view, price: S.priceAt(c, at), phase: S.phase(c, at), window: S.enrollmentWindow(c, at) };
  }
  if (view === 'home') return { at: at.toISOString(), view, home: await member.homePayload(sql, c, at, null, { active: true }) };
  if (view === 'calendar') return { at: at.toISOString(), view, days: await member.calendarDays(sql, c, at, null) };
  const d = await member.dayByNumber(sql, c, query.n);
  // "Include drafts" previews unpublished content as if it were published.
  const row = drafts ? { ...d, status: 'published' } : d;
  const out = await member.buildDay(sql, c, row, at, null);
  return { at: at.toISOString(), view, draft_preview: drafts && d.status !== 'published', day: out };
});

// ------------------------------------------------------- announcements
function parseAnnouncement(b, tz) {
  const v = {
    title: H.text(b.title, { max: 160, required: true, field: 'Title' }),
    body: H.text(b.body, { max: 5000, field: 'Message', multiline: true }),
    status: H.oneOf(b.status || 'draft', ['draft', 'published'], 'Status'),
    pinned: b.pinned === true,
    publish_at: b.publish_local ? fromLocal(b.publish_local, tz, 'Publish time') : null,
  };
  return v;
}
routes['GET admin/announcements'] = admin(async ({ query, sql }) => {
  const c = await cohortFor(sql, query);
  const rows = await sql`select * from so_announcements where cohort_id = ${c.id} order by pinned desc, coalesce(publish_at, created_at) desc`;
  return { announcements: rows.map(r => ({ ...r, publish_local: localStr(r.publish_at, c.timezone) })), timezone: c.timezone };
}, 'view');
routes['POST admin/announcements'] = admin(async ({ query, sql, req, admin: who }) => {
  const c = await cohortFor(sql, query);
  const v = parseAnnouncement(H.body(req), c.timezone);
  const rows = await sql`insert into so_announcements ${sql({ ...v, cohort_id: c.id, updated_by: who.actor })} returning *`;
  await C.audit(sql, who.actor, 'announcement_created', 'announcement', rows[0].id, null, { title: v.title, status: v.status });
  return { announcement: rows[0] };
});
routes['PUT admin/announcements/:id'] = admin(async ({ query, sql, req, params, admin: who }) => {
  const c = await cohortFor(sql, query);
  const id = H.uuid(params.id, 'announcement');
  const v = parseAnnouncement(H.body(req), c.timezone);
  const rows = await sql`update so_announcements set ${sql({ ...v, updated_at: new Date(), updated_by: who.actor })} where id = ${id} and cohort_id = ${c.id} returning *`;
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Unknown announcement.');
  await C.audit(sql, who.actor, 'announcement_updated', 'announcement', id, null, { status: v.status });
  return { announcement: rows[0] };
});
routes['DELETE admin/announcements/:id'] = admin(async ({ query, sql, params, admin: who }) => {
  const c = await cohortFor(sql, query);
  const id = H.uuid(params.id, 'announcement');
  await sql`delete from so_announcements where id = ${id} and cohort_id = ${c.id}`;
  await C.audit(sql, who.actor, 'announcement_deleted', 'announcement', id, null, null);
  return { ok: true };
});

routes['GET admin/audit'] = admin(async ({ query, sql }) => ({
  entries: await sql`select id, actor, action, entity, entity_id, before, after, created_at from so_admin_audit_log order by id desc limit 300`,
}));

routes['GET admin/webhooks'] = admin(async ({ query, sql }) => ({
  events: await sql`select id, type, status, error, attempts, received_at, processed_at from so_webhook_events order by received_at desc limit 200`,
}));

module.exports = { routes, cohortOut };
