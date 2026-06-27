'use strict';
const { checkRateLimit, clientIp } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!checkRateLimit(clientIp(req))) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }

  const { firstName, lastName, email, company, inquiryType, message } = req.body || {};

  if (!email || !firstName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const token = process.env.MAILERLITE_API_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const body = {
    email,
    fields: {
      name:         firstName,
      last_name:    lastName    || '',
      company:      company     || '',
      inquiry_type: inquiryType || '',
      message:      message     || '',
    },
  };

  const groupId = process.env.MAILERLITE_GROUP_ID_CONTACT;
  if (groupId) body.groups = [groupId];

  const mlRes = await fetch('https://connect.mailerlite.com/api/subscribers', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
      'Accept':        'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!mlRes.ok) {
    console.error('MailerLite contact error:', mlRes.status);
    return res.status(500).json({ error: 'Failed to send message' });
  }

  return res.status(200).json({ success: true });
};
