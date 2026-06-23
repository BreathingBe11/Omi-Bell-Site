const Stripe = require('stripe');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({error: 'Method not allowed'});

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({error: 'Payment system not configured yet. Please check back soon.'});
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const siteUrl = process.env.SITE_URL || 'https://omibell.com';

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'The 30-Day Show Playbook',
          description: 'Complete framework for launching and sustaining a live show — templates, systems, and every lesson from 30+ days of doing it live.',
        },
        unit_amount: 299,
      },
      quantity: 1,
    }],
    mode: 'payment',
    success_url: `${siteUrl}/playbook-download?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl}/resources#30-day-show`,
  });

  res.json({url: session.url});
};
