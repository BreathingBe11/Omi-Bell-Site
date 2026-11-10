'use strict';
// Minimal Stripe REST client (no SDK) plus webhook signature verification.
// Docs: https://docs.stripe.com/api/checkout/sessions and
//       https://docs.stripe.com/webhooks#verify-manually

const crypto = require('crypto');
const { HttpError } = require('./http');
const { isProductionDeploy } = require('./env');

function apiBase() {
  const override = process.env.STRIPE_API_BASE;
  // The override exists only so automated tests can point at a local double.
  if (override && !isProductionDeploy()) return override.replace(/\/+$/, '');
  return 'https://api.stripe.com';
}

// Stripe expects application/x-www-form-urlencoded with bracketed nesting.
function encodeForm(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => {
      if (item !== null && typeof item === 'object') encodeForm(item, `${key}[${i}]`, out);
      else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
    });
    else if (typeof v === 'object') encodeForm(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join('&');
}

async function stripeRequest(method, path, params, { idempotencyKey } = {}) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new HttpError(503, 'payments_not_configured', 'Payments are not configured yet.');
  const headers = { Authorization: `Bearer ${key}` };
  // Uses the account's default API version unless one is pinned explicitly.
  if (process.env.STRIPE_API_VERSION) headers['Stripe-Version'] = process.env.STRIPE_API_VERSION;
  let url = `${apiBase()}${path}`;
  let bodyStr;
  if (method === 'GET') {
    if (params) url += `?${encodeForm(params)}`;
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    bodyStr = params ? encodeForm(params) : '';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: bodyStr, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new HttpError(503, 'payment_provider_unreachable', 'We could not reach the payment provider. Please try again.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new HttpError(res.status >= 500 ? 503 : 502, 'payment_provider_error',
      'The payment provider returned an error.');
    err.stripe = { status: res.status, type: json.error && json.error.type, code: json.error && json.error.code };
    console.error('[so] stripe error', path.replace(/cs_[A-Za-z0-9_]+/, 'cs_…'), err.stripe);
    throw err;
  }
  return json;
}

function createCheckoutSession(params, idempotencyKey) {
  return stripeRequest('POST', '/v1/checkout/sessions', params, { idempotencyKey });
}
function retrieveCheckoutSession(id) {
  return stripeRequest('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`);
}
function expireCheckoutSession(id) {
  return stripeRequest('POST', `/v1/checkout/sessions/${encodeURIComponent(id)}/expire`, {});
}
function createRefund(params, idempotencyKey) {
  return stripeRequest('POST', '/v1/refunds', params, { idempotencyKey });
}
function retrievePrice(id) {
  return stripeRequest('GET', `/v1/prices/${encodeURIComponent(id)}`);
}

// Returns the parsed event, or throws HttpError(400) when the signature is invalid.
function verifyWebhook(rawBody, sigHeader, secret, { toleranceSeconds = 300, now = Date.now() } = {}) {
  if (!secret) throw new HttpError(503, 'webhook_not_configured');
  if (!sigHeader || typeof sigHeader !== 'string') throw new HttpError(400, 'bad_signature');
  const raw = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  let t = null;
  const v1 = [];
  for (const part of sigHeader.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') t = Number(v);
    else if (k === 'v1' && v) v1.push(v);
  }
  if (!t || !v1.length) throw new HttpError(400, 'bad_signature');
  if (Math.abs(now / 1000 - t) > toleranceSeconds) throw new HttpError(400, 'stale_signature');
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw}`, 'utf8').digest('hex');
  const eBuf = Buffer.from(expected, 'hex');
  const ok = v1.some(sig => {
    const sBuf = Buffer.from(sig, 'hex');
    return sBuf.length === eBuf.length && crypto.timingSafeEqual(sBuf, eBuf);
  });
  if (!ok) throw new HttpError(400, 'bad_signature');
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'bad_json'); }
}

// Used by tests and the local Stripe double to produce valid signatures.
function signPayload(payload, secret, t = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${payload}`, 'utf8').digest('hex');
  return `t=${t},v1=${sig}`;
}

module.exports = {
  encodeForm, stripeRequest, createCheckoutSession, retrieveCheckoutSession, expireCheckoutSession,
  retrievePrice, createRefund, verifyWebhook, signPayload, apiBase,
};
