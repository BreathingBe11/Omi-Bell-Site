'use strict';
// Email: editable templates + an outbox.
//
// Every message is written to so_email_outbox first (inside the same database
// transaction as the decision or event that caused it, where there is one),
// then delivered by processOutbox(). Statuses distinguish what actually
// happened:
//   queued -> sending -> submitted (accepted by Resend) -> delivered | bounced | complained
//   failed (Resend refused or was unreachable)  |  skipped (delivery is off / no recipient)
// "Submitted" is never shown as "delivered"; delivery comes from Resend's webhook.
//
// SO_EMAIL_DELIVERY: off (default) | sandbox (all mail to SO_SANDBOX_EMAIL) | live.
// Re-sending creates a new outbox row and never re-runs the action behind it.

const { emailMode, siteUrl, BASE_PATH } = require('./env');
const { escapeHtml, HttpError } = require('./http');

const COMMON = ['first_name', 'cohort_name', 'cohort_dates', 'app_link', 'support_email'];

// key: [label, category, subject, body, extra merge fields]
const DEFAULTS = {
  purchase_next_steps: ['Enrollment confirmed', 'transactional',
    'You’re enrolled in {{cohort_name}}',
    `Hi {{first_name}},

You’re in. Your payment for {{cohort_name}} ({{cohort_dates}}) is confirmed and your seat is yours. Your receipt comes separately from our payment provider.

Your platform is open now: {{app_link}}

What to expect:
- Every day, January 4–24, 2027, including weekends: a new Guided Audio, Leadership Journal Prompt, and Business Action Toolkit resource. Plan for 5–10 minutes of audio and about 20–40 minutes to apply the day’s work.
- Three live Solutions Seat group coaching calls with Omi: Wednesdays, January 6, 13 and 20, 1–2 p.m. PST. Recordings are available in the platform.
- Questions: ask Omi in the platform. During the cohort, Omi responds within 24 hours, Monday through Friday.
- Access: 12 months of program materials and call recordings, January 4, 2027 through January 3, 2028.

Refunds: you may request a full refund before the cohort begins on January 4, 2027. Once the cohort begins, all sales are final. To request a refund before the start date, email hello@omisworld.com.

{{support_line}}`, ['support_line']],
  submission_received: ['Fit check received', 'transactional',
    'We received your fit check',
    `Hi {{first_name}},

Thanks for sending your fit check for {{cohort_name}}. Our team reviews {{review_turnaround}}, and we'll email you as soon as there's a decision.

Your status: {{app_link}}

{{support_line}}`, ['review_turnaround', 'support_line']],
  approval: ['Approved', 'transactional',
    'You’re approved for {{cohort_name}}',
    `Hi {{first_name}},

You’re approved. Your seat in {{cohort_name}} is confirmed for {{cohort_dates}}.

{{member_message}}

Open your cohort space: {{app_link}}

{{support_line}}`, ['member_message', 'support_line']],
  rejection: ['Not approved (with refund status)', 'transactional',
    'An update on your {{cohort_name}} enrollment',
    `Hi {{first_name}},

Thank you for your interest in {{cohort_name}}. After reviewing your fit check, we’ve decided this cohort isn’t the right fit for where your business is right now.

{{member_message}}

{{refund_message}}

Your account, receipt and refund status stay available here: {{app_link}}

{{support_line}}`, ['member_message', 'refund_message', 'refund_amount', 'support_line']],
  refund_update: ['Refund delay or processing update', 'transactional',
    'An update on your {{cohort_name}} refund',
    `Hi {{first_name}},

We’re writing with an update on your refund of {{refund_amount}}. {{refund_message}}

{{member_message}}

Your refund status: {{app_link}}

{{support_line}}`, ['refund_message', 'refund_amount', 'member_message', 'support_line']],
  refund_completed: ['Refund completed (optional)', 'transactional',
    'Your {{cohort_name}} refund is complete',
    `Hi {{first_name}},

Your refund of {{refund_amount}} has been processed by our payment provider. Depending on your bank, it can take several business days to appear on your statement.

{{support_line}}`, ['refund_amount', 'support_line']],
  support_reply: ['Reply to a question', 'transactional',
    'Re: {{thread_subject}}',
    `Hi {{first_name}},

There’s a new reply to your question “{{thread_subject}}”. For your privacy, the reply itself is in your account rather than in this email.

Read and reply here: {{thread_link}}

Replies to this email aren’t monitored; please respond in the app.`, ['thread_subject', 'thread_link']],
  introductions_open: ['Introductions are open (optional)', 'optional',
    'Meet your {{cohort_name}} cohort',
    `Hi {{first_name}},

Introductions are open. Share a little about your business and meet the business owners you’ll be building alongside.

Introduce yourself: {{app_link}}

You’re receiving this because you opted in to cohort reminders. You can change that in your account.`, []],
  kickoff: ['Cohort kickoff (optional)', 'optional',
    '{{cohort_name}} begins soon',
    `Hi {{first_name}},

{{cohort_name}} begins {{start_date}}. Your daily guidance, practices and tools will appear in your cohort space when we start.

Open your cohort space: {{app_link}}

You’re receiving this because you opted in to cohort reminders. You can change that in your account.`, ['start_date']],
  call_reminder: ['Solutions Seat reminder (optional)', 'optional',
    'Solutions Seat: {{call_time}}',
    `Hi {{first_name}},

A reminder that {{call_title}} is on {{call_time}}. Bring a challenge you’re working through; we’ll think it through together.

The join button appears in your cohort space shortly before the call: {{app_link}}

You’re receiving this because you opted in to call reminders. You can change that in your account.`, ['call_title', 'call_time']],
};

// Templates from the retired fit-check review (kept so old log entries still render).
const RETIRED = new Set(['submission_received', 'approval', 'rejection']);

function allowedFields(key) { return new Set([...COMMON, ...(DEFAULTS[key] ? DEFAULTS[key][4] : [])]); }

function templateMeta(key) {
  const d = DEFAULTS[key];
  return d ? { key, label: d[0], category: d[1], default_subject: d[2], default_body: d[3], fields: [...allowedFields(key)] } : null;
}

// Rejects unknown {{fields}} so a typo can't ship to members.
function validateTemplate(key, subject, body) {
  const allowed = allowedFields(key);
  const bad = [...`${subject}\n${body}`.matchAll(/{{\s*([^}]*?)\s*}}/g)].map(m => m[1]).filter(f => !allowed.has(f));
  if (bad.length) throw new HttpError(400, 'invalid_template', `Unknown merge field(s): ${[...new Set(bad)].map(f => `{{${f}}}`).join(', ')}. Allowed: ${[...allowed].map(f => `{{${f}}}`).join(' ')}`);
  const unbalanced = (`${subject}${body}`.match(/{{/g) || []).length !== (`${subject}${body}`.match(/}}/g) || []).length;
  if (unbalanced) throw new HttpError(400, 'invalid_template', 'A merge field is missing its closing braces.');
}

function render(text, vars) {
  return String(text).replace(/{{\s*([a-z_]+)\s*}}/g, (_, f) => (vars[f] == null ? '' : String(vars[f])))
    .replace(/\n{3,}/g, '\n\n').trim();
}

async function loadTemplate(sql, key) {
  const d = DEFAULTS[key];
  if (!d) throw new Error(`Unknown email template ${key}`);
  const row = (await sql`select * from so_email_templates where key = ${key}`)[0];
  if (row) return { key, subject: row.subject, body: row.body, version: row.version, enabled: row.enabled, category: d[1] };
  return { key, subject: d[2], body: d[3], version: 0, enabled: true, category: d[1] };
}

function fmtDates(startDate, endDate) {
  const f = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return `${f(startDate)} – ${f(endDate)}`;
}

// Standard variables for a member of a cohort.
async function baseVars(sql, cohort, userId) {
  const S = require('./schedule');
  const sched = S.schedule(cohort);
  const intake = userId ? (await sql`select first_name from so_intakes where user_id = ${userId} and cohort_id = ${cohort.id}`)[0] : null;
  const prof = userId ? (await sql`select display_name from so_profiles where user_id = ${userId}`)[0] : null;
  const support = (await sql`select value from so_site_content where key = 'support.email' and status = 'published'`)[0];
  return {
    first_name: (intake && intake.first_name) || (prof && prof.display_name ? prof.display_name.trim().split(/\s+/)[0] : '') || 'there',
    cohort_name: cohort.name,
    cohort_dates: fmtDates(sched.start_date, sched.end_date),
    start_date: new Date(`${sched.start_date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }),
    review_turnaround: cohort.review_turnaround,
    app_link: `${siteUrl()}${BASE_PATH}/login?next=${encodeURIComponent('/app')}`,
    support_email: support ? support.value : '',
    support_line: support ? `Questions? Email ${support.value}, or ask in your account.` : 'Questions? Ask in your account and we’ll get back to you.',
  };
}

// Queue a message. `db` may be a transaction. Duplicate dedupe keys are ignored.
async function enqueue(db, { key, dedupeKey, to, userId = null, cohortId = null, vars, bodyOverride = null, subjectOverride = null,
  related = null, actor = null, category = null, resendOf = null }) {
  const t = await loadTemplate(db, key);
  if (!t.enabled && !resendOf && category !== 'test') return null;
  const subject = render(subjectOverride || t.subject, vars);
  const body = render(bodyOverride || t.body, vars);
  const rows = await db`
    insert into so_email_outbox (dedupe_key, template_key, template_version, category, user_id, cohort_id, to_email, subject, body_text,
      edited, related_type, related_id, actor, resend_of)
    values (${dedupeKey}, ${key}, ${t.version}, ${category || t.category}, ${userId}, ${cohortId}, ${to}, ${subject}, ${body},
      ${!!(bodyOverride || subjectOverride)}, ${related ? related.type : null}, ${related ? String(related.id) : null}, ${actor}, ${resendOf})
    on conflict (dedupe_key) do nothing returning *`;
  return rows[0] || null;
}

function toHtml(text) {
  const linked = escapeHtml(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#5b2a5e">$1</a>');
  const paras = linked.split(/\n\s*\n/).map(p => `<p style="margin:0 0 16px">${p.replace(/\n/g, '<br>')}</p>`).join('');
  return `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#3a1f3d;background:#fbf7f1;line-height:1.7;font-size:16px">
<p style="font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#87482a;margin:0 0 20px">Smooth Operators</p>${paras}</div>`;
}

// Deliver queued messages. Safe to call repeatedly: rows are claimed atomically.
async function processOutbox(sql, { ids = null, limit = 20 } = {}) {
  const claimed = ids
    ? await sql`update so_email_outbox set status = 'sending', attempts = attempts + 1, updated_at = now()
                where id = any(${ids}) and status = 'queued' returning *`
    : await sql`update so_email_outbox set status = 'sending', attempts = attempts + 1, updated_at = now()
                where id in (select id from so_email_outbox where status = 'queued' order by created_at limit ${limit} for update skip locked)
                returning *`;
  const mode = emailMode();
  const key = process.env.RESEND_API_KEY;
  const results = [];
  for (const m of claimed) {
    const recipient = mode === 'live' ? m.to_email : mode === 'sandbox' ? process.env.SO_SANDBOX_EMAIL : null;
    if (!recipient || !key) {
      const why = mode === 'off' ? 'Email delivery is off (SO_EMAIL_DELIVERY).' : !key ? 'RESEND_API_KEY is not set.' : 'SO_SANDBOX_EMAIL is not set.';
      await sql`update so_email_outbox set status = 'skipped', last_error = ${why}, updated_at = now() where id = ${m.id}`;
      results.push({ id: m.id, status: 'skipped' });
      continue;
    }
    try {
      const res = await fetch(process.env.SO_RESEND_API_BASE && !require('./env').isProductionDeploy() ? `${process.env.SO_RESEND_API_BASE}/emails` : 'https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'Idempotency-Key': `so-${m.id}` },
        body: JSON.stringify({
          from: process.env.SO_EMAIL_FROM || process.env.RESEND_FROM || 'Omi Bell <hello@omibell.com>',
          to: [recipient],
          ...(process.env.SO_EMAIL_REPLY_TO ? { reply_to: process.env.SO_EMAIL_REPLY_TO } : {}),
          subject: mode === 'sandbox' ? `[sandbox → ${m.to_email}] ${m.subject}` : m.subject,
          text: m.body_text,
          html: toHtml(m.body_text),
          tags: [{ name: 'so_outbox', value: m.id.replace(/-/g, '') }],
        }),
        signal: AbortSignal.timeout(10000),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Resend ${res.status}${j && j.name ? ` ${j.name}` : ''}`);
      await sql`update so_email_outbox set status = 'submitted', provider_id = ${j.id || null}, submitted_at = now(), last_error = null, updated_at = now() where id = ${m.id}`;
      results.push({ id: m.id, status: 'submitted' });
    } catch (e) {
      await sql`update so_email_outbox set status = 'failed', last_error = ${String(e.message).slice(0, 200)}, updated_at = now() where id = ${m.id}`;
      console.error('[so] email failed', m.template_key, e.message);
      results.push({ id: m.id, status: 'failed' });
    }
  }
  return results;
}

// Resend delivery webhooks (Svix-signed): https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests
function verifySvix(raw, headers, secret, now = Date.now()) {
  const crypto = require('crypto');
  const id = headers['svix-id'], ts = headers['svix-timestamp'], sig = headers['svix-signature'];
  if (!secret) throw new HttpError(503, 'webhook_not_configured');
  if (!id || !ts || !sig) throw new HttpError(400, 'bad_signature');
  if (Math.abs(now / 1000 - Number(ts)) > 300) throw new HttpError(400, 'stale_signature');
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest();
  const ok = String(sig).split(' ').some(part => {
    const [ver, val] = part.split(',');
    if (ver !== 'v1' || !val) return false;
    const b = Buffer.from(val, 'base64');
    return b.length === expected.length && crypto.timingSafeEqual(b, expected);
  });
  if (!ok) throw new HttpError(400, 'bad_signature');
  return JSON.parse(raw);
}

async function processResendEvent(sql, raw, headers) {
  const evt = verifySvix(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw), headers, process.env.RESEND_WEBHOOK_SECRET);
  const id = `resend:${headers['svix-id']}`;
  const ins = await sql`insert into so_webhook_events (id, type, object_id) values (${id}, ${evt.type || 'unknown'}, ${evt.data && evt.data.email_id || null})
                        on conflict (id) do nothing returning id`;
  if (!ins[0]) return { status: 200, body: { received: true, duplicate: true } };
  const map = { 'email.sent': 'submitted', 'email.delivered': 'delivered', 'email.bounced': 'bounced', 'email.complained': 'complained', 'email.failed': 'failed' };
  const status = map[evt.type];
  if (status && evt.data && evt.data.email_id) {
    await sql`update so_email_outbox set status = ${status}, delivered_at = case when ${status} = 'delivered' then now() else delivered_at end,
              last_error = case when ${status} in ('bounced', 'failed', 'complained') then ${evt.type} else last_error end, updated_at = now()
              where provider_id = ${evt.data.email_id}
                and not (status = 'delivered' and ${status} = 'submitted')`;
  }
  await sql`update so_webhook_events set status = ${status ? 'processed' : 'ignored'}, processed_at = now() where id = ${id}`;
  return { status: 200, body: { received: true } };
}

module.exports = {
  DEFAULTS, RETIRED, templateMeta, validateTemplate, render, loadTemplate, baseVars, enqueue, processOutbox, toHtml, fmtDates,
  verifySvix, processResendEvent, allowedFields,
};
