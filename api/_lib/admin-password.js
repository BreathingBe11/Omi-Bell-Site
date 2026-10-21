'use strict';
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// The admin password hash lives in Supabase once it has been reset from the
// site; until then it falls back to the ADMIN_PASSWORD_HASH env var.

const KEY = 'admin_password_hash';

function db() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function getAdminPasswordHash() {
  const { data, error } = await db().from('admin_settings').select('value').eq('key', KEY).maybeSingle();
  // A missing table just means no reset has been set up yet; any other error
  // must not silently fall back to the old password.
  if (error && !['42P01', 'PGRST205'].includes(error.code)) throw error;
  return (data && data.value) || process.env.ADMIN_PASSWORD_HASH || null;
}

async function setAdminPasswordHash(hash) {
  const { error } = await db()
    .from('admin_settings')
    .upsert({ key: KEY, value: hash, updated_at: new Date().toISOString() });
  return !error;
}

// Short fingerprint of the current hash, so a reset link stops working once used.
function hashFingerprint(hash) {
  return crypto.createHash('sha256').update(hash).digest('hex').slice(0, 16);
}

module.exports = { getAdminPasswordHash, setAdminPasswordHash, hashFingerprint };
