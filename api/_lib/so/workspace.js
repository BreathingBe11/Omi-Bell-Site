'use strict';
// Admin workspace (second brief): overview, members & review, sales, progress,
// Solutions Seat prep, emails, staff. Every route checks a server-side
// permission. Private journal text is never selected anywhere in this file.

const S = require('./schedule');
const C = require('./core');
const H = require('./http');
const T = require('./time');
const env = require('./env');
const email = require('./email');
const refunds = require('./refunds');
const intakeMod = require('./intake');
const storage = require('./storage');
const { requireAdmin } = require('./identity');

const { HttpError } = H;
const routes = {};
const can = (fn, perm) => async ctx => { ctx.admin = await requireAdmin(ctx.req, ctx.sql, perm); return fn(ctx); };

// Shared cohort selector: ?cohort=<id>, default = the active cohort.
async function cohortFor(sql, query) {
  if (query && query.cohort && /^[0-9a-f-]{36}$/i.test(query.cohort)) {
    const c = (await sql`select * from so_cohorts where id = ${query.cohort}`)[0];
    if (c) return c;
  }
  return C.loadCohort(sql);
}

routes['GET admin/cohorts'] = can(async ({ sql, admin: who }) => ({
  cohorts: await sql`select id, name, start_date, is_default from so_cohorts order by is_default desc, start_date desc`,
  me: { actor: who.actor, role: who.role, perms: who.perms },
}), 'view');

const liveOnly = () => env.stripeMode() === 'live';

// Dates (YYYY-MM-DD, cohort time) -> UTC range; null = unbounded.
function range(cohort, query) {
  const from = query.from && T.isDateStr(query.from) ? T.zonedToUtc(query.from, '00:00', cohort.timezone) : null;
  const to = query.to && T.isDateStr(query.to) ? T.zonedToUtc(T.addDays(query.to, 1), '00:00', cohort.timezone) : null;
  return { from, to, label: from || to ? `${query.from || 'start'} to ${query.to || 'today'} (${cohort.timezone})` : 'All time, this cohort' };
}

// ------------------------------------------------------------------ members
async function memberRows(sql, cohort) {
  return sql`
    with people as (
      select user_id from so_intakes where cohort_id = ${cohort.id}
      union select user_id from so_enrollments where cohort_id = ${cohort.id}
    )
    select pe.user_id, p.email, p.display_name,
      i.id as intake_id, i.status as intake_status, i.version as intake_version, i.submitted_at, i.first_name, i.last_name,
      i.business_name, i.created_at as intake_created_at, i.updated_at as intake_updated_at,
      e.id as enrollment_id, e.review_state, e.review_version, e.access_state, e.source, e.is_test, e.activated_at, e.reviewed_at,
      pu.status as purchase_status, pu.amount_paid_cents, pu.price_tier, pu.paid_at, pu.needs_review,
      (select status from so_refund_attempts ra where ra.purchase_id = pu.id order by created_at desc limit 1) as refund_status,
      greatest(
        (select max(created_at) from so_events ev where ev.user_id = pe.user_id and ev.cohort_id = ${cohort.id}),
        (select max(updated_at) from so_day_progress dp where dp.user_id = pe.user_id and dp.cohort_id = ${cohort.id}),
        (select max(updated_at) from so_journal_entries je where je.user_id = pe.user_id and je.cohort_id = ${cohort.id}),
        i.updated_at
      ) as last_active
    from people pe join so_profiles p on p.user_id = pe.user_id
    left join so_intakes i on i.user_id = pe.user_id and i.cohort_id = ${cohort.id}
    left join so_enrollments e on e.user_id = pe.user_id and e.cohort_id = ${cohort.id}
    left join so_purchases pu on pu.id = e.purchase_id`;
}

function rowOut(r) {
  const infoStatus = r.intake_status === 'submitted' ? 'submitted' : r.intake_id ? 'incomplete' : 'none';
  const paid = r.source === 'manual' || ['paid', 'partially_refunded', 'refunded', 'disputed'].includes(r.purchase_status);
  let review = 'not_enrolled';
  if (r.enrollment_id) review = r.review_state === 'pending' && infoStatus !== 'submitted' ? 'awaiting_submission' : r.review_state;
  const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.display_name || r.email;
  return {
    user_id: r.user_id, name, email: r.email, business: r.business_name || null, info_status: infoStatus,
    review_status: review, payment_status: r.enrollment_id ? (r.source === 'manual' ? 'manual' : r.purchase_status || 'unknown') : 'not_paid',
    paid, refund_status: r.refund_status || null, submitted_at: r.submitted_at, last_active: r.last_active,
    enrollment_id: r.enrollment_id, is_test: !!r.is_test, needs_review: r.needs_review || null, price_tier: r.price_tier || null,
    amount_paid_cents: r.amount_paid_cents ?? null,
  };
}

const FILTERS = {
  all: () => true,
  incomplete: m => m.info_status !== 'submitted',
  awaiting: m => m.review_status === 'pending' && m.paid,
  approved: m => m.review_status === 'approved',
  rejected: m => m.review_status === 'rejected',
};

routes['GET admin/members'] = can(async ({ sql, query }) => {
  const cohort = await cohortFor(sql, query);
  let rows = (await memberRows(sql, cohort)).map(rowOut);
  const counts = Object.fromEntries(Object.entries(FILTERS).map(([k, f]) => [k, rows.filter(f).length]));
  const filter = FILTERS[query.filter] ? query.filter : 'all';
  rows = rows.filter(FILTERS[filter]);
  if (query.pay) rows = rows.filter(m => m.payment_status === query.pay || (query.pay === 'refund' && m.refund_status));
  const term = String(query.q || '').trim().toLowerCase().slice(0, 100);
  if (term) rows = rows.filter(m => `${m.name} ${m.business || ''} ${m.email}`.toLowerCase().includes(term));
  // Review queue: oldest submitted first. Otherwise newest first.
  const dir = query.sort === 'submitted_asc' || (!query.sort && filter === 'awaiting') ? 1 : -1;
  rows.sort((a, b) => dir * ((a.submitted_at ? +new Date(a.submitted_at) : 0) - (b.submitted_at ? +new Date(b.submitted_at) : 0)));
  const size = 25;
  const page = Math.max(1, Math.min(1000, Number(query.page) || 1));
  return { counts, total: rows.length, page, pages: Math.max(1, Math.ceil(rows.length / size)), members: rows.slice((page - 1) * size, page * size) };
}, 'view');

async function cardFor(sql, cohort, userId, who) {
  const finance = who.perms.includes('finance');
  const p = (await sql`select user_id, email, display_name from so_profiles where user_id = ${userId}`)[0];
  if (!p) throw new HttpError(404, 'not_found', 'Unknown member.');
  const i = await intakeMod.loadIntake(sql, userId, cohort.id);
  const e = (await sql`select * from so_enrollments where user_id = ${userId} and cohort_id = ${cohort.id}`)[0] || null;
  const purchases = await sql`select * from so_purchases where user_id = ${userId} and cohort_id = ${cohort.id} and status not in ('created') order by created_at desc`;
  const attempts = purchases.length ? await sql`select * from so_refund_attempts where purchase_id = any(${purchases.map(x => x.id)}) order by created_at desc` : [];
  const versions = i ? await sql`select version, submitted_at, policy_version from so_intake_versions where intake_id = ${i.id} order by version desc` : [];
  const notes = await sql`select id, author, body, created_at from so_admin_notes where user_id = ${userId} and (cohort_id = ${cohort.id} or cohort_id is null) order by created_at desc`;
  const decisions = e ? await sql`select * from so_review_decisions where enrollment_id = ${e.id} order by created_at desc` : [];
  const emails = await sql`select id, template_key, template_version, to_email, subject, status, last_error, edited, created_at, submitted_at, delivered_at, actor, resend_of
                           from so_email_outbox where user_id = ${userId} order by created_at desc limit 50`;
  const intro = (await sql`select photo_path, preferred_name from so_introductions where user_id = ${userId} and cohort_id = ${cohort.id}`)[0];
  let photo = null;
  if (intro && intro.photo_path) { try { photo = await storage.signedDownloadUrl(intro.photo_path, 600); } catch { photo = null; } }
  const prog = (await sql`select count(started_at)::int as started, count(completed_at)::int as completed, max(updated_at) as last
                          from so_day_progress where user_id = ${userId} and cohort_id = ${cohort.id}`)[0];
  const events = await sql`select name, day_number, created_at from so_events where user_id = ${userId} and cohort_id = ${cohort.id} order by created_at desc limit 60`;
  const counts = (await sql`select (select count(*)::int from so_call_challenges where user_id = ${userId} and cohort_id = ${cohort.id}) as challenges,
                                   (select count(*)::int from so_support_threads where user_id = ${userId}) as questions`)[0];

  const paidPurchase = purchases.find(x => ['paid', 'partially_refunded', 'disputed', 'refunded'].includes(x.status));
  const infoOk = !!(i && i.status === 'submitted');
  const paymentOk = !!(e && (e.source === 'manual' || (paidPurchase && ['paid', 'partially_refunded'].includes(paidPurchase.status))));
  const blockers = [];
  if (!e) blockers.push('Has not paid');
  else if (!paymentOk) blockers.push(paidPurchase && paidPurchase.status === 'disputed' ? 'Payment is disputed; resolve it in Stripe first' : 'Payment not confirmed');
  if (!infoOk) blockers.push('Fit check not submitted');
  if (e && e.review_state !== 'pending') blockers.push(`Already ${e.review_state}`);
  if (!who.perms.includes('decide')) blockers.push('Your role can’t make decisions');
  const refundable = paidPurchase && paidPurchase.status !== 'refunded' ? (paidPurchase.amount_paid_cents || 0) - (paidPurchase.refunded_cents || 0) : 0;
  const accessLabel = !e ? 'none' : e.access_state !== 'active' ? (e.access_state === 'refunded' ? 'suspended (refunded)' : e.access_state)
    : e.review_state === 'approved' ? (S.accessStatus(cohort, e, new Date()).active ? 'cohort_active' : 'expired') : 'application_only';
  const dash = x => `https://dashboard.stripe.com/${x.livemode === false ? 'test/' : ''}payments/${x.stripe_payment_intent_id}`;

  return {
    user_id: userId, email: p.email, name: i && i.first_name ? `${i.first_name} ${i.last_name || ''}`.trim() : (p.display_name || p.email),
    business: i ? i.business_name : null, photo_url: photo, cohort: { id: cohort.id, name: cohort.name },
    info: i ? { status: i.status, version: i.version, submitted_at: i.submitted_at, missing: i.status === 'submitted' ? [] : intakeMod.missingFields(i),
      policy_version: i.policy_version, early_stage: intakeMod.earlyStage(i), answers: intakeMod.answersOut(i), versions } : null,
    enrollment: e ? { id: e.id, review_state: e.review_state, review_version: e.review_version, access_state: e.access_state, access: accessLabel,
      source: e.source, is_test: e.is_test, activated_at: e.activated_at, reviewed_at: e.reviewed_at, reviewed_by: e.reviewed_by } : null,
    payments: purchases.filter(x => x.status !== 'open' && x.status !== 'expired' || x.paid_at).map(x => ({
      id: x.id, status: x.status, tier: x.price_tier, amount_cents: x.amount_paid_cents ?? x.amount_cents, currency: x.currency, paid_at: x.paid_at,
      tax_cents: x.tax_cents, refunded_cents: x.refunded_cents, livemode: x.livemode, needs_review: x.needs_review,
      ...(finance ? { fee_cents: x.fee_cents, receipt_url: x.receipt_url, provider_ref: x.stripe_payment_intent_id,
        provider_link: x.stripe_payment_intent_id ? dash(x) : null } : {}),
    })),
    refunds: finance ? attempts.map(a => ({ id: a.id, status: a.status, amount_cents: a.amount_cents, failure_reason: a.failure_reason,
      needs_attention: a.needs_attention, source: a.source, created_at: a.created_at, updated_at: a.updated_at, provider_ref: a.stripe_refund_id })) : [],
    notes,
    history: [
      ...decisions.map(d => ({ type: 'decision', at: d.created_at, actor: d.actor, decision: d.decision, intake_version: d.intake_version, member_message: d.member_message, internal_note: d.internal_note })),
      ...emails.map(m => ({ type: 'email', at: m.created_at, id: m.id, template: m.template_key, subject: m.subject, to: m.to_email, status: m.status,
        error: m.last_error, edited: m.edited, submitted_at: m.submitted_at, delivered_at: m.delivered_at, actor: m.actor, resend_of: m.resend_of })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at)),
    activity: { days_started: prog.started, days_completed: prog.completed, last_progress: prog.last, has_intro: !!intro,
      challenges: counts.challenges, questions: counts.questions, events },
    decision: {
      allowed: blockers.length === 0, blockers, review_version: e ? e.review_version : null, intake_version: i ? i.version : null,
      refund_cents: refundable, currency: paidPurchase ? paidPurchase.currency : 'usd', will_refund: !!(paidPurchase && refundable > 0),
      recipient: p.email,
    },
  };
}

routes['GET admin/members/:id'] = can(async ({ sql, query, params, admin: who }) => {
  const cohort = await cohortFor(sql, query);
  return { member: await cardFor(sql, cohort, H.uuid(params.id, 'member'), who) };
}, 'view');

routes['POST admin/members/:id/notes'] = can(async ({ sql, req, query, params, admin: who }) => {
  const cohort = await cohortFor(sql, query);
  const id = H.uuid(params.id, 'member');
  const body = H.text(H.body(req).body, { max: 4000, required: true, field: 'Note', multiline: true });
  const rows = await sql`insert into so_admin_notes (user_id, cohort_id, author, body) values (${id}, ${cohort.id}, ${who.actor}, ${body}) returning id, author, body, created_at`;
  return { note: rows[0] };
}, 'view');

// Rendered decision email, for the confirmation panel.
async function decisionVars(sql, cohort, userId, memberMessage, refundCents, refundMsg) {
  const timing = (await C.loadContent(sql)).get('purchase.refund_timing');
  return { ...(await email.baseVars(sql, cohort, userId)), member_message: memberMessage || '',
    refund_amount: refunds.money(refundCents), refund_message: refundMsg !== undefined ? refundMsg : refunds.refundMessage(refundCents ? { status: 'pending', amount_cents: refundCents } : null, refundCents, timing) };
}

routes['POST admin/members/:id/decision-preview'] = can(async ({ sql, req, query, params, admin: who }) => {
  const cohort = await cohortFor(sql, query);
  const id = H.uuid(params.id, 'member');
  const b = H.body(req);
  const decision = H.oneOf(b.decision, ['approve', 'reject'], 'Decision');
  const card = await cardFor(sql, cohort, id, who);
  const key = decision === 'approve' ? 'approval' : 'rejection';
  const t = await email.loadTemplate(sql, key);
  const vars = await decisionVars(sql, cohort, id, H.text(b.member_message, { max: 3000, multiline: true, field: 'Message' }), card.decision.refund_cents);
  return { to: card.decision.recipient, template_body: t.body, subject: email.render(t.subject, vars), body: email.render(b.body || t.body, vars),
    refund_cents: card.decision.refund_cents, will_refund: card.decision.will_refund };
}, 'decide');

routes['POST admin/members/:id/decision'] = can(async ({ sql, req, query, params, admin: who }) => {
  const cohort = await cohortFor(sql, query);
  const userId = H.uuid(params.id, 'member');
  const b = H.body(req);
  const decision = H.oneOf(b.decision, ['approve', 'reject'], 'Decision');
  const memberMessage = H.text(b.member_message, { max: 3000, multiline: true, field: 'Message to the member' }) || '';
  const internal = H.text(b.internal_note, { max: 3000, multiline: true, field: 'Internal note' }) || null;
  const key = decision === 'approve' ? 'approval' : 'rejection';
  let bodyOverride = null;
  if (b.body) {
    bodyOverride = H.text(b.body, { max: 8000, multiline: true, field: 'Email' });
    email.validateTemplate(key, 'x', bodyOverride);
    if (decision === 'reject' && !/{{\s*refund_message\s*}}/.test(bodyOverride)) {
      throw new HttpError(400, 'invalid_template', 'Keep {{refund_message}} in the rejection email so it states the real refund status.');
    }
  }
  if (decision === 'reject' && !memberMessage) throw new HttpError(400, 'invalid_input', 'Write a short explanation for the member.');
  const reviewVersion = H.int(b.review_version, { min: 0, field: 'review version' });
  const intakeVersion = H.int(b.intake_version, { min: 0, field: 'submission version' });

  const result = await sql.begin(async tx => {
    const e = (await tx`select * from so_enrollments where user_id = ${userId} and cohort_id = ${cohort.id} for update`)[0];
    if (!e) throw new HttpError(409, 'not_paid', 'This person hasn’t paid, so there’s nothing to decide yet.');
    if (e.review_state !== 'pending') throw new HttpError(409, 'already_decided', `This enrollment was already ${e.review_state}.`, { review_state: e.review_state });
    if (e.review_version !== reviewVersion) throw new HttpError(409, 'stale', 'Someone else changed this review. Reload the card.');
    const i = (await tx`select * from so_intakes where user_id = ${userId} and cohort_id = ${cohort.id}`)[0];
    if (!i || i.status !== 'submitted') throw new HttpError(409, 'not_submitted', 'The fit check hasn’t been submitted.');
    if (i.version !== intakeVersion) throw new HttpError(409, 'stale_submission', 'The member updated their fit check. Reload and review the new version.');
    const p = e.purchase_id ? (await tx`select * from so_purchases where id = ${e.purchase_id} for update`)[0] : null;
    if (e.source !== 'manual' && !(p && ['paid', 'partially_refunded'].includes(p.status))) {
      throw new HttpError(409, 'payment_not_confirmed', p && p.status === 'disputed' ? 'This payment is disputed. Resolve it in Stripe first.' : 'Payment isn’t confirmed.');
    }
    const state = decision === 'approve' ? 'approved' : 'rejected';
    await tx`update so_enrollments set review_state = ${state}, review_version = review_version + 1, reviewed_at = now(),
             reviewed_by = ${who.actor}, review_note = ${internal}, updated_at = now() where id = ${e.id}`;
    const d = (await tx`insert into so_review_decisions (enrollment_id, decision, intake_version, actor, member_message, internal_note)
                        values (${e.id}, ${state}, ${i.version}, ${who.actor}, ${memberMessage || null}, ${internal}) returning *`)[0];
    let attempt = null;
    if (state === 'rejected' && p) {
      const amount = (p.amount_paid_cents || 0) - (p.refunded_cents || 0);
      if (amount > 0) {
        attempt = (await tx`insert into so_refund_attempts (purchase_id, enrollment_id, amount_cents, currency, status, idempotency_key, actor)
                            values (${p.id}, ${e.id}, ${amount}, ${p.currency}, 'queued', ${`so-refund-${p.id}-${d.id}`}, ${who.actor}) returning *`)[0];
      }
    }
    await C.audit(tx, who.actor, `enrollment_${state}`, 'enrollment', e.id, { review_state: 'pending', intake_version: i.version },
      { review_state: state, refund_attempt: attempt ? attempt.id : null });
    if (state === 'approved') {
      const vars = await decisionVars(tx, cohort, userId, memberMessage, 0, '');
      const prof = (await tx`select email from so_profiles where user_id = ${userId}`)[0];
      await email.enqueue(tx, { key: 'approval', dedupeKey: `decision:${d.id}`, to: prof.email, userId, cohortId: cohort.id, vars, bodyOverride,
        related: { type: 'decision', id: d.id }, actor: who.actor });
    }
    return { enrollment: e, decision: d, attempt };
  });

  // Outside the transaction: provider call, then a status-accurate email.
  let attempt = result.attempt;
  if (attempt) attempt = await refunds.executeRefund(sql, attempt.id);
  if (decision === 'reject') {
    const prof = (await sql`select email from so_profiles where user_id = ${userId}`)[0];
    const timing = (await C.loadContent(sql)).get('purchase.refund_timing');
    const vars = await decisionVars(sql, cohort, userId, memberMessage, attempt ? attempt.amount_cents : 0, refunds.refundMessage(attempt, attempt && attempt.amount_cents, timing));
    await email.enqueue(sql, { key: 'rejection', dedupeKey: `decision:${result.decision.id}`, to: prof.email, userId, cohortId: cohort.id, vars, bodyOverride,
      related: { type: 'decision', id: result.decision.id }, actor: who.actor });
  }
  const sent = await email.processOutbox(sql, { ids: (await sql`select id from so_email_outbox where dedupe_key = ${`decision:${result.decision.id}`}`).map(r => r.id) });
  const next = (await memberRows(sql, cohort)).map(rowOut).filter(FILTERS.awaiting).filter(m => m.user_id !== userId)
    .sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at))[0];
  return {
    decision: result.decision.decision,
    refund: attempt ? { status: attempt.status, amount_cents: attempt.amount_cents, failure_reason: attempt.failure_reason } : null,
    email: sent[0] ? sent[0].status : 'not_sent',
    next_user_id: next ? next.user_id : null,
  };
}, 'decide');

// Deliberate, audited reopening of an approval (never of a rejection/refund).
routes['POST admin/members/:id/reopen'] = can(async ({ sql, req, query, params, admin: who }) => {
  const cohort = await cohortFor(sql, query);
  const userId = H.uuid(params.id, 'member');
  const reason = H.text(H.body(req).reason, { max: 1000, required: true, field: 'Reason', multiline: true });
  const e = (await sql`update so_enrollments set review_state = 'pending', review_version = review_version + 1, updated_at = now()
                       where user_id = ${userId} and cohort_id = ${cohort.id} and review_state = 'approved' returning *`)[0];
  if (!e) throw new HttpError(409, 'not_approved', 'Only approved enrollments can be reopened. Rejected, refunded enrollments can’t be reversed here.');
  await sql`insert into so_review_decisions (enrollment_id, decision, actor, internal_note) values (${e.id}, 'reopened', ${who.actor}, ${reason})`;
  await C.audit(sql, who.actor, 'enrollment_reopened', 'enrollment', e.id, { review_state: 'approved' }, { review_state: 'pending', reason });
  return { ok: true };
}, 'decide');

routes['POST admin/refunds/:id/retry'] = can(async ({ sql, params, admin: who }) => {
  const id = H.uuid(params.id, 'refund');
  const a = (await sql`select * from so_refund_attempts where id = ${id}`)[0];
  if (!a) throw new HttpError(404, 'not_found', 'Unknown refund.');
  if (a.status !== 'failed') throw new HttpError(409, 'not_failed', 'Only a failed refund can be retried.');
  if (/already fully refunded/.test(a.failure_reason || '')) throw new HttpError(409, 'needs_manual_check', 'Stripe says this payment is already refunded. Check it in Stripe instead of retrying.');
  await sql`update so_refund_attempts set status = 'queued', needs_attention = false, updated_at = now() where id = ${id}`;
  const out = await refunds.executeRefund(sql, id);
  await C.audit(sql, who.actor, 'refund_retried', 'refund', id, { status: 'failed' }, { status: out.status });
  return { refund: { status: out.status, failure_reason: out.failure_reason } };
}, 'finance');

// ---------------------------------------------------------------- overview
async function salesTotals(sql, cohort, from, to) {
  const live = liveOnly();
  const g = (await sql`select coalesce(sum(amount_paid_cents), 0)::int as gross, count(*)::int as n,
      count(*) filter (where price_tier = 'intro')::int as intro, count(*) filter (where price_tier = 'regular')::int as regular,
      coalesce(sum(fee_cents), 0)::int as fees, count(fee_cents)::int as fees_known, coalesce(sum(tax_cents), 0)::int as tax
    from so_purchases where cohort_id = ${cohort.id} and paid_at is not null and (${!live} or livemode)
      and (${from}::timestamptz is null or paid_at >= ${from}) and (${to}::timestamptz is null or paid_at < ${to})`)[0];
  const r = (await sql`select coalesce(sum(ra.amount_cents) filter (where ra.status = 'succeeded'), 0)::int as completed,
      coalesce(sum(ra.amount_cents) filter (where ra.status in ('queued', 'pending', 'requires_action')), 0)::int as pending,
      count(*) filter (where ra.status = 'failed')::int as failed
    from so_refund_attempts ra join so_purchases p on p.id = ra.purchase_id
    where p.cohort_id = ${cohort.id} and (${!live} or p.livemode)
      and (${from}::timestamptz is null or ra.created_at >= ${from}) and (${to}::timestamptz is null or ra.created_at < ${to})`)[0];
  return { gross_cents: g.gross, purchases: g.n, intro_count: g.intro, regular_count: g.regular, fee_cents: g.fees_known ? g.fees : null,
    fees_known_for: g.fees_known, tax_cents: g.tax, refunds_completed_cents: r.completed, refunds_pending_cents: r.pending, refunds_failed: r.failed,
    net_cents: g.gross - r.completed, net_after_fees_cents: g.fees_known === g.n && g.n ? g.gross - r.completed - g.fees : null,
    data: live ? 'live' : 'test' };
}

routes['GET admin/home'] = can(async ({ sql, query, now, admin: who }) => {
  const cohort = await cohortFor(sql, query);
  const members = (await memberRows(sql, cohort)).map(rowOut);
  const paid = members.filter(m => m.enrollment_id && m.review_status !== 'rejected' && (m.paid || m.payment_status === 'manual'));
  const awaiting = members.filter(FILTERS.awaiting).sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));
  const calls = await C.loadMemberCalls(sql, cohort, now);
  const next = C.nextCall(calls);
  const nextChallenges = next ? (await sql`select count(*)::int as n from so_call_challenges where call_id = ${next.id}`)[0].n : 0;
  const unassigned = (await sql`select count(*)::int as n from so_call_challenges where cohort_id = ${cohort.id} and call_id is null and status = 'submitted'`)[0].n;
  const newQuestions = (await sql`select count(*)::int as n from so_support_threads where status = 'new' and (cohort_id = ${cohort.id} or cohort_id is null)`)[0].n;

  const att = [];
  const add = (kind, text, link, severity = 'normal') => att.push({ kind, text, link, severity });
  if (awaiting.length) add('review', `${awaiting.length} paid ${awaiting.length === 1 ? 'member is' : 'members are'} waiting for your review (oldest submitted ${new Date(awaiting[0].submitted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: cohort.timezone })}).`, '#members/awaiting', 'high');
  const incompletePaid = members.filter(m => m.enrollment_id && m.info_status !== 'submitted' && m.review_status !== 'rejected');
  if (incompletePaid.length) add('info', `${incompletePaid.length} paid ${incompletePaid.length === 1 ? 'member hasn’t' : 'members haven’t'} submitted complete information.`, '#members/incomplete');
  if (who.perms.includes('finance')) {
    const fr = (await sql`select count(*)::int as n from so_refund_attempts ra join so_purchases p on p.id = ra.purchase_id
                          where p.cohort_id = ${cohort.id} and (ra.status = 'failed' or ra.needs_attention)`)[0].n;
    if (fr) add('refund', `${fr} refund${fr === 1 ? '' : 's'} failed or need attention.`, '#sales/refunds', 'high');
    const rv = (await sql`select count(*)::int as n from so_purchases where cohort_id = ${cohort.id} and needs_review is not null`)[0].n;
    if (rv) add('payment', `${rv} payment${rv === 1 ? '' : 's'} flagged for review (dispute, capacity or amount).`, '#sales/flagged');
    const wh = (await sql`select count(*)::int as n from so_webhook_events where status = 'failed'`)[0].n;
    if (wh) add('webhook', `${wh} payment event${wh === 1 ? '' : 's'} from Stripe failed to process.`, '#settings/log', 'high');
  }
  const ef = await sql`select template_key, count(*)::int as n from so_email_outbox where cohort_id = ${cohort.id} and status in ('failed', 'bounced', 'complained') group by 1`;
  const efTotal = ef.reduce((a, r) => a + r.n, 0);
  if (efTotal) add('email', `${efTotal} email${efTotal === 1 ? '' : 's'} failed or bounced${ef.some(r => ['approval', 'rejection'].includes(r.template_key)) ? ', including decision emails' : ''}.`, '#settings/emails/failed', 'high');
  if (newQuestions) add('question', `${newQuestions} new question${newQuestions === 1 ? '' : 's'} from members.`, '#settings/questions');
  // Content readiness for days unlocking within 7 days.
  const sched = S.schedule(cohort);
  const days = await sql`select * from so_days where cohort_id = ${cohort.id} order by day_number`;
  const resources = await C.loadResourcesWithDays(sql, cohort.id);
  const rmap = new Map(resources.map(r => [r.id, r]));
  const links = await sql`select dr.* from so_day_resources dr join so_days d on d.id = dr.day_id where d.cohort_id = ${cohort.id}`;
  const soon = days.filter(d => {
    const u = sched.days[d.day_number - 1];
    const ms = u ? u.unlock_at - now : -1;
    return ms > -86400000 && ms < 7 * 86400000 && C.dayReadiness(d, links.filter(l => l.day_id === d.id), rmap).length;
  });
  if (soon.length) add('content', `Day ${soon.map(d => d.day_number).join(', ')} ${soon.length === 1 ? 'unlocks' : 'unlock'} within 7 days and ${soon.length === 1 ? 'isn’t' : 'aren’t'} ready.`, '#program', 'high');
  const noLink = (await sql`select count(*)::int as n from so_calls where cohort_id = ${cohort.id} and status = 'scheduled'
                            and (meeting_url is null or meeting_url = '') and starts_at between ${now} and ${new Date(+now + 14 * 86400000)}`)[0].n;
  if (noLink) add('call', `${noLink} upcoming Solutions Seat call${noLink === 1 ? ' is' : 's are'} missing a meeting link.`, '#seat', 'high');
  const content = await C.loadContent(sql);
  const sales = await C.salesReadiness(sql, cohort, content, now);
  if (sales.mode !== 'live' || sales.blockers.length) add('launch', `${sales.blockers.length} launch item${sales.blockers.length === 1 ? '' : 's'} still needed before live sales.`, '#settings/readiness');

  const totals = who.perms.includes('finance') ? await salesTotals(sql, cohort, null, null) : null;
  return {
    now: now.toISOString(), cohort: { id: cohort.id, name: cohort.name, timezone: cohort.timezone, phase: S.phase(cohort, now) },
    cards: {
      sales: totals ? { gross_cents: totals.gross_cents, purchases: totals.purchases, scope: 'All time, this cohort (successful payments before refunds)', data: totals.data } : null,
      paid_members: { total: paid.length, awaiting: paid.filter(m => m.review_status === 'pending' || m.review_status === 'awaiting_submission').length,
        approved: paid.filter(m => m.review_status === 'approved').length },
      awaiting_review: awaiting.length,
      next_call: next ? { id: next.id, title: next.title, starts_at: next.starts_at, challenges: nextChallenges, unassigned_challenges: unassigned } : null,
    },
    attention: att.sort((a, b) => (a.severity === 'high' ? 0 : 1) - (b.severity === 'high' ? 0 : 1)),
    new_questions: newQuestions,
    seats: { limit: cohort.seat_limit, taken: await require('./payments').seatsTaken(sql, cohort, now) },
  };
}, 'view');

// ---------------------------------------------------------------------- sales
async function transactions(sql, cohort, query) {
  const live = liveOnly();
  const { from, to } = range(cohort, query);
  const rows = await sql`
    select pu.id, pu.user_id, pu.status, pu.price_tier, pu.amount_cents, pu.amount_paid_cents, pu.tax_cents, pu.fee_cents, pu.refunded_cents,
           pu.currency, pu.paid_at, pu.created_at, pu.livemode, pu.receipt_url, pu.stripe_payment_intent_id, pu.needs_review,
           p.email, coalesce(nullif(trim(concat_ws(' ', i.first_name, i.last_name)), ''), p.display_name, p.email) as name,
           e.review_state, (select status from so_refund_attempts ra where ra.purchase_id = pu.id order by created_at desc limit 1) as refund_status
    from so_purchases pu join so_profiles p on p.user_id = pu.user_id
    left join so_intakes i on i.user_id = pu.user_id and i.cohort_id = pu.cohort_id
    left join so_enrollments e on e.purchase_id = pu.id
    where pu.cohort_id = ${cohort.id} and pu.status in ('pending', 'paid', 'failed', 'refunded', 'partially_refunded', 'disputed')
      and (${!live} or pu.livemode is not false)
      and (${from}::timestamptz is null or coalesce(pu.paid_at, pu.created_at) >= ${from}) and (${to}::timestamptz is null or coalesce(pu.paid_at, pu.created_at) < ${to})
    order by coalesce(pu.paid_at, pu.created_at) desc`;
  return rows.filter(r => (!query.state || r.status === query.state) && (!query.review || r.review_state === query.review)
    && (!query.tier || r.price_tier === query.tier) && (!query.refund || (query.refund === 'any' ? !!r.refund_status : r.refund_status === query.refund))
    && (query.flagged !== '1' || r.needs_review));
}

routes['GET admin/sales'] = can(async ({ sql, query }) => {
  const cohort = await cohortFor(sql, query);
  const rg = range(cohort, query);
  const totals = await salesTotals(sql, cohort, rg.from, rg.to);
  const live = liveOnly();
  const series = await sql`select to_char(paid_at at time zone ${cohort.timezone}, 'YYYY-MM-DD') as day, sum(amount_paid_cents)::int as cents, count(*)::int as n
                           from so_purchases where cohort_id = ${cohort.id} and paid_at is not null and (${!live} or livemode)
                             and (${rg.from}::timestamptz is null or paid_at >= ${rg.from}) and (${rg.to}::timestamptz is null or paid_at < ${rg.to})
                           group by 1 order by 1`;
  const review = (await sql`select count(*) filter (where e.review_state = 'pending')::int as awaiting, count(*) filter (where e.review_state = 'approved')::int as approved,
                                   count(*) filter (where e.review_state = 'rejected')::int as rejected
                            from so_enrollments e join so_purchases p on p.id = e.purchase_id where e.cohort_id = ${cohort.id} and p.paid_at is not null and (${!live} or p.livemode)`)[0];
  return {
    scope: rg.label, totals, review, series,
    definitions: {
      gross: 'Successful payments, before refunds, by payment date.',
      refunds: 'Completed = Stripe confirmed. Pending = started, not yet confirmed. By refund start date.',
      net: 'Gross minus completed refunds. Not profit.',
      fees: 'Stripe processing fees, where Stripe reported them.',
    },
    transactions: (await transactions(sql, cohort, query)).slice(0, 500).map(r => ({
      ...r, provider_link: r.stripe_payment_intent_id ? `https://dashboard.stripe.com/${r.livemode === false ? 'test/' : ''}payments/${r.stripe_payment_intent_id}` : null,
    })),
  };
}, 'finance');

function csvCell(v) {
  let s = v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function sendCsv(res, name, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 200;
  res.end('﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
  return H.HANDLED;
}
const usd = c => (c == null ? '' : (c / 100).toFixed(2));

routes['GET admin/sales/export'] = can(async ({ sql, query, res, admin: who }) => {
  const cohort = await cohortFor(sql, query);
  const rows = await transactions(sql, cohort, query);
  await C.audit(sql, who.actor, 'sales_exported', 'cohort', cohort.id, null, { rows: rows.length, filters: query });
  return sendCsv(res, 'smooth-operators-sales.csv', [
    ['Date', 'Buyer', 'Email', 'Price', 'Paid', 'Tax', 'Refunded', 'Currency', 'Payment state', 'Review', 'Refund', 'Test', 'Stripe payment'],
    ...rows.map(r => [r.paid_at ? new Date(r.paid_at).toISOString().slice(0, 10) : '', r.name, r.email, r.price_tier, usd(r.amount_paid_cents), usd(r.tax_cents),
      usd(r.refunded_cents), r.currency, r.status, r.review_state || '', r.refund_status || '', r.livemode === false, r.stripe_payment_intent_id || '']),
  ]);
}, 'finance');

// Members export: fit-check answers, no journal text.
routes['GET admin/members/export'] = can(async ({ sql, query, res, admin: who }) => {
  const cohort = await cohortFor(sql, query);
  const base = (await memberRows(sql, cohort)).map(rowOut).filter(FILTERS[FILTERS[query.filter] ? query.filter : 'all']);
  const intakes = await sql`select * from so_intakes where cohort_id = ${cohort.id}`;
  const im = new Map(intakes.map(i => [i.user_id, i]));
  const qs = intakeMod.QUESTIONS;
  await C.audit(sql, who.actor, 'members_exported', 'cohort', cohort.id, null, { rows: base.length, filter: query.filter || 'all' });
  return sendCsv(res, 'smooth-operators-members.csv', [
    ['Email', ...qs.map(q => q[1]), 'Information', 'Review', 'Payment', 'Amount paid', 'Price', 'Submitted', 'Last active', 'Test'],
    ...base.map(m => {
      const ans = intakeMod.answersOut(im.get(m.user_id) || null);
      return [m.email, ...ans.map(a => a.answer || ''), m.info_status, m.review_status, m.payment_status, usd(m.amount_paid_cents), m.price_tier || '',
        m.submitted_at ? new Date(m.submitted_at).toISOString().slice(0, 10) : '', m.last_active ? new Date(m.last_active).toISOString().slice(0, 10) : '', m.is_test];
    }),
  ]);
}, 'finance');

// ------------------------------------------------------------------ progress
routes['GET admin/progress'] = can(async ({ sql, query, now }) => {
  const cohort = await cohortFor(sql, query);
  const rows = await sql`
    select e.user_id, p.email, coalesce(nullif(trim(concat_ws(' ', i.first_name, i.last_name)), ''), p.display_name, p.email) as name, i.business_name,
      (select count(*)::int from so_day_progress dp where dp.user_id = e.user_id and dp.cohort_id = e.cohort_id and dp.started_at is not null) as started,
      (select count(*)::int from so_day_progress dp where dp.user_id = e.user_id and dp.cohort_id = e.cohort_id and dp.completed_at is not null) as completed,
      (select count(*)::int from so_events ev where ev.user_id = e.user_id and ev.cohort_id = e.cohort_id and ev.name = 'day_opened') as days_opened,
      greatest((select max(created_at) from so_events ev where ev.user_id = e.user_id and ev.cohort_id = e.cohort_id),
               (select max(updated_at) from so_day_progress dp where dp.user_id = e.user_id and dp.cohort_id = e.cohort_id),
               (select max(updated_at) from so_journal_entries je where je.user_id = e.user_id and je.cohort_id = e.cohort_id)) as last_active
    from so_enrollments e join so_profiles p on p.user_id = e.user_id
    left join so_intakes i on i.user_id = e.user_id and i.cohort_id = e.cohort_id
    where e.cohort_id = ${cohort.id} and e.review_state = 'approved' and e.access_state = 'active'`;
  const week = 7 * 86400000;
  const members = rows.map(r => ({ ...r,
    status: r.last_active && now - new Date(r.last_active) < week && (r.started || r.completed || r.days_opened) ? 'recently_active'
      : r.started || r.completed ? 'started' : 'not_started' }));
  const perDay = await sql`select d.day_number, d.title, count(dp.completed_at)::int as completed, count(dp.started_at)::int as started
                           from so_days d left join so_day_progress dp on dp.day_id = d.id
                             and dp.user_id in (select user_id from so_enrollments where cohort_id = ${cohort.id} and review_state = 'approved')
                           where d.cohort_id = ${cohort.id} group by d.day_number, d.title order by d.day_number`;
  return {
    summary: { members: members.length, not_started: members.filter(m => m.status === 'not_started').length,
      started: members.filter(m => m.status === 'started').length, recently_active: members.filter(m => m.status === 'recently_active').length },
    per_day: perDay, members,
    definitions: {
      started: 'Saved a reflection or played a practice on at least one day.',
      completed: 'Days the member chose to mark complete. Completion is voluntary.',
      recently_active: 'Started, and did something in the app in the last 7 days.',
      caveat: 'Opening or downloading a template is not completed work, and clicking a call link is not attendance. Journal writing is private and never counted or shown.',
    },
  };
}, 'view');

// ------------------------------------------------------------ Solutions Seat
routes['GET admin/challenges'] = can(async ({ sql, query }) => {
  const cohort = await cohortFor(sql, query);
  const rows = await sql`
    select ch.id, ch.user_id, ch.call_id, ch.body, ch.working_on, ch.stuck_on, ch.help_wanted, ch.share_permission, ch.status, ch.facilitator_note, ch.created_at,
           p.email, coalesce(nullif(trim(concat_ws(' ', i.first_name, i.last_name)), ''), p.display_name, p.email) as name, i.business_name, c.title as call_title, c.starts_at
    from so_call_challenges ch join so_profiles p on p.user_id = ch.user_id
    left join so_intakes i on i.user_id = ch.user_id and i.cohort_id = ch.cohort_id
    left join so_calls c on c.id = ch.call_id
    where ch.cohort_id = ${cohort.id} order by ch.created_at desc`;
  return { challenges: rows };
}, 'support');

routes['PUT admin/challenges/:id'] = can(async ({ sql, req, params }) => {
  const id = H.uuid(params.id, 'challenge');
  const b = H.body(req);
  const cur = (await sql`select * from so_call_challenges where id = ${id}`)[0];
  if (!cur) throw new HttpError(404, 'not_found', 'Unknown challenge.');
  const status = b.status !== undefined ? H.oneOf(b.status, ['submitted', 'selected', 'discussed', 'follow_up'], 'Status') : cur.status;
  const note = b.facilitator_note !== undefined ? (H.text(b.facilitator_note, { max: 3000, field: 'Facilitator note', multiline: true }) || null) : cur.facilitator_note;
  const callId = b.call_id !== undefined ? (b.call_id ? H.uuid(b.call_id, 'call') : null) : cur.call_id;
  const rows = await sql`update so_call_challenges set status = ${status}, facilitator_note = ${note}, call_id = ${callId}, updated_at = now() where id = ${id}
                         returning id, status, facilitator_note, call_id`;
  return { challenge: rows[0] };
}, 'support');

routes['GET admin/calls/:id/prep'] = can(async ({ sql, params }) => {
  const id = H.uuid(params.id, 'call');
  const call = (await sql`select * from so_calls where id = ${id}`)[0];
  if (!call) throw new HttpError(404, 'not_found', 'Unknown call.');
  const selected = await sql`
    select ch.*, coalesce(nullif(trim(concat_ws(' ', i.first_name, i.last_name)), ''), p.display_name, p.email) as name, i.business_name,
           i.business_stage, i.revenue_to_date, i.team_size
    from so_call_challenges ch join so_profiles p on p.user_id = ch.user_id
    left join so_intakes i on i.user_id = ch.user_id and i.cohort_id = ch.cohort_id
    where ch.status = 'selected' and (ch.call_id = ${id} or ch.call_id is null) and ch.cohort_id = ${call.cohort_id}
    order by ch.created_at`;
  return { call, selected: selected.map(s => ({ ...s, stage: intakeMod.label('business_stage', s.business_stage),
    revenue: intakeMod.label('revenue_to_date', s.revenue_to_date), team: intakeMod.label('team_size', s.team_size) })) };
}, 'support');

// --------------------------------------------------------------------- emails
routes['GET admin/emails'] = can(async ({ sql, query }) => {
  const cohort = await cohortFor(sql, query);
  const st = query.status === 'failed' ? ['failed', 'bounced', 'complained'] : query.status ? [query.status] : null;
  const rows = await sql`select id, template_key, template_version, category, to_email, subject, status, last_error, edited, attempts, created_at, submitted_at,
                                delivered_at, actor, related_type, related_id, resend_of, user_id
                         from so_email_outbox where (cohort_id = ${cohort.id} or cohort_id is null)
                           and (${st}::text[] is null or status = any(${st})) order by created_at desc limit 300`;
  return { emails: rows, mode: env.emailMode(), resend_configured: !!process.env.RESEND_API_KEY, delivery_webhook: !!process.env.RESEND_WEBHOOK_SECRET };
}, 'view');

routes['GET admin/emails/:id'] = can(async ({ sql, params }) => {
  const m = (await sql`select * from so_email_outbox where id = ${H.uuid(params.id, 'email')}`)[0];
  if (!m) throw new HttpError(404, 'not_found', 'Unknown email.');
  return { email: m };
}, 'view');

// Re-send the same content as a new message. Never repeats the approval/refund behind it.
routes['POST admin/emails/:id/resend'] = can(async ({ sql, params, admin: who }) => {
  const m = (await sql`select * from so_email_outbox where id = ${H.uuid(params.id, 'email')}`)[0];
  if (!m) throw new HttpError(404, 'not_found', 'Unknown email.');
  if (['queued', 'sending'].includes(m.status)) throw new HttpError(409, 'in_flight', 'This email is still being sent.');
  const n = (await sql`select count(*)::int as n from so_email_outbox where resend_of = ${m.id}`)[0].n;
  const rows = await sql`insert into so_email_outbox (dedupe_key, template_key, template_version, category, user_id, cohort_id, to_email, subject, body_text,
                           edited, related_type, related_id, actor, resend_of)
                         values (${`${m.dedupe_key}:resend:${n + 1}`}, ${m.template_key}, ${m.template_version}, ${m.category}, ${m.user_id}, ${m.cohort_id},
                           ${m.to_email}, ${m.subject}, ${m.body_text}, ${m.edited}, ${m.related_type}, ${m.related_id}, ${who.actor}, ${m.id}) returning id`;
  await C.audit(sql, who.actor, 'email_resent', 'email', m.id, null, { new_id: rows[0].id });
  const out = await email.processOutbox(sql, { ids: [rows[0].id] });
  return { id: rows[0].id, status: out[0] ? out[0].status : 'queued' };
}, 'decide');

routes['POST admin/emails/process'] = can(async ({ sql }) => ({ results: await email.processOutbox(sql, { limit: 50 }) }), 'settings');

routes['GET admin/email-templates'] = can(async ({ sql }) => {
  const out = [];
  for (const key of Object.keys(email.DEFAULTS)) {
    const t = await email.loadTemplate(sql, key);
    const meta = email.templateMeta(key);
    out.push({ ...meta, subject: t.subject, body: t.body, version: t.version, enabled: t.enabled, customized: t.version > 0 });
  }
  return { templates: out };
}, 'view');

routes['GET admin/email-templates/:key/versions'] = can(async ({ sql, params }) => ({
  versions: await sql`select version, subject, body, created_at, created_by from so_email_template_versions where key = ${params.key} order by version desc`,
}), 'view');

routes['PUT admin/email-templates/:key'] = can(async ({ sql, req, params, admin: who }) => {
  const key = params.key;
  if (!email.DEFAULTS[key]) throw new HttpError(404, 'not_found', 'Unknown template.');
  const b = H.body(req);
  const subject = H.text(b.subject, { max: 200, required: true, field: 'Subject' });
  const body = H.text(b.body, { max: 10000, required: true, field: 'Body', multiline: true });
  email.validateTemplate(key, subject, body);
  if (key === 'rejection' && !/{{\s*refund_message\s*}}/.test(body)) throw new HttpError(400, 'invalid_template', 'The rejection email must include {{refund_message}} so it states the real refund status.');
  const transactional = email.DEFAULTS[key][1] === 'transactional';
  const enabled = b.enabled === undefined ? true : b.enabled === true;
  if (!enabled && ['approval', 'rejection', 'purchase_next_steps'].includes(key)) throw new HttpError(400, 'invalid_input', 'Decision and payment emails can’t be switched off.');
  void transactional;
  const row = await sql.begin(async tx => {
    const cur = (await tx`select version from so_email_templates where key = ${key} for update`)[0];
    const version = (cur ? cur.version : 0) + 1;
    const r = (await tx`insert into so_email_templates (key, subject, body, version, enabled, updated_by) values (${key}, ${subject}, ${body}, ${version}, ${enabled}, ${who.actor})
                        on conflict (key) do update set subject = excluded.subject, body = excluded.body, version = excluded.version, enabled = excluded.enabled,
                          updated_at = now(), updated_by = excluded.updated_by returning *`)[0];
    await tx`insert into so_email_template_versions (key, version, subject, body, created_by) values (${key}, ${version}, ${subject}, ${body}, ${who.actor})`;
    return r;
  });
  await C.audit(sql, who.actor, 'email_template_updated', 'email_template', key, null, { version: row.version });
  return { template: row };
}, 'settings');

async function sampleVars(sql, cohort) {
  return { ...(await email.baseVars(sql, cohort, null)), first_name: 'Jordan', member_message: '(Your personal note to the member appears here.)',
    refund_amount: '$999.00', refund_message: refunds.refundMessage({ status: 'pending', amount_cents: 99900 }, 99900, (await C.loadContent(sql)).get('purchase.refund_timing')),
    thread_subject: 'Question about my account', thread_link: `${env.siteUrl()}${env.BASE_PATH}/app/help`, call_title: 'Solutions Seat',
    call_time: 'Tuesday, January 5 at 10:00 a.m. PST' };
}

routes['POST admin/email-templates/:key/preview'] = can(async ({ sql, req, query, params }) => {
  const key = params.key;
  if (!email.DEFAULTS[key]) throw new HttpError(404, 'not_found', 'Unknown template.');
  const b = H.body(req);
  const t = await email.loadTemplate(sql, key);
  const subject = b.subject || t.subject, body = b.body || t.body;
  email.validateTemplate(key, subject, body);
  const vars = await sampleVars(sql, await cohortFor(sql, query));
  return { subject: email.render(subject, vars), body: email.render(body, vars) };
}, 'view');

routes['POST admin/email-templates/:key/test'] = can(async ({ sql, req, query, params, admin: who }) => {
  const key = params.key;
  if (!email.DEFAULTS[key]) throw new HttpError(404, 'not_found', 'Unknown template.');
  const to = H.text(H.body(req).to, { max: 200, required: true, field: 'Test recipient' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new HttpError(400, 'invalid_input', 'Enter a valid email address.');
  await H.rateLimit(sql, `test-email:${who.actor}`, 20, 3600);
  const cohort = await cohortFor(sql, query);
  const m = await email.enqueue(sql, { key, dedupeKey: `test:${key}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, to, cohortId: cohort.id,
    vars: await sampleVars(sql, cohort), actor: who.actor, category: 'test', subjectOverride: `[TEST] ${(await email.loadTemplate(sql, key)).subject}` });
  const out = await email.processOutbox(sql, { ids: [m.id] });
  return { status: out[0] ? out[0].status : 'queued' };
}, 'settings');

// Optional reminders: only approved, active members who opted in. Preview count first.
const PREF_FOR = { introductions_open: 'intros_open', kickoff: 'cohort_begins', call_reminder: 'upcoming_calls' };
routes['POST admin/emails/broadcast'] = can(async ({ sql, req, query, admin: who }) => {
  const cohort = await cohortFor(sql, query);
  const b = H.body(req);
  const key = H.oneOf(b.key, Object.keys(PREF_FOR), 'Reminder');
  let call = null;
  if (key === 'call_reminder') {
    call = (await sql`select * from so_calls where id = ${H.uuid(b.call_id, 'call')} and cohort_id = ${cohort.id} and status = 'scheduled'`)[0];
    if (!call) throw new HttpError(400, 'invalid_input', 'Choose a scheduled call.');
  }
  const pref = PREF_FOR[key];
  const recipients = await sql`select p.user_id, p.email from so_enrollments e join so_profiles p on p.user_id = e.user_id
                               where e.cohort_id = ${cohort.id} and e.review_state = 'approved' and e.access_state = 'active'
                                 and coalesce((p.email_prefs ->> ${pref})::boolean, false)`;
  if (b.confirm !== true) return { recipients: recipients.length, preference: pref };
  let queued = 0;
  for (const r of recipients) {
    const vars = { ...(await email.baseVars(sql, cohort, r.user_id)),
      call_title: call ? call.title : '', call_time: call ? `${new Date(call.starts_at).toLocaleString('en-US', { timeZone: cohort.timezone, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}` : '' };
    const m = await email.enqueue(sql, { key, dedupeKey: `${key}:${cohort.id}:${call ? call.id : 'all'}:${r.user_id}`, to: r.email, userId: r.user_id, cohortId: cohort.id,
      vars, actor: who.actor, related: call ? { type: 'call', id: call.id } : null });
    if (m) queued++;
  }
  await C.audit(sql, who.actor, 'reminder_sent', 'email', key, null, { recipients: recipients.length, queued });
  const results = await email.processOutbox(sql, { limit: 500 });
  return { recipients: recipients.length, queued, results: results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {}) };
}, 'settings');

// ---------------------------------------------------------------------- staff
routes['GET admin/staff'] = can(async ({ sql }) => ({
  staff: await sql`select email, display_name, role, updated_at from so_profiles where role <> 'member' order by role, email`,
}), 'staff');

routes['PUT admin/staff'] = can(async ({ sql, req, admin: who }) => {
  const b = H.body(req);
  const em = H.text(b.email, { max: 200, required: true, field: 'Email' }).toLowerCase();
  const role = H.oneOf(b.role, ['member', 'support', 'admin'], 'Role');
  const rows = await sql`update so_profiles set role = ${role}, updated_at = now() where email = ${em} and role <> 'owner' returning email, role`;
  if (!rows[0]) throw new HttpError(404, 'no_account', 'That person needs to sign in once at /smoothoperators/login first (owners can only be changed in the database).');
  await C.audit(sql, who.actor, 'staff_role_changed', 'profile', em, null, { role });
  return { staff: rows[0] };
}, 'staff');

module.exports = { routes, cohortFor };
