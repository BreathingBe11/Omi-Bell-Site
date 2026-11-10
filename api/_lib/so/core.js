'use strict';
// Shared domain logic: loading the cohort, content, visibility gates and the
// serializers that decide exactly which fields leave the server.
//
// Visibility rule for days: a member sees full day content only when the day
// is BOTH unlocked by time (cohort schedule) AND published by an admin.
// Locked days expose only an owner-approved preview (title/summary) and the
// unlock date — never the body, question, action, transcript or file paths.

const S = require('./schedule');
const { localDateStr } = require('./time');
const { SITE_CONTENT, PILLARS, WEEKS } = require('./content');
const { HttpError } = require('./http');
const env = require('./env');

async function loadCohort(sql) {
  const rows = await sql`select * from so_cohorts where is_default limit 1`;
  if (!rows[0]) throw new HttpError(503, 'cohort_not_configured', 'The cohort is not configured yet.');
  return rows[0];
}

async function loadWeeks(sql, cohortId) {
  const rows = await sql`select * from so_weeks where cohort_id = ${cohortId} order by week_number`;
  return rows.length ? rows : WEEKS;
}

async function loadContent(sql) {
  const rows = await sql`select key, value, status from so_site_content`;
  const map = new Map(rows.map(r => [r.key, r]));
  const get = key => {
    const r = map.get(key);
    if (r && r.status === 'published') return r.value;
    const def = SITE_CONTENT.find(c => c.key === key);
    return def ? def.default : '';
  };
  const isPublished = key => { const r = map.get(key); return !!(r && r.status === 'published' && r.value.trim()); };
  return { get, isPublished, rows: map };
}

// ------------------------------------------------------------ enrollment
async function loadEnrollment(sql, userId, cohortId) {
  return (await sql`select * from so_enrollments where user_id = ${userId} and cohort_id = ${cohortId}`)[0] || null;
}

async function memberContext(sql, user, now, { requireAccess = true } = {}) {
  const cohort = await loadCohort(sql);
  const enrollment = await loadEnrollment(sql, user.id, cohort.id);
  const access = S.accessStatus(cohort, enrollment, now);
  if (requireAccess && !access.active) {
    throw new HttpError(403, access.reason === 'not_enrolled' ? 'not_enrolled' : 'no_access',
      access.reason === 'not_enrolled' ? 'This area is for enrolled members.' : 'Your access to this cohort is not active.',
      { reason: access.reason });
  }
  return { cohort, enrollment, access, user, now };
}

// ------------------------------------------------------------- days
function dayState(cohort, day, now) {
  if (!S.isDayUnlocked(cohort, day.day_number, now)) return 'locked';
  return day.status === 'published' ? 'available' : 'preparing';
}

function dayHeader(cohort, sched, weeks, day) {
  const d = sched.days[day.day_number - 1];
  const week = S.weekOf(day.day_number);
  const w = weeks.find(x => x.week_number === week) || {};
  return {
    day_number: day.day_number,
    date: d ? d.date : null,
    unlock_at: d ? d.unlock_at.toISOString() : null,
    week,
    pillar: w.pillar || null,
    pillar_label: w.pillar && PILLARS[w.pillar] ? PILLARS[w.pillar].label : null,
  };
}

// The only representation of a locked or not-yet-published day.
function dayPreview(cohort, sched, weeks, day, now) {
  const state = dayState(cohort, day, now);
  const approved = !!day.preview_published;
  return {
    ...dayHeader(cohort, sched, weeks, day),
    state,
    title: approved ? day.title : null,
    preview_summary: approved ? (day.preview_summary || null) : null,
  };
}

// ---------------------------------------------------------- resources
function resourceReleased(cohort, resource, linkedDays, now) {
  if (resource.status !== 'published') return false;
  if (resource.release_mode === 'immediately') return true;
  if (resource.release_mode === 'at_time') return now.getTime() >= new Date(resource.release_at).getTime();
  return linkedDays.some(d => d.status === 'published' && S.isDayUnlocked(cohort, d.day_number, now));
}

function fileKind(r) {
  if (r.source_type === 'link') return 'Link';
  const m = r.mime_type || '';
  if (m === 'application/pdf') return 'PDF';
  if (m.includes('wordprocessingml') || m === 'application/msword') return 'Word';
  if (m.includes('spreadsheetml') || m === 'application/vnd.ms-excel') return 'Excel';
  if (m.includes('presentationml')) return 'PowerPoint';
  if (m === 'text/csv') return 'CSV';
  if (m.startsWith('audio/')) return 'Audio';
  if (m.startsWith('video/')) return 'Video';
  if (m.startsWith('text/')) return 'Text';
  return 'File';
}

// Public-safe resource shape: never includes storage_path or external_url
// (links are fetched through the access endpoint, which re-checks release).
function resourceOut(r, extra = {}) {
  return {
    id: r.id, kind: r.kind, title: r.title, purpose: r.purpose || null, description: r.description || null,
    pillar: r.pillar || null, file_kind: fileKind(r), source_type: r.source_type,
    practice_type: r.practice_type || null, duration_seconds: r.duration_seconds || null,
    has_transcript: !!(r.transcript && r.transcript.trim()),
    ...extra,
  };
}

// All resources with their linked days, for release checks.
async function loadResourcesWithDays(sql, cohortId) {
  const resources = await sql`select * from so_resources where cohort_id = ${cohortId} order by title`;
  const links = await sql`
    select dr.resource_id, dr.role, dr.sort, d.id as day_id, d.day_number, d.status
    from so_day_resources dr join so_days d on d.id = dr.day_id
    where d.cohort_id = ${cohortId} order by d.day_number, dr.sort`;
  const byRes = new Map();
  for (const l of links) {
    if (!byRes.has(l.resource_id)) byRes.set(l.resource_id, []);
    byRes.get(l.resource_id).push(l);
  }
  return resources.map(r => ({ ...r, links: byRes.get(r.id) || [] }));
}

// -------------------------------------------------------------- calls
function callTimes(cohort, call) {
  const starts = new Date(call.starts_at);
  const windowMin = call.join_window_minutes ?? cohort.call_join_window_minutes;
  return {
    starts,
    ends: new Date(starts.getTime() + call.duration_minutes * 60000),
    joinOpens: new Date(starts.getTime() - windowMin * 60000),
  };
}

function callState(cohort, call, now) {
  if (call.status === 'canceled') return 'canceled';
  const t = callTimes(cohort, call);
  if (now < t.joinOpens) return 'upcoming';
  if (now < t.ends) return 'joinable';
  return 'ended';
}

function callOut(cohort, call, now, replay) {
  const t = callTimes(cohort, call);
  const state = callState(cohort, call, now);
  return {
    id: call.id, title: call.title, description: call.description || null,
    starts_at: t.starts.toISOString(), ends_at: t.ends.toISOString(), join_opens_at: t.joinOpens.toISOString(),
    duration_minutes: call.duration_minutes, cohort_timezone: cohort.timezone,
    cohort_date: localDateStr(t.starts, cohort.timezone),
    state, has_meeting_link: !!call.meeting_url,
    replay: replay ? resourceOut(replay) : null,
  };
}

async function loadMemberCalls(sql, cohort, now) {
  const calls = await sql`
    select c.*, r.id as r_id from so_calls c
    left join so_resources r on r.id = c.replay_resource_id
    where c.cohort_id = ${cohort.id} and c.status in ('scheduled', 'canceled')
    order by c.starts_at`;
  const replayIds = calls.filter(c => c.replay_published && c.r_id).map(c => c.r_id);
  const replays = replayIds.length
    ? await sql`select * from so_resources where id = any(${replayIds}) and status = 'published'` : [];
  const rmap = new Map(replays.map(r => [r.id, r]));
  return calls.map(c => callOut(cohort, c, now, c.replay_published ? rmap.get(c.r_id) : null));
}

function nextCall(calls) {
  return calls.find(c => c.state === 'upcoming' || c.state === 'joinable') || null;
}

// ---------------------------------------------------------- readiness
const SALES_CONTENT = [
  ['purchase.refund_policy', 'Refund policy'],
  ['purchase.access_terms', 'Access duration statement'],
  ['purchase.tax_treatment', 'Tax treatment statement'],
  ['calls.recording_policy', 'Call recording & replay policy'],
  ['legal.terms', 'Terms'],
  ['legal.privacy', 'Privacy policy'],
  ['support.email', 'Support contact'],
];

async function salesReadiness(sql, cohort, content, now) {
  const mode = env.stripeMode();
  const blockers = [];
  const add = (key, label) => blockers.push({ key, label });
  if (mode === 'unconfigured') add('stripe_key', 'Stripe secret key (STRIPE_SECRET_KEY)');
  if (mode === 'invalid') add('stripe_key', 'Stripe secret key is not a valid sk_/rk_ key');
  if (mode === 'test') add('stripe_live', 'Stripe is in TEST mode (live key not configured)');
  if (!process.env.STRIPE_WEBHOOK_SECRET) add('stripe_webhook', 'Stripe webhook signing secret (STRIPE_WEBHOOK_SECRET)');
  if (!env.supabaseConfigured()) add('auth', 'Supabase Auth settings (SUPABASE_URL, SUPABASE_ANON_KEY)');
  if (!cohort.settings_confirmed_at) add('settings_confirmed', 'Owner confirmation of dates, unlock time, price cutoff and enrollment window');
  if (cohort.access_policy === 'unset') add('access_policy', 'Post-cohort access policy');
  for (const [key, label] of SALES_CONTENT) if (!content.isPublished(key)) add(`content:${key}`, `${label} (published)`);
  const calls = await sql`select count(*)::int as n from so_calls where cohort_id = ${cohort.id} and status = 'scheduled'`;
  if (!calls[0].n) add('calls', 'At least one scheduled Solutions Seat call');
  if (env.emailMode() !== 'live' || !process.env.RESEND_API_KEY) add('email', 'Live transactional email (SO_EMAIL_DELIVERY=live and RESEND_API_KEY)');
  if (!cohort.sales_enabled) add('sales_enabled', 'Sales switched on in admin settings');

  const window = S.enrollmentWindow(cohort, now);
  const infra = !!(process.env.STRIPE_WEBHOOK_SECRET && env.supabaseConfigured());
  let canCheckout = false;
  let reason = null;
  if (mode === 'live') canCheckout = blockers.length === 0;
  else if (mode === 'test') canCheckout = infra && env.testCheckoutAllowed();
  if (!canCheckout) reason = 'not_ready';
  else if (!window.open) { canCheckout = false; reason = window.reason === 'closed' ? 'enrollment_closed' : 'not_yet_open'; }
  return {
    mode: mode === 'live' || mode === 'test' ? mode : 'disabled',
    can_checkout: canCheckout,
    reason,
    test_mode: mode === 'test',
    blockers,
    window,
  };
}

// Per-day content-release readiness (does not include private member data).
function dayReadiness(day, links, resourcesById) {
  const issues = [];
  if (day.status !== 'published') issues.push('Not published');
  if (day.is_sample) issues.push('Still provisional sample content');
  if (!day.reflection_prompt) issues.push('No reflection question');
  if (!day.action_body && !day.action_title) issues.push('No practical action');
  if (!day.preview_published) issues.push('Preview not approved');
  const practice = links.find(l => l.role === 'practice');
  if (!practice) issues.push('No guided practice linked');
  for (const l of links) {
    const r = resourcesById.get(l.resource_id);
    if (!r) continue;
    if (r.status !== 'published') issues.push(`“${r.title}” is not published`);
    if (r.source_type === 'file' && !r.storage_path) issues.push(`“${r.title}” has no file uploaded`);
    if (r.kind === 'practice' && !(r.transcript && r.transcript.trim())) issues.push(`“${r.title}” has no transcript`);
    if (r.is_sample) issues.push(`“${r.title}” is a sample placeholder`);
  }
  return issues;
}

async function recordEvent(sql, name, { userId = null, cohortId = null, dayNumber = null, refId = null } = {}) {
  try {
    await sql`insert into so_events (name, user_id, cohort_id, day_number, ref_id)
              values (${name}, ${userId}, ${cohortId}, ${dayNumber}, ${refId})`;
  } catch (e) {
    console.error('[so] event log failed', name, e.code);
  }
}

async function audit(sql, actor, action, entity, entityId, before, after) {
  await sql`insert into so_admin_audit_log (actor, action, entity, entity_id, before, after)
            values (${actor}, ${action}, ${entity}, ${entityId ? String(entityId) : null},
                    ${before ? sql.json(before) : null}, ${after ? sql.json(after) : null})`;
}

module.exports = {
  loadCohort, loadWeeks, loadContent, loadEnrollment, memberContext,
  dayState, dayHeader, dayPreview, resourceReleased, resourceOut, fileKind, loadResourcesWithDays,
  callTimes, callState, callOut, loadMemberCalls, nextCall,
  salesReadiness, dayReadiness, SALES_CONTENT, recordEvent, audit,
};
