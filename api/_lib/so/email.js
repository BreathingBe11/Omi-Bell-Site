'use strict';
// Transactional email through Resend (the provider already used by the site).
//
// SO_EMAIL_DELIVERY controls delivery:
//   off      (default) record the intent, send nothing
//   sandbox  send every message to SO_SANDBOX_EMAIL instead of the member
//   live     send to the member
// Every message has a dedupe key so retries and duplicate webhooks never send twice.

const { emailMode } = require('./env');
const { escapeHtml } = require('./http');

async function sendTransactional(sql, { dedupeKey, kind, userId, to, subject, html, text }) {
  const claimed = await sql`
    insert into so_email_log (dedupe_key, kind, user_id, status) values (${dedupeKey}, ${kind}, ${userId || null}, 'sending')
    on conflict (dedupe_key) do update set status = 'sending', created_at = now()
      where so_email_log.status in ('failed')
    returning dedupe_key`;
  if (!claimed.length) return { status: 'duplicate' };

  const mode = emailMode();
  const recipient = mode === 'live' ? to : mode === 'sandbox' ? process.env.SO_SANDBOX_EMAIL : null;
  const key = process.env.RESEND_API_KEY;
  if (!recipient || !key) {
    const status = mode === 'off' ? 'skipped_off' : 'skipped_unconfigured';
    await sql`update so_email_log set status = ${status} where dedupe_key = ${dedupeKey}`;
    return { status };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'Idempotency-Key': dedupeKey.slice(0, 256) },
      body: JSON.stringify({
        from: process.env.SO_EMAIL_FROM || process.env.RESEND_FROM || 'Omi Bell <hello@omibell.com>',
        to: [recipient],
        ...(process.env.SO_EMAIL_REPLY_TO ? { reply_to: process.env.SO_EMAIL_REPLY_TO } : {}),
        subject: mode === 'sandbox' ? `[sandbox] ${subject}` : subject,
        html, text,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`resend ${res.status}`);
    await sql`update so_email_log set status = 'sent' where dedupe_key = ${dedupeKey}`;
    return { status: 'sent' };
  } catch (e) {
    console.error('[so] email failed', kind, e.message);
    await sql`update so_email_log set status = 'failed' where dedupe_key = ${dedupeKey}`;
    return { status: 'failed' };
  }
}

function confirmationEmail({ cohortName, startDate, endDate, returnUrl, supportEmail }) {
  const fmt = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const dates = `${fmt(startDate)} – ${fmt(endDate)}`;
  const support = supportEmail ? `<p>Questions? Reach us at <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a>.</p>` : '';
  const html = `
<div style="font-family:Georgia,serif;max-width:540px;margin:0 auto;padding:32px 24px;color:#3a1f3d;background:#fbf7f1;line-height:1.7">
  <p style="font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#8a4b2c;margin:0 0 8px">${escapeHtml(cohortName)}</p>
  <h1 style="font-weight:normal;font-size:28px;margin:0 0 20px">You’re in. Let’s build what comes next.</h1>
  <p>Your enrollment is confirmed. You know how to generate business. We’ll help you build the operations to handle what comes next.</p>
  <p><strong>Cohort dates:</strong> ${escapeHtml(dates)}</p>
  <p>Your daily guidance, practices, and tools will appear in your cohort space when we begin. Sign in with this email address to open it:</p>
  <p><a href="${escapeHtml(returnUrl)}" style="display:inline-block;background:#5b2a5e;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none">Open My Cohort</a></p>
  <p style="font-size:14px;color:#6b5a66">Your payment receipt comes separately from our payment provider.</p>
  ${support}
</div>`;
  const text = `You’re in. Let’s build what comes next.\n\nYour enrollment in ${cohortName} is confirmed.\nCohort dates: ${dates}\n\nOpen your cohort (sign in with this email): ${returnUrl}\n\nYour payment receipt comes separately from our payment provider.` +
    (supportEmail ? `\n\nQuestions? ${supportEmail}` : '');
  return { subject: `You’re in: ${cohortName}`, html, text };
}

function approvalEmail({ cohortName, startDate, endDate, returnUrl }) {
  const fmt = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const dates = `${fmt(startDate)} – ${fmt(endDate)}`;
  const html = `
<div style="font-family:Georgia,serif;max-width:540px;margin:0 auto;padding:32px 24px;color:#3a1f3d;background:#fbf7f1;line-height:1.7">
  <p style="font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#8a4b2c;margin:0 0 8px">${escapeHtml(cohortName)}</p>
  <h1 style="font-weight:normal;font-size:28px;margin:0 0 20px">You’re approved. Welcome to the cohort.</h1>
  <p>We’ve reviewed your fit check and your seat is confirmed for ${escapeHtml(dates)}.</p>
  <p><a href="${escapeHtml(returnUrl)}" style="display:inline-block;background:#5b2a5e;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none">Open My Cohort</a></p>
</div>`;
  const text = `You’re approved. Welcome to the cohort.\n\nWe’ve reviewed your fit check and your seat in ${cohortName} is confirmed for ${dates}.\n\nOpen your cohort: ${returnUrl}`;
  return { subject: `You’re approved: ${cohortName}`, html, text };
}

module.exports = { sendTransactional, confirmationEmail, approvalEmail };
