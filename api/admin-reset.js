'use strict';
const { signToken, verifyToken, hashPassword, checkRateLimit, clientIp } = require('./_lib/auth');
const { getAdminPasswordHash, setAdminPasswordHash, hashFingerprint } = require('./_lib/admin-password');

const RESET_TTL   = 30 * 60 * 1000; // 30 minutes
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'hello@omisworld.com';
const SITE_URL    = 'https://www.omibell.com';

// POST { action: 'request' }                 → emails a reset link to the admin
// POST { action: 'reset', token, password }  → sets a new admin password
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!checkRateLimit(clientIp(req))) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }

  const secret = process.env.SESSION_SECRET;
  const { action, token, password } = req.body || {};
  const current = await getAdminPasswordHash();
  if (!secret || !current) return res.status(500).json({ error: 'Server configuration error' });

  if (action === 'request') {
    const resetToken = signToken(
      { role: 'reset', fp: hashFingerprint(current), exp: Date.now() + RESET_TTL },
      secret
    );
    const link = `${SITE_URL}/admin?reset=${encodeURIComponent(resetToken)}`;

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from:    process.env.RESEND_FROM || 'Omi Bell <hello@omibell.com>',
        to:      [ADMIN_EMAIL],
        subject: 'Reset your Omi Bell admin password',
        html:    `<p>Someone asked to reset the admin password for omibell.com.</p>` +
                 `<p><a href="${link}">Choose a new password</a></p>` +
                 `<p>This link works once and expires in 30 minutes. If you didn't ask for this, you can ignore this email.</p>`,
        text:    `Someone asked to reset the admin password for omibell.com.\n\nChoose a new password: ${link}\n\n` +
                 `This link works once and expires in 30 minutes. If you didn't ask for this, you can ignore this email.`,
      }),
    });
    if (!r.ok) {
      console.error('Resend admin reset error:', r.status, await r.text());
      return res.status(500).json({ error: 'Could not send the reset email.' });
    }
    return res.status(200).json({ success: true });
  }

  if (action === 'reset') {
    const payload = verifyToken(token, secret);
    if (!payload || payload.role !== 'reset' || payload.fp !== hashFingerprint(current)) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    if (!(await setAdminPasswordHash(hashPassword(password)))) {
      return res.status(500).json({ error: 'Could not save the new password.' });
    }
    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
};
