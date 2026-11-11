#!/usr/bin/env node
'use strict';
// Local server that emulates the parts of Vercel this site relies on:
// static files with cleanUrls, vercel.json rewrites + headers, and Node
// functions in /api with req.query / req.body / res.status().json().
//
//   node scripts/so-dev-server.js            (PORT=3000 by default)
//
// Reads environment variables from the shell (see .env.smoothoperators.example).

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};

function compile(source) {
  const names = [];
  let re = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ':') {
      const m = /^:([A-Za-z_]\w*)(\([^)]*\))?(\*)?/.exec(source.slice(i));
      names.push(m[1]);
      re += m[2] ? m[2] : m[3] ? '(.*)' : '([^/]+)';
      if (m[2] && m[3]) re += '';
      i += m[0].length;
    } else if (ch === '(') {
      const end = source.indexOf(')', i);
      names.push(`_${names.length}`);
      re += source.slice(i, end + 1);
      i = end + 1;
    } else {
      re += ch.replace(/[.+?^${}|[\]\\/]/g, '\\$&');
      i++;
    }
  }
  // "/x/:path*" should also match "/x"
  re = re.replace(/\\\/\(\.\*\)$/, '(?:/(.*))?');
  return { re: new RegExp(`^${re}$`), names };
}
const rewrites = (vercel.rewrites || []).map(r => ({ ...r, ...compile(r.source) }));
const headerRules = (vercel.headers || []).map(h => ({ ...h, ...compile(h.source) }));

function staticFile(urlPath) {
  const clean = decodeURIComponent(urlPath).replace(/\/+$/, '') || '/';
  if (clean.includes('..') || clean.split('/').some(s => s.startsWith('.') && s.length > 1)) return null;
  const base = path.join(ROOT, clean);
  if (!base.startsWith(ROOT)) return null;
  const candidates = [base, `${base}.html`, path.join(base, 'index.html')];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile() && !c.includes(`${path.sep}node_modules${path.sep}`)) return c; } catch { /* next */ }
  }
  return null;
}

const fnCache = new Map();
function loadFn(name) {
  if (!/^[\w-]+$/.test(name)) return null;
  const file = path.join(ROOT, 'api', `${name}.js`);
  if (!fs.existsSync(file)) return null;
  if (!fnCache.has(file)) fnCache.set(file, require(file));
  return fnCache.get(file);
}

function decorate(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return res; };
  res.send = b => { res.end(b); return res; };
  return res;
}

function applyHeaders(res, pathname) {
  for (const rule of headerRules) {
    if (!rule.re.test(pathname)) continue;
    for (const h of rule.headers) {
      let v = h.value;
      if (h.key === 'Content-Security-Policy' && process.env.SO_DEV_EXTRA_ORIGINS) {
        const extra = process.env.SO_DEV_EXTRA_ORIGINS;
        v = v.replace(/connect-src ([^;]+);/, `connect-src $1 ${extra};`).replace(/media-src ([^;]+);/, `media-src $1 ${extra};`)
          .replace(/img-src ([^;]+);/, `img-src $1 ${extra};`);
      }
      res.setHeader(h.key, v);
    }
  }
}

async function handle(req, res) {
  decorate(res);
  const url = new URL(req.url, 'http://localhost');
  let pathname = url.pathname;
  const query = Object.fromEntries(url.searchParams);
  applyHeaders(res, pathname);

  let file = pathname.startsWith('/api/') ? null : staticFile(pathname);
  if (!file && !/^\/api\/[\w-]+$/.test(pathname)) {
    for (const r of rewrites) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      const vals = Object.fromEntries(r.names.map((n, i) => [n, m[i + 1] || '']));
      const dest = new URL(r.destination.replace(/:(\w+)\*?/g, (_, n) => vals[n] ?? ''), 'http://localhost');
      pathname = dest.pathname;
      for (const [k, v] of dest.searchParams) query[k] = v;
      break;
    }
    // Like Vercel with cleanUrls: a rewrite to "x.html" does not resolve; use "x".
    file = pathname.startsWith('/api/') || (vercel.cleanUrls && pathname.endsWith('.html')) ? null : staticFile(pathname);
  }

  const fnMatch = /^\/api\/([\w-]+)$/.exec(pathname);
  if (fnMatch) {
    const fn = loadFn(fnMatch[1]);
    if (!fn) { res.statusCode = 404; return res.end('Not found'); }
    req.query = query;
    const raw = fn.config && fn.config.api && fn.config.api.bodyParser === false;
    if (!raw && !['GET', 'HEAD'].includes(req.method)) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const txt = Buffer.concat(chunks).toString('utf8');
      req.body = (req.headers['content-type'] || '').includes('application/json') && txt ? JSON.parse(txt) : txt;
    }
    return fn(req, res);
  }
  if (file) {
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    return fs.createReadStream(file).pipe(res);
  }
  res.statusCode = 404;
  const nf = staticFile('/404');
  if (nf) { res.setHeader('Content-Type', MIME['.html']); return fs.createReadStream(nf).pipe(res); }
  res.end('Not found');
}

function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch(err => {
      console.error('[dev-server]', err);
      if (!res.headersSent) { res.statusCode = 500; res.end('Internal error'); }
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, () => console.log(`Dev server on http://localhost:${port}/smoothoperators`));
}

module.exports = { createServer };
