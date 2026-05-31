'use strict';
const { createClient } = require('@supabase/supabase-js');
const {
  verifyPassword, hashPassword, isHashed,
  signToken, checkRateLimit, clientIp,
} = require('./_lib/auth');

const TOKEN_TTL = 8 * 60 * 60 * 1000; // 8 hours

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!checkRateLimit(clientIp(req))) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }

  const { name, password } = req.body || {};
  if (!name || !password || typeof name !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Name and password required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const secret      = process.env.SESSION_SECRET;
  if (!supabaseUrl || !serviceKey || !secret) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const db = createClient(supabaseUrl, serviceKey);
  const { data, error } = await db
    .from('writers')
    .select('id, name, bio, password, active')
    .ilike('name', name.trim())
    .single();

  // Use the same generic message for not-found and wrong-password to avoid enumeration.
  const DENIED = { error: 'Name or password not found. Contact Omi to get access.' };

  if (error || !data || !data.active) return res.status(401).json(DENIED);

  let valid = false;
  if (isHashed(data.password)) {
    valid = verifyPassword(password, data.password);
  } else {
    // Legacy plaintext — compare then silently upgrade to hashed on success.
    valid = data.password === password;
    if (valid) {
      await db.from('writers').update({ password: hashPassword(password) }).eq('id', data.id);
    }
  }

  if (!valid) return res.status(401).json(DENIED);

  const writer = { id: data.id, name: data.name, bio: data.bio };
  const token  = signToken(
    { role: 'writer', writer, iat: Date.now(), exp: Date.now() + TOKEN_TTL },
    secret
  );
  return res.status(200).json({ token, writer });
};
