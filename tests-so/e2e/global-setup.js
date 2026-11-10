'use strict';
const { boot } = require('../support/harness');

module.exports = async function globalSetup() {
  const h = await boot();
  process.env.SO_E2E_BASE = h.appBase;
  process.env.SO_E2E_ADMIN_TOKEN = h.adminToken;
  return async () => { await h.close(); };
};
