'use strict';
const { createClient } = require('@supabase/supabase-js');
const { verifyAdminToken } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyAdminToken(req)) return res.status(401).json({ error: 'Unauthorized' });

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await db
    .from('posts')
    .select('id, title, date, published, status, author_name, author_id')
    .order('date', { ascending: false });

  if (error) return res.status(500).json({ error: 'Failed to load posts' });
  return res.status(200).json({ posts: data || [] });
};
