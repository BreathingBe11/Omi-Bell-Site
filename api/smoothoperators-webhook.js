'use strict';
// Stripe webhook for Smooth Operators.
// Configure in Stripe: Developers -> Webhooks -> endpoint
//   https://<your-domain>/api/smoothoperators-webhook
// Events: checkout.session.completed, checkout.session.async_payment_succeeded,
//   checkout.session.async_payment_failed, checkout.session.expired,
//   charge.refunded, charge.dispute.created, charge.dispute.closed
//   refund.created, refund.updated, refund.failed
// The signing secret goes in STRIPE_WEBHOOK_SECRET.
//
// Resend delivery webhooks use the same URL (Resend -> Webhooks; events
// email.sent, email.delivered, email.bounced, email.complained, email.failed),
// signing secret in RESEND_WEBHOOK_SECRET.

const { getSqlReady } = require('./_lib/so/db');
const { processWebhook } = require('./_lib/so/payments');
const { processResendEvent } = require('./_lib/so/email');
const H = require('./_lib/so/http');

// Signature verification needs the exact bytes Stripe sent.
async function rawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length) return Buffer.concat(chunks);
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  return Buffer.alloc(0);
}

async function handler(req, res) {
  if (req.method !== 'POST') return H.sendJson(res, 405, { error: 'method_not_allowed' });
  try {
    const raw = await rawBody(req);
    if (raw.length > 1024 * 1024) return H.sendJson(res, 413, { error: 'too_large' });
    // Resend delivery events (Svix-signed) share this endpoint; everything else is Stripe.
    const sql = await getSqlReady();
    const out = req.headers['svix-id']
      ? await processResendEvent(sql, raw, req.headers)
      : await processWebhook(sql, raw, req.headers['stripe-signature']);
    return H.sendJson(res, out.status, out.body);
  } catch (err) {
    return H.sendError(res, err);
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
