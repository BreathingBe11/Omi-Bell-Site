'use strict';
const { createClient } = require('@supabase/supabase-js');
const { checkRateLimit, clientIp, verifyAdminToken } = require('./_lib/auth');

// Coterie sessions in Omi's Layer. All times are Central (CDT, UTC-5).
const TZ_OFFSET   = '-05:00';
const DAYS        = ['2026-10-21', '2026-10-22'];
const DAY_START   = 8 * 60;        // 8:00 AM
const DAY_END     = 21 * 60;       // 9:00 PM — last session must end by then
const SESSION_MIN = 20;
const STEP_MIN    = 30;            // 20 min session + 10 min transition
const BLOCKED     = ['2026-10-21T15:00']; // 3:00–3:30 PM today
const SERVICES    = ['Reiki', 'Breathwork', 'Sound healing', 'Combo'];
const COTERIE_GROUP = '201963862928393795'; // MailerLite "Coterie" group
const OWNER_EMAIL   = process.env.ADMIN_EMAIL || 'hello@omisworld.com';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function pad(n) { return String(n).padStart(2, '0'); }

function allSlots() {
  const slots = [];
  for (const day of DAYS) {
    for (let m = DAY_START; m + SESSION_MIN <= DAY_END; m += STEP_MIN) {
      const local = `${day}T${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
      if (BLOCKED.includes(local)) continue;
      slots.push(new Date(`${local}:00${TZ_OFFSET}`).toISOString());
    }
  }
  return slots;
}

function openSlots() {
  const cutoff = Date.now() + 5 * 60 * 1000;
  return allSlots().filter(s => new Date(s).getTime() > cutoff);
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (String(raw).trim().startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

function sessionWhen(slot_start) {
  return new Date(slot_start).toLocaleString('en-US', {
    timeZone: 'America/Chicago', weekday: 'long', month: 'long',
    day: 'numeric', hour: 'numeric', minute: '2-digit',
  }) + ' CT';
}

function serviceText(service) {
  return service === 'Combo' ? "A combo (we'll decide together when you arrive)" : service;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Sends an email via Resend (skipped if RESEND_API_KEY isn't set).
async function sendEmail(message) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({ from: process.env.RESEND_FROM || 'Omi Bell <hello@omibell.com>', ...message }),
  });
  if (!res.ok) console.error('Resend coterie error:', res.status, await res.text());
}

async function sendWelcomeEmail({ name, email, service, slot_start }) {
  const first = escapeHtml(name.split(' ')[0]);
  const when  = escapeHtml(sessionWhen(slot_start));
  const what  = escapeHtml(serviceText(service));

  const html = `
<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#1d2430;line-height:1.7">
  <p style="font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#2AB5C5;margin:0 0 8px">Coterie</p>
  <h1 style="font-weight:normal;font-size:28px;margin:0 0 24px">Welcome, ${first}</h1>
  <p>Thank you for reserving a session with me. I'm so glad you're joining me in Omi's Layer.</p>
  <table style="margin:24px 0;border-collapse:collapse;font-size:16px">
    <tr><td style="padding:4px 16px 4px 0;color:#6b7280">When</td><td>${when}</td></tr>
    <tr><td style="padding:4px 16px 4px 0;color:#6b7280">Session</td><td>${what}</td></tr>
    <tr><td style="padding:4px 16px 4px 0;color:#6b7280">Where</td><td>Omi's Layer, the second floor speakeasy room</td></tr>
  </table>
  <p>Sessions are 20 minutes, so please come a few minutes early. I'll reach out when it's time.</p>
  <p style="margin-top:32px">With love,<br>Omi</p>
</div>`;

  const text =
    `Welcome, ${name.split(' ')[0]}\n\n` +
    `Thank you for reserving a session with me. I'm so glad you're joining me in Omi's Layer.\n\n` +
    `When: ${sessionWhen(slot_start)}\nSession: ${serviceText(service)}\n` +
    `Where: Omi's Layer, the second floor speakeasy room\n\n` +
    `Sessions are 20 minutes, so please come a few minutes early. I'll reach out when it's time.\n\n` +
    `With love,\nOmi`;

  await sendEmail({
    to:       [email],
    reply_to: OWNER_EMAIL,
    subject:  `Welcome to the Coterie, ${name.split(' ')[0]}`,
    html,
    text,
  });
}

// Lets Omi know a new booking came in; replying goes straight to the guest.
async function sendOwnerNotice({ name, phone, email, service, slot_start }) {
  const rows = [
    ['When', sessionWhen(slot_start)],
    ['Session', serviceText(service)],
    ['Name', name],
    ['Phone', phone],
    ['Email', email],
  ];
  await sendEmail({
    to:       [OWNER_EMAIL],
    reply_to: email,
    subject:  `New Coterie booking: ${name}, ${sessionWhen(slot_start)}`,
    html:     `<p>New booking for Omi's Layer:</p><table style="font-size:15px">` +
              rows.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#6b7280">${k}</td><td>${escapeHtml(v)}</td></tr>`).join('') +
              `</table><p><a href="https://www.omibell.com/coterie/list">See all bookings</a></p>`,
    text:     rows.map(([k, v]) => `${k}: ${v}`).join('\n') + '\n\nAll bookings: https://www.omibell.com/coterie/list',
  });
}

// Adds the guest to the MailerLite "Coterie" group so you can email them later.
async function addToMailerLite({ name, phone, email, service, slot_start }) {
  const token   = process.env.MAILERLITE_API_TOKEN;
  const groupId = process.env.MAILERLITE_GROUP_ID_COTERIE || COTERIE_GROUP;
  if (!token || !groupId) return;

  const res = await fetch('https://connect.mailerlite.com/api/subscribers', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
      'Accept':        'application/json',
    },
    body: JSON.stringify({
      email,
      groups: [groupId],
      fields: {
        name:            name.split(' ')[0],
        last_name:       name.split(' ').slice(1).join(' '),
        phone,
        coterie_time:    sessionWhen(slot_start),
        coterie_service: serviceText(service),
      },
    }),
  });
  if (!res.ok) console.error('MailerLite coterie error:', res.status, await res.text());
}

module.exports = async function handler(req, res) {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Admin: full booking list for the /coterie/list page.
  if (req.method === 'GET' && req.query.list) {
    if (!verifyAdminToken(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { data, error } = await db
      .from('coterie_bookings')
      .select('id, slot_start, name, phone, email, service')
      .order('slot_start');
    if (error) return res.status(500).json({ error: 'Failed to load bookings.' });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ bookings: data || [] });
  }

  if (req.method === 'GET') {
    const { data, error } = await db.from('coterie_bookings').select('slot_start');
    if (error) {
      console.error('Coterie fetch error:', error);
      return res.status(500).json({ error: 'Failed to load times.' });
    }
    const taken = new Set(data.map(r => new Date(r.slot_start).toISOString()));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ slots: openSlots().filter(s => !taken.has(s)) });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!checkRateLimit(clientIp(req))) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }

  const { name, phone, email, service, slot } = req.body || {};

  if (!name || !phone || !email || !service || !slot) {
    return res.status(400).json({ error: 'Please fill in every field.' });
  }
  if (name.length > 120 || email.length > 200) {
    return res.status(400).json({ error: 'Input too long.' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }
  const e164 = normalizePhone(phone);
  if (!e164) {
    return res.status(400).json({ error: 'Invalid phone number.' });
  }
  if (!SERVICES.includes(service)) {
    return res.status(400).json({ error: 'Invalid service.' });
  }
  if (!openSlots().includes(slot)) {
    return res.status(400).json({ error: 'That time is no longer available.' });
  }

  const booking = {
    slot_start: slot,
    name: name.trim(),
    phone: e164,
    email: email.trim(),
    service,
  };

  const { error } = await db.from('coterie_bookings').insert(booking);
  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Someone just grabbed that time. Please pick another.' });
    }
    console.error('Coterie insert error:', error);
    return res.status(500).json({ error: 'Failed to save booking.' });
  }

  const results = await Promise.allSettled([
    sendWelcomeEmail(booking), sendOwnerNotice(booking), addToMailerLite(booking),
  ]);
  results.filter(r => r.status === 'rejected').forEach(r => console.error('Coterie follow-up error:', r.reason));

  return res.status(200).json({ success: true });
};
