'use strict';
// Postgres connection for Smooth Operators. Uses SO_DATABASE_URL, which must be
// a server-only connection string (Supabase: Project Settings -> Database ->
// Connection pooling, "Transaction" mode, port 6543). Never expose it to the
// browser. Prepared statements are disabled for compatibility with the pooler.

const postgres = require('postgres');
const { HttpError } = require('./http');

let sql = null;

// Reads postgresql://user:password@host:port/db tolerantly, so a password with
// symbols works whether or not it was percent-encoded.
// Supabase asks for special characters to be percent-encoded (e.g. @ -> %40).
// Decode valid encodings; keep the text as-is if it isn't valid encoding
// (e.g. a password that simply contains a % sign).
function decodeLoose(v) {
  try { return decodeURIComponent(v); } catch { return v; }
}

function parseUrl(raw) {
  const url = String(raw).trim().replace(/^["']|["']$/g, '');
  const m = /^postgres(?:ql)?:\/\/([^:/@]+)(?::(.*))?@([^@/:]+)(?::(\d+))?\/([^?\s]+)(\?.*)?$/.exec(url);
  if (!m) {
    console.error('[so] SO_DATABASE_URL is not a valid postgresql:// connection string');
    throw new HttpError(503, 'not_configured', 'The database connection setting (SO_DATABASE_URL) is not valid.');
  }
  if (m[2] && /^\[.*\]$/.test(m[2])) {
    console.error('[so] SO_DATABASE_URL still contains the [YOUR-PASSWORD] placeholder');
    throw new HttpError(503, 'not_configured', 'The database password in SO_DATABASE_URL still needs to be filled in.');
  }
  return { username: decodeLoose(m[1]), password: m[2] ? decodeLoose(m[2]) : undefined, host: m[3], port: Number(m[4] || 5432), database: m[5] };
}

function getSql() {
  if (sql) return sql;
  const url = process.env.SO_DATABASE_URL;
  if (!url) throw new HttpError(503, 'not_configured', 'Smooth Operators is not configured yet.');
  const conn = parseUrl(url);
  const local = /^(localhost|127\.0\.0\.1)$/.test(conn.host);
  sql = postgres({ ...conn,
    max: Number(process.env.SO_DB_POOL_MAX || 3),
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: local ? false : 'require',
    onnotice: () => {},
  });
  return sql;
}

// Test hook.
function setSql(instance) { sql = instance; }

module.exports = { getSql, setSql, parseUrl };
