#!/usr/bin/env node
/**
 * One-time setup utility: generate a scrypt hash for your admin password.
 *
 * Usage:
 *   node scripts/hash-password.js <your-admin-password>
 *
 * Copy the output and set it as the ADMIN_PASSWORD_HASH environment variable
 * in your Vercel project (Settings → Environment Variables).
 */
const crypto = require('crypto');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-password.js <your-admin-password>');
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');
const result = `${salt}:${hash}`;

console.log('\nADMIN_PASSWORD_HASH=');
console.log(result);
console.log('\nAdd this value to Vercel → Settings → Environment Variables.');
console.log('Also add SESSION_SECRET with any long random string, e.g.:');
console.log(crypto.randomBytes(32).toString('hex'));
