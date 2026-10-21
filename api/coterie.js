'use strict';
const { createClient } = require('@supabase/supabase-js');
const { checkRateLimit, clientIp } = require('./_lib/auth');

// Coterie sessions in Omi's Layer. All times are Central (CDT, UTC-5).
const TZ_OFFSET   = '-05:00';
const DAYS        = ['2026-10-21', '2026-10-22'];
const DAY_START   = 8 * 60;        // 8:00 AM
const DAY_END     = 21 * 60;       // 9:00 PM — last session must end by then
const SESSION_MIN = 20;
const STEP_MIN    = 30;            // 20 min session + 10 min transition
const BLOCKED     = ['2026-10-21T15:00']; // 3:00–3:30 PM today
const SERVICES    = ['Reiki', 'Breathwork', 'Sound healing', 'Combo'];

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

function formatTime(iso) {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', month: 'short',
    day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (String(raw).trim().startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

// --- SMS via Twilio (optional: skipped if env vars are missing) ---

async function sendSms(to, body, sendAt) {
  const sid     = process.env.TWILIO_ACCOUNT_SID;
  const token   = process.env.TWILIO_AUTH_TOKEN;
  const service = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (!sid || !token || !service) return false;

  const params = new URLSearchParams({ To: to, Body: body, MessagingServiceSid: service });
  if (sendAt) {
    params.set('ScheduleType', 'fixed');
    params.set('SendAt', sendAt.toISOString());
  }

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: params,
  });
  if (!res.ok) {
    console.error('Twilio error:', res.status, await res.text());
    return false;
  }
  return true;
}

async function textBooking({ name, phone, service, slot_start }) {
  const first = name.split(' ')[0];
  const when  = formatTime(slot_start);
  const what  = service === 'Combo' ? 'a combo session' : service;

  await sendSms(phone,
    `Hi ${first}! You're booked with Omi for ${what} on ${when} CT in Omi's Layer, ` +
    `the second floor speakeasy room. We'll text you when it's time.`);

  // Twilio can only schedule messages 15+ minutes out; closer bookings get just the confirmation.
  const remindAt = new Date(new Date(slot_start).getTime() - 5 * 60 * 1000);
  if (remindAt.getTime() - Date.now() >= 16 * 60 * 1000) {
    await sendSms(phone,
      `Hi ${first}, it's almost time! Your session with Omi starts in 5 minutes. ` +
      `Head up to Omi's Layer, the second floor speakeasy room.`, remindAt);
  }
}

module.exports = async function handler(req, res) {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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

  try {
    await textBooking(booking);
  } catch (err) {
    console.error('Coterie SMS error:', err);
  }

  return res.status(200).json({ success: true });
};
