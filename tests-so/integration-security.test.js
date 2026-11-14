'use strict';
// Site-wide security checks that need the database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./support/harness');

let h;
test.before(async () => { h = await boot(); });
test.after(async () => { await h.close(); });

const req = ip => ({ headers: { 'x-real-ip': ip }, socket: {} });

test('admin login limit holds in the database (not per server copy): 5 tries per 15 minutes per IP', async () => {
  const { limitLogin } = require('../api/_lib/auth');
  for (let i = 0; i < 5; i++) assert.equal(await limitLogin(req('203.0.113.7'), 'admin'), true);
  assert.equal(await limitLogin(req('203.0.113.7'), 'admin'), false, 'sixth try refused');
  // A forged x-forwarded-for can't dodge it: x-real-ip (set by Vercel) wins.
  assert.equal(await limitLogin({ headers: { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '1.2.3.4' }, socket: {} }, 'admin'), false);
  assert.equal(await limitLogin(req('198.51.100.9'), 'admin'), true, 'other visitors unaffected');
  const row = (await h.sql`select count from so_rate_limits where key = 'login:admin:ip:203.0.113.7'`)[0];
  assert.ok(row && row.count >= 6, 'stored in Postgres, shared by every server copy');
});
