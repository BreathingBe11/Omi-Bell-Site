'use strict';
const { createClient } = require('@supabase/supabase-js');
const { verifyWriterToken } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const payload = verifyWriterToken(req);
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });

  const writer   = payload.writer;
  const { id, ...fields } = req.body || {};

  // Enforce author identity from the token — never trust the client.
  fields.author_id   = writer.id;
  fields.author_name = writer.name;
  fields.author_bio  = writer.bio || null;

  // Writers can only save drafts or submit — not publish directly.
  if (!['draft', 'submitted'].includes(fields.status)) {
    return res.status(403).json({ error: 'Writers cannot publish directly' });
  }
  fields.published = false;

  delete fields.created_at;

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (id) {
    // Verify ownership before updating.
    const { data: existing } = await db
      .from('posts')
      .select('author_id, status, published')
      .eq('id', id)
      .single();

    if (!existing || existing.author_id !== writer.id) {
      return res.status(403).json({ error: 'Not your post' });
    }
    // Cannot edit a post that is already published or under review.
    if (existing.published || existing.status === 'submitted') {
      return res.status(403).json({ error: 'Post cannot be edited in its current state' });
    }

    const { error } = await db.from('posts').update(fields).eq('id', id);
    if (error) return res.status(500).json({ error: 'Failed to save post' });
    return res.status(200).json({ success: true, id });
  }

  // New post.
  if (!fields.date) fields.date = new Date().toISOString();
  const { data, error } = await db.from('posts').insert(fields).select('id').single();
  if (error) return res.status(500).json({ error: 'Failed to create post' });
  return res.status(200).json({ success: true, id: data.id });
};
