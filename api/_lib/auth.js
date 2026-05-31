'use strict';
const crypto = require('crypto');

// --- Token signing (HMAC-SHA256, no external deps) ---

function signToken(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const data = token.slice(0, dot);
  const sig  = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  const sBuf = Buffer.from(sig,      'base64url');
  const eBuf = Buffer.from(expected, 'base64url');
  if (sBuf.length !== eBuf.length || !crypto.timingSafeEqual(sBuf, eBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// --- Password hashing (scrypt, built-in Node crypto) ---

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const colon = stored.indexOf(':');
  if (colon < 1) return false;
  const salt = stored.slice(0, colon);
  const hash = stored.slice(colon + 1);
  try {
    const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(
      Buffer.from(hash,      'hex'),
      Buffer.from(candidate, 'hex')
    );
  } catch {
    return false;
  }
}

// Detect whether a stored value is a scrypt hash or legacy plaintext.
// Scrypt hashes are: 32 hex chars + ':' + 128 hex chars (64-byte output).
const HASH_RE = /^[0-9a-f]{32}:[0-9a-f]{128}$/;
function isHashed(stored) { return HASH_RE.test(stored); }

// --- Per-IP rate limiting (in-memory; resets per serverless instance) ---

const _rateLimits = new Map();
const RATE_MAX    = 5;
const RATE_WINDOW = 15 * 60 * 1000; // 15 minutes

function checkRateLimit(ip) {
  const now   = Date.now();
  const entry = _rateLimits.get(ip) || { count: 0, reset: now + RATE_WINDOW };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + RATE_WINDOW; }
  entry.count++;
  _rateLimits.set(ip, entry);
  return entry.count <= RATE_MAX;
}

// --- Admin token helpers ---

function getBearer(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function verifyAdminToken(req) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  const payload = verifyToken(getBearer(req), secret);
  if (!payload || payload.role !== 'admin') return null;
  return payload;
}

function verifyWriterToken(req) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  const payload = verifyToken(getBearer(req), secret);
  if (!payload || payload.role !== 'writer' || !payload.writer) return null;
  return payload;
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';
}

module.exports = {
  signToken, verifyToken,
  hashPassword, verifyPassword, isHashed,
  checkRateLimit,
  verifyAdminToken, verifyWriterToken, clientIp,
};
