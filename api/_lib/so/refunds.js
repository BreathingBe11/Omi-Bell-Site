'use strict';
// Full refunds issued by an admin (pre-start refund requests).
//
// A refund attempt row is created in the same transaction as the rejection
// (one live attempt per purchase is enforced by a unique index). The Stripe
// call happens after commit with an idempotency key derived from the attempt,
// so a retry after a lost response returns the same refund. Before any retry
// we also list the payment's refunds at Stripe and adopt one we already made,
// which covers retries after Stripe's 24-hour idempotency window.
// Refund status is then kept in step by Stripe's refund webhooks.

const stripe = require('./stripe');
const email = require('./email');

const STRIPE_STATUS = { pending: 'pending', succeeded: 'succeeded', failed: 'failed', requires_action: 'requires_action', canceled: 'canceled' };

async function setFromRefund(sql, attempt, refund) {
  const status = STRIPE_STATUS[refund.status] || 'pending';
  const rows = await sql`
    update so_refund_attempts set status = ${status}, stripe_refund_id = coalesce(stripe_refund_id, ${refund.id}),
      amount_cents = coalesce(${refund.amount ?? null}, amount_cents), failure_reason = ${refund.failure_reason || null},
      needs_attention = ${status === 'failed' || status === 'requires_action' || status === 'canceled'}, updated_at = now()
    where id = ${attempt.id} returning *`;
  const updated = rows[0];
  if (status === 'succeeded' && attempt.status !== 'succeeded') await maybeSendCompleted(sql, updated);
  return updated;
}

async function maybeSendCompleted(sql, attempt) {
  const p = (await sql`select * from so_purchases where id = ${attempt.purchase_id}`)[0];
  const c = (await sql`select * from so_cohorts where id = ${p.cohort_id}`)[0];
  if (!c.send_refund_completed_email) return;
  const prof = (await sql`select email from so_profiles where user_id = ${p.user_id}`)[0];
  if (!prof) return;
  const vars = { ...(await email.baseVars(sql, c, p.user_id)), refund_amount: money(attempt.amount_cents || p.amount_paid_cents) };
  const m = await email.enqueue(sql, { key: 'refund_completed', dedupeKey: `refund-completed:${attempt.id}`, to: prof.email, userId: p.user_id,
    cohortId: c.id, vars, related: { type: 'refund', id: attempt.id }, actor: 'stripe' });
  if (m) await email.processOutbox(sql, { ids: [m.id] });
}

const money = c => (c == null ? '' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);

// Look for a refund we already created for this attempt (lost-response recovery).
async function findExisting(purchase, attempt) {
  if (!purchase.stripe_payment_intent_id) return null;
  try {
    const list = await stripe.stripeRequest('GET', '/v1/refunds', { payment_intent: purchase.stripe_payment_intent_id, limit: 20 });
    return (list.data || []).find(r => r.metadata && r.metadata.so_refund_attempt === attempt.id) || null;
  } catch { return null; }
}

// Calls Stripe for a queued/failed attempt. Never creates a second attempt.
async function executeRefund(sql, attemptId) {
  const attempt = (await sql`select * from so_refund_attempts where id = ${attemptId}`)[0];
  if (!attempt || ['succeeded', 'pending', 'canceled'].includes(attempt.status) && attempt.stripe_refund_id) return attempt;
  const purchase = (await sql`select * from so_purchases where id = ${attempt.purchase_id}`)[0];
  if (!purchase.stripe_payment_intent_id) {
    return (await sql`update so_refund_attempts set status = 'failed', failure_reason = 'No provider payment reference on this purchase.',
                      needs_attention = true, updated_at = now() where id = ${attempt.id} returning *`)[0];
  }
  const existing = await findExisting(purchase, attempt);
  if (existing) return setFromRefund(sql, attempt, existing);
  try {
    // Amount omitted = refund everything still refundable (including any tax). Stripe does not deduct fees from the buyer.
    const refund = await stripe.createRefund({
      payment_intent: purchase.stripe_payment_intent_id,
      reason: 'requested_by_customer',
      metadata: { so_refund_attempt: attempt.id, so_purchase: purchase.id, reason: 'enrollment_not_approved' },
    }, attempt.idempotency_key);
    return setFromRefund(sql, attempt, refund);
  } catch (e) {
    const code = e.stripe && e.stripe.code;
    const reason = code === 'charge_already_refunded' ? 'This payment was already fully refunded at Stripe. Check the payment before doing anything else.'
      : e.code === 'payment_provider_unreachable' || (e.stripe && e.stripe.status >= 500) ? 'Stripe could not be reached or had a temporary problem. It is safe to retry; a retry never creates a second refund.'
      : `Stripe refused the refund${code ? ` (${code})` : ''}.`;
    return (await sql`update so_refund_attempts set status = 'failed', failure_reason = ${reason}, needs_attention = true, updated_at = now()
                      where id = ${attempt.id} returning *`)[0];
  }
}

// Stripe refund object from a webhook (refund.created / refund.updated / refund.failed / charge.refund.updated).
async function applyRefundEvent(sql, refund) {
  let attempt = (await sql`select * from so_refund_attempts where stripe_refund_id = ${refund.id}`)[0];
  if (!attempt && refund.metadata && /^[0-9a-f-]{36}$/.test(refund.metadata.so_refund_attempt || '')) {
    attempt = (await sql`select * from so_refund_attempts where id = ${refund.metadata.so_refund_attempt}`)[0];
  }
  if (!attempt) {
    // Refund made outside the app (e.g. Stripe dashboard): record it so totals stay truthful.
    const p = refund.payment_intent ? (await sql`select * from so_purchases where stripe_payment_intent_id = ${refund.payment_intent}`)[0] : null;
    if (!p) return { applied: false };
    attempt = (await sql`insert into so_refund_attempts (purchase_id, amount_cents, currency, status, stripe_refund_id, idempotency_key, source, actor)
                         values (${p.id}, ${refund.amount ?? null}, ${refund.currency || 'usd'}, 'pending', ${refund.id}, ${`external-${refund.id}`}, 'external', 'stripe')
                         on conflict do nothing returning *`)[0];
    if (!attempt) return { applied: false };
  }
  await setFromRefund(sql, attempt, refund);
  return { applied: true };
}

// `timing` is the owner-approved refund-timing sentence (site content: purchase.refund_timing).
function refundMessage(attempt, amountCents, timing) {
  if (!attempt) return 'No payment was taken for this enrollment, so there is nothing to refund.';
  const amt = money(attempt.amount_cents || amountCents);
  if (attempt.status === 'succeeded' || attempt.status === 'pending') {
    return `We’ve initiated a full refund of ${amt} to your original payment method.${timing ? ` ${timing}` : ''}`;
  }
  return `Your full refund of ${amt} is being processed. We hit a delay starting it with our payment provider and are working on it now. We’ll email you when it’s on its way; you don’t need to do anything.`;
}

module.exports = { executeRefund, applyRefundEvent, refundMessage, money };
