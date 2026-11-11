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

const OPTIONS = { prepare: false, idle_timeout: 20, connect_timeout: 8, onnotice: () => {} };

// Turn whatever Supabase string was pasted into the addresses worth trying.
// The "Direct connection" host (db.<ref>.supabase.co) isn't reachable from
// Vercel, so it's converted to the Transaction pooler, which lives on one of
// two regional hosts (aws-0 / aws-1) depending on when the project was made.
function candidates(conn) {
  const direct = /^db\.([a-z0-9]{10,40})\.supabase\.co$/.exec(conn.host);
  const pooler = /\.pooler\.supabase\.com$/.test(conn.host);
  const refFromEnv = (/^https:\/\/([a-z0-9]{10,40})\.supabase\.co/.exec(process.env.SUPABASE_URL || '') || [])[1];
  const ref = direct ? direct[1] : refFromEnv;
  const fixUser = u => (ref && u === 'postgres' ? `postgres.${ref}` : u);
  if (direct) {
    // Try the pasted address first (works when Supabase's IPv4 add-on is on),
    // then the shared pooler on both regional hosts.
    const region = process.env.SO_DB_REGION || 'us-east-1';
    return [conn, ...[`aws-0-${region}`, `aws-1-${region}`].map(h => ({
      ...conn, host: `${h}.pooler.supabase.com`, port: 6543, username: fixUser(conn.username), database: conn.database || 'postgres',
    }))];
  }
  if (pooler) {
    const list = [{ ...conn, username: fixUser(conn.username) }];
    const other = conn.host.replace(/^aws-0-/, 'aws-1-') === conn.host ? conn.host.replace(/^aws-1-/, 'aws-0-') : conn.host.replace(/^aws-0-/, 'aws-1-');
    if (other !== conn.host) list.push({ ...list[0], host: other });
    return list;
  }
  return [conn];
}

// Plain-English reason, safe to show (never contains the password).
function explain(err) {
  const msg = String((err && err.message) || '');
  const code = err && err.code;
  if (code === 'ENOTFOUND' || /getaddrinfo/.test(msg)) return 'Vercel could not reach the database address in SO_DATABASE_URL. In Supabase → Connect, click "Enable IPv4 add-on" (or use the shared pooler address ending in pooler.supabase.com), then redeploy.';
  if (code === '28P01' || /password authentication failed/i.test(msg)) return 'Supabase rejected the database password in SO_DATABASE_URL. Reset the database password in Supabase (letters and numbers only), put the new one in SO_DATABASE_URL, and redeploy.';
  if (/tenant or user not found/i.test(msg)) return 'Supabase did not recognise the database user in SO_DATABASE_URL. Copy the "Transaction pooler" string from Supabase → Connect.';
  if (code === 'CONNECT_TIMEOUT' || code === 'ETIMEDOUT' || code === 'ENETUNREACH' || /timeout/i.test(msg)) return 'Connecting to the database timed out. Use the "Transaction pooler" string (port 6543) from Supabase → Connect.';
  if (code === '42P01') return 'The Smooth Operators tables are missing. Run supabase/smooth_operators.sql in the Supabase SQL editor.';
  return `The database connection failed (${code || 'unknown error'}).`;
}

// "Not found" is the least informative failure; prefer a password or user error.
function mostUseful(errors) {
  const rank = e => {
    const m = String((e && e.message) || '');
    if (e && e.code === '28P01' || /password authentication failed/i.test(m)) return 0;
    if (/tenant or user not found/i.test(m)) return 1;
    if (e && (e.code === 'ENOTFOUND' || /getaddrinfo/.test(m))) return 3;
    return 2;
  };
  return errors.slice().sort((a, b) => rank(a) - rank(b))[0];
}

let ready = null;

// Connects (once per server instance), trying each candidate address in turn.
async function getSqlReady() {
  if (sql) return sql;
  if (ready) return ready;
  const url = process.env.SO_DATABASE_URL;
  if (!url) throw new HttpError(503, 'not_configured', 'Smooth Operators is not configured yet.');
  const conn = parseUrl(url);
  ready = (async () => {
    const errors = [];
    for (const c of candidates(conn)) {
      const local = /^(localhost|127\.0\.0\.1)$/.test(c.host);
      const client = postgres({ ...c, ...OPTIONS, max: Number(process.env.SO_DB_POOL_MAX || 3), ssl: local ? false : 'require' });
      try {
        await client`select 1`;
        sql = client;
        if (c.host !== conn.host) console.log(`[so] database: connected via ${c.host}:${c.port} (adjusted from the pasted address)`);
        return client;
      } catch (e) {
        errors.push(e);
        console.error(`[so] database: ${c.host}:${c.port} failed: ${e.code || ''} ${String(e.message || '').slice(0, 160)}`);
        client.end({ timeout: 1 }).catch(() => {});
      }
    }
    throw new HttpError(503, 'database_unreachable', explain(mostUseful(errors)));
  })();
  try { return await ready; } finally { ready = null; }
}

// Synchronous accessor for code paths that already ran getSqlReady (and tests).
function getSql() {
  if (sql) return sql;
  const url = process.env.SO_DATABASE_URL;
  if (!url) throw new HttpError(503, 'not_configured', 'Smooth Operators is not configured yet.');
  const conn = parseUrl(url);
  const local = /^(localhost|127\.0\.0\.1)$/.test(conn.host);
  sql = postgres({ ...conn, ...OPTIONS, max: Number(process.env.SO_DB_POOL_MAX || 3), ssl: local ? false : 'require' });
  return sql;
}

// Test hook.
function setSql(instance) { sql = instance; }

module.exports = { getSql, getSqlReady, setSql, parseUrl, candidates, explain, mostUseful };
