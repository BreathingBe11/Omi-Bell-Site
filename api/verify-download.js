const Stripe = require('stripe');
const {createClient} = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  const {session_id} = req.query;
  if (!session_id) return res.status(400).json({error: 'Missing session_id'});

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({error: 'Payment verification unavailable'});
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(session_id);
  } catch {
    return res.status(400).json({error: 'Invalid session'});
  }

  if (session.payment_status !== 'paid') {
    return res.status(402).json({error: 'Payment not completed'});
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const {data, error} = await supabase.storage
    .from('playbook')
    .createSignedUrl('30-day-show-playbook.pdf', 3600);

  if (error) {
    return res.status(503).json({error: 'Download not available yet. Please contact hello@omisworld.com.'});
  }

  res.json({download_url: data.signedUrl, email: session.customer_details?.email});
};
