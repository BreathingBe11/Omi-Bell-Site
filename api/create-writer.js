'use strict';
const { createClient } = require('@supabase/supabase-js');
const { verifyAdminToken, hashPassword } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyAdminToken(req))  return res.status(401).json({ error: 'Unauthorized' });

  const { name, password, bio } = req.body || {};
  if (!name || !password || typeof name !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Name and password are required' });
  }
  if (name.trim().length < 2)  return res.status(400).json({ error: 'Name too short' });
  if (password.length < 8)     return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { error } = await db.from('writers').insert({
    name:     name.trim(),
    password: hashPassword(password),
    bio:      bio?.trim() || null,
    active:   true,
  });

  if (error) return res.status(500).json({ error: 'Failed to create writer' });
  return res.status(200).json({ success: true });
};
