module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { firstName, lastName, email, company, inquiryType } = req.body || {};

  if (!email || !firstName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const token = process.env.MAILERLITE_API_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const body = {
    email,
    fields: {
      name: firstName,
      last_name: lastName || '',
    },
  };

  const groupId = process.env.MAILERLITE_GROUP_ID_CONTACT;
  if (groupId) body.groups = [groupId];

  const mlRes = await fetch('https://connect.mailerlite.com/api/subscribers', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!mlRes.ok && mlRes.status !== 200 && mlRes.status !== 201) {
    console.error('MailerLite error:', mlRes.status, await mlRes.text());
    return res.status(500).json({ error: 'Failed to add subscriber' });
  }

  return res.status(200).json({ success: true });
}
