'use strict';
// TEST DOUBLES ONLY. A single local HTTP server that imitates the small parts
// of Supabase Auth, Supabase Storage and Stripe that the app calls, so the
// whole purchase-to-reflection flow can be exercised offline.
//
// The app never talks to this in production: STRIPE_API_BASE is ignored on
// the production deployment, and SUPABASE_URL is the real project there.
// Webhooks sent by this double are signed with the same algorithm Stripe uses,
// so the app's real signature verification is what's being tested.

const http = require('http');
const crypto = require('crypto');
const { signPayload } = require('../../api/_lib/so/stripe');

function b64url(o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); }
function fakeJwt(sub, email) {
  const now = Math.floor(Date.now() / 1000);
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub, email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600 })}.${crypto.randomBytes(16).toString('base64url')}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function parseForm(str) {
  const out = {};
  for (const part of str.split('&').filter(Boolean)) {
    const [k, v] = part.split('=').map(decodeURIComponent);
    out[k] = v;
  }
  return out;
}

function startMocks({ sql, webhookUrl, webhookSecret, port = 0 } = {}) {
  const state = {
    users: new Map(),        // email -> {id, email}
    tokens: new Map(),       // access token -> user
    codes: new Map(),        // email -> code
    sessions: new Map(),     // stripe session id -> session
    idem: new Map(),         // idempotency key -> session id
    objects: new Map(),      // storage path -> Buffer
    webhookMode: 'immediate', // 'immediate' | 'none'
    sentEvents: [],
    stripeCalls: [],
    refunds: [],
    emails: [],
    refundMode: null,
    refundStatus: null,
    emailFail: false,
  };
  let base = '';

  async function ensureUser(email) {
    let u = state.users.get(email);
    if (!u) {
      u = { id: crypto.randomUUID(), email };
      state.users.set(email, u);
      if (sql) await sql`insert into auth.users (id, email) values (${u.id}, ${email}) on conflict do nothing`;
    }
    return u;
  }
  function issue(u) {
    const token = fakeJwt(u.id, u.email);
    state.tokens.set(token, u);
    return token;
  }

  async function sendEvent(type, object, { livemode = false } = {}) {
    const event = { id: `evt_${crypto.randomBytes(8).toString('hex')}`, object: 'event', type, livemode, data: { object } };
    const payload = JSON.stringify(event);
    state.sentEvents.push(event);
    const res = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signPayload(payload, webhookSecret) }, body: payload });
    return { event, status: res.status, body: await res.json().catch(() => null), payload };
  }

  function sessionView(s) {
    return { ...s };
  }

  async function completeSession(id, { paid = true } = {}) {
    const s = state.sessions.get(id);
    s.status = 'complete';
    s.payment_status = paid ? 'paid' : 'unpaid';
    s.payment_intent = s.payment_intent || `pi_${crypto.randomBytes(8).toString('hex')}`;
    return s;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'OPTIONS') return json(204, {});
    try {
      // ---------------- Supabase Auth
      if (p === '/auth/v1/otp' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)).toString() || '{}');
        const code = '123456';
        state.codes.set(String(b.email).toLowerCase(), code);
        return json(200, {});
      }
      if (p === '/auth/v1/verify' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)).toString() || '{}');
        const email = String(b.email || '').toLowerCase();
        if (state.codes.get(email) !== b.token) return json(403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
        state.codes.delete(email);
        const u = await ensureUser(email);
        const access = issue(u);
        const now = Math.floor(Date.now() / 1000);
        return json(200, {
          access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: `r_${crypto.randomBytes(8).toString('hex')}`,
          user: { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: new Date().toISOString(), app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
        });
      }
      if (p === '/auth/v1/user' && req.method === 'GET') {
        const tok = (req.headers.authorization || '').replace('Bearer ', '');
        const u = state.tokens.get(tok);
        if (!u) return json(401, { msg: 'invalid' });
        return json(200, { id: u.id, email: u.email, email_confirmed_at: new Date().toISOString(), aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} });
      }
      if (p === '/auth/v1/token') return json(400, { error: 'refresh not supported in mock' });
      if (p === '/auth/v1/logout') return json(204, {});

      // ---------------- Supabase Storage
      let m;
      if ((m = /^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/.exec(p)) && req.method === 'POST') {
        return json(200, { signedURL: `/object/sign/${m[1]}/${m[2]}?token=${crypto.randomBytes(6).toString('hex')}` });
      }
      if ((m = /^\/storage\/v1\/object\/upload\/sign\/([^/]+)\/(.+)$/.exec(p)) && req.method === 'POST') {
        return json(200, { url: `/object/upload/sign/${m[1]}/${m[2]}?token=${crypto.randomBytes(6).toString('hex')}` });
      }
      if ((m = /^\/storage\/v1\/object\/upload\/sign\/([^/]+)\/(.+)$/.exec(p)) && req.method === 'PUT') {
        state.objects.set(decodeURIComponent(m[2]), await readBody(req));
        return json(200, { Key: m[2] });
      }
      if ((m = /^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/.exec(p)) && req.method === 'GET') {
        const obj = state.objects.get(decodeURIComponent(m[2]));
        if (!obj) return json(404, { error: 'not_found' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
        return res.end(obj);
      }
      if (/^\/storage\/v1\/object\/[^/]+$/.test(p) && req.method === 'DELETE') return json(200, []);

      // ---------------- Stripe
      if (p === '/v1/checkout/sessions' && req.method === 'POST') {
        const form = parseForm((await readBody(req)).toString());
        state.stripeCalls.push({ path: p, form });
        const key = req.headers['idempotency-key'];
        if (key && state.idem.has(key)) return json(200, sessionView(state.sessions.get(state.idem.get(key))));
        const id = `cs_test_${crypto.randomBytes(10).toString('hex')}`;
        const amount = Number(form['line_items[0][price_data][unit_amount]']);
        const s = {
          id, object: 'checkout.session', url: `${base}/pay/${id}`, status: 'open', payment_status: 'unpaid', livemode: false,
          expires_at: Number(form.expires_at), amount_total: amount, amount_subtotal: amount, currency: form['line_items[0][price_data][currency]'],
          client_reference_id: form.client_reference_id, success_url: form.success_url, cancel_url: form.cancel_url,
          metadata: { purchase_id: form['metadata[purchase_id]'], user_id: form['metadata[user_id]'], cohort_id: form['metadata[cohort_id]'], price_tier: form['metadata[price_tier]'] },
          payment_intent: null,
        };
        state.sessions.set(id, s);
        if (key) state.idem.set(key, id);
        return json(200, sessionView(s));
      }
      if ((m = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(p)) && req.method === 'GET') {
        const s = state.sessions.get(m[1]);
        return s ? json(200, sessionView(s)) : json(404, { error: { type: 'invalid_request_error' } });
      }
      if ((m = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(p)) && req.method === 'POST') {
        const s = state.sessions.get(m[1]);
        if (!s) return json(404, { error: { type: 'invalid_request_error' } });
        if (s.status !== 'open') return json(400, { error: { type: 'invalid_request_error', code: 'checkout_session_not_open' } });
        s.status = 'expired';
        return json(200, sessionView(s));
      }
      if (p === '/v1/refunds' && req.method === 'POST') {
        const form = parseForm((await readBody(req)).toString());
        state.stripeCalls.push({ path: p, form });
        const key = req.headers['idempotency-key'];
        if (key && state.idem.has(key)) return json(200, state.idem.get(key));
        if (state.refundMode === 'api_error') return json(500, { error: { type: 'api_error' } });
        if (state.refundMode === 'already') return json(400, { error: { type: 'invalid_request_error', code: 'charge_already_refunded' } });
        const sess = [...state.sessions.values()].find(x => x.payment_intent === form.payment_intent);
        const r = { id: `re_${crypto.randomBytes(6).toString('hex')}`, object: 'refund', status: state.refundStatus || 'succeeded',
          payment_intent: form.payment_intent, amount: sess ? sess.amount_total : 0, currency: 'usd',
          metadata: { so_refund_attempt: form['metadata[so_refund_attempt]'], so_purchase: form['metadata[so_purchase]'] } };
        state.refunds.push(r);
        if (key) state.idem.set(key, r);
        if (state.refundMode === 'lost') return json(502, { error: { type: 'api_error' } }); // refund made, response lost
        return json(200, r);
      }
      if (p === '/v1/refunds' && req.method === 'GET') {
        return json(200, { object: 'list', data: state.refunds.filter(r => r.payment_intent === url.searchParams.get('payment_intent')) });
      }
      if ((m = /^\/v1\/payment_intents\/([^/]+)$/.exec(p)) && req.method === 'GET') {
        return json(200, { id: m[1], object: 'payment_intent', latest_charge: { id: `ch_${m[1].slice(3)}`, receipt_url: `https://pay.stripe.com/receipts/${m[1]}`,
          balance_transaction: { id: 'txn_1', fee: 2927 } } });
      }
      // ---------------- Resend
      if (p === '/emails' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)).toString() || '{}');
        if (state.emailFail) return json(500, { name: 'internal_server_error' });
        const id = `em_${crypto.randomBytes(6).toString('hex')}`;
        state.emails.push({ id, ...b });
        return json(200, { id });
      }
      // Hosted "checkout" page for browser tests.
      if ((m = /^\/pay\/([^/]+)$/.exec(p)) && req.method === 'GET') {
        const s = state.sessions.get(m[1]);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(`<!doctype html><title>Test checkout</title><h1>Stripe test double</h1>
<p id="amount">${s.amount_total}</p><form method="post" action="/pay/${s.id}/complete"><button id="pay">Pay with test card</button></form>
<a id="cancel" href="${s.cancel_url}">Back</a>`);
      }
      if ((m = /^\/pay\/([^/]+)\/complete$/.exec(p)) && req.method === 'POST') {
        const s = await completeSession(m[1]);
        if (state.webhookMode === 'immediate') await sendEvent('checkout.session.completed', sessionView(s));
        res.writeHead(303, { Location: s.success_url.replace('{CHECKOUT_SESSION_ID}', s.id) });
        return res.end();
      }
      json(404, { error: 'mock_not_found', path: p });
    } catch (e) {
      json(500, { error: e.message });
    }
  });

  return new Promise(resolve => server.listen(port, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve({
      base, state, server, sendEvent, completeSession,
      async signIn(email) { const u = await ensureUser(email.toLowerCase()); return { user: u, token: issue(u) }; },
      close: () => new Promise(r => server.close(r)),
    });
  }));
}

module.exports = { startMocks };
