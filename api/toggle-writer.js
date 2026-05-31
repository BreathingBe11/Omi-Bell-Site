'use strict';
const { createClient } = require('@supabase/supabase-js');
const { verifyAdminToken } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyAdminToken(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { id, active } = req.body || {};
  if (!id || typeof active !== 'boolean') {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { error } = await db.from('writers').update({ active }).eq('id', id);

  if (error) return res.status(500).json({ error: 'Failed to update writer' });
  return res.status(200).json({ success: true });
};
