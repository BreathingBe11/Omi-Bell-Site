'use strict';
const { verifyPassword, signToken, checkRateLimit, clientIp } = require('./_lib/auth');

const TOKEN_TTL = 8 * 60 * 60 * 1000; // 8 hours

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!checkRateLimit(clientIp(req))) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }

  const { password } = req.body || {};
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password required' });
  }

  const hash   = process.env.ADMIN_PASSWORD_HASH;
  const secret = process.env.SESSION_SECRET;
  if (!hash || !secret) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  if (!verifyPassword(password, hash)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  const token = signToken(
    { role: 'admin', iat: Date.now(), exp: Date.now() + TOKEN_TTL },
    secret
  );
  return res.status(200).json({ token });
};
