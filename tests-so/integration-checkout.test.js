'use strict';
// Checkout without signing in first: form -> saved lead -> Stripe -> paid ->
// "set up your account" email -> sign in with the same email. Plus the one-time
// reminder for people who didn't pay, unsubscribe, and the daily cron.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./support/harness');

let h;
test.before(async () => { h = await boot(); });
test.after(async () => { await h.close(); });

const admin = (m, p, body) => h.api(m, p, { token: h.adminToken, body });
const APP = { first_name: 'Robin', last_name: 'Reyes', phone: '(555) 555-0142', postal_code: '90034', business_name: 'Reyes Studio',
  website_url: 'reyes.example.com', business_stage: 'growing', revenue_to_date: '250k_500k', years_in_business: '3_5', prior_ops_work: 'no',
  has_full_time_staff: 'yes', team_size: '3_5', ops_questions: 'How do I hand off client onboarding?' };
const start = ({ name, ...body }) => {
  const [first_name, ...rest] = (name || 'Robin Reyes').split(' ');
  return h.api('POST', 'checkout/start', { body: { ...APP, first_name, last_name: rest.join(' ') || 'Reyes', eligible: true, terms: true, ...body } });
};

test('the form validates and quietly rejects bots', async () => {
  assert.equal((await start({ email: 'not-an-email' })).status, 400);
  assert.equal((await start({ email: 'a@example.com', eligible: false })).status, 400);
  assert.equal((await start({ email: 'a@example.com', terms: false })).status, 400);
  assert.equal((await start({ email: 'a@example.com', first_name: '' })).status, 400);
  assert.equal((await start({ email: 'a@example.com', revenue_to_date: '' })).status, 400, 'revenue required');
  assert.equal((await start({ email: 'a@example.com', team_size: 'lots' })).status, 400, 'only listed choices');
  assert.equal((await start({ email: 'a@example.com', phone: '123' })).status, 400);
  assert.equal((await start({ email: 'a@example.com', postal_code: '' })).status, 400);
  assert.equal((await start({ email: 'a@example.com', ops_questions: '' })).status, 400);
  assert.equal((await start({ email: 'a@example.com', website_url: '' })).status, 400, 'website required');
  assert.equal((await start({ email: 'a@example.com', website_url: 'not a site' })).status, 400);
  assert.equal((await h.api('GET', 'checkout/form')).body.options.revenue_to_date.length, 8);
  assert.equal((await start({ email: 'bot@example.com', company_website: 'http://spam' })).status, 400);
  assert.equal((await h.sql`select count(*)::int as n from so_leads where email = 'bot@example.com'`)[0].n, 0);
});

test('continue to payment: no sign-in needed; the form is saved before Stripe opens', async () => {
  const r = await start({ email: '  Robin@Example.com ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.state, 'redirect');
  assert.equal(r.body.amount_cents, 99700);
  const lead = (await h.sql`select * from so_leads where email = 'robin@example.com'`)[0];
  assert.equal(lead.name, 'Robin Reyes');
  assert.equal(lead.status, 'started');
  assert.ok(lead.eligibility_confirmed_at && lead.terms_accepted_at);
  const user = (await h.sql`select id from auth.users where email = 'robin@example.com'`)[0];
  const app = (await h.sql`select * from so_intakes where user_id = ${user.id}`)[0];
  assert.equal(app.business_name, 'Reyes Studio');
  assert.equal(app.revenue_to_date, '250k_500k');
  assert.equal(app.years_in_business, '3_5');
  assert.equal(app.postal_code, '90034');
  assert.equal(app.phone, '(555) 555-0142');
  assert.match(app.website_url, /^https:\/\/reyes\.example\.com\/?$/);
  assert.equal(app.prior_ops_work, false);
  assert.equal(app.has_full_time_staff, true);
  assert.equal(app.ops_questions, 'How do I hand off client onboarding?');
  assert.equal(app.address_line1, null, 'no street address asked');
  assert.ok(user, 'account created for the email');
  assert.equal(lead.user_id, user.id);
  const prof = (await h.sql`select display_name, eligibility_confirmed_at from so_profiles where user_id = ${user.id}`)[0];
  assert.equal(prof.display_name, 'Robin Reyes');
  const call = h.mocks.state.stripeCalls.filter(x => x.path === '/v1/checkout/sessions').at(-1);
  assert.equal(call.form.customer_email, 'robin@example.com', 'Stripe gets the same email');
  // Going back and continuing again reuses the same account, lead and checkout.
  const again = await start({ email: 'robin@example.com' });
  assert.equal(again.body.reused, true);
  assert.equal((await h.sql`select checkout_count from so_leads where email = 'robin@example.com'`)[0].checkout_count, 2);
  assert.equal((await h.sql`select count(*)::int as n from auth.users where email = 'robin@example.com'`)[0].n, 1);
});

test('after paying: confirmed without signing in, account-setup email, and sign-in finds the enrollment', async () => {
  const r = await start({ email: 'paid-buyer@example.com', name: 'Pat Buyer' });
  const sid = r.body.url.split('/pay/')[1];
  const sess = await h.mocks.completeSession(sid);
  await h.mocks.sendEvent('checkout.session.completed', sess);
  const status = await h.api('GET', `checkout/status?session_id=${sid}`);
  assert.equal(status.status, 200);
  assert.equal(status.body.state, 'confirmed');
  assert.equal(status.body.email, 'paid-buyer@example.com');
  assert.equal((await h.api('GET', 'checkout/status?session_id=cs_test_madeupmadeup')).status, 404);
  const lead = (await h.sql`select status, paid_at from so_leads where email = 'paid-buyer@example.com'`)[0];
  assert.equal(lead.status, 'paid');
  const mail = (await h.sql`select subject, body_text from so_email_outbox where template_key = 'purchase_next_steps' and to_email = 'paid-buyer@example.com'`)[0];
  assert.match(mail.subject, /Set up your Smooth Operators account/);
  assert.match(mail.body_text, /login\?next=%2Fapp&email=paid-buyer%40example\.com/);
  assert.match(mail.body_text, /Sign in with Google or with a one-time code/);
  // Signing in later (code or Google) with that email lands in the same account.
  const s = await h.mocks.signIn('paid-buyer@example.com');
  const home = await h.api('GET', 'home', { token: s.token });
  assert.equal(home.status, 200);
  // Someone else signed in can't read this checkout.
  const other = await h.mocks.signIn('someone-else@example.com');
  assert.equal((await h.api('GET', `checkout/status?session_id=${sid}`, { token: other.token })).status, 404);
  // Using the form again with an enrolled email never charges twice or reveals details.
  const before = h.mocks.state.stripeCalls.filter(x => x.path === '/v1/checkout/sessions').length;
  const dup = await start({ email: 'paid-buyer@example.com' });
  assert.equal(dup.body.state, 'already_enrolled');
  assert.match(dup.body.login_url, /\/smoothoperators\/login\?next=%2Fapp&email=paid-buyer%40example\.com/);
  assert.equal(h.mocks.state.stripeCalls.filter(x => x.path === '/v1/checkout/sessions').length, before);
});

test('one reminder for people who did not pay, never for payers or the unsubscribed', async () => {
  await start({ email: 'maybe-later@example.com', name: 'Morgan Later' });
  await start({ email: 'no-thanks@example.com', name: 'Nia Nope' });
  await h.sql`update so_leads set last_checkout_at = now() - interval '25 hours'`;
  const nope = (await h.sql`select unsubscribe_token from so_leads where email = 'no-thanks@example.com'`)[0].unsubscribe_token;
  const unsub = await fetch(`${h.appBase}/api/so/leads/unsubscribe?token=${nope}`);
  assert.equal(unsub.status, 200);
  assert.match(await unsub.text(), /You’re unsubscribed/);

  const list = await admin('GET', 'admin/leads');
  const later = list.body.leads.find(l => l.email === 'maybe-later@example.com');
  assert.equal(later.status, 'started');
  assert.equal(later.business_name, 'Reyes Studio');
  assert.equal(later.revenue_label, '$250K–$500K');
  assert.ok(list.body.leads.some(l => l.email === 'paid-buyer@example.com' && l.status === 'paid'));
  assert.ok((await admin('GET', 'admin/home')).body.attention.some(a => a.kind === 'leads'));

  const r = await admin('POST', 'admin/leads/remind');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const sentTo = (await h.sql`select to_email, body_text from so_email_outbox where template_key = 'checkout_reminder'`);
  const emails = sentTo.map(x => x.to_email).sort();
  assert.ok(emails.includes('maybe-later@example.com'));
  assert.ok(emails.includes('robin@example.com'));
  assert.ok(!emails.includes('no-thanks@example.com'), 'unsubscribed');
  assert.ok(!emails.includes('paid-buyer@example.com'), 'already paid');
  const m = sentTo.find(x => x.to_email === 'maybe-later@example.com');
  assert.match(m.body_text, /Hi Morgan/);
  assert.match(m.body_text, /\/smoothoperators\/checkout/);
  assert.match(m.body_text, /\/api\/so\/leads\/unsubscribe\?token=[0-9a-f]{20,}/);
  // Only ever one.
  assert.equal((await admin('POST', 'admin/leads/remind')).body.sent, 0);
});

test('the daily cron needs the Vercel cron secret', async () => {
  assert.equal((await h.api('GET', 'cron/reminders')).status, 401);
  process.env.CRON_SECRET = 'cron-test-secret';
  try {
    const res = await fetch(`${h.appBase}/api/so/cron/reminders`, { headers: { Authorization: 'Bearer cron-test-secret' } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).sent, 0);
    assert.equal((await fetch(`${h.appBase}/api/so/cron/reminders`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  } finally { delete process.env.CRON_SECRET; }
});

test('admin can fully delete a test member so the email can be reused; real payers are protected', async () => {
  const r = await start({ email: 'reuse-me@example.com', name: 'Test Again' });
  const sid = r.body.url.split('/pay/')[1];
  await h.mocks.sendEvent('checkout.session.completed', await h.mocks.completeSession(sid));
  const uid = (await h.sql`select id from auth.users where email = 'reuse-me@example.com'`)[0].id;
  assert.equal((await admin('POST', `admin/members/${uid}/delete`, { confirm_email: 'wrong@example.com' })).status, 400);
  const support = await h.mocks.signIn('helper2@example.com');
  await h.sql`insert into so_profiles (user_id, email, role) values (${support.user.id}, 'helper2@example.com', 'support') on conflict (user_id) do update set role = 'support'`;
  assert.equal((await h.api('POST', `admin/members/${uid}/delete`, { token: support.token, body: { confirm_email: 'reuse-me@example.com' } })).status, 403);
  const d = await admin('POST', `admin/members/${uid}/delete`, { confirm_email: 'Reuse-Me@example.com' });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  for (const [t, col] of [['auth.users', 'id'], ['so_profiles', 'user_id'], ['so_enrollments', 'user_id'], ['so_purchases', 'user_id'], ['so_intakes', 'user_id']]) {
    assert.equal((await h.sql.unsafe(`select count(*)::int as n from ${t} where ${col} = $1`, [uid]))[0].n, 0, `${t} cleared`);
  }
  assert.equal((await h.sql`select count(*)::int as n from so_leads where email = 'reuse-me@example.com'`)[0].n, 0);
  // Same email signs up again from scratch.
  const again = await start({ email: 'reuse-me@example.com', name: 'Test Again' });
  assert.equal(again.body.state, 'redirect');
  const uid2 = (await h.sql`select id from auth.users where email = 'reuse-me@example.com'`)[0].id;
  assert.notEqual(uid2, uid);
  // A real (live-mode) payment can't be deleted.
  const live = await start({ email: 'real-payer@example.com', name: 'Real Payer' });
  await h.mocks.sendEvent('checkout.session.completed', await h.mocks.completeSession(live.body.url.split('/pay/')[1]));
  const lid = (await h.sql`select id from auth.users where email = 'real-payer@example.com'`)[0].id;
  await h.sql`update so_purchases set livemode = true where user_id = ${lid}`;
  const blocked = await admin('POST', `admin/members/${lid}/delete`, { confirm_email: 'real-payer@example.com' });
  assert.equal(blocked.status, 409);
  assert.equal((await h.sql`select count(*)::int as n from so_purchases where user_id = ${lid}`)[0].n, 1);
});
