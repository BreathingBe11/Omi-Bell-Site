'use strict';
// Smooth Operators API + server-rendered public pages.
// Reached through rewrites in vercel.json:
//   /api/so/<path>            -> ?route=<path>
//   /smoothoperators          -> ?route=page/landing
//   /smoothoperators/terms    -> ?route=page/terms
//   /smoothoperators/privacy  -> ?route=page/privacy
// One function keeps the deployment under Vercel's per-project function limits.

const { getSql } = require('./_lib/so/db');
const H = require('./_lib/so/http');

const table = [];
function register(routes) {
  for (const [key, fn] of Object.entries(routes)) {
    const [method, pattern] = key.split(' ');
    const names = [];
    const re = new RegExp('^' + pattern.split('/').map(seg => {
      if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/') + '$');
    table.push({ method, re, names, fn });
  }
}
register(require('./_lib/so/member').routes);
register(require('./_lib/so/payments').routes);
register(require('./_lib/so/intake').routes);
register(require('./_lib/so/admin').routes);
register(require('./_lib/so/pages').routes);

function routeOf(req) {
  let r = req.query && req.query.route;
  if (Array.isArray(r)) r = r.join('/');
  return String(r || '').replace(/^\/+|\/+$/g, '');
}

module.exports = async function handler(req, res) {
  const path = routeOf(req);
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  let matched = null;
  let methodMismatch = false;
  for (const r of table) {
    const m = r.re.exec(path);
    if (!m) continue;
    if (r.method !== method) { methodMismatch = true; continue; }
    matched = { r, params: Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
    break;
  }
  if (!matched) return H.sendJson(res, methodMismatch ? 405 : 404, { error: methodMismatch ? 'method_not_allowed' : 'not_found' });
  try {
    const out = await matched.r.fn({ req, res, sql: getSql(), now: new Date(), params: matched.params, query: req.query || {} });
    if (out === H.HANDLED) return;
    H.sendJson(res, 200, out);
  } catch (err) {
    H.sendError(res, err);
  }
};
