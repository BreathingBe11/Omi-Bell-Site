'use strict';
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data, error } = await db
    .from('resources')
    .select('id, name, description, link, created_at')
    .eq('approved', true)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Resource fetch error:', error);
    return res.status(500).json({ error: 'Failed to load resources.' });
  }

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  return res.status(200).json({ resources: data || [] });
};
