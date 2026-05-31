'use strict';
const { createClient } = require('@supabase/supabase-js');
const { verifyWriterToken } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const payload = verifyWriterToken(req);
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });

  const writerId = payload.writer.id;
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { id } = req.query;

  if (id) {
    // Single post — must belong to this writer.
    const { data, error } = await db
      .from('posts')
      .select('*')
      .eq('id', id)
      .eq('author_id', writerId)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Post not found' });
    return res.status(200).json({ post: data });
  }

  // List — only this writer's posts.
  const { data, error } = await db
    .from('posts')
    .select('id, title, date, published, status')
    .eq('author_id', writerId)
    .order('updated_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'Failed to load posts' });
  return res.status(200).json({ posts: data || [] });
};
