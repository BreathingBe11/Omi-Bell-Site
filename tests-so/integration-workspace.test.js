'use strict';
// Admin workspace brief: review queue, approve/reject with refund and email,
// idempotency under retries and concurrency, failures and safe retries,
// access restrictions while pending/rejected, privacy, sales, questions.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { boot } = require('./support/harness');

let h;
test.before(async () => {
  h = await boot({ SO_EMAIL_DELIVERY: 'sandbox', SO_SANDBOX_EMAIL: 'sandbox@example.com', RESEND_API_KEY: 're_test_local', RESEND_WEBHOOK_SECRET: `whsec_${Buffer.from('resend-secret').toString('base64')}` });
  process.env.SO_RESEND_API_BASE = h.mocks.base;
});
test.after(async () => { delete process.env.SO_RESEND_API_BASE; await h.close(); });

const admin = (m, p, body) => h.api(m, p, { token: h.adminToken, body });

// Buyer who submitted the fit check and paid (webhook delivered).
async function paidMember(email, fit = {}) {
  const s = await h.buyer(email, fit);
  const r = await h.api('POST', 'checkout/session', { token: s.token, body: {} });
  const sess = await h.mocks.completeSession(r.body.url.split('/pay/')[1]);
  await h.mocks.sendEvent('checkout.session.completed', sess);
  return { ...s, sess };
}
async function card(userId) { return (await admin('GET', `admin/members/${userId}`)).body.member; }
async function decide(userId, decision, extra = {}) {
  const c = await card(userId);
  return admin('POST', `admin/members/${userId}/decision`, {
    decision, review_version: c.decision.review_version, intake_version: c.decision.intake_version,
    member_message: decision === 'reject' ? 'We think a later cohort will suit your stage better.' : '', ...extra,
  });
}
const sentTo = subject => h.mocks.state.emails.filter(e => e.subject.includes(subject));

test('drafts never enter the review queue; only an explicit valid submission does', async () => {
  const { token, user } = await h.mocks.signIn('drafty@example.com');
  const draft = await h.api('PUT', 'intake', { token, body: { first_name: 'Dee', business_name: 'Draft Co' } });
  assert.equal(draft.status, 200);
  assert.equal(draft.body.intake.status, 'draft');
  assert.ok(draft.body.intake.missing.includes('phone'));
  assert.equal((await h.api('POST', 'checkout/session', { token, body: {} })).body.state, 'intake_required');
  const list = await admin('GET', 'admin/members?filter=incomplete');
  assert.ok(list.body.members.some(m => m.user_id === user.id && m.info_status === 'incomplete'));
  assert.ok(!(await admin('GET', 'admin/members?filter=awaiting')).body.members.some(m => m.user_id === user.id));
  const bad = await h.api('PUT', 'intake', { token, body: { first_name: 'Dee', business_name: 'Draft Co', submit: true } });
  assert.equal(bad.status, 400, 'submission validates every required answer');
  const sub = await h.api('PUT', 'intake', { token, body: { ...h.FIT, first_name: 'Dee', business_name: 'Draft Co' } });
  assert.equal(sub.body.intake.status, 'submitted');
  assert.equal(sub.body.intake.version, 1);
  assert.ok(sub.body.intake.policy_version, 'accepted policy version is recorded');
});

test('review card shows every submitted answer, version and payment; queue is oldest first', async () => {
  const a = await paidMember('first-in-line@example.com', { first_name: 'Ada', business_name: 'Analytical Ops' });
  await new Promise(r => setTimeout(r, 20));
  const b = await paidMember('second-in-line@example.com', { first_name: 'Ben' });
  const q = await admin('GET', 'admin/members?filter=awaiting');
  const ids = q.body.members.map(m => m.user_id);
  assert.ok(ids.indexOf(a.user.id) < ids.indexOf(b.user.id), 'oldest submitted first');
  const c = await card(a.user.id);
  assert.equal(c.info.status, 'submitted');
  assert.equal(c.info.version, 1);
  const ans = Object.fromEntries(c.info.answers.map(x => [x.key, x.answer]));
  assert.equal(ans.business_name, 'Analytical Ops');
  assert.equal(ans.revenue_to_date, '$100K–$250K');
  assert.equal(ans.prior_ops_work, 'No');
  assert.equal(c.payments[0].amount_cents, 99900);
  assert.match(c.payments[0].receipt_url, /receipts/);
  assert.equal(c.payments[0].fee_cents, 2927);
  assert.equal(c.enrollment.access, 'application_only');
  assert.equal(c.decision.allowed, true);
  assert.equal(c.decision.refund_cents, 99900);
  const note = await admin('POST', `admin/members/${a.user.id}/notes`, { body: 'Strong fit; similar stage to others.' });
  assert.equal(note.status, 200);
});

test('pending members cannot reach cohort content by any route', async () => {
  const m = await paidMember('pending-only@example.com');
  await h.setLiveDay(2);
  await h.sql`update so_days set status = 'published', is_sample = false where day_number <= 2`;
  const c = await h.cohort();
  const call = (await admin('POST', 'admin/calls', { title: 'Seat', starts_at: new Date(Date.now() + 5 * 60000).toISOString(), meeting_url: 'https://meet.example.com/x', status: 'scheduled' })).body.call;
  const res = (await admin('POST', 'admin/resources', { kind: 'template', title: 'Open template', source_type: 'link', external_url: 'https://docs.example.com/t' })).body.resource;
  await admin('PUT', `admin/resources/${res.id}`, { status: 'published', release_mode: 'immediately' });
  for (const [method, path] of [['GET', 'home'], ['GET', 'calendar'], ['GET', 'day/1'], ['GET', 'library'], ['GET', `resource/${res.id}/access`],
    ['GET', 'journal'], ['GET', 'calls'], ['GET', `calls/${call.id}/ics`], ['POST', `calls/${call.id}/join`], ['GET', 'introductions'],
    ['PUT', 'journal/1']]) {
    const r = await h.api(method, path, { token: m.token, body: method === 'GET' ? undefined : { body: 'x', base_revision: null } });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.doesNotMatch(r.text, /meet\.example\.com|docs\.example\.com/);
  }
  // What they can see: their application status, account, and support.
  assert.equal((await h.api('GET', 'application', { token: m.token })).body.review_state, 'pending');
  assert.equal((await h.api('GET', 'account', { token: m.token })).status, 200);
  const cats = (await h.api('GET', 'help/threads', { token: m.token })).body.categories.map(x => x.key);
  assert.deepEqual(cats, ['application', 'account_access', 'billing_refund', 'other']);
  void c;
});

test('approve: grants access, one accurate email, and duplicate or concurrent decisions are refused', async () => {
  const m = await paidMember('approve-once@example.com');
  const before = sentTo('approved').length;
  const c = await card(m.user.id);
  const stale = await admin('POST', `admin/members/${m.user.id}/decision`, { decision: 'approve', review_version: c.decision.review_version + 7, intake_version: c.decision.intake_version });
  assert.equal(stale.status, 409);
  const body = { decision: 'approve', review_version: c.decision.review_version, intake_version: c.decision.intake_version, member_message: 'So glad you’re here.' };
  const [x, y] = await Promise.all([admin('POST', `admin/members/${m.user.id}/decision`, body), admin('POST', `admin/members/${m.user.id}/decision`, body)]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  const ok = x.status === 200 ? x : y;
  assert.equal(ok.body.email, 'submitted', 'accepted by the email provider (not claimed as delivered)');
  assert.equal(sentTo('approved').length, before + 1, 'exactly one approval email');
  assert.match(sentTo('approved').at(-1).text, /So glad you’re here\./);
  const again = await decide(m.user.id, 'approve');
  assert.equal(again.status, 409);
  assert.equal((await h.api('GET', 'home', { token: m.token })).status, 200, 'approved members get the cohort');
  // Approval never publishes the application as an introduction.
  assert.equal((await h.sql`select count(*)::int as n from so_introductions where user_id = ${m.user.id}`)[0].n, 0);
  const intros = await h.api('GET', 'introductions', { token: m.token });
  assert.doesNotMatch(intros.text, /555-0100|1 Main St|How do I delegate/);
  // An approved enrollment can't be refunded by rejecting it.
  assert.equal((await decide(m.user.id, 'reject')).status, 409);
});

test('reject: requires a member-facing reason, refunds once in full, blocks access, emails the real refund status', async () => {
  const m = await paidMember('reject-me@example.com');
  const c = await h.cohort();
  const day = (await h.sql`select id from so_days where cohort_id = ${c.id} and day_number = 1`)[0];
  await h.sql`insert into so_journal_entries (user_id, cohort_id, day_id, body) values (${m.user.id}, ${c.id}, ${day.id}, 'kept words')`;
  assert.equal((await decide(m.user.id, 'reject', { member_message: '' })).status, 400);
  const refundsBefore = h.mocks.state.refunds.length;
  const r = await decide(m.user.id, 'reject');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.refund.status, 'succeeded');
  assert.equal(r.body.refund.amount_cents, 99900);
  assert.equal(h.mocks.state.refunds.length, refundsBefore + 1);
  const lastRefund = h.mocks.state.stripeCalls.filter(x => x.path === '/v1/refunds').at(-1);
  assert.equal(lastRefund.form.payment_intent, m.sess.payment_intent);
  assert.equal(lastRefund.form.amount, undefined, 'full refund: amount omitted so tax is included and no fee is deducted');
  const mail = sentTo('An update on your').at(-1);
  assert.match(mail.text, /initiated a full refund of \$999\.00/);
  assert.match(mail.text, /later cohort/);
  const home = await h.api('GET', 'home', { token: m.token });
  assert.equal(home.status, 403);
  assert.equal(home.body.reason, 'rejected');
  const app = await h.api('GET', 'application', { token: m.token });
  assert.equal(app.body.review_state, 'rejected');
  assert.equal(app.body.refund.status, 'succeeded');
  assert.equal((await h.sql`select count(*)::int as n from so_journal_entries where user_id = ${m.user.id}`)[0].n, 1, 'no data deleted');
  // Webhook redelivery and refund events don't duplicate anything.
  const refund = h.mocks.state.refunds.at(-1);
  await h.mocks.sendEvent('refund.updated', refund);
  await h.mocks.sendEvent('refund.updated', refund);
  await h.mocks.sendEvent('charge.refunded', { id: 'ch_r', object: 'charge', payment_intent: m.sess.payment_intent, amount: 99900, amount_refunded: 99900, refunds: { data: [refund] } });
  const attempts = await h.sql`select * from so_refund_attempts ra join so_purchases p on p.id = ra.purchase_id where p.user_id = ${m.user.id}`;
  assert.equal(attempts.length, 1);
  assert.equal((await h.sql`select status from so_purchases where user_id = ${m.user.id} and status <> 'expired'`)[0].status, 'refunded');
  // Rejection can't be casually reversed.
  assert.equal((await admin('POST', `admin/members/${m.user.id}/reopen`, { reason: 'oops' })).status, 409);
});

test('refund failure: honest email, flagged for attention, safe retry never double-refunds', async () => {
  const m = await paidMember('refund-fail@example.com');
  h.mocks.state.refundMode = 'api_error';
  const r = await decide(m.user.id, 'reject');
  h.mocks.state.refundMode = null;
  assert.equal(r.body.refund.status, 'failed');
  assert.match(sentTo('An update on your').at(-1).text, /being processed/);
  assert.doesNotMatch(sentTo('An update on your').at(-1).text, /initiated a full refund/);
  const home = await admin('GET', 'admin/home');
  assert.ok(home.body.attention.some(a => a.kind === 'refund'));
  const c = await card(m.user.id);
  const failed = c.refunds.find(x => x.status === 'failed');
  const before = h.mocks.state.refunds.length;
  const retry = await admin('POST', `admin/refunds/${failed.id}/retry`);
  assert.equal(retry.body.refund.status, 'succeeded');
  assert.equal(h.mocks.state.refunds.length, before + 1);
  assert.equal((await admin('POST', `admin/refunds/${failed.id}/retry`)).status, 409, 'a succeeded refund cannot be retried');
});

test('lost provider response: the retry adopts the refund Stripe already made', async () => {
  const m = await paidMember('lost-response@example.com');
  h.mocks.state.refundMode = 'lost';
  const r = await decide(m.user.id, 'reject');
  h.mocks.state.refundMode = null;
  assert.equal(r.body.refund.status, 'failed');
  const count = h.mocks.state.refunds.filter(x => x.payment_intent === m.sess.payment_intent).length;
  assert.equal(count, 1, 'Stripe made the refund even though we never heard back');
  const a = (await card(m.user.id)).refunds[0];
  // Simulate the idempotency window having passed: retry must still not refund twice.
  await h.sql`update so_refund_attempts set idempotency_key = ${`expired-${crypto.randomUUID()}`} where id = ${a.id}`;
  const retry = await admin('POST', `admin/refunds/${a.id}/retry`);
  assert.equal(retry.body.refund.status, 'succeeded');
  assert.equal(h.mocks.state.refunds.filter(x => x.payment_intent === m.sess.payment_intent).length, 1);
});

test('email failure is separate from the decision; resend never repeats the decision or refund', async () => {
  const m = await paidMember('email-fail@example.com');
  h.mocks.state.emailFail = true;
  const r = await decide(m.user.id, 'approve');
  h.mocks.state.emailFail = false;
  assert.equal(r.status, 200);
  assert.equal(r.body.email, 'failed');
  assert.equal((await h.api('GET', 'home', { token: m.token })).status, 200, 'decision stands even though the email failed');
  assert.ok((await admin('GET', 'admin/home')).body.attention.some(a => a.kind === 'email'));
  const failedEmail = (await admin('GET', 'admin/emails?status=failed')).body.emails.find(e => e.user_id === m.user.id);
  const decisionsBefore = (await h.sql`select count(*)::int as n from so_review_decisions`)[0].n;
  const resend = await admin('POST', `admin/emails/${failedEmail.id}/resend`);
  assert.equal(resend.body.status, 'submitted');
  assert.equal((await h.sql`select count(*)::int as n from so_review_decisions`)[0].n, decisionsBefore);
});

test('delivery status comes from signed Resend webhooks only', async () => {
  const e = (await h.sql`select * from so_email_outbox where status = 'submitted' and provider_id is not null limit 1`)[0];
  const payload = JSON.stringify({ type: 'email.delivered', data: { email_id: e.provider_id } });
  const id = `msg_${crypto.randomBytes(4).toString('hex')}`, ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', Buffer.from('resend-secret')).update(`${id}.${ts}.${payload}`).digest('base64');
  const bad = await fetch(`${h.appBase}/api/smoothoperators-webhook`, { method: 'POST', headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': 'v1,AAAA' }, body: payload });
  assert.equal(bad.status, 400);
  const ok = await fetch(`${h.appBase}/api/smoothoperators-webhook`, { method: 'POST', headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` }, body: payload });
  assert.equal(ok.status, 200);
  assert.equal((await h.sql`select status from so_email_outbox where id = ${e.id}`)[0].status, 'delivered');
});

test('templates: merge fields are validated, versions kept, rejection must state refund status', async () => {
  const bad = await admin('PUT', 'admin/email-templates/approval', { subject: 'Hi {{first_nam}}', body: 'x' });
  assert.equal(bad.status, 400);
  const noRefund = await admin('PUT', 'admin/email-templates/rejection', { subject: 'Update', body: 'Hi {{first_name}}, sorry.' });
  assert.equal(noRefund.status, 400);
  const ok = await admin('PUT', 'admin/email-templates/approval', { subject: 'Welcome, {{first_name}}', body: 'Hi {{first_name}}, you’re in {{cohort_name}}. {{app_link}}' });
  assert.equal(ok.body.template.version, 1);
  await admin('PUT', 'admin/email-templates/approval', { subject: 'Welcome again, {{first_name}}', body: 'Hi {{first_name}}. {{app_link}}' });
  assert.equal((await admin('GET', 'admin/email-templates/approval/versions')).body.versions.length, 2);
  const prev = await admin('POST', 'admin/email-templates/approval/preview', {});
  assert.match(prev.body.subject, /Welcome again, Jordan/);
  const t = await admin('POST', 'admin/email-templates/kickoff/test', { to: 'omi-test@example.com' });
  assert.equal(t.body.status, 'submitted');
});

test('sales: gross, refunds and net reflect confirmed transactions with stated scope', async () => {
  const s = await admin('GET', 'admin/sales');
  assert.equal(s.status, 200);
  const paid = (await h.sql`select coalesce(sum(amount_paid_cents),0)::int as g from so_purchases where paid_at is not null`)[0].g;
  const refunded = (await h.sql`select coalesce(sum(amount_cents),0)::int as r from so_refund_attempts where status = 'succeeded'`)[0].r;
  assert.equal(s.body.totals.gross_cents, paid);
  assert.equal(s.body.totals.refunds_completed_cents, refunded);
  assert.equal(s.body.totals.net_cents, paid - refunded);
  assert.equal(s.body.totals.data, 'test');
  assert.match(s.body.scope, /All time/);
  assert.ok(s.body.transactions.some(t => t.status === 'refunded'));
  assert.ok(s.body.review.rejected >= 1);
  const csv = await admin('GET', 'admin/sales/export?state=refunded');
  assert.match(csv.text, /^﻿?Date,Buyer,Email/);
  assert.ok(csv.text.trim().split('\n').slice(1).every(l => l.includes('refunded')));
  const home = await admin('GET', 'admin/home');
  assert.equal(home.body.cards.sales.gross_cents, paid);
  assert.match(home.body.cards.sales.scope, /before refunds/);
});

test('questions inbox is separate from challenges; internal notes stay internal; reply email carries a link only', async () => {
  const m = await paidMember('asker@example.com');
  const t = await h.api('POST', 'help/threads', { token: m.token, body: { category: 'billing_refund', subject: 'Receipt copy', body: 'Can I get my receipt again?' } });
  assert.equal(t.status, 200);
  assert.equal((await h.api('POST', 'help/threads', { token: m.token, body: { category: 'program', subject: 'x', body: 'y' } })).status, 400, 'restricted while pending');
  const inbox = await admin('GET', 'admin/questions?status=new');
  assert.ok(inbox.body.questions.some(q => q.id === t.body.thread.id));
  await admin('POST', `admin/questions/${t.body.thread.id}/note`, { body: 'INTERNAL: check Stripe first' });
  const reply = await admin('POST', `admin/questions/${t.body.thread.id}/reply`, { body: 'Here is your receipt link.' });
  assert.equal(reply.body.email, 'submitted');
  const view = await h.api('GET', `help/threads/${t.body.thread.id}`, { token: m.token });
  assert.doesNotMatch(view.text, /INTERNAL/);
  assert.equal(view.body.messages.length, 2);
  const mail = sentTo('Re: Receipt copy').at(-1);
  assert.doesNotMatch(mail.text, /Here is your receipt link|INTERNAL/);
  assert.match(mail.text, /login\?next=%2Fapp%2Fhelp%2F/);
  const other = await h.mocks.signIn('nosy@example.com');
  assert.equal((await h.api('GET', `help/threads/${t.body.thread.id}`, { token: other.token })).status, 404);
  assert.equal((await admin('GET', 'admin/challenges')).body.challenges.some(c => c.working_on === 'Can I get my receipt again?'), false);
});

test('support staff: members and questions yes; decisions, refunds, sales and exports no', async () => {
  const s = await h.mocks.signIn('helper@example.com');
  await h.sql`insert into so_profiles (user_id, email, role) values (${s.user.id}, 'helper@example.com', 'support') on conflict (user_id) do update set role = 'support'`;
  const tok = s.token;
  assert.equal((await h.api('GET', 'admin/members', { token: tok })).status, 200);
  assert.equal((await h.api('GET', 'admin/questions', { token: tok })).status, 200);
  for (const [m, p] of [['GET', 'admin/sales'], ['GET', 'admin/sales/export'], ['GET', 'admin/members/export'], ['PUT', 'admin/cohort'], ['GET', 'admin/staff']]) {
    assert.equal((await h.api(m, p, { token: tok, body: m === 'GET' ? undefined : {} })).status, 403, `${m} ${p}`);
  }
  const pend = await paidMember('support-cant-decide@example.com');
  const c = (await h.api('GET', `admin/members/${pend.user.id}`, { token: tok })).body.member;
  assert.equal(c.decision.allowed, false);
  assert.equal(c.payments[0].provider_ref, undefined, 'no payment references for support');
  assert.equal((await h.api('POST', `admin/members/${pend.user.id}/decision`, { token: tok, body: { decision: 'approve', review_version: 0, intake_version: 1 } })).status, 403);
  // Owner can grant roles; nobody can self-register.
  assert.equal((await admin('PUT', 'admin/staff', { email: 'helper@example.com', role: 'admin' })).status, 200);
  assert.equal((await h.api('PUT', 'admin/staff', { token: (await h.mocks.signIn('rando@example.com')).token, body: { email: 'rando@example.com', role: 'admin' } })).status, 403);
});

test('no admin view, card, export or analytics exposes private journal text', async () => {
  const m = await paidMember('private-writer@example.com');
  await decide(m.user.id, 'approve');
  const c = await h.cohort();
  const day = (await h.sql`select id from so_days where cohort_id = ${c.id} and day_number = 1`)[0];
  await h.sql`insert into so_journal_entries (user_id, cohort_id, day_id, body) values (${m.user.id}, ${c.id}, ${day.id}, 'TOP-SECRET-REFLECTION')
              on conflict (user_id, cohort_id, day_id) do update set body = 'TOP-SECRET-REFLECTION'`;
  for (const p of ['admin/home', 'admin/members', `admin/members/${m.user.id}`, 'admin/sales', 'admin/sales/export', 'admin/members/export',
    'admin/progress', 'admin/emails', 'admin/challenges', 'admin/questions', 'admin/overview', 'admin/audit']) {
    const r = await admin('GET', p);
    assert.equal(r.status, 200, p);
    assert.doesNotMatch(r.text, /TOP-SECRET-REFLECTION/, p);
  }
  const prog = await admin('GET', 'admin/progress');
  assert.ok(prog.body.members.some(x => x.user_id === m.user.id));
  assert.match(prog.body.definitions.caveat, /not attendance/);
});

test('Solutions Seat: challenge workflow states, facilitator notes and session prep', async () => {
  const m = await paidMember('seat-member@example.com');
  await decide(m.user.id, 'approve');
  const call = (await admin('POST', 'admin/calls', { title: 'Prep call', starts_at: new Date(Date.now() + 2 * 86400000).toISOString(), meeting_url: 'https://meet.example.com/p', status: 'scheduled' })).body.call;
  const ch = await h.api('POST', 'challenges', { token: m.token, body: { call_id: call.id, working_on: 'Client onboarding', stuck_on: 'Too many handoffs',
    help_wanted: 'Which step to delegate first', share_permission: true } });
  assert.equal(ch.status, 200);
  const up = await admin('PUT', `admin/challenges/${ch.body.challenge.id}`, { status: 'selected', facilitator_note: 'Pair with ops scorecard example' });
  assert.equal(up.body.challenge.status, 'selected');
  const prep = await admin('GET', `admin/calls/${call.id}/prep`);
  assert.ok(prep.body.selected.some(s => s.working_on === 'Client onboarding' && s.share_permission));
  assert.equal((await admin('PUT', `admin/challenges/${ch.body.challenge.id}`, { status: 'reviewed' })).status, 400);
  const home = await admin('GET', 'admin/home');
  assert.ok(home.body.cards.next_call);
  const memberView = await h.api('GET', 'calls', { token: m.token });
  assert.doesNotMatch(memberView.text, /Pair with ops scorecard/, 'facilitator notes are private');
});
