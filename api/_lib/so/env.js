'use strict';
// Environment-derived configuration. Secrets are read here and never returned
// to clients; only derived booleans/modes leave the server.

const BASE_PATH = '/smoothoperators';

function stripeMode() {
  const key = process.env.STRIPE_SECRET_KEY || '';
  if (!key) return 'unconfigured';
  if (/^(sk|rk)_live_/.test(key)) return 'live';
  if (/^(sk|rk)_test_/.test(key)) return 'test';
  return 'invalid';
}

function isProductionDeploy() {
  return process.env.VERCEL_ENV === 'production';
}

// Test-mode checkout on the production deployment would let visitors "enroll"
// with test cards, so it needs an explicit opt-in there.
function testCheckoutAllowed() {
  return stripeMode() === 'test' && (!isProductionDeploy() || process.env.SO_ALLOW_TEST_CHECKOUT === 'true');
}

function supabaseConfigured() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
}

function emailMode() {
  const m = process.env.SO_EMAIL_DELIVERY || 'off';
  return ['off', 'sandbox', 'live'].includes(m) ? m : 'off';
}

function siteUrl(req) {
  if (process.env.SO_SITE_URL) return process.env.SO_SITE_URL.replace(/\/+$/, '');
  const host = (req && (req.headers['x-forwarded-host'] || req.headers.host)) || 'localhost:3000';
  const proto = (req && req.headers['x-forwarded-proto']) || (/^localhost|^127\./.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

function appUrl(req, path = '') {
  return `${siteUrl(req)}${BASE_PATH}${path}`;
}

module.exports = {
  BASE_PATH, stripeMode, isProductionDeploy, testCheckoutAllowed, supabaseConfigured, emailMode, siteUrl, appUrl,
};
