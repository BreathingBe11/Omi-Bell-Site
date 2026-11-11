'use strict';
// Questions inbox ("Ask for Help"). Separate from Solutions Seat challenges.
// Members under review or not approved get a restricted set of categories
// (application, account, billing). Staff internal notes are never returned to
// members or put in emails. Reply emails carry a link, not the reply text.

const C = require('./core');
const H = require('./http');
const email = require('./email');
const env = require('./env');
const { requireUser, ensureProfile, requireAdmin } = require('./identity');

const { HttpError } = H;
const ALL = ['program', 'account_access', 'billing_refund', 'resources', 'other'];
const RESTRICTED = ['application', 'account_access', 'billing_refund', 'other'];
const LABELS = { program: 'Program', account_access: 'Account or access', billing_refund: 'Billing or refund', resources: 'Resources', application: 'My application', other: 'Something else', bug: 'Bug report' };

async function memberScope(sql, req) {
  const user = await requireUser(req);
  await ensureProfile(sql, user);
  const cohort = await C.loadCohort(sql);
  const e = await C.loadEnrollment(sql, user.id, cohort.id);
  const full = !!(e && e.access_state === 'active' && e.review_state === 'approved');
  return { user, cohort, categories: full ? ALL : RESTRICTED };
}

const publicMsg = m => ({ id: m.id, author_type: m.author_type, body: m.body, created_at: m.created_at });

const routes = {};

routes['GET help/threads'] = async ({ sql, req }) => {
  const { user, categories } = await memberScope(sql, req);
  const threads = await sql`select id, category, subject, status, last_message_at, created_at,
      (select author_type from so_support_messages m where m.thread_id = t.id and not m.internal order by created_at desc limit 1) as last_author
    from so_support_threads t where user_id = ${user.id} order by last_message_at desc`;
  return { threads, categories: categories.map(k => ({ key: k, label: LABELS[k] })) };
};

routes['GET help/threads/:id'] = async ({ sql, req, params }) => {
  const { user } = await memberScope(sql, req);
  const id = H.uuid(params.id, 'question');
  const t = (await sql`select id, category, subject, status, created_at from so_support_threads where id = ${id} and user_id = ${user.id}`)[0];
  if (!t) throw new HttpError(404, 'not_found', 'Question not found.');
  const msgs = await sql`select * from so_support_messages where thread_id = ${id} and not internal order by created_at`;
  return { thread: { ...t, category_label: LABELS[t.category] }, messages: msgs.map(publicMsg) };
};

routes['POST help/threads'] = async ({ sql, req }) => {
  const { user, cohort, categories } = await memberScope(sql, req);
  const b = H.body(req);
  // Anyone signed in can report a bug, whatever their enrollment state.
  const category = H.oneOf(b.category, [...categories, 'bug'], 'Topic');
  const subject = H.text(b.subject, { max: 140, required: true, field: 'Subject' });
  const body = H.text(b.body, { max: 5000, required: true, field: 'Your question', multiline: true });
  await H.rateLimit(sql, `help:${user.id}`, 10, 3600);
  const t = await sql.begin(async tx => {
    const th = (await tx`insert into so_support_threads (user_id, cohort_id, category, subject) values (${user.id}, ${cohort.id}, ${category}, ${subject}) returning *`)[0];
    await tx`insert into so_support_messages (thread_id, author_type, author, body) values (${th.id}, 'member', ${user.email}, ${body})`;
    return th;
  });
  return { thread: { id: t.id } };
};

routes['POST help/threads/:id/messages'] = async ({ sql, req, params }) => {
  const { user } = await memberScope(sql, req);
  const id = H.uuid(params.id, 'question');
  const body = H.text(H.body(req).body, { max: 5000, required: true, field: 'Your reply', multiline: true });
  const t = (await sql`select id from so_support_threads where id = ${id} and user_id = ${user.id}`)[0];
  if (!t) throw new HttpError(404, 'not_found', 'Question not found.');
  await H.rateLimit(sql, `help:${user.id}`, 30, 3600);
  await sql`insert into so_support_messages (thread_id, author_type, author, body) values (${id}, 'member', ${user.email}, ${body})`;
  // A member follow-up reopens a resolved question.
  await sql`update so_support_threads set last_message_at = now(), updated_at = now(),
            status = case when status = 'resolved' then 'new' else status end where id = ${id}`;
  return { ok: true };
};

// ---------------------------------------------------------------- staff
const staff = (fn, perm = 'support') => async ctx => { ctx.admin = await requireAdmin(ctx.req, ctx.sql, perm); return fn(ctx); };

routes['GET admin/questions'] = staff(async ({ sql, query }) => {
  const status = query.status && ['new', 'in_progress', 'resolved'].includes(query.status) ? query.status : null;
  const rows = await sql`
    select t.id, t.user_id, t.category, t.subject, t.status, t.last_message_at, t.created_at, p.email,
           coalesce(nullif(trim(concat_ws(' ', i.first_name, i.last_name)), ''), p.display_name, p.email) as name,
           (select body from so_support_messages m where m.thread_id = t.id and not m.internal order by created_at desc limit 1) as latest,
           (select author_type from so_support_messages m where m.thread_id = t.id and not m.internal order by created_at desc limit 1) as latest_author
    from so_support_threads t join so_profiles p on p.user_id = t.user_id
    left join so_intakes i on i.user_id = t.user_id and i.cohort_id = t.cohort_id
    where (${status}::text is null or t.status = ${status}) order by (t.status = 'new') desc, t.last_message_at desc limit 300`;
  const counts = await sql`select status, count(*)::int as n from so_support_threads group by status`;
  return {
    questions: rows.map(r => ({ ...r, category_label: LABELS[r.category], latest: r.latest && r.latest.length > 160 ? `${r.latest.slice(0, 160)}…` : r.latest })),
    counts: Object.fromEntries(counts.map(c => [c.status, c.n])),
  };
});

routes['GET admin/questions/:id'] = staff(async ({ sql, params }) => {
  const id = H.uuid(params.id, 'question');
  const t = (await sql`select t.*, p.email from so_support_threads t join so_profiles p on p.user_id = t.user_id where t.id = ${id}`)[0];
  if (!t) throw new HttpError(404, 'not_found', 'Question not found.');
  const msgs = await sql`select * from so_support_messages where thread_id = ${id} order by created_at`;
  return { thread: { ...t, category_label: LABELS[t.category] }, messages: msgs };
});

routes['POST admin/questions/:id/reply'] = staff(async ({ sql, req, params, admin: who }) => {
  const id = H.uuid(params.id, 'question');
  const body = H.text(H.body(req).body, { max: 5000, required: true, field: 'Reply', multiline: true });
  const t = (await sql`select t.*, p.email from so_support_threads t join so_profiles p on p.user_id = t.user_id where t.id = ${id}`)[0];
  if (!t) throw new HttpError(404, 'not_found', 'Question not found.');
  const cohort = t.cohort_id ? (await sql`select * from so_cohorts where id = ${t.cohort_id}`)[0] : await C.loadCohort(sql);
  const msg = await sql.begin(async tx => {
    const m = (await tx`insert into so_support_messages (thread_id, author_type, author, body) values (${id}, 'staff', ${who.actor}, ${body}) returning *`)[0];
    await tx`update so_support_threads set status = case when status = 'new' then 'in_progress' else status end, last_message_at = now(), updated_at = now() where id = ${id}`;
    const vars = { ...(await email.baseVars(tx, cohort, t.user_id)), thread_subject: t.subject,
      thread_link: `${env.siteUrl()}${env.BASE_PATH}/login?next=${encodeURIComponent(`/app/help/${id}`)}` };
    const out = await email.enqueue(tx, { key: 'support_reply', dedupeKey: `support-reply:${m.id}`, to: t.email, userId: t.user_id, cohortId: cohort.id,
      vars, related: { type: 'support_thread', id }, actor: who.actor });
    return { m, out };
  });
  const delivery = msg.out ? (await email.processOutbox(sql, { ids: [msg.out.id] }))[0] : null;
  return { message: msg.m, email: delivery ? delivery.status : 'template_disabled' };
});

routes['POST admin/questions/:id/note'] = staff(async ({ sql, req, params, admin: who }) => {
  const id = H.uuid(params.id, 'question');
  const body = H.text(H.body(req).body, { max: 5000, required: true, field: 'Note', multiline: true });
  const rows = await sql`insert into so_support_messages (thread_id, author_type, author, internal, body)
                         select ${id}, 'staff', ${who.actor}, true, ${body} where exists (select 1 from so_support_threads where id = ${id}) returning *`;
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Question not found.');
  return { message: rows[0] };
});

routes['PUT admin/questions/:id'] = staff(async ({ sql, req, params }) => {
  const id = H.uuid(params.id, 'question');
  const status = H.oneOf(H.body(req).status, ['new', 'in_progress', 'resolved'], 'Status');
  const rows = await sql`update so_support_threads set status = ${status}, updated_at = now() where id = ${id} returning id, status`;
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Question not found.');
  return { thread: rows[0] };
});

module.exports = { routes, LABELS };
