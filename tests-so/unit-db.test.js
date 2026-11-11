'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUrl, candidates, explain, mostUseful } = require('../api/_lib/so/db');

test('a pasted Supabase db.* address is tried first, then the shared pooler', () => {
  const c = candidates(parseUrl('postgresql://postgres:Secret123@db.mfevhwdtpftmlsksrgdi.supabase.co:6543/postgres'));
  assert.deepEqual(c.map(x => `${x.username}@${x.host}:${x.port}`), [
    'postgres@db.mfevhwdtpftmlsksrgdi.supabase.co:6543',
    'postgres.mfevhwdtpftmlsksrgdi@aws-0-us-east-1.pooler.supabase.com:6543',
    'postgres.mfevhwdtpftmlsksrgdi@aws-1-us-east-1.pooler.supabase.com:6543',
  ]);
  assert.equal(c[0].password, 'Secret123');
});

test('a pooler string is used as-is, with the other regional host as a backup', () => {
  const c = candidates(parseUrl('postgresql://postgres.abcdefghijklmnopqrst:pw@aws-1-us-east-1.pooler.supabase.com:6543/postgres'));
  assert.deepEqual(c.map(x => x.host), ['aws-1-us-east-1.pooler.supabase.com', 'aws-0-us-east-1.pooler.supabase.com']);
  assert.equal(c[0].username, 'postgres.abcdefghijklmnopqrst');
});

test('a pooler string missing the project in the username is fixed from SUPABASE_URL', () => {
  const prev = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = 'https://mfevhwdtpftmlsksrgdi.supabase.co';
  try {
    const c = candidates(parseUrl('postgresql://postgres:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres'));
    assert.equal(c[0].username, 'postgres.mfevhwdtpftmlsksrgdi');
  } finally { process.env.SUPABASE_URL = prev; }
});

test('connection failures are explained in plain English without the password', () => {
  assert.match(explain({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND db.x.supabase.co' }), /Enable IPv4 add-on/);
  assert.match(explain({ code: '28P01', message: 'password authentication failed for user "postgres"' }), /rejected the database password/);
  assert.match(explain({ code: 'XX000', message: 'Tenant or user not found' }), /did not recognise the database user/);
  assert.match(explain({ code: 'CONNECT_TIMEOUT', message: 'write CONNECT_TIMEOUT' }), /timed out/);
  assert.match(explain({ code: '42P01', message: 'relation "so_cohorts" does not exist' }), /Run supabase\/smooth_operators\.sql/);
});

test('the most useful failure is reported when several addresses were tried', () => {
  const e = mostUseful([{ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND a' }, { code: 'XX000', message: 'Tenant or user not found' }, { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND b' }]);
  assert.equal(e.code, 'XX000');
});
