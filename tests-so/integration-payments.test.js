'use strict';
// Checkout -> verified payment -> enrollment, against a real Postgres and the
// app's real webhook signature verification.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./support/harness');

let h;
test.before(async () => { h = await boot(); });
test.after(async () => { await h.close(); });

const enrollments = async userId => (await h.sql`select * from so_enrollments where user_id = ${userId}`);
const stripeCreates = () => h.mocks.state.stripeCalls.filter(c => c.path === '/v1/checkout/sessions').length;

test('landing page shows dates, host, server price and test-mode label', async () => {
  const res = await fetch(`${h.appBase}/smoothoperators`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /You’ve built a business\. Now stop being what holds it together\./);
  assert.match(html, /SMOOTH OPERATORS · LIVE 21-DAY COHORT/);
  assert.match(html, /January 4–24, 2027/);
  assert.match(html, /Omi Bell/);
  assert.match(html, /Join the Cohort — \$999/);
  assert.match(html, /Save \$498 through November 30\. Regular enrollment: \$1,497\./);
  assert.match(html, /11:59 p\.m\. PST on November 30, 2026 \(America\/Los_Angeles\)/);
  assert.match(html, /Test mode\./);
  assert.doesNotMatch(html, /Questions<\/h2>/, 'draft FAQs are not published');
});

test('after the cutoff the landing page drops the expired offer', async () => {
  await h.setCohort({ price_cutoff_at: new Date(Date.now() - 1000) });
  const html = await (await fetch(`${h.appBase}/smoothoperators`)).text();
  assert.match(html, /Join the Cohort — \$1,497/);
  assert.doesNotMatch(html, /\$999/);
  assert.doesNotMatch(html, /Save \$498/);
  await h.setCohort({ price_cutoff_at: new Date('2026-12-01T08:00:00Z') });
});

test('checkout requires a verified signed-in identity', async () => {
  const r = await h.api('POST', 'checkout/session', { body: {} });
  assert.equal(r.status, 401);
  const forged = await h.api('POST', 'checkout/session', { token: 'a.b.c', body: {} });
  assert.equal(forged.status, 401);
});

test('price comes from server time; client-sent amounts are ignored', async () => {
  const { token } = await h.buyer('price@example.com');
  const r = await h.api('POST', 'checkout/session', { token, body: { amount_cents: 1, price_tier: 'intro', unit_amount: 100 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'redirect');
  assert.equal(r.body.amount_cents, 99900);
  const call = h.mocks.state.stripeCalls.at(-1);
  assert.equal(call.form['line_items[0][price_data][unit_amount]'], '99900');
  assert.equal(call.form['line_items[0][price_data][currency]'], 'usd');
  assert.equal(call.form.mode, 'payment');
});

test('repeated and concurrent clicks reuse one checkout session', async () => {
  const { token, user } = await h.buyer('clicks@example.com');
  const before = stripeCreates();
  const results = await Promise.all(Array.from({ length: 5 }, () => h.api('POST', 'checkout/session', { token, body: {} })));
  const urls = new Set(results.map(r => r.body.url));
  assert.equal(urls.size, 1);
  assert.ok(stripeCreates() - before <= 1 || new Set(h.mocks.state.stripeCalls.slice(before).map(c => c.form.client_reference_id)).size === 1,
    'at most one purchase reaches Stripe (idempotency key dedupes retries)');
  const purchases = await h.sql`select * from so_purchases where user_id = ${user.id}`;
  assert.equal(purchases.length, 1);
});

test('intro quote is honoured until its own expiry, then new sessions use the regular price', async () => {
  const { token, user } = await h.buyer('cutoff@example.com');
  const first = await h.api('POST', 'checkout/session', { token, body: {} });
  assert.equal(first.body.amount_cents, 99900);

  // Cutoff passes while the session is still open: same session, same quote.
  await h.setCohort({ price_cutoff_at: new Date(Date.now() - 1000) });
  const again = await h.api('POST', 'checkout/session', { token, body: {} });
  assert.equal(again.body.url, first.body.url);
  assert.equal(again.body.amount_cents, 99900);
  assert.equal(again.body.reused, true);

  // Once that session reaches expiry, a new session is quoted at $1,497 and the old one is expired at Stripe.
  await h.sql`update so_purchases set expires_at = now() + interval '30 seconds' where user_id = ${user.id} and status = 'open'`;
  const fresh = await h.api('POST', 'checkout/session', { token, body: {} });
  assert.notEqual(fresh.body.url, first.body.url);
  assert.equal(fresh.body.amount_cents, 149700);
  const oldSessionId = first.body.url.split('/pay/')[1];
  assert.equal(h.mocks.state.sessions.get(oldSessionId).status, 'expired');
  const rows = await h.sql`select status, price_tier from so_purchases where user_id = ${user.id} order by created_at`;
  assert.deepEqual(rows.map(r => `${r.status}:${r.price_tier}`), ['expired:intro', 'open:regular']);
  await h.setCohort({ price_cutoff_at: new Date('2026-12-01T08:00:00Z') });
});

test('success redirect alone never grants access; cancel never grants access', async () => {
  const { token, user } = await h.buyer('noaccess@example.com');
  const r = await h.api('POST', 'checkout/session', { token, body: {} });
  const sid = r.body.url.split('/pay/')[1];
  const status = await h.api('GET', `checkout/status?session_id=${sid}`, { token });
  assert.equal(status.body.state, 'not_completed');
  assert.equal((await enrollments(user.id)).length, 0);
  const home = await h.api('GET', 'home', { token });
  assert.equal(home.status, 403);
  assert.equal(home.body.error, 'not_enrolled');
});

test('a forged or wrongly signed webhook is rejected', async () => {
  const res = await fetch(`${h.appBase}/api/smoothoperators-webhook`, {
    method: 'POST', headers: { 'Stripe-Signature': 't=1,v1=deadbeef', 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', data: { object: {} } }),
  });
  assert.equal(res.status, 400);
});

test('verified payment enrolls exactly once, even with duplicate and repeated webhooks', async () => {
  const { token, user } = await h.buyer('payer@example.com');
  const r = await h.api('POST', 'checkout/session', { token, body: {} });
  const sid = r.body.url.split('/pay/')[1];
  const s = await h.mocks.completeSession(sid);
  const first = await h.mocks.sendEvent('checkout.session.completed', s);
  assert.equal(first.status, 200);

  // Same event delivered again (Stripe retry).
  const dupRes = await fetch(`${h.appBase}/api/smoothoperators-webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': require('../api/_lib/so/stripe').signPayload(first.payload, h.WEBHOOK_SECRET) },
    body: first.payload,
  });
  assert.equal((await dupRes.json()).duplicate, true);
  // A different event for the same session (e.g. async_payment_succeeded).
  await h.mocks.sendEvent('checkout.session.async_payment_succeeded', s);

  const en = await enrollments(user.id);
  assert.equal(en.length, 1);
  assert.equal(en[0].access_state, 'active');
  assert.equal(en[0].is_test, true, 'test-mode payments are flagged as test enrollments');
  const emails = await h.sql`select * from so_email_log where user_id = ${user.id}`;
  assert.equal(emails.length, 1, 'confirmation is attempted once');

  const status = await h.api('GET', `checkout/status?session_id=${sid}`, { token });
  assert.equal(status.body.state, 'confirmed');
  // Enrolled members are not charged again through ordinary navigation.
  const before = stripeCreates();
  const again = await h.api('POST', 'checkout/session', { token, body: {} });
  assert.equal(again.body.state, 'already_enrolled');
  assert.equal(stripeCreates(), before);
  const home = await h.api('GET', 'home', { token });
  assert.equal(home.status, 200);
});

test('delayed webhook: returning to the success page reconciles with Stripe server-side', async () => {
  h.mocks.state.webhookMode = 'none';
  const { token, user } = await h.buyer('delayed@example.com');
  const r = await h.api('POST', 'checkout/session', { token, body: {} });
  const sid = r.body.url.split('/pay/')[1];
  await h.mocks.completeSession(sid);
  const status = await h.api('GET', `checkout/status?session_id=${sid}`, { token });
  assert.equal(status.body.state, 'confirmed');
  assert.equal((await enrollments(user.id)).length, 1);
  // The webhook arriving later changes nothing.
  await h.mocks.sendEvent('checkout.session.completed', h.mocks.state.sessions.get(sid));
  assert.equal((await enrollments(user.id)).length, 1);
  h.mocks.state.webhookMode = 'immediate';
});

test('a session id cannot be claimed by a different account', async () => {
  const a = await h.buyer('owner-a@example.com');
  const b = await h.buyer('owner-b@example.com');
  const r = await h.api('POST', 'checkout/session', { token: a.token, body: {} });
  const sid = r.body.url.split('/pay/')[1];
  await h.mocks.completeSession(sid);
  const theft = await h.api('GET', `checkout/status?session_id=${sid}`, { token: b.token });
  assert.equal(theft.status, 404);
  assert.equal((await enrollments(b.user.id)).length, 0);
  assert.equal((await h.api('GET', `checkout/status?session_id=${sid}`, { token: a.token })).body.state, 'confirmed');
});

test('delayed payment methods stay pending until Stripe confirms; failure grants nothing', async () => {
  h.mocks.state.webhookMode = 'none';
  const ok = await h.buyer('async-ok@example.com');
  const r1 = await h.api('POST', 'checkout/session', { token: ok.token, body: {} });
  const s1 = await h.mocks.completeSession(r1.body.url.split('/pay/')[1], { paid: false });
  await h.mocks.sendEvent('checkout.session.completed', s1);
  assert.equal((await h.api('GET', `checkout/status?session_id=${s1.id}`, { token: ok.token })).body.state, 'pending');
  assert.equal((await h.api('POST', 'checkout/session', { token: ok.token, body: {} })).body.state, 'pending', 'no second charge while pending');
  s1.payment_status = 'paid';
  await h.mocks.sendEvent('checkout.session.async_payment_succeeded', s1);
  assert.equal((await enrollments(ok.user.id))[0].access_state, 'active');

  const bad = await h.buyer('async-bad@example.com');
  const r2 = await h.api('POST', 'checkout/session', { token: bad.token, body: {} });
  const s2 = await h.mocks.completeSession(r2.body.url.split('/pay/')[1], { paid: false });
  await h.mocks.sendEvent('checkout.session.completed', s2);
  await h.mocks.sendEvent('checkout.session.async_payment_failed', s2);
  assert.equal((await h.api('GET', `checkout/status?session_id=${s2.id}`, { token: bad.token })).body.state, 'failed');
  assert.equal((await enrollments(bad.user.id)).length, 0);
  h.mocks.state.webhookMode = 'immediate';
});

test('refunds suspend access per policy without deleting the member’s writing', async () => {
  const { token, user } = await h.buyer('refund@example.com');
  const r = await h.api('POST', 'checkout/session', { token, body: {} });
  const s = await h.mocks.completeSession(r.body.url.split('/pay/')[1]);
  await h.mocks.sendEvent('checkout.session.completed', s);
  const c = await h.cohort();
  const day = (await h.sql`select id from so_days where cohort_id = ${c.id} and day_number = 1`)[0];
  await h.sql`insert into so_journal_entries (user_id, cohort_id, day_id, body) values (${user.id}, ${c.id}, ${day.id}, 'private words')`;

  await h.mocks.sendEvent('charge.refunded', { id: 'ch_1', object: 'charge', payment_intent: s.payment_intent, amount: 99900, amount_refunded: 99900 });
  assert.equal((await enrollments(user.id))[0].access_state, 'refunded');
  assert.equal((await h.api('GET', 'home', { token })).status, 403);
  assert.equal((await h.sql`select count(*)::int as n from so_journal_entries where user_id = ${user.id}`)[0].n, 1);
  const p = (await h.sql`select status from so_purchases where stripe_payment_intent_id = ${s.payment_intent}`)[0];
  assert.equal(p.status, 'refunded');
});

test('disputes keep access by default and restore cleanly when won', async () => {
  const { token, user } = await h.buyer('dispute@example.com');
  const r = await h.api('POST', 'checkout/session', { token, body: {} });
  const s = await h.mocks.completeSession(r.body.url.split('/pay/')[1]);
  await h.mocks.sendEvent('checkout.session.completed', s);
  await h.mocks.sendEvent('charge.dispute.created', { id: 'dp_1', object: 'dispute', payment_intent: s.payment_intent, status: 'needs_response' });
  assert.equal((await enrollments(user.id))[0].access_state, 'active');
  const p = (await h.sql`select status, needs_review from so_purchases where stripe_payment_intent_id = ${s.payment_intent}`)[0];
  assert.equal(p.status, 'disputed');
  assert.equal(p.needs_review, 'dispute_open');
  await h.mocks.sendEvent('charge.dispute.closed', { id: 'dp_1', object: 'dispute', payment_intent: s.payment_intent, status: 'won' });
  assert.equal((await h.sql`select status from so_purchases where stripe_payment_intent_id = ${s.payment_intent}`)[0].status, 'paid');
});

test('live-mode checkout stays disabled until every launch requirement is met', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_live_placeholder';
  try {
    const offer = await h.api('GET', 'offer');
    assert.equal(offer.body.sales.mode, 'live');
    assert.equal(offer.body.sales.can_checkout, false);
    const { token } = await h.buyer('live@example.com');
    const r = await h.api('POST', 'checkout/session', { token, body: {} });
    assert.equal(r.body.state, 'unavailable');
    const html = await (await fetch(`${h.appBase}/smoothoperators`)).text();
    assert.match(html, /Enrollment opens soon\./);
    assert.doesNotMatch(html, /href="\/smoothoperators\/checkout"/);
    const ov = await h.api('GET', 'admin/overview', { token: h.adminToken });
    const keys = ov.body.sales.blockers.map(b => b.key);
    for (const k of ['settings_confirmed', 'access_policy', 'content:purchase.refund_policy', 'content:legal.terms', 'content:legal.privacy', 'content:support.email', 'calls', 'email', 'sales_enabled']) {
      assert.ok(keys.includes(k), `missing blocker ${k}`);
    }
  } finally {
    process.env.STRIPE_SECRET_KEY = 'sk_test_local';
  }
});

test('test-mode checkout is refused on the production deployment unless explicitly allowed', async () => {
  process.env.VERCEL_ENV = 'production';
  try {
    const offer = await h.api('GET', 'offer');
    assert.equal(offer.body.sales.can_checkout, false);
  } finally {
    delete process.env.VERCEL_ENV;
  }
});

test('checkout requires the fit check, and the fit check validates answers', async () => {
  const { token } = await h.mocks.signIn('nofit@example.com');
  assert.equal((await h.api('POST', 'checkout/session', { token, body: {} })).body.state, 'intake_required');
  const missingAck = await h.api('PUT', 'intake', { token, body: { ...h.FIT, policy_ack: false } });
  assert.equal(missingAck.status, 400);
  assert.match(missingAck.body.message, /refund policy/);
  assert.equal((await h.api('PUT', 'intake', { token, body: { ...h.FIT, revenue_to_date: 'a lot' } })).status, 400);
  assert.equal((await h.api('PUT', 'intake', { token, body: { ...h.FIT, postal_code: '9461' } })).status, 400);
  assert.equal((await h.api('PUT', 'intake', { token, body: { ...h.FIT, website_url: '', no_website: false } })).status, 400);
  assert.equal((await h.api('PUT', 'intake', { token, body: { ...h.FIT, website_url: '', no_website: true } })).status, 200);
  const outside = await h.api('PUT', 'intake', { token, body: { ...h.FIT, state: 'OUTSIDE_US', postal_code: 'M5V 2T6', country: 'Canada' } });
  assert.equal(outside.status, 200);
  assert.equal(outside.body.intake.country, 'Canada');
  const early = await h.api('PUT', 'intake', { token, body: { ...h.FIT, business_stage: 'idea', revenue_to_date: 'under_10k' } });
  assert.equal(early.body.intake.early_stage, true, 'early-stage founders get a gentle note, not a block');
  assert.equal((await h.api('POST', 'checkout/session', { token, body: {} })).body.state, 'redirect');
  // Fit-check details never reach the public offer or landing page.
  const html = await (await fetch(`${h.appBase}/smoothoperators`)).text();
  assert.doesNotMatch(html, /555-0100|1 Main St/);
});

test('hidden seat limit: site says "All seats are full" without revealing the number', async () => {
  const c = await h.cohort();
  const taken = (await h.sql`select count(*)::int as n from so_enrollments where cohort_id = ${c.id} and access_state = 'active'`)[0].n;
  const holder = await h.buyer('seat-holder@example.com');
  await h.api('POST', 'checkout/session', { token: holder.token, body: {} }); // holds a seat while open
  const holds = (await h.sql`select count(*)::int as n from so_purchases where status in ('open','created','pending') and expires_at > now()
                             and user_id not in (select user_id from so_enrollments where access_state = 'active')`)[0].n;
  await h.setCohort({ seat_limit: taken + holds });
  const late = await h.buyer('too-late@example.com');
  assert.equal((await h.api('POST', 'checkout/session', { token: late.token, body: {} })).body.state, 'full');
  const offer = await h.api('GET', 'offer');
  assert.equal(offer.body.sales.reason, 'full');
  assert.doesNotMatch(offer.text, /seat_limit|seats_taken/);
  const html = await (await fetch(`${h.appBase}/smoothoperators`)).text();
  assert.match(html, /All seats are full\./);
  assert.doesNotMatch(html, /\b30\b.*seats|seats left/i);
  // The person already holding a checkout can still finish it.
  assert.equal((await h.api('POST', 'checkout/session', { token: holder.token, body: {} })).body.state, 'redirect');
  assert.equal((await h.api('GET', 'offer', { token: holder.token })).body.sales.can_checkout, true);
  await h.setCohort({ seat_limit: 30 });
});

test('review: approve makes it non-refundable; not a fit refunds in full and ends access', async () => {
  const admin = (m, p, body) => h.api(m, p, { token: h.adminToken, body });
  const pay = async email => {
    const s = await h.buyer(email);
    const r = await h.api('POST', 'checkout/session', { token: s.token, body: {} });
    const sess = await h.mocks.completeSession(r.body.url.split('/pay/')[1]);
    await h.mocks.sendEvent('checkout.session.completed', sess);
    const e = (await h.sql`select * from so_enrollments where user_id = ${s.user.id}`)[0];
    return { ...s, e, sess };
  };
  const yes = await pay('approve-me@example.com');
  assert.equal(yes.e.review_state, 'pending');
  assert.equal((await h.api('GET', 'home', { token: yes.token })).body.review_state, 'pending');
  const ok = await admin('POST', `admin/enrollments/${yes.e.id}/review`, { decision: 'approved' });
  assert.equal(ok.body.enrollment.review_state, 'approved');
  const noRefund = await admin('POST', `admin/enrollments/${yes.e.id}/review`, { decision: 'not_a_fit' });
  assert.equal(noRefund.status, 409, 'approved enrollments are non-refundable through review');

  const no = await pay('not-a-fit@example.com');
  const before = h.mocks.state.stripeCalls.filter(c => c.path === '/v1/refunds').length;
  const nf = await admin('POST', `admin/enrollments/${no.e.id}/review`, { decision: 'not_a_fit', note: 'pre-revenue' });
  assert.equal(nf.status, 200);
  const refunds = h.mocks.state.stripeCalls.filter(c => c.path === '/v1/refunds');
  assert.equal(refunds.length, before + 1);
  assert.equal(refunds.at(-1).form.payment_intent, no.sess.payment_intent);
  assert.equal((await h.api('GET', 'home', { token: no.token })).status, 403);
  await h.mocks.sendEvent('charge.refunded', { id: 'ch_nf', object: 'charge', payment_intent: no.sess.payment_intent, amount: 99900, amount_refunded: 99900 });
  assert.equal((await h.sql`select status from so_purchases where stripe_payment_intent_id = ${no.sess.payment_intent}`)[0].status, 'refunded');
  assert.equal((await h.sql`select review_state from so_enrollments where id = ${no.e.id}`)[0].review_state, 'not_a_fit');
  // Members can't change their fit check after review.
  assert.equal((await h.api('PUT', 'intake', { token: yes.token, body: h.FIT })).status, 409);

  // Members dashboard shows fit-check details and CSV export guards against formulas.
  await h.api('PUT', 'intake', { token: (await h.buyer('formula@example.com', { business_name: '=HYPERLINK("x")' })).token, body: { ...h.FIT, business_name: '=HYPERLINK("x")' } });
  const m = await admin('GET', 'admin/members');
  const row = m.body.members.find(x => x.email === 'approve-me@example.com');
  assert.equal(row.intake.phone, '(555) 555-0100');
  assert.equal(row.intake.labels.revenue_to_date, '$100K–$250K');
  assert.ok(m.body.unpaid.some(u => u.email === 'formula@example.com'), 'unpaid fit checks are listed for follow-up');
  const csv = await admin('GET', 'admin/members/export');
  assert.match(csv.text, /First name,Last name,Email,Phone/);
  assert.match(csv.text, /approve-me@example\.com/);
  assert.equal((await h.api('GET', 'admin/members', { token: yes.token })).status, 403);
  assert.equal((await h.api('GET', 'admin/members/export')).status, 403);
});
