'use strict';
const { createClient } = require('@supabase/supabase-js');
const { verifyAdminToken } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyAdminToken(req)) return res.status(401).json({ error: 'Unauthorized' });

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  // Explicitly exclude the password column — never send it to the client.
  const { data, error } = await db
    .from('writers')
    .select('id, name, bio, active, created_at')
    .order('created_at');

  if (error) return res.status(500).json({ error: 'Failed to load writers' });
  return res.status(200).json({ writers: data || [] });
};
