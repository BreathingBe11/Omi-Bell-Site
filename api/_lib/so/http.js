'use strict';
// Request/response helpers, validation and a database-backed rate limiter.

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function sendJson(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function sendError(res, err) {
  if (err instanceof HttpError) {
    return sendJson(res, err.status, { error: err.code, message: err.message, ...(err.extra || {}) });
  }
  // Never echo internal errors (they can contain SQL or provider detail).
  console.error('[so] unhandled error:', err && (err.code || ''), err && err.message);
  return sendJson(res, 500, { error: 'server_error', message: 'Something went wrong on our side. Please try again.' });
}

function body(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === 'string') { try { return JSON.parse(b); } catch { throw new HttpError(400, 'bad_json'); } }
  if (Buffer.isBuffer(b)) { try { return JSON.parse(b.toString('utf8')); } catch { throw new HttpError(400, 'bad_json'); } }
  return b;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// Plain-text field: strips control characters, enforces type and length.
function text(v, { max = 500, required = false, field = 'field', multiline = false } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw new HttpError(400, 'invalid_input', `${field} must be text.`);
  let s = v.replace(CONTROL, '');
  if (!multiline) s = s.replace(/[\r\n]+/g, ' ');
  s = s.trim();
  if (required && !s) throw new HttpError(400, 'invalid_input', `${field} is required.`);
  if (s.length > max) throw new HttpError(400, 'invalid_input', `${field} must be ${max} characters or fewer.`);
  return s;
}

function optionalUrl(v, { field = 'URL', max = 500, allowRelative = false } = {}) {
  const s = text(v, { max, field });
  if (!s) return null;
  if (allowRelative && /^\/[A-Za-z0-9/_.\-%]+$/.test(s) && !s.startsWith('//')) return s;
  let u;
  try { u = new URL(s); } catch { throw new HttpError(400, 'invalid_input', `${field} must be a full https:// link.`); }
  if (u.protocol !== 'https:') throw new HttpError(400, 'invalid_input', `${field} must start with https://.`);
  if (u.username || u.password) throw new HttpError(400, 'invalid_input', `${field} must not contain credentials.`);
  return u.toString();
}

function int(v, { min = -Infinity, max = Infinity, field = 'number', nullable = false } = {}) {
  if ((v === null || v === undefined || v === '') && nullable) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, 'invalid_input', `${field} must be a whole number between ${min} and ${max}.`);
  return n;
}

function oneOf(v, allowed, field = 'value') {
  if (!allowed.includes(v)) throw new HttpError(400, 'invalid_input', `${field} must be one of: ${allowed.join(', ')}.`);
  return v;
}

function isoDate(v, { field = 'date', nullable = false } = {}) {
  if ((v === null || v === undefined || v === '') && nullable) return null;
  const d = new Date(v);
  if (typeof v !== 'string' || Number.isNaN(d.getTime())) throw new HttpError(400, 'invalid_input', `${field} must be a valid date and time.`);
  return d;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(v, field = 'id') {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new HttpError(404, 'not_found', `Unknown ${field}.`);
  return v.toLowerCase();
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Fixed-window limiter stored in Postgres so it holds across serverless instances.
async function rateLimit(sql, key, max, windowSeconds) {
  const rows = await sql`
    insert into so_rate_limits (key, window_start, count) values (${key}, now(), 1)
    on conflict (key) do update set
      count = case when so_rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
                   then 1 else so_rate_limits.count + 1 end,
      window_start = case when so_rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
                   then now() else so_rate_limits.window_start end
    returning count`;
  if (rows[0].count > max) throw new HttpError(429, 'rate_limited', 'Too many requests. Please wait a few minutes and try again.');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Returned by handlers that wrote the response themselves (downloads).
const HANDLED = Symbol('handled');

module.exports = {
  HANDLED, HttpError, sendJson, sendError, body, text, optionalUrl, int, oneOf, isoDate, uuid,
  clientIp, rateLimit, escapeHtml,
};
