'use strict';
const { createClient } = require('@supabase/supabase-js');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, description, link, submitter_email } = req.body || {};

  if (!name || !description || !link) {
    return res.status(400).json({ error: 'Name, description, and link are required.' });
  }

  if (name.length > 120 || description.length > 600 || link.length > 500) {
    return res.status(400).json({ error: 'Input too long.' });
  }

  if (submitter_email && !EMAIL_RE.test(submitter_email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  let parsedLink;
  try {
    parsedLink = new URL(link);
    if (!['http:', 'https:'].includes(parsedLink.protocol)) throw new Error();
  } catch {
    return res.status(400).json({ error: 'Link must be a valid URL.' });
  }

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { error } = await db.from('resources').insert({
    name: name.trim(),
    description: description.trim(),
    link: parsedLink.href,
    submitter_email: submitter_email ? submitter_email.trim() : null,
    approved: false,
  });

  if (error) {
    console.error('Resource insert error:', error);
    return res.status(500).json({ error: 'Failed to save resource.' });
  }

  return res.status(200).json({ success: true });
};
