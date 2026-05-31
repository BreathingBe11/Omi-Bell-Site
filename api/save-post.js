'use strict';
const { createClient } = require('@supabase/supabase-js');
const { verifyAdminToken } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyAdminToken(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { id, ...fields } = req.body || {};

  // Strip fields that should never be set by the client directly.
  delete fields.created_at;

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (id) {
    const { error } = await db.from('posts').update(fields).eq('id', id);
    if (error) return res.status(500).json({ error: 'Failed to save post' });
    return res.status(200).json({ success: true, id });
  } else {
    const { data, error } = await db.from('posts').insert(fields).select('id').single();
    if (error) return res.status(500).json({ error: 'Failed to create post' });
    return res.status(200).json({ success: true, id: data.id });
  }
};
