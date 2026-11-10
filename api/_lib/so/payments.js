'use strict';
// Checkout -> payment -> enrollment.
//
// Access is granted ONLY by activatePurchase(), which runs when Stripe tells us
// (via a signature-verified webhook, or a server-to-server session lookup)
// that a Checkout Session we created is complete and paid. A success redirect
// on its own never grants anything.
//
// Introductory-price policy (explicit and tested): price is chosen by server
// time when a Checkout Session is created. A session created before the cutoff
// keeps its quoted price until that session's own expiry (cohort
// checkout_ttl_minutes, enforced by Stripe via expires_at). Any new session
// after the cutoff is created at the regular price. Open sessions are never
// silently repriced.

const S = require('./schedule');
const C = require('./core');
const H = require('./http');
const stripe = require('./stripe');
const env = require('./env');
const { requireUser, ensureProfile } = require('./identity');
const { sendTransactional, confirmationEmail } = require('./email');

const { HttpError } = H;
const INFLIGHT = ['created', 'open', 'pending'];

function priceOut(price) {
  return {
    tier: price.tier, amount_cents: price.amount_cents, regular_cents: price.regular_cents,
    intro_cents: price.intro_cents, savings_cents: price.savings_cents, intro_active: price.intro_active,
    cutoff_at: price.cutoff_at ? price.cutoff_at.toISOString() : null, currency: price.currency,
  };
}

async function offerPayload(sql, now) {
  const cohort = await C.loadCohort(sql);
  const content = await C.loadContent(sql);
  const sched = S.schedule(cohort);
  const readiness = await C.salesReadiness(sql, cohort, content, now);
  return {
    cohort: {
      name: cohort.name, timezone: cohort.timezone, start_date: sched.start_date, end_date: sched.end_date,
      starts_at: sched.starts_at.toISOString(), days_count: cohort.days_count,
    },
    price: priceOut(S.priceAt(cohort, now)),
    sales: { mode: readiness.mode, can_checkout: readiness.can_checkout, reason: readiness.reason, test_mode: readiness.test_mode },
    disclosure: {
      refund_policy: content.isPublished('purchase.refund_policy') ? content.get('purchase.refund_policy') : null,
      access_terms: content.isPublished('purchase.access_terms') ? content.get('purchase.access_terms') : null,
      tax_treatment: content.isPublished('purchase.tax_treatment') ? content.get('purchase.tax_treatment') : null,
      extra: content.isPublished('purchase.disclosure') ? content.get('purchase.disclosure') : null,
      terms_published: content.isPublished('legal.terms'),
      privacy_published: content.isPublished('legal.privacy'),
    },
    support_email: content.isPublished('support.email') ? content.get('support.email') : null,
  };
}

// Optional pre-created Stripe Prices. When configured, their amount/currency
// must exactly match the server-side price or checkout refuses to start.
async function lineItemFor(cohort, price) {
  const priceId = price.tier === 'intro' ? process.env.STRIPE_PRICE_ID_INTRO : process.env.STRIPE_PRICE_ID_REGULAR;
  if (priceId) {
    const p = await stripe.retrievePrice(priceId);
    if (p.unit_amount !== price.amount_cents || p.currency !== price.currency || p.type !== 'one_time' || !p.active) {
      console.error('[so] configured Stripe price does not match server price', price.tier);
      throw new HttpError(503, 'price_misconfigured', 'Checkout is temporarily unavailable. Please contact support.');
    }
    return { price: priceId, quantity: 1 };
  }
  const sched = S.schedule(cohort);
  return {
    quantity: 1,
    price_data: {
      currency: price.currency,
      unit_amount: price.amount_cents,
      product_data: {
        name: `${cohort.name} — Live 21-Day Cohort`,
        description: `Live guided cohort with Omi Bell, ${sched.start_date} to ${sched.end_date}. One-time payment.`,
      },
    },
  };
}

async function createStripeSession(req, cohort, purchase, user) {
  const price = { tier: purchase.price_tier, amount_cents: purchase.amount_cents, currency: purchase.currency };
  const meta = { purchase_id: purchase.id, user_id: user.id, cohort_id: cohort.id, price_tier: purchase.price_tier };
  const params = {
    mode: 'payment',
    client_reference_id: purchase.id,
    customer_email: user.email,
    line_items: [await lineItemFor(cohort, price)],
    metadata: meta,
    payment_intent_data: { metadata: meta, receipt_email: user.email },
    expires_at: Math.floor(new Date(purchase.expires_at).getTime() / 1000),
    success_url: `${env.appUrl(req, '/checkout/success')}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.appUrl(req, '/checkout')}?canceled=1`,
  };
  if (process.env.STRIPE_AUTOMATIC_TAX === 'true') params.automatic_tax = { enabled: true };
  return stripe.createCheckoutSession(params, `so-purchase-${purchase.id}`);
}

async function checkoutSession({ sql, req, now }) {
  const user = await requireUser(req);
  await ensureProfile(sql, user);
  const cohort = await C.loadCohort(sql);
  const enrollment = await C.loadEnrollment(sql, user.id, cohort.id);
  if (enrollment && enrollment.access_state === 'active') return { state: 'already_enrolled' };
  if (enrollment && enrollment.access_state !== 'refunded') return { state: 'contact_support', reason: enrollment.access_state };

  const content = await C.loadContent(sql);
  const readiness = await C.salesReadiness(sql, cohort, content, now);
  if (!readiness.can_checkout) {
    return { state: readiness.reason === 'enrollment_closed' ? 'enrollment_closed' : 'unavailable', reason: readiness.reason };
  }
  await H.rateLimit(sql, `checkout:${user.id}`, 12, 600);

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      // Retiring a stale session may have discovered it was actually paid.
      const e = await C.loadEnrollment(sql, user.id, cohort.id);
      if (e && e.access_state === 'active') return { state: 'already_enrolled' };
    }
    const existing = (await sql`select * from so_purchases where user_id = ${user.id} and cohort_id = ${cohort.id}
                                and status = any(${INFLIGHT}) limit 1`)[0];
    if (existing) {
      if (existing.status === 'pending') return { state: 'pending' };
      if (existing.status === 'open' && S.quoteStillValid(existing, now)) {
        return { state: 'redirect', url: existing.checkout_url, reused: true, price_tier: existing.price_tier, amount_cents: existing.amount_cents };
      }
      if (existing.status === 'created' && new Date(existing.expires_at) > now) {
        // A previous attempt stopped before Stripe answered. The idempotency key
        // makes Stripe return the same session instead of creating another.
        return finishSession(sql, req, cohort, existing, user, now);
      }
      // Expired (or about to): close it out before quoting a fresh price.
      await retireSession(sql, existing);
      continue;
    }
    const price = S.priceAt(cohort, now);
    // +60s so the provider's minimum expiry is met despite network latency.
    const expiresAt = new Date(now.getTime() + (cohort.checkout_ttl_minutes * 60 + 60) * 1000);
    const ins = await sql`
      insert into so_purchases (user_id, cohort_id, status, price_tier, amount_cents, currency, quoted_at, expires_at)
      values (${user.id}, ${cohort.id}, 'created', ${price.tier}, ${price.amount_cents}, ${price.currency}, ${now}, ${expiresAt})
      on conflict do nothing returning *`;
    if (!ins[0]) continue; // another click won the race; loop to reuse it
    return finishSession(sql, req, cohort, ins[0], user, now);
  }
  throw new HttpError(409, 'busy', 'Your checkout is already being prepared. Please try again.');
}

async function finishSession(sql, req, cohort, purchase, user, now) {
  const session = await createStripeSession(req, cohort, purchase, user);
  const rows = await sql`
    update so_purchases set status = 'open', stripe_session_id = ${session.id}, checkout_url = ${session.url},
      expires_at = to_timestamp(${session.expires_at}), livemode = ${!!session.livemode}, updated_at = now()
    where id = ${purchase.id} and status = 'created' returning *`;
  const p = rows[0] || (await sql`select * from so_purchases where id = ${purchase.id}`)[0];
  C.recordEvent(sql, 'checkout_started', { userId: user.id, cohortId: cohort.id, refId: p.price_tier });
  return { state: 'redirect', url: p.checkout_url, reused: false, price_tier: p.price_tier, amount_cents: p.amount_cents };
}

// Expire a stale session at Stripe (so it can't be paid later) and locally.
async function retireSession(sql, purchase) {
  if (purchase.stripe_session_id) {
    try {
      const s = await stripe.expireCheckoutSession(purchase.stripe_session_id);
      await applySession(sql, s);
    } catch (e) {
      // Already expired or completed: look at the truth and apply it.
      const s = await stripe.retrieveCheckoutSession(purchase.stripe_session_id);
      await applySession(sql, s);
      if (s.status === 'complete') return;
    }
  }
  await sql`update so_purchases set status = 'expired', updated_at = now()
            where id = ${purchase.id} and status in ('created', 'open')`;
}

// Apply the provider's view of a Checkout Session to our records.
async function applySession(sql, session) {
  if (!session || !session.id) return { applied: false };
  let purchase = (await sql`select * from so_purchases where stripe_session_id = ${session.id}`)[0];
  if (!purchase && session.metadata && session.metadata.purchase_id && /^[0-9a-f-]{36}$/i.test(session.metadata.purchase_id)) {
    const p = (await sql`select * from so_purchases where id = ${session.metadata.purchase_id}`)[0];
    if (p && !p.stripe_session_id) {
      await sql`update so_purchases set stripe_session_id = ${session.id} where id = ${p.id} and stripe_session_id is null`;
      purchase = { ...p, stripe_session_id: session.id };
    }
  }
  if (!purchase) return { applied: false, reason: 'unknown_session' };

  if (session.status === 'complete' && session.payment_status === 'paid') {
    return activatePurchase(sql, purchase, {
      paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent && session.payment_intent.id,
      amountTotal: session.amount_total, amountSubtotal: session.amount_subtotal,
      currency: session.currency, livemode: !!session.livemode,
    });
  }
  if (session.status === 'complete') {
    // Delayed payment methods: complete but not yet paid.
    await sql`update so_purchases set status = 'pending', updated_at = now() where id = ${purchase.id} and status in ('created', 'open')`;
    return { applied: true, state: 'pending' };
  }
  if (session.status === 'expired') {
    await sql`update so_purchases set status = 'expired', updated_at = now() where id = ${purchase.id} and status in ('created', 'open')`;
    return { applied: true, state: 'expired' };
  }
  return { applied: false, state: 'open' };
}

async function activatePurchase(sql, purchase, { paymentIntent, amountTotal, amountSubtotal, currency, livemode }) {
  const result = await sql.begin(async tx => {
    const expected = purchase.amount_cents;
    const mismatch = (amountSubtotal != null && amountSubtotal !== expected) || (currency && currency !== purchase.currency);
    const up = await tx`
      update so_purchases set status = 'paid', paid_at = coalesce(paid_at, now()),
        stripe_payment_intent_id = coalesce(stripe_payment_intent_id, ${paymentIntent || null}),
        amount_paid_cents = ${amountTotal ?? null}, livemode = ${livemode},
        needs_review = case when ${mismatch} then 'amount_mismatch' else needs_review end, updated_at = now()
      where id = ${purchase.id} and status in ('created', 'open', 'pending', 'expired', 'failed', 'canceled')
      returning *`;
    if (!up[0]) return { activated: false, already: true };
    const p = up[0];
    const otherPaid = await tx`select id from so_purchases where user_id = ${p.user_id} and cohort_id = ${p.cohort_id}
                               and status = 'paid' and id <> ${p.id}`;
    if (otherPaid.length) await tx`update so_purchases set needs_review = 'duplicate_payment' where id = ${p.id}`;

    const en = await tx`
      insert into so_enrollments (user_id, cohort_id, purchase_id, source, access_state, is_test)
      values (${p.user_id}, ${p.cohort_id}, ${p.id}, 'stripe', 'active', ${!livemode})
      on conflict (user_id, cohort_id) do update set
        access_state = case when so_enrollments.access_state = 'refunded' then 'active' else so_enrollments.access_state end,
        purchase_id  = case when so_enrollments.access_state = 'refunded' or so_enrollments.purchase_id is null
                            then excluded.purchase_id else so_enrollments.purchase_id end,
        updated_at = now()
      returning *`;
    return { activated: true, purchase: p, enrollment: en[0] };
  });
  if (result.activated) {
    C.recordEvent(sql, 'payment_confirmed', { userId: result.purchase.user_id, cohortId: result.purchase.cohort_id, refId: result.purchase.price_tier });
    await sendConfirmation(sql, result.enrollment).catch(e => console.error('[so] confirmation email error', e.message));
  }
  return { applied: true, state: 'paid', ...result };
}

async function sendConfirmation(sql, enrollment) {
  const cohort = (await sql`select * from so_cohorts where id = ${enrollment.cohort_id}`)[0];
  const profile = (await sql`select email from so_profiles where user_id = ${enrollment.user_id}`)[0];
  if (!profile) return;
  const content = await C.loadContent(sql);
  const sched = S.schedule(cohort);
  const msg = confirmationEmail({
    cohortName: cohort.name, startDate: sched.start_date, endDate: sched.end_date,
    returnUrl: `${env.siteUrl()}${env.BASE_PATH}/login?next=${encodeURIComponent('/app')}`,
    supportEmail: content.isPublished('support.email') ? content.get('support.email') : null,
  });
  const r = await sendTransactional(sql, {
    dedupeKey: `enrollment-confirmed:${enrollment.id}`, kind: 'enrollment_confirmed', userId: enrollment.user_id,
    to: profile.email, ...msg,
  });
  if (r.status === 'sent' || r.status.startsWith('skipped')) {
    await sql`update so_enrollments set confirmation_email_sent_at = coalesce(confirmation_email_sent_at, now())
              where id = ${enrollment.id} and ${r.status === 'sent'}`;
  }
}

// Return from Stripe: verify server-side, reconciling if the webhook is late.
async function checkoutStatus({ sql, req, query }) {
  const user = await requireUser(req);
  const cohort = await C.loadCohort(sql);
  const sid = H.text(query.session_id, { max: 255, field: 'session' });
  if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) throw new HttpError(404, 'not_found', 'We could not find that checkout.');
  const purchase = (await sql`select * from so_purchases where stripe_session_id = ${sid} and user_id = ${user.id}`)[0];
  // Someone else's (or a made-up) session id looks the same as a missing one.
  if (!purchase) throw new HttpError(404, 'not_found', 'We could not find that checkout for this account.');

  const enrolled = async () => {
    const e = await C.loadEnrollment(sql, user.id, cohort.id);
    return e && e.access_state === 'active';
  };
  if (purchase.status === 'paid' && await enrolled()) return { state: 'confirmed' };
  try {
    const session = await stripe.retrieveCheckoutSession(sid);
    await applySession(sql, session);
  } catch (e) {
    return { state: 'verification_error' };
  }
  const p = (await sql`select status from so_purchases where id = ${purchase.id}`)[0];
  if (p.status === 'paid' && await enrolled()) return { state: 'confirmed' };
  if (p.status === 'pending') return { state: 'pending' };
  if (p.status === 'failed') return { state: 'failed' };
  if (p.status === 'expired' || p.status === 'canceled') return { state: 'expired' };
  if (p.status === 'refunded' || p.status === 'disputed') return { state: 'contact_support' };
  return { state: 'not_completed' };
}

// ----------------------------------------------------------- webhooks
async function purchaseByPaymentIntent(sql, pi) {
  if (!pi) return null;
  const id = typeof pi === 'string' ? pi : pi.id;
  return (await sql`select * from so_purchases where stripe_payment_intent_id = ${id}`)[0] || null;
}

async function setEnrollmentForPurchase(sql, purchase, fromStates, toState) {
  await sql`update so_enrollments set access_state = ${toState}, updated_at = now()
            where purchase_id = ${purchase.id} and access_state = any(${fromStates})`;
}

async function handleEvent(sql, event) {
  const obj = event.data && event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.expired':
      return applySession(sql, obj);
    case 'checkout.session.async_payment_failed': {
      await sql`update so_purchases set status = 'failed', updated_at = now()
                where stripe_session_id = ${obj.id} and status in ('created', 'open', 'pending')`;
      return { applied: true };
    }
    case 'charge.refunded': {
      const p = await purchaseByPaymentIntent(sql, obj.payment_intent);
      if (!p) return { applied: false };
      const cohort = (await sql`select * from so_cohorts where id = ${p.cohort_id}`)[0];
      const full = obj.amount_refunded >= obj.amount;
      await sql`update so_purchases set status = ${full ? 'refunded' : 'partially_refunded'},
                refunded_at = coalesce(refunded_at, now()), updated_at = now() where id = ${p.id}`;
      // Access data (journal, progress) is never deleted; only the access state changes.
      if (full && cohort.refund_access_action === 'suspend') await setEnrollmentForPurchase(sql, p, ['active', 'disputed'], 'refunded');
      await C.audit(sql, 'stripe', full ? 'purchase_refunded' : 'purchase_partially_refunded', 'purchase', p.id, null,
        { access_action: full ? cohort.refund_access_action : 'keep' });
      return { applied: true };
    }
    case 'charge.dispute.created': {
      const p = await purchaseByPaymentIntent(sql, obj.payment_intent);
      if (!p) return { applied: false };
      const cohort = (await sql`select * from so_cohorts where id = ${p.cohort_id}`)[0];
      await sql`update so_purchases set status = 'disputed', needs_review = 'dispute_open', updated_at = now() where id = ${p.id}`;
      if (cohort.dispute_access_action === 'suspend') await setEnrollmentForPurchase(sql, p, ['active'], 'disputed');
      await C.audit(sql, 'stripe', 'purchase_disputed', 'purchase', p.id, null, { access_action: cohort.dispute_access_action });
      return { applied: true };
    }
    case 'charge.dispute.closed': {
      const p = await purchaseByPaymentIntent(sql, obj.payment_intent);
      if (!p) return { applied: false };
      const cohort = (await sql`select * from so_cohorts where id = ${p.cohort_id}`)[0];
      if (obj.status === 'won') {
        await sql`update so_purchases set status = 'paid', needs_review = null, updated_at = now() where id = ${p.id}`;
        await setEnrollmentForPurchase(sql, p, ['disputed'], 'active');
      } else if (obj.status === 'lost') {
        await sql`update so_purchases set status = 'refunded', needs_review = 'dispute_lost', refunded_at = coalesce(refunded_at, now()), updated_at = now() where id = ${p.id}`;
        if (cohort.refund_access_action === 'suspend') await setEnrollmentForPurchase(sql, p, ['active', 'disputed'], 'refunded');
      }
      await C.audit(sql, 'stripe', 'dispute_closed', 'purchase', p.id, null, { outcome: obj.status });
      return { applied: true };
    }
    default:
      return { applied: false, ignored: true };
  }
}

async function processWebhook(sql, rawBody, signature) {
  const event = stripe.verifyWebhook(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  const mode = env.stripeMode();
  const obj = event.data && event.data.object;
  // Ignore events from the other Stripe mode (e.g. test events hitting live).
  if ((mode === 'live' && !event.livemode) || (mode === 'test' && event.livemode)) {
    return { status: 200, body: { received: true, ignored: 'mode_mismatch' } };
  }
  const rec = await sql`
    insert into so_webhook_events (id, type, livemode, object_id) values (${event.id}, ${event.type}, ${!!event.livemode}, ${obj && obj.id || null})
    on conflict (id) do update set attempts = so_webhook_events.attempts + 1
    returning status, (xmax = 0) as inserted`;
  if (!rec[0].inserted && ['processed', 'ignored'].includes(rec[0].status)) {
    return { status: 200, body: { received: true, duplicate: true } };
  }
  try {
    const r = await handleEvent(sql, event);
    await sql`update so_webhook_events set status = ${r.ignored ? 'ignored' : 'processed'}, processed_at = now(), error = null where id = ${event.id}`;
    return { status: 200, body: { received: true } };
  } catch (e) {
    await sql`update so_webhook_events set status = 'failed', error = ${String(e.code || e.message || 'error').slice(0, 200)} where id = ${event.id}`;
    console.error('[so] webhook processing failed', event.type, e.code || e.message);
    return { status: 500, body: { error: 'processing_failed' } }; // Stripe retries
  }
}

const routes = {
  'GET offer': async ({ sql, now }) => offerPayload(sql, now),
  'POST checkout/session': checkoutSession,
  'GET checkout/status': checkoutStatus,
};

module.exports = { routes, offerPayload, applySession, activatePurchase, processWebhook, handleEvent, sendConfirmation, retireSession };
