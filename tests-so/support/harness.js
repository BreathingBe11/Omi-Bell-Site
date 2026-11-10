'use strict';
// Boots a fresh Postgres database (migration + seed), the test doubles, and
// the real dev server, then exposes small helpers for integration tests.
// Requires a local Postgres: `scripts/so-test-db.sh start` (SO_TEST_PG_URL overrides).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const postgres = require('postgres');
const { startMocks } = require('./mock-services');

const ROOT = path.resolve(__dirname, '..', '..');
const ADMIN_URL = process.env.SO_TEST_PG_URL || 'postgres://postgres@127.0.0.1:54329/postgres';

async function createDatabase() {
  const name = `so_test_${crypto.randomBytes(4).toString('hex')}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${name}`);
  const sql = postgres(url, { max: 4, onnotice: () => {} });
  // Supabase provides the auth schema and API roles; stub them for tests.
  await sql.unsafe(`create schema auth; create table auth.users (id uuid primary key, email text);
    do $$ begin create role anon; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated; exception when duplicate_object then null; end $$;`);
  await sql.unsafe(fs.readFileSync(path.join(ROOT, 'supabase/smooth_operators.sql'), 'utf8'));
  await sql.unsafe(fs.readFileSync(path.join(ROOT, 'supabase/smooth_operators_seed.sql'), 'utf8'));
  return { name, url, sql };
}

async function dropDatabase(name) {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.end();
}

async function boot(extraEnv = {}) {
  const db = await createDatabase();
  const WEBHOOK_SECRET = 'whsec_test_local';
  const http = require('http');
  // Reserve a port for the app first so mocks know where to send webhooks.
  const probe = http.createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const appPort = probe.address().port;
  await new Promise(r => probe.close(r));
  const appBase = `http://127.0.0.1:${appPort}`;

  const mocks = await startMocks({ sql: db.sql, webhookUrl: `${appBase}/api/smoothoperators-webhook`, webhookSecret: WEBHOOK_SECRET });
  Object.assign(process.env, {
    SO_DATABASE_URL: db.url,
    SUPABASE_URL: mocks.base,
    SUPABASE_ANON_KEY: 'anon-test-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-test-key',
    STRIPE_SECRET_KEY: 'sk_test_local',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_API_BASE: mocks.base,
    SESSION_SECRET: 'test-session-secret',
    SO_SITE_URL: appBase,
    SO_EMAIL_DELIVERY: 'off',
    SO_DEV_EXTRA_ORIGINS: mocks.base,
    ...extraEnv,
  });
  delete process.env.VERCEL_ENV;
  const { createServer } = require('../../scripts/so-dev-server');
  const server = createServer();
  await new Promise(r => server.listen(appPort, '127.0.0.1', r));

  const { signToken } = require('../../api/_lib/auth');
  const adminToken = signToken({ role: 'admin', iat: Date.now(), exp: Date.now() + 3600000 }, process.env.SESSION_SECRET);

  async function api(method, p, { token, body, raw } = {}) {
    const res = await fetch(`${appBase}/api/so/${p}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (raw) return res;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, text };
  }

  async function cohort() { return (await db.sql`select * from so_cohorts where is_default`)[0]; }
  async function setCohort(fields) {
    await db.sql`update so_cohorts set ${db.sql(fields)} where is_default`;
  }
  // Put "now" on a given cohort day by moving the start date (no clock hacks).
  async function setLiveDay(n) {
    const { localDateStr, addDays } = require('../../api/_lib/so/time');
    const c = await cohort();
    const today = localDateStr(new Date(), c.timezone);
    await setCohort({ start_date: addDays(today, -(n - 1)), unlock_time: '00:00', intro_opens_at: new Date(Date.now() - 40 * 86400000) });
  }
  async function enroll(email) {
    const s = await mocks.signIn(email);
    await db.sql`insert into so_profiles (user_id, email) values (${s.user.id}, ${email}) on conflict do nothing`;
    const c = await cohort();
    await db.sql`insert into so_enrollments (user_id, cohort_id, source) values (${s.user.id}, ${c.id}, 'manual') on conflict do nothing`;
    return s;
  }

  async function close() {
    await new Promise(r => server.close(r));
    await mocks.close();
    const { getSql } = require('../../api/_lib/so/db');
    try { await getSql().end({ timeout: 1 }); } catch { /* ignore */ }
    await db.sql.end({ timeout: 1 });
    await dropDatabase(db.name);
  }

  return { appBase, db, sql: db.sql, mocks, api, adminToken, cohort, setCohort, setLiveDay, enroll, close, WEBHOOK_SECRET };
}

module.exports = { boot };
