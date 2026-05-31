'use strict';
const { createClient } = require('@supabase/supabase-js');
const { verifyAdminToken } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyAdminToken(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Post ID required' });

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await db.from('posts').select('*').eq('id', id).single();

  if (error || !data) return res.status(404).json({ error: 'Post not found' });
  return res.status(200).json({ post: data });
};
