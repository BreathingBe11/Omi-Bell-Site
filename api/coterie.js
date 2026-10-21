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

// Adds the guest to the MailerLite "Coterie" group. A MailerLite automation on that
// group sends the welcome email, using the coterie_time and coterie_service fields.
async function addToMailerLite({ name, phone, email, service, slot_start }) {
  const token   = process.env.MAILERLITE_API_TOKEN;
  const groupId = process.env.MAILERLITE_GROUP_ID_COTERIE;
  if (!token || !groupId) return;

  const when = new Date(slot_start).toLocaleString('en-US', {
    timeZone: 'America/Chicago', weekday: 'long', month: 'long',
    day: 'numeric', hour: 'numeric', minute: '2-digit',
  });

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
        coterie_time:    `${when} CT`,
        coterie_service: service === 'Combo' ? "a combo (we'll decide together when you arrive)" : service,
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

  try {
    await addToMailerLite(booking);
  } catch (err) {
    console.error('MailerLite coterie error:', err);
  }

  return res.status(200).json({ success: true });
};
