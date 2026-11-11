/* Smooth Operators — shared client helpers (auth, API, formatting).
   The browser never decides access, price or release: it renders what the
   server returns. Browser storage holds only the Supabase session and
   unsent-draft backups; all durable data lives on the server. */
(function () {
  'use strict';
  const SO = (window.SO = window.SO || {});
  SO.base = '/smoothoperators';

  let configP = null;
  SO.config = function () {
    if (!configP) configP = fetch('/api/so/public-config').then(r => r.json()).catch(() => ({}));
    return configP;
  };

  let clientP = null;
  SO.auth = function () {
    if (!clientP) {
      clientP = SO.config().then(cfg => {
        if (!cfg.supabase_url || !cfg.supabase_anon_key || !window.supabase) return null;
        return window.supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit', storageKey: 'so-auth' },
        });
      });
    }
    return clientP;
  };

  SO.token = async function () {
    const c = await SO.auth();
    if (!c) return null;
    try {
      const { data } = await c.auth.getSession();
      return data && data.session ? data.session.access_token : null;
    } catch { return null; }
  };

  SO.signOut = async function () {
    const c = await SO.auth();
    if (c) { try { await c.auth.signOut(); } catch { /* local session cleared anyway */ } }
    try { localStorage.removeItem('so-auth'); } catch { /* storage unavailable */ }
  };

  class ApiError extends Error {
    constructor(status, code, message, data) { super(message); this.status = status; this.code = code; this.data = data || {}; }
  }
  SO.ApiError = ApiError;

  SO.api = async function (method, path, body, { auth = true, raw = false, signal } = {}) {
    const headers = {};
    if (auth) { const t = await SO.token(); if (t) headers.Authorization = `Bearer ${t}`; }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(`/api/so/${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw new ApiError(0, 'network', 'You appear to be offline. We’ll keep trying.');
    }
    if (raw && res.ok) return res;
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw new ApiError(res.status, data.error || 'error', data.message || 'Something went wrong. Please try again.', data);
    return data;
  };

  // ------------------------------------------------------------ formatting
  SO.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  };
  // Owner text -> escaped paragraphs; lines starting with "- " become a list.
  SO.paras = function (text) {
    return String(text || '').split(/\n\s*\n/).map(block => {
      const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) return '';
      if (lines.every(l => /^[-•]\s+/.test(l))) return `<ul>${lines.map(l => `<li>${SO.esc(l.replace(/^[-•]\s+/, ''))}</li>`).join('')}</ul>`;
      return `<p>${lines.map(SO.esc).join('<br>')}</p>`;
    }).join('');
  };
  SO.viewerTz = function () {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
  };
  function tzName(d, tz) {
    try {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(d).find(x => x.type === 'timeZoneName');
      return p ? p.value : tz;
    } catch { return tz; }
  }
  SO.fmtDateTime = function (iso, tz, { weekday = true } = {}) {
    const d = new Date(iso);
    const date = d.toLocaleDateString('en-US', { timeZone: tz, weekday: weekday ? 'short' : undefined, month: 'short', day: 'numeric', year: 'numeric' });
    const time = d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
    return `${date} · ${time} ${tzName(d, tz)}`;
  };
  SO.fmtTime = function (iso, tz) {
    const d = new Date(iso);
    return `${d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })} ${tzName(d, tz)}`;
  };
  // 'YYYY-MM-DD' (a cohort calendar date) -> "Monday, January 4, 2027"
  SO.fmtCohortDate = function (dateStr, opts) {
    return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', Object.assign({ timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }, opts || {}));
  };
  SO.money = function (cents) {
    return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0 })}`;
  };
  SO.duration = function (sec) {
    if (!sec) return '';
    const m = Math.round(sec / 60);
    return m < 1 ? `${sec} sec` : `${m} min`;
  };
  SO.track = function (name) {
    SO.api('POST', 'events', { name }).catch(() => {});
  };

  // FAQ accordion, shared by the landing page and the member platform.
  // Same markup as the server renderer: answers start open (works without JS)
  // and are collapsed here. Plus when collapsed, minus when open.
  SO.faqHtml = function (list, prefix) {
    prefix = prefix || 'faq';
    const paras = t => String(t || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(p => `<p>${SO.esc(p).replace(/\n/g, '<br>')}</p>`).join('');
    return `<div class="faq-list" data-faq>${list.map((f, i) => `<div class="faq-item"><h3 class="faq-q"><button type="button" id="${prefix}-q-${i}" aria-expanded="true" aria-controls="${prefix}-a-${i}"><span>${SO.esc(f.question)}</span><span class="faq-icon" aria-hidden="true"></span></button></h3><div class="faq-a" id="${prefix}-a-${i}" role="region" aria-labelledby="${prefix}-q-${i}">${paras(f.answer)}</div></div>`).join('')}</div>`;
  };
  SO.initFaq = function (root) {
    (root || document).querySelectorAll('[data-faq]').forEach(list => {
      if (list.dataset.ready) return;
      list.dataset.ready = '1';
      const buttons = Array.from(list.querySelectorAll('.faq-q button'));
      const set = (b, open) => {
        b.setAttribute('aria-expanded', String(open));
        const panel = document.getElementById(b.getAttribute('aria-controls'));
        if (panel) panel.hidden = !open;
      };
      buttons.forEach((b, i) => {
        set(b, false);
        b.addEventListener('click', () => set(b, b.getAttribute('aria-expanded') !== 'true'));
        b.addEventListener('keydown', e => {
          const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: buttons.length - 1 }[e.key];
          if (to === undefined) return;
          e.preventDefault();
          buttons[(to + buttons.length) % buttons.length].focus();
        });
      });
    });
  };
})();
