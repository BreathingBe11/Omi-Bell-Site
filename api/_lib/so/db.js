'use strict';
// Postgres connection for Smooth Operators. Uses SO_DATABASE_URL, which must be
// a server-only connection string (Supabase: Project Settings -> Database ->
// Connection pooling, "Transaction" mode, port 6543). Never expose it to the
// browser. Prepared statements are disabled for compatibility with the pooler.

const postgres = require('postgres');
const { HttpError } = require('./http');

let sql = null;

function getSql() {
  if (sql) return sql;
  const url = process.env.SO_DATABASE_URL;
  if (!url) throw new HttpError(503, 'not_configured', 'Smooth Operators is not configured yet.');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  sql = postgres(url, {
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

module.exports = { getSql, setSql };
