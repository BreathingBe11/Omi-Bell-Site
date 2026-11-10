'use strict';
// Member identity (Supabase Auth) and admin identity.
//
// Members sign in with Supabase Auth email codes/links; the browser sends the
// Supabase access token as a Bearer token and we validate it with the Auth
// server on every request (cached briefly). Admins are either the existing
// omibell.com admin (password login at /api/admin-login, HMAC token) or a
// Supabase user whose so_profiles.role is 'admin' — that role can only be set
// with SQL, never from the client.

const crypto = require('crypto');
const { verifyAdminToken } = require('../auth');
const { HttpError } = require('./http');

const cache = new Map();
const CACHE_MS = 60 * 1000;

function bearer(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

async function getAuthUser(req) {
  const token = bearer(req);
  // Supabase access tokens are JWTs (three segments). The site admin token has two.
  if (!token || token.split('.').length !== 3 || token.length > 4096) return null;
  const url = process.env.SUPABASE_URL;
  const apikey = process.env.SUPABASE_ANON_KEY;
  if (!url || !apikey) throw new HttpError(503, 'auth_not_configured', 'Sign-in is not configured yet.');

  const key = crypto.createHash('sha256').update(token).digest('hex');
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.user;

  let res;
  try {
    res = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/user`, {
      headers: { apikey, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new HttpError(503, 'auth_unreachable', 'We could not verify your sign-in. Please try again.');
  }
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new HttpError(503, 'auth_unreachable', 'We could not verify your sign-in. Please try again.');
  const u = await res.json();
  if (!u || !u.id || !u.email) return null;
  // Only verified identities can buy or access the cohort.
  if (!u.email_confirmed_at && !u.confirmed_at) return null;
  const user = { id: u.id, email: String(u.email).toLowerCase() };
  cache.set(key, { user, until: Date.now() + CACHE_MS });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return user;
}

async function requireUser(req) {
  const user = await getAuthUser(req);
  if (!user) throw new HttpError(401, 'unauthenticated', 'Please sign in to continue.');
  return user;
}

async function ensureProfile(sql, user) {
  const rows = await sql`
    insert into so_profiles (user_id, email) values (${user.id}, ${user.email})
    on conflict (user_id) do update set email = excluded.email
      where so_profiles.email is distinct from excluded.email
    returning *`;
  if (rows[0]) return rows[0];
  return (await sql`select * from so_profiles where user_id = ${user.id}`)[0];
}

async function requireAdmin(req, sql) {
  if (verifyAdminToken(req)) return { actor: 'site-admin' };
  const user = await getAuthUser(req);
  if (user) {
    const p = (await sql`select role from so_profiles where user_id = ${user.id}`)[0];
    if (p && p.role === 'admin') return { actor: user.email, userId: user.id };
  }
  throw new HttpError(403, 'forbidden', 'Admin access required.');
}

module.exports = { getAuthUser, requireUser, ensureProfile, requireAdmin, _cache: cache };
