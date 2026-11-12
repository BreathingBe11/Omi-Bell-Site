/* Smooth Operators — member app, sign-in and checkout (single-page app).
   Routes (under /smoothoperators):
     /login, /login/help, /checkout, /checkout/success,
     /app, /app/calendar, /app/library, /app/journal, /app/calls-help,
     /app/day/:n, /app/resource/:id, /app/introductions, /app/introductions/edit, /app/account */
(function () {
  'use strict';
  const SO = window.SO;
  const esc = SO.esc;
  const B = SO.base;
  const root = document.getElementById('root');
  const drawerRoot = document.getElementById('drawer-root');
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  const NAV = [
    ['/app', 'Today'],
    ['/app/calendar', '21-Day Calendar'],
    ['/app/library', 'Library'],
    ['/app/journal', 'My Journal'],
    ['/app/calls-help', 'Calls & Help'],
  ];

  const state = { me: null, shell: false, calls: null, callsAt: 0, renderId: 0 };
  const unsavedGuards = new Set();
  const cleanups = [];

  // ------------------------------------------------------------ utilities
  const h = (strings, ...vals) => strings.reduce((acc, s, i) => acc + s + (i < vals.length ? vals[i] : ''), '');
  const q = (sel, el = document) => el.querySelector(sel);
  const qa = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const link = (path, label, cls = '') => `<a href="${B}${path}"${cls ? ` class="${cls}"` : ''}>${label}</a>`;
  function relPath() { return (location.pathname.replace(/\/+$/, '').slice(B.length)) || '/'; }
  function safeNext(n) { return /^\/(app|checkout)(\/[\w\-/]*)?(\?[\w=&%-]*)?$/.test(n || '') ? n : '/app'; }
  function onCleanup(fn) { cleanups.push(fn); }
  function errorBox(err, retry) {
    const msg = err && err.status === 0 ? 'You appear to be offline. Check your connection and try again.' : (err && err.message) || 'Something went wrong.';
    return `<div class="notice notice-error" role="alert"><p>${esc(msg)}</p>${retry ? '<button class="btn btn-secondary btn-sm" data-retry>Try again</button>' : ''}</div>`;
  }
  function wireRetry(el) { qa('[data-retry]', el).forEach(b => b.addEventListener('click', () => render())); }
  function setTitle(t) {
    document.title = t ? `${t} · Smooth Operators` : 'Smooth Operators';
    const tb = q('#topbar-title');
    if (tb) tb.textContent = t || 'Smooth Operators';
  }
  function focusMain() {
    const target = q('#main h1') || q('#main');
    if (target) { if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true }); }
  }
  async function supportEmail() {
    try { const o = await SO.api('GET', 'offer', undefined, { auth: false }); return o.support_email; } catch { return null; }
  }
  function supportLine(email) {
    return email ? `Questions? Email <a href="mailto:${esc(email)}">${esc(email)}</a>.` : 'If something looks wrong, reply to your confirmation email and we’ll help.';
  }
  async function openResource(id, { download } = {}) {
    // Open the tab synchronously so popup blockers allow it, then point it at the short-lived URL.
    const w = download ? null : window.open('', '_blank');
    try {
      const r = await SO.api('GET', `resource/${id}/access${download ? '?download=1' : ''}`);
      if (r.kind === 'download') {
        if (w) w.close();
        const a = document.createElement('a');
        a.href = r.url; a.rel = 'noopener'; a.download = '';
        document.body.appendChild(a); a.click(); a.remove();
      } else if (w) { w.opener = null; w.location.href = r.url; } else { window.location.href = r.url; }
    } catch (e) {
      if (w) w.close();
      alert(e.message || 'That resource could not be opened.');
    }
  }
  async function downloadBlob(path, filename) {
    const res = await SO.api('GET', path, undefined, { raw: true });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  async function loadCalls(force) {
    if (!force && state.calls && Date.now() - state.callsAt < 60000) return state.calls;
    state.calls = await SO.api('GET', 'calls');
    state.callsAt = Date.now();
    return state.calls;
  }

  // ---------------------------------------------------------------- router
  const routes = [
    [/^\/login$/, viewLogin],
    [/^\/login\/help$/, viewLoginHelp],
    [/^\/checkout$/, viewCheckout],
    [/^\/checkout\/success$/, viewSuccess],
    [/^\/app$/, viewToday, { shell: true, nav: '/app' }],
    [/^\/app\/calendar$/, viewCalendar, { shell: true, nav: '/app/calendar' }],
    [/^\/app\/library$/, viewLibrary, { shell: true, nav: '/app/library' }],
    [/^\/app\/journal$/, viewJournal, { shell: true, nav: '/app/journal' }],
    [/^\/app\/journal\/(new|[0-9a-f-]{36})$/, viewNote, { shell: true, nav: '/app/journal' }],
    [/^\/app\/calls-help$/, viewCalls, { shell: true, nav: '/app/calls-help' }],
    [/^\/app\/day\/(\d{1,2})$/, viewDay, { shell: true, nav: '/app/calendar' }],
    [/^\/app\/resource\/([0-9a-f-]{36})$/, viewResource, { shell: true, nav: '/app/library' }],
    [/^\/app\/introductions$/, viewIntroductions, { shell: true, nav: null }],
    [/^\/app\/introductions\/edit$/, viewIntroEdit, { shell: true, nav: null }],
    [/^\/app\/account$/, viewAccount, { shell: true, nav: '/app/account', limitedOk: true }],
    [/^\/app\/status$/, viewStatus, { shell: 'limited' }],
    [/^\/app\/help$/, viewHelp, { shell: true, nav: '/app/calls-help', limitedOk: true }],
    [/^\/app\/help\/([0-9a-f-]{36})$/, viewThread, { shell: true, nav: '/app/calls-help', limitedOk: true }],
  ];

  function confirmLeave() {
    for (const g of unsavedGuards) if (g()) return window.confirm('You have writing that hasn’t saved yet. Leave this page anyway?');
    return true;
  }
  window.addEventListener('beforeunload', e => {
    for (const g of unsavedGuards) if (g()) { e.preventDefault(); e.returnValue = ''; return; }
  });

  function navigate(href, { replace = false } = {}) {
    if (!confirmLeave()) return;
    history.replaceState(Object.assign({}, history.state, { scroll: window.scrollY }), '');
    if (replace) history.replaceState({}, '', href); else history.pushState({}, '', href);
    render({ restoreScroll: false });
  }
  SO.navigate = navigate;

  document.addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href]');
    if (!a || a.target || a.hasAttribute('download') || a.dataset.external !== undefined) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return;
    const rel = url.pathname.slice(B.length);
    if (!url.pathname.startsWith(`${B}/`) || !routes.some(([re]) => re.test(rel.replace(/\/+$/, '')))) return;
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
    e.preventDefault();
    closeDrawer(false);
    navigate(url.pathname + url.search + url.hash);
  });
  window.addEventListener('popstate', () => {
    // Back/forward: unsaved writing is already protected by autosave + local backup.
    render({ restoreScroll: true });
  });

  async function render({ restoreScroll = false } = {}) {
    const id = ++state.renderId;
    while (cleanups.length) { try { cleanups.pop()(); } catch { /* ignore */ } }
    unsavedGuards.clear();
    const path = relPath();
    const match = routes.map(([re, fn, opts]) => [re.exec(path), fn, opts || {}]).find(([m]) => m);
    if (!match) { navigate(`${B}/app`, { replace: true }); return; }
    const [m, fn, opts] = match;
    const params = m.slice(1);
    const query = Object.fromEntries(new URLSearchParams(location.search));
    let container;
    let spinnerTimer = null;
    if (opts.shell) {
      const mode = await ensureMember(path, opts);
      if (!mode || id !== state.renderId) return;
      if (mode === 'limited') {
        state.shell = false;
        root.innerHTML = limitedFrame();
        wireSignout(root);
      } else renderShell(opts.nav);
      container = q('#main');
      // Keep the previous page on screen, softly faded, while the next one loads;
      // only show a spinner if loading takes a noticeable moment.
      if (container.children.length && !container.querySelector(':scope > .loading')) {
        container.classList.remove('page-enter');
        container.classList.add('is-leaving');
        container.setAttribute('aria-busy', 'true');
        spinnerTimer = setTimeout(() => {
          if (id === state.renderId) container.innerHTML = '<p class="loading" role="status"><span class="spinner" aria-hidden="true"></span> Loading…</p>';
        }, 450);
      } else container.innerHTML = '<p class="loading" role="status"><span class="spinner" aria-hidden="true"></span> Loading…</p>';
    } else {
      state.shell = false;
      root.innerHTML = publicFrame();
      container = q('#main');
    }
    try {
      const title = await fn(container, params, query, { isCurrent: () => id === state.renderId });
      if (id !== state.renderId) { clearTimeout(spinnerTimer); return; }
      setTitle(title);
    } catch (err) {
      if (id !== state.renderId) return;
      if (err && err.status === 401) { navigate(`${B}/login?next=${encodeURIComponent(path + location.search)}`, { replace: true }); return; }
      container.innerHTML = errorBox(err, true);
      wireRetry(container);
      setTitle('Something went wrong');
    }
    clearTimeout(spinnerTimer);
    container.classList.remove('is-leaving', 'page-enter');
    container.removeAttribute('aria-busy');
    void container.offsetWidth; // restart the entrance animation
    container.classList.add('page-enter');
    const y = restoreScroll && history.state && typeof history.state.scroll === 'number' ? history.state.scroll : 0;
    window.scrollTo(0, y);
    if (!restoreScroll) focusMain();
  }

  // ------------------------------------------------------------- frames
  // Paid but not approved (or not approved): status, help and account only.
  function limitedFrame() {
    const cur = relPath();
    const a = (p, l) => `<a href="${B}${p}"${cur === p ? ' aria-current="page"' : ''}>${l}</a>`;
    return `<header class="pub-header"><a class="wordmark" href="${B}">Smooth Operators</a>
<nav aria-label="Account" class="limited-nav">${a('/app/status', 'My enrollment')}${a('/app/help', 'Help')}<a class="nav-account" href="${B}/app/account"${cur === '/app/account' ? ' aria-current="page"' : ''}><span data-avatar="sm">${avatarHtml('sm')}</span><span>My Account</span></a></nav></header>
<main id="main" class="main" tabindex="-1"></main>`;
  }

  function publicFrame() {
    return `<header class="pub-header"><a class="wordmark" href="${B}">Smooth Operators</a></header>
<main id="main" class="main" tabindex="-1"></main>`;
  }

  async function ensureMember(path, opts = {}) {
    if (!state.me) {
      try { state.me = await SO.api('GET', 'me'); } catch (e) {
        state.shell = false;
        root.innerHTML = publicFrame();
        q('#main').innerHTML = errorBox(e, true);
        wireRetry(root);
        return false;
      }
    }
    const me = state.me;
    if (!me.signed_in) {
      navigate(`${B}/login?next=${encodeURIComponent(path + location.search)}`, { replace: true });
      return false;
    }
    if (me.enrolled && me.access.active && me.review_state !== 'approved') {
      if (opts.shell === 'limited' || opts.limitedOk) return 'limited';
      navigate(`${B}/app/status`, { replace: true });
      return false;
    }
    if (opts.shell === 'limited') {
      if (!me.enrolled) { navigate(`${B}/checkout`, { replace: true }); return false; }
      if (me.review_state === 'approved' && me.access.active) { navigate(`${B}/app`, { replace: true }); return false; }
      return 'limited';
    }
    if (!me.enrolled && opts.limitedOk && /^\/app\/help/.test(path)) return 'limited';
    if (me.enrolled && me.review_state === 'rejected' && (opts.limitedOk)) return 'limited';
    if (me.enrolled && me.review_state === 'rejected') { navigate(`${B}/app/status`, { replace: true }); return false; }
    if (!me.enrolled || !me.access.active) {
      state.shell = false;
      root.innerHTML = publicFrame();
      const main = q('#main');
      const email = await supportEmail();
      let body;
      if (!me.enrolled) {
        body = `<h1>This space is for enrolled members</h1>
<p>You’re signed in as <strong>${esc(me.email)}</strong>, and this email isn’t enrolled in Smooth Operators yet.</p>
<p>If you enrolled with a different email, sign out and sign in with that one.</p>
<div class="row"><a class="btn btn-primary" href="${B}/checkout">Join the cohort</a><button class="btn btn-secondary" data-signout>Sign out</button></div>`;
      } else if (me.access.reason === 'access_period_ended') {
        body = `<h1>Your access period has ended</h1><p>Thank you for being part of Smooth Operators.</p><p>${supportLine(email)}</p>
<button class="btn btn-secondary" data-signout>Sign out</button>`;
      } else {
        body = `<h1>Your access is paused</h1><p>Your cohort access isn’t active right now. Your saved work hasn’t been deleted.</p><p>${supportLine(email)}</p>
<button class="btn btn-secondary" data-signout>Sign out</button>`;
      }
      main.innerHTML = `<div class="stack">${body}</div>`;
      wireSignout(main);
      setTitle('Smooth Operators');
      focusMain();
      return false;
    }
    return 'full';
  }

  function wireSignout(el) {
    qa('[data-signout]', el).forEach(b => b.addEventListener('click', async () => {
      if (!confirmLeave()) return;
      await SO.signOut();
      state.me = null;
      window.location.href = B;
    }));
  }

  function initials() {
    const me = state.me || {};
    const src = (me.display_name || '').trim() || (me.email || '').split('@')[0] || '';
    const parts = src.split(/[\s._-]+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }
  function avatarHtml(size = 'sm') {
    const url = state.me && state.me.avatar_url;
    return `<span class="avatar avatar-${size}" aria-hidden="true">${url ? `<img src="${esc(url)}" alt="">` : `<span>${esc(initials())}</span>`}</span>`;
  }
  function refreshAvatars() {
    qa('[data-avatar]').forEach(el => { el.innerHTML = avatarHtml(el.dataset.avatar); });
  }

  function navHtml(active, idPrefix) {
    const items = NAV.map(([p, label]) => `<li><a href="${B}${p}"${p === active ? ' aria-current="page"' : ''}>${label}</a></li>`).join('');
    return `<ul class="nav-list" id="${idPrefix}-nav">${items}</ul>
<ul class="nav-list nav-secondary">
  <li><a class="nav-account" href="${B}/app/account"${active === '/app/account' ? ' aria-current="page"' : ''}><span data-avatar="sm">${avatarHtml('sm')}</span><span>My Account</span></a></li>
</ul>`;
  }

  function renderShell(active) {
    const testBanner = state.me && state.me.test_enrollment
      ? '<div class="test-banner" role="note"><strong>Test enrollment.</strong> This access came from a Stripe test-mode payment.</div>' : '';
    if (!state.shell) {
      root.innerHTML = `${testBanner}<div class="app-shell">
  <header class="topbar">
    <button class="menu-btn" type="button" aria-expanded="false" aria-controls="drawer" id="menu-btn"><span class="menu-icon" aria-hidden="true"></span>Menu</button>
    <p class="topbar-title" id="topbar-title" aria-hidden="true"></p>
    <a class="call-chip" id="call-chip" hidden></a>
    <a class="topbar-avatar" href="${B}/app/account" aria-label="My Account"><span data-avatar="sm">${avatarHtml('sm')}</span></a>
  </header>
  <nav class="sidebar" aria-label="Main">
    <a class="wordmark" href="${B}/app">Smooth Operators<span class="wordmark-by">with Omi Bell</span></a>
    <div id="side-nav-wrap">${navHtml(active, 'side')}</div>
    <div class="sidebar-call" id="side-call"></div>
  </nav>
  <main id="main" class="main" tabindex="-1"></main>
</div>`;
      q('#menu-btn').addEventListener('click', openDrawer);
      wireSignout(q('.sidebar'));
      state.shell = true;
    } else {
      q('#side-nav-wrap').innerHTML = navHtml(active, 'side');
      wireSignout(q('.sidebar'));
    }
    state.activeNav = active;
    updateCallChip();
  }

  async function updateCallChip() {
    let data;
    try { data = await loadCalls(); } catch { return; }
    const next = data.calls.find(c => c.state === 'upcoming' || c.state === 'joinable');
    const chip = q('#call-chip');
    const side = q('#side-call');
    if (!chip || !side) return;
    if (!next) { chip.hidden = true; side.innerHTML = ''; return; }
    const tz = SO.viewerTz();
    const when = new Date(next.starts_at).toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' });
    chip.hidden = false;
    chip.href = `${B}/app/calls-help`;
    chip.classList.toggle('joinable', next.state === 'joinable');
    chip.textContent = next.state === 'joinable' ? 'Call open: Join' : `Next call ${when}`;
    side.innerHTML = `<div class="card" style="padding:1rem"><p class="small muted" style="margin:0">${next.state === 'joinable' ? 'Happening now' : 'Next Solutions Seat'}</p>
<p style="margin:.2rem 0 .6rem;font-weight:500">${esc(SO.fmtDateTime(next.starts_at, tz))}</p>
<a class="btn ${next.state === 'joinable' ? 'btn-primary' : 'btn-secondary'} btn-sm" href="${B}/app/calls-help">${next.state === 'joinable' ? 'Join Solutions Seat' : 'Call details'}</a></div>`;
  }

  // Accessible drawer: focus moves in, Tab is trapped, Esc closes, focus returns to Menu.
  let drawerKeyHandler = null;
  function openDrawer() {
    const btn = q('#menu-btn');
    drawerRoot.innerHTML = `<div class="drawer-backdrop" data-close></div>
<div class="drawer" id="drawer" role="dialog" aria-modal="true" aria-label="Menu">
  <div class="drawer-head"><span class="wordmark">Smooth Operators</span><button class="close-btn" type="button" data-close>Close</button></div>
  <nav aria-label="Main">${navHtml(state.activeNav, 'drawer')}</nav>
</div>`;
    btn.setAttribute('aria-expanded', 'true');
    document.body.classList.add('drawer-open');
    qa('[data-close]', drawerRoot).forEach(el => el.addEventListener('click', () => closeDrawer(true)));
    wireSignout(drawerRoot);
    const focusables = () => qa('a[href], button', q('#drawer'));
    (q('[aria-current="page"]', drawerRoot) || focusables()[0]).focus();
    drawerKeyHandler = e => {
      if (e.key === 'Escape') { e.preventDefault(); closeDrawer(true); return; }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    };
    document.addEventListener('keydown', drawerKeyHandler);
  }
  function closeDrawer(returnFocus) {
    if (!drawerRoot.innerHTML) return;
    drawerRoot.innerHTML = '';
    document.body.classList.remove('drawer-open');
    if (drawerKeyHandler) document.removeEventListener('keydown', drawerKeyHandler);
    const btn = q('#menu-btn');
    if (btn) { btn.setAttribute('aria-expanded', 'false'); if (returnFocus) btn.focus(); }
  }

  // ============================================================ sign in
  function loginForm(container, { next, heading = true, intro, email: prefill } = {}) {
    container.innerHTML = `${heading ? `<h1>${typeof heading === 'string' ? esc(heading) : 'Sign in'}</h1>` : ''}
<p>${intro || 'Continue with Google, or use your email and we’ll send you a 6-digit code. There’s no password to remember.'}</p>
<div id="oauth-err" role="alert"></div>
<div id="google-slot" class="google-slot" aria-busy="true"></div><div id="google-fallback" hidden><button class="btn btn-secondary btn-block google-btn" type="button" id="google-btn"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.2l7.9 6.2C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C.9 16.5 0 20.1 0 24s.9 7.5 2.6 10.8l7.9-6.2z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.7 2.2-8.5 2.2-6.3 0-11.6-4.1-13.5-9.9l-7.9 6.2C6.6 42.6 14.6 48 24 48z"/></svg> Continue with Google</button></div>
<p class="or-divider"><span>or use your email</span></p>
<form id="email-form" novalidate>
  <div class="field"><label for="email">Email address</label>
  <input id="email" type="email" name="email" autocomplete="email" required inputmode="email" value="${esc(prefill || '')}"></div>
  <p class="form-error" id="email-err" role="alert"></p>
  <div class="row"><button class="btn btn-primary" type="submit">Send my code</button>
  <button class="linklike" type="button" id="have-code">I already have a code</button></div>
</form>
<form id="code-form" hidden novalidate>
  <p id="code-intro"></p>
  <div class="field"><label for="code">Sign-in code</label>
  <input id="code" class="code-input" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="10" required></div>
  <p class="form-error" id="code-err" role="alert"></p>
  <div class="row"><button class="btn btn-primary" type="submit">Sign in</button>
  <button class="btn btn-ghost btn-sm" type="button" id="resend-code">Send a new code</button>
  <button class="linklike" type="button" id="change-email">Use a different email</button></div>
</form>
<p class="small muted" style="margin-top:1.5rem">${link('/login/help', 'Trouble signing in?')}</p>`;
    const ef = q('#email-form', container), cf = q('#code-form', container);
    const RESEND_AFTER = 60 * 1000, CODE_LIFETIME = 60 * 60 * 1000;
    const remember = v => { try { v ? sessionStorage.setItem('so-otp', JSON.stringify(v)) : sessionStorage.removeItem('so-otp'); } catch { /* ignore */ } };
    const recall = () => { try { return JSON.parse(sessionStorage.getItem('so-otp') || 'null'); } catch { return null; } };
    let email = '';
    let sentAt = 0;
    let tick = null;
    onCleanup(() => clearInterval(tick));
    const validEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
    const timeLabel = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    // Countdown on "Send a new code" so people don't trip the provider's limit.
    function startCooldown() {
      const rb = q('#resend-code', container);
      clearInterval(tick);
      const update = () => {
        const left = Math.ceil((sentAt + RESEND_AFTER - Date.now()) / 1000);
        if (left > 0) { rb.disabled = true; rb.textContent = `Send a new code in ${left}s`; } else { rb.disabled = false; rb.textContent = 'Send a new code'; clearInterval(tick); }
      };
      update();
      tick = setInterval(update, 1000);
    }
    function showCode(intro) {
      ef.hidden = true; cf.hidden = false;
      q('#code-intro', container).innerHTML = intro;
      q('#code-err', container).textContent = '';
      startCooldown();
      q('#code', container).focus();
    }
    // Plain-language reasons. Supabase limits how often one address can get a code.
    function sendProblem(error) {
      const m = String((error && error.message) || '');
      const status = error && error.status;
      if (status === 429 || /rate|seconds|security purposes|too many/i.test(m)) return 'recent';
      if (status === 400 && /email/i.test(m) && /invalid|valid/i.test(m)) return 'address';
      return 'sending';
    }
    async function sendCode() {
      const client = await SO.auth();
      if (!client) return { problem: 'config' };
      const { error } = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
      if (!error) { sentAt = Date.now(); remember({ email, at: sentAt }); return { ok: true }; }
      return { problem: sendProblem(error), error };
    }
    const sentIntro = () => `We sent a 6-digit code to <strong>${esc(email)}</strong>. Enter it below. It can take a minute to arrive; check spam or promotions if you don’t see it.`;
    const recentIntro = () => `We already sent a code to <strong>${esc(email)}</strong>${sentAt ? ` at ${esc(timeLabel(sentAt))}` : ' a moment ago'}. Codes last an hour, so use that one, or send a new code when the timer runs out (a new code replaces the old one).`;

    ef.addEventListener('submit', async e => {
      e.preventDefault();
      const input = q('#email', container);
      const err = q('#email-err', container);
      email = input.value.trim().toLowerCase();
      if (!validEmail(email)) { err.textContent = 'Enter a valid email address.'; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
      input.removeAttribute('aria-invalid'); err.textContent = '';
      // Same address within the last minute: go straight to the code box instead of failing.
      const prev = recall();
      if (prev && prev.email === email && Date.now() - prev.at < RESEND_AFTER) { sentAt = prev.at; showCode(recentIntro()); return; }
      const btn = q('button[type=submit]', ef);
      btn.disabled = true; btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Sending…';
      const r = await sendCode();
      btn.disabled = false; btn.textContent = 'Send my code';
      if (r.ok) { showCode(sentIntro()); return; }
      if (r.problem === 'recent') { if (!sentAt) sentAt = (prev && prev.email === email && prev.at) || Date.now(); showCode(recentIntro()); return; }
      err.textContent = {
        config: 'Sign-in isn’t configured yet. Please try again later.',
        address: 'That email address doesn’t look right. Check it and try again.',
        sending: 'We couldn’t send the email just now. That’s on our side, not your address. Please try again in a few minutes, or continue with Google.',
      }[r.problem];
    });
    q('#have-code', container).addEventListener('click', () => {
      const input = q('#email', container);
      const typed = input.value.trim().toLowerCase();
      const prev = recall();
      email = validEmail(typed) ? typed : (prev && prev.email) || '';
      if (!email) { q('#email-err', container).textContent = 'Enter the email address the code was sent to first.'; input.focus(); return; }
      sentAt = prev && prev.email === email ? prev.at : 0;
      showCode(`Enter the 6-digit code we sent to <strong>${esc(email)}</strong>. Codes last an hour; if yours has expired, send a new one.`);
    });
    q('#resend-code', container).addEventListener('click', async () => {
      const rb = q('#resend-code', container), err = q('#code-err', container);
      rb.disabled = true; rb.innerHTML = '<span class="spinner" aria-hidden="true"></span> Sending…';
      const r = await sendCode();
      if (r.ok) { q('#code-intro', container).innerHTML = `We sent a new code to <strong>${esc(email)}</strong>. Use the newest one; it replaces any earlier code.`; q('#code', container).value = ''; err.textContent = ''; }
      else if (r.problem === 'recent') { sentAt = Date.now(); err.textContent = 'A code was sent very recently. Please wait for the timer, then try again.'; }
      else err.textContent = r.problem === 'sending' ? 'We couldn’t send the email just now. Please try again in a few minutes.' : 'We couldn’t send a code. Please try again.';
      startCooldown();
    });
    cf.addEventListener('submit', async e => {
      e.preventDefault();
      const code = q('#code', container).value.replace(/\D/g, '');
      const err = q('#code-err', container);
      if (code.length < 6) { err.textContent = 'Enter the code from your email.'; return; }
      const btn = q('button[type=submit]', cf);
      btn.disabled = true; btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Checking…';
      const client = await SO.auth();
      const { error } = await client.auth.verifyOtp({ email, token: code, type: 'email' });
      btn.disabled = false; btn.textContent = 'Sign in';
      if (error) { err.textContent = 'That code didn’t work or has expired. Check you’re using the newest code, or send a new one.'; return; }
      remember(null);
      state.me = null;
      navigate(`${B}${next}`, { replace: true });
    });
    q('#change-email', container).addEventListener('click', () => { cf.hidden = true; ef.hidden = false; q('#email', container).focus(); });

    // Came back after requesting a code (e.g. left the page): offer the code box right away.
    const pending = recall();
    if (pending && Date.now() - pending.at < CODE_LIFETIME && (!prefill || prefill.toLowerCase() === pending.email)) {
      email = pending.email; sentAt = pending.at;
      q('#email', container).value = email;
      showCode(`We sent a code to <strong>${esc(email)}</strong> at ${esc(timeLabel(sentAt))}. Enter it below, or send a new one.`);
    }
    // Preferred: Google's own button on this page (no redirect through the Supabase address).
    setupGoogleButton(container, next);
    // Fallback if Google's button can't load: Supabase redirect flow.
    q('#google-btn', container).addEventListener('click', async () => {
      const btn = q('#google-btn', container);
      const client = await SO.auth();
      if (!client) { q('#oauth-err', container).innerHTML = '<p class="form-error">Sign-in isn’t configured yet. Please try again later.</p>'; return; }
      btn.disabled = true;
      const { error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${location.origin}${B}/login?next=${encodeURIComponent(next)}`, queryParams: { prompt: 'select_account' } },
      });
      if (error) { btn.disabled = false; q('#oauth-err', container).innerHTML = '<p class="form-error">Google sign-in isn’t available right now. Use your email instead.</p>'; }
    });
  }

  // ------------------------------------------------ Sign in with Google (GIS)
  // Google's official button renders on omibell.com; Google returns a signed ID
  // token to this page, and Supabase verifies it (signInWithIdToken), including
  // a one-time nonce. People never see the Supabase project address.
  let gisLoad = null;
  function loadGis() {
    if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve();
    if (!gisLoad) {
      gisLoad = new Promise((resolve, reject) => {
        const sc = document.createElement('script');
        sc.src = 'https://accounts.google.com/gsi/client';
        sc.async = true;
        sc.onload = () => (window.google && window.google.accounts ? resolve() : reject(new Error('gis')));
        sc.onerror = () => { gisLoad = null; reject(new Error('gis')); };
        document.head.appendChild(sc);
        setTimeout(() => reject(new Error('gis timeout')), 8000);
      });
    }
    return gisLoad;
  }
  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  async function setupGoogleButton(container, next) {
    const cfg = await SO.config();
    const slot = q('#google-slot', container);
    // Show the redirect-based backup only when Google's own button can't be used.
    const fallback = () => { if (!slot) return; slot.remove(); const f = q('#google-fallback', container); if (f) f.hidden = false; };
    if (!slot || !cfg.google_client_id || !window.crypto || !crypto.subtle) return fallback();
    try { await loadGis(); } catch { return fallback(); }
    if (!document.contains(slot)) return;
    const raw = Array.from(crypto.getRandomValues(new Uint8Array(24))).map(b => b.toString(16).padStart(2, '0')).join('');
    const hashed = await sha256Hex(raw);
    const errBox = q('#oauth-err', container);
    window.google.accounts.id.initialize({
      client_id: cfg.google_client_id,
      nonce: hashed,
      ux_mode: 'popup',
      context: 'signin',
      itp_support: true,
      callback: async resp => {
        errBox.innerHTML = '<p class="small muted" role="status"><span class="spinner" aria-hidden="true"></span> Signing you in…</p>';
        const client = await SO.auth();
        const { error } = client ? await client.auth.signInWithIdToken({ provider: 'google', token: resp.credential, nonce: raw }) : { error: true };
        if (error) { errBox.innerHTML = '<p class="form-error">Google sign-in didn’t work. Please try again, or use your email.</p>'; return; }
        state.me = null;
        navigate(`${B}${next}`, { replace: true });
      },
    });
    slot.innerHTML = '';
    slot.removeAttribute('aria-busy');
    window.google.accounts.id.renderButton(slot, {
      type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', logo_alignment: 'center',
      width: Math.min(Math.max(slot.clientWidth || 320, 240), 400),
    });
  }

  async function viewLogin(main, _p, query) {
    const next = safeNext(query.next);
    const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
    const oauthError = query.error_description || hashParams.get('error_description');
    const client = await SO.auth();
    const session = client ? (await client.auth.getSession()).data.session : null;
    if (session) {
      // Arrived from an emailed link, or already signed in.
      if (query.next) { navigate(`${B}${next}`, { replace: true }); return 'Sign in'; }
      const me = await SO.api('GET', 'me');
      main.innerHTML = `<div class="stack"><h1>You’re signed in</h1><p>Signed in as <strong>${esc(me.email)}</strong>.</p>
<div class="row">${me.enrolled ? `<a class="btn btn-primary" href="${B}/app">Open My Cohort</a>` : `<a class="btn btn-primary" href="${B}/checkout">Continue to enrollment</a>`}
<button class="btn btn-secondary" data-signout>Sign out</button></div></div>`;
      wireSignout(main);
      return 'Account';
    }
    const wrap = document.createElement('div');
    wrap.className = 'stack';
    main.innerHTML = '';
    main.appendChild(wrap);
    const prefill = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query.email || '') ? query.email : '';
    loginForm(wrap, prefill
      ? { next, email: prefill, heading: 'Set up your account', intro: `Set up your account by signing in as <strong>${esc(prefill)}</strong>: continue with Google (using that address), or we’ll email you a 6-digit code. There’s no password.` }
      : { next });
    if (oauthError) q('#oauth-err', wrap).innerHTML = `<p class="notice notice-error">Google sign-in didn’t finish (${esc(oauthError)}). Try again, or use your email.</p>`;
    return prefill ? 'Set up your account' : 'Sign in';
  }

  async function viewLoginHelp(main) {
    const email = await supportEmail();
    main.innerHTML = `<div class="stack">
<a class="back-link" href="${B}/login">Back to sign in</a>
<h1>Trouble signing in?</h1>
<p>There are no passwords, so there’s nothing to reset. Sign in with Google, or request a 6-digit code by email, any time and on any device.</p>
<ul>
  <li>Use the same email address you enrolled with. Your enrollment belongs to that address, whether you sign in with Google or with a code.</li>
  <li>“Continue with Google” works when your Google account uses that same email.</li>
  <li>Codes expire after a short time. If one doesn’t work, request a fresh one.</li>
  <li>Check your spam or promotions folder for the code email.</li>
</ul>
<p>${supportLine(email)}</p></div>`;
    return 'Sign-in help';
  }

  // ============================================================ checkout
  function offerSummary(o) {
    const p = o.price;
    const intro = p.intro_active
      ? `<p class="small muted">Introductory price. Regular enrollment: ${SO.money(p.regular_cents)}. Ends ${esc(SO.fmtDateTime(p.cutoff_at, o.cohort.timezone, { weekday: false }))} (${esc(o.cohort.timezone)}).</p>` : '';
    return `<div class="card stack">
  <p class="eyebrow" style="margin:0">Smooth Operators · Live 21-day cohort</p>
  <p style="margin:0"><span style="font-family:var(--serif);font-size:2.4rem;color:var(--ink);font-weight:600">${SO.money(p.amount_cents)}</span> <span class="muted">USD · one-time payment</span></p>
  ${intro}
  <p style="margin:0">${esc(SO.fmtCohortDate(o.cohort.start_date, { weekday: undefined }))} – ${esc(SO.fmtCohortDate(o.cohort.end_date, { weekday: undefined }))} · Hosted by Omi Bell · Everyone follows the same calendar.</p>
  <ul class="offer-points">
    <li>New Guided Audio, Leadership Journal Prompt and Business Action Toolkit resource every day, January 4–24, 2027</li>
    <li>Three live Solutions Seat group coaching calls with Omi: Wednesdays, January 6, 13 and 20, 1–2 p.m. PST</li>
    <li>Direct Q&amp;A with Omi in the platform during the cohort (replies within 24 hours, Monday–Friday)</li>
    <li>12 months of access to program materials and call recordings</li>
  </ul>
  ${o.disclosure.access_terms ? `<p class="small">${esc(o.disclosure.access_terms)}</p>` : ''}
  ${o.disclosure.refund_policy ? `<p class="small"><strong>Refunds:</strong> ${esc(o.disclosure.refund_policy)}</p>` : ''}
  ${o.disclosure.tax_treatment ? `<p class="small">${esc(o.disclosure.tax_treatment)}</p>` : ''}
  ${o.disclosure.extra ? `<p class="small">${esc(o.disclosure.extra)}</p>` : ''}
  ${o.disclosure.terms_published || o.disclosure.privacy_published ? `<p class="small muted">By continuing you agree to the ${o.disclosure.terms_published ? `<a href="${B}/terms" data-external>Terms</a>` : ''}${o.disclosure.terms_published && o.disclosure.privacy_published ? ' and ' : ''}${o.disclosure.privacy_published ? `<a href="${B}/privacy" data-external>Privacy Policy</a>` : ''}.</p>` : ''}
</div>`;
  }

  async function viewCheckout(main, _p, query) {
    const offer = await SO.api('GET', 'offer', undefined, { auth: false });
    const token = await SO.token();
    const me = token ? await SO.api('GET', 'me') : { signed_in: false };
    const test = offer.sales.test_mode ? '<div class="notice notice-warn" role="note"><p><strong>Test mode.</strong> Use a Stripe test card. No real payment is taken.</p></div>' : '';
    const canceled = query.canceled ? '<div class="notice" role="status"><p>Checkout was canceled. You haven’t been charged. You can continue whenever you’re ready.</p></div>' : '';
    main.innerHTML = `<div class="stack"><h1>Join Smooth Operators</h1>${test}${canceled}<div id="step"></div><h2 style="font-size:1.45rem;margin:1.5rem 0 0">What’s included</h2>${offerSummary(offer)}</div>`;
    const step = q('#step', main);

    if (me.signed_in && me.enrolled && me.access.active) {
      step.innerHTML = `<div class="notice notice-success"><p>You’re already enrolled as <strong>${esc(me.email)}</strong>. There’s nothing more to pay.</p></div>
<a class="btn btn-primary" href="${B}/app">Open My Cohort</a>`;
      return 'Join';
    }
    if (!offer.sales.can_checkout) {
      step.innerHTML = `<div class="notice"><p>${offer.sales.reason === 'full' ? 'All seats are full.' : offer.sales.reason === 'enrollment_closed' ? 'Enrollment for this cohort has closed.' : 'Enrollment isn’t open yet. Please check back soon.'}</p></div>
<p>${supportLine(offer.support_email)}</p>`;
      return 'Join';
    }
    await checkoutForm(step, offer, me);
    return 'Join';
  }

  // One short form, then straight to Stripe. No sign-in first: the form is
  // saved when they continue, and they set up sign-in after paying.
  async function checkoutForm(step, offer, me) {
    const signedIn = !!me.signed_in;
    const price = SO.money(offer.price.amount_cents);
    const { options } = await SO.api('GET', 'checkout/form', undefined, { auth: false });
    // Restore what they typed if they come back from Stripe without paying.
    let saved = {};
    try { saved = JSON.parse(sessionStorage.getItem('so-checkout-form') || '{}'); } catch { /* storage unavailable */ }
    const nameParts = ((me && me.display_name) || '').trim().split(/\s+/);
    const v = { first_name: nameParts[0] || '', last_name: nameParts.slice(1).join(' '), email: (me && me.email) || '', ...saved };
    if (signedIn) v.email = me.email;
    const input = (id, label, attrs = '', help = '') => `<div class="field"><label for="f-${id}">${label}</label><input${/type=/.test(attrs) ? '' : ' type="text"'} id="f-${id}" name="${id}" value="${esc(v[id] || '')}" ${attrs}>${help ? `<p class="help">${help}</p>` : ''}</div>`;
    const select = (id, label, opts) => `<div class="field"><label for="f-${id}">${label}</label><select id="f-${id}" name="${id}" required><option value="">Choose one…</option>${opts.map(([val, lab]) => `<option value="${esc(val)}"${String(v[id]) === String(val) ? ' selected' : ''}>${esc(lab)}</option>`).join('')}</select></div>`;
    const yn = [['yes', 'Yes'], ['no', 'No']];
    step.innerHTML = `<form id="join" class="card" novalidate>
  <h2 style="font-size:1.6rem;margin-top:0">Your application</h2>
  <p class="muted" style="margin-top:-.25rem">A few quick questions so Omi knows who’s in the room. Most are a dropdown. Your answers are private to Omi and her team.</p>
  <h3 class="form-sub">About you</h3>
  <div class="grid-2">${input('first_name', 'First name', 'autocomplete="given-name" maxlength="80" required')}${input('last_name', 'Last name', 'autocomplete="family-name" maxlength="80" required')}</div>
  ${input('email', 'Email address', `type="email" autocomplete="email" inputmode="email" maxlength="254" required${signedIn ? ' readonly' : ''}`,
    signedIn ? 'Signed in. <button class="linklike" type="button" data-signout>Use a different email</button>' : 'Your receipt and account setup link go here, so double-check it.')}
  <div class="grid-2">${input('phone', 'Phone number', 'type="tel" autocomplete="tel" maxlength="30" required')}${input('postal_code', 'ZIP code', 'autocomplete="postal-code" maxlength="12" required')}</div>
  <h3 class="form-sub">Your business</h3>
  ${input('business_name', 'Business name', 'autocomplete="organization" maxlength="160" required')}
  ${input('website_url', 'Website <span class="muted small">(optional)</span>', 'type="url" inputmode="url" placeholder="yourbusiness.com" maxlength="300"')}
  ${select('business_stage', 'Stage of business', options.business_stage)}
  ${select('revenue_to_date', 'Revenue generated so far (total, since you started)', options.revenue_to_date)}
  ${select('years_in_business', 'How long have you been in business?', options.years_in_business)}
  ${select('prior_ops_work', 'Have you done any operations work before (SOPs, workflows, role descriptions, scorecards)?', yn)}
  ${select('has_full_time_staff', 'Do you have full-time staff?', yn)}
  ${select('team_size', 'How many people are on your team? Count full-time staff and contractors, not including you.', options.team_size)}
  <div class="field"><label for="f-ops_questions">What are your most pressing questions about operations?</label>
  <textarea id="f-ops_questions" name="ops_questions" maxlength="3000" required style="min-height:6rem">${esc(v.ops_questions || '')}</textarea></div>
  <div class="hp" aria-hidden="true"><label for="j-company">Company website</label><input id="j-company" type="text" tabindex="-1" autocomplete="off"></div>
  <label class="check"><input type="checkbox" id="j-ok"><span>I own a business with customers and revenue, and I’m enrolling for business purposes.</span></label>
  <div class="notice" style="margin-top:1rem"><p><strong>Refund policy.</strong> ${esc(offer.disclosure.refund_policy || '')}</p></div>
  <label class="check"><input type="checkbox" id="j-terms"><span>I agree to the <a href="${B}/terms" target="_blank" rel="noopener">Terms</a>, the <a href="${B}/privacy" target="_blank" rel="noopener">Privacy Policy</a>, and the refund policy above.</span></label>
  <p class="form-error" id="j-err" role="alert"></p>
  <button class="btn btn-primary btn-lg btn-block" type="submit" id="pay-btn">Continue to payment — ${price}</button>
  <p class="small muted" style="margin:.75rem 0 0">Secure checkout by Stripe. Your answers are saved when you continue. After you pay, we’ll email you a link to set up your account. If you don’t finish checkout, we may send you one reminder (unsubscribe any time).</p>
  ${signedIn ? '' : `<p class="small" style="margin:.5rem 0 0">Already enrolled? ${link('/login', 'Sign in')}</p>`}
</form>`;
    wireSignout(step);
    const form = q('#join', step), err = q('#j-err', form), btn = q('#pay-btn', form);
    const FIELDS = ['first_name', 'last_name', 'email', 'phone', 'postal_code', 'business_name', 'website_url', 'business_stage', 'revenue_to_date',
      'years_in_business', 'prior_ops_work', 'has_full_time_staff', 'team_size', 'ops_questions'];
    const collect = () => Object.fromEntries(FIELDS.map(f => [f, form.elements[f].value.trim()]));
    const remember = () => { try { sessionStorage.setItem('so-checkout-form', JSON.stringify(collect())); } catch { /* ignore */ } };
    form.addEventListener('change', remember);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const data = collect();
      const fail = (msg, name) => { err.textContent = msg; if (name) form.elements[name].focus(); };
      const labels = { first_name: 'Enter your first name.', last_name: 'Enter your last name.', email: 'Enter your email address.', phone: 'Enter your phone number.',
        postal_code: 'Enter your ZIP code.', business_name: 'Enter your business name.', business_stage: 'Choose your stage of business.',
        revenue_to_date: 'Choose your revenue so far.', years_in_business: 'Choose how long you’ve been in business.', prior_ops_work: 'Choose yes or no for operations work.',
        has_full_time_staff: 'Choose yes or no for full-time staff.', team_size: 'Choose your team size.', ops_questions: 'Tell us your most pressing questions about operations.' };
      const missing = Object.keys(labels).find(k => !data[k]);
      if (missing) return fail(labels[missing], missing);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) return fail('Enter a valid email address.', 'email');
      if (!q('#j-ok', form).checked) return fail('Please confirm you own a business with customers and revenue.');
      if (!q('#j-terms', form).checked) return fail('Please agree to the Terms, Privacy Policy and refund policy.');
      err.textContent = '';
      remember();
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Opening secure checkout…';
      try {
        const r = await SO.api('POST', 'checkout/start', { ...data, eligible: true, terms: true, company_website: q('#j-company', form).value });
        if (r.state === 'redirect') { window.location.assign(r.url); return; }
        const text = {
          already_enrolled: `You’re already enrolled with this email. <a href="${r.login_url || `${B}/login`}">Sign in to your account</a>.`,
          pending: 'We’re confirming your enrollment. You won’t need to pay again. Check your email in a few minutes.',
          full: 'All seats are full.',
          enrollment_closed: 'Enrollment for this cohort has closed.',
          unavailable: 'Enrollment isn’t open right now.',
          contact_support: `This email needs a quick look from our team before checkout. ${supportLine(offer.support_email)}`,
        }[r.state] || 'Checkout is unavailable right now.';
        err.innerHTML = text;
      } catch (ex) { err.textContent = ex.message; }
      btn.disabled = false;
      btn.textContent = `Continue to payment — ${price}`;
    });
  }

  async function viewSuccess(main, _p, query, ctx) {
    const sid = query.session_id || '';
    const token = await SO.token();
    const email = await supportEmail();
    main.innerHTML = '<div class="stack" id="status-box" aria-live="polite"></div>';
    const box = q('#status-box', main);
    let tries = 0;
    let timer = null;
    onCleanup(() => clearTimeout(timer));
    const show = html => { box.innerHTML = html; };
    const pending = extra => show(`<h1>We’re confirming your enrollment</h1>
<p>We’re confirming your enrollment. You won’t need to pay again.</p>
<p class="muted"><span class="spinner" aria-hidden="true"></span> This usually takes a few seconds.</p>${extra || ''}`);
    async function check() {
      if (!ctx.isCurrent()) return;
      tries++;
      let r;
      try { r = await SO.api('GET', `checkout/status?session_id=${encodeURIComponent(sid)}`); }
      catch (e) {
        if (e.status === 404) {
          show(`<h1>We couldn’t find that checkout</h1><p>This checkout isn’t linked to the account you’re signed in with. If you paid using a different email, sign out and sign in with that email.</p>
<p>${supportLine(email)}</p><button class="btn btn-secondary" data-signout>Sign out</button>`);
          wireSignout(box);
          return;
        }
        r = { state: 'verification_error' };
      }
      if (r.state === 'confirmed') {
        state.me = null;
        try { sessionStorage.removeItem('so-checkout-form'); } catch { /* ignore */ }
        const setup = `${B}/login?next=%2Fapp&email=${encodeURIComponent(r.email || '')}`;
        show(`<h1>You’re in.</h1><p>Your payment is confirmed and your seat in Smooth Operators is yours. Your receipt is on its way from Stripe.</p>
${token ? '' : `<div class="notice"><p><strong>Next: set up your account.</strong> We’ve emailed ${r.email ? `<strong>${esc(r.email)}</strong>` : 'you'} a link. You can also do it right now: sign in with Google or a one-time code, using that same email.</p></div>`}
<p>Daily guided programming runs January 4–24, 2027. Once you’re in, you can look around, add a profile photo, and save the live call dates.</p>
${token ? `<a class="btn btn-primary" href="${B}/app" id="open-cohort">Open My Cohort</a>` : `<a class="btn btn-primary" href="${setup}" id="open-cohort">Set up my account</a>`}`);
        q('#open-cohort', box).focus();
        return;
      }
      if (r.state === 'failed') { show(`<h1>The payment didn’t go through</h1><p>You haven’t been enrolled and nothing further will be charged.</p><a class="btn btn-primary" href="${B}/checkout">Try again</a><p>${supportLine(email)}</p>`); return; }
      if (r.state === 'expired') { show(`<h1>This checkout expired</h1><p>You weren’t charged. Start a new checkout whenever you’re ready.</p><a class="btn btn-primary" href="${B}/checkout">Return to checkout</a>`); return; }
      if (r.state === 'contact_support') { show(`<h1>We need to take a look</h1><p>${supportLine(email)}</p>`); return; }
      if (r.state === 'verification_error') {
        show(`<h1>We’re having trouble confirming right now</h1><p>This is temporary. If you completed payment, you won’t need to pay again.</p>
<button class="btn btn-primary" id="retry">Check again</button><p>${supportLine(email)}</p>`);
        q('#retry', box).addEventListener('click', () => { pending(); check(); });
        return;
      }
      // pending / not_completed: keep checking, then hand control to the member.
      if (tries < 20) { pending(); timer = setTimeout(check, tries < 5 ? 2000 : 4000); return; }
      pending(`<p>It’s taking longer than usual. Your payment is safe and you won’t be charged twice.</p>
<button class="btn btn-secondary" id="retry">Check again</button><p>${supportLine(email)}</p>`);
      q('#retry', box).addEventListener('click', () => { tries = 0; check(); });
    }
    pending();
    check();
    return 'Confirming enrollment';
  }

  // ============================================================ Today
  function countdownHtml(iso) {
    return `<div class="countdown" aria-hidden="true" data-countdown="${esc(iso)}">
  <div class="countdown-unit"><span class="countdown-num" data-u="d">–</span><span class="countdown-lbl">Days</span></div>
  <div class="countdown-unit"><span class="countdown-num" data-u="h">–</span><span class="countdown-lbl">Hours</span></div>
  <div class="countdown-unit"><span class="countdown-num" data-u="m">–</span><span class="countdown-lbl">Minutes</span></div>
</div>`;
  }
  function startCountdown(el) {
    const box = q('[data-countdown]', el);
    if (!box) return;
    const target = new Date(box.dataset.countdown).getTime();
    const tick = () => {
      const ms = Math.max(0, target - Date.now());
      const d = Math.floor(ms / 86400000), hh = Math.floor(ms / 3600000) % 24, mm = Math.floor(ms / 60000) % 60;
      q('[data-u=d]', box).textContent = d; q('[data-u=h]', box).textContent = hh; q('[data-u=m]', box).textContent = mm;
    };
    tick();
    const t = setInterval(tick, 30000);
    onCleanup(() => clearInterval(t));
  }

  async function viewToday(main, _p, _q, ctx) {
    const home = await SO.api('GET', 'home');
    if (!ctx.isCurrent()) return;
    const c = home.cohort;
    const startLocal = SO.fmtDateTime(c.starts_at, c.timezone);
    const startDay = SO.fmtCohortDate(c.start_date, { weekday: undefined, year: undefined });
    const introDay = new Date(c.intro_opens_at).toLocaleDateString('en-US', { timeZone: c.timezone, month: 'long', day: 'numeric' });

    if (home.phase === 'pre_intros' || home.phase === 'intros_open') {
      let intro;
      if (home.phase === 'pre_intros') {
        intro = `<div class="teaser"><p style="margin:0">Meet your cohort starting ${esc(introDay)}. Come back then to introduce yourself.</p></div>`;
      } else if (!home.has_intro) {
        intro = `<div class="teaser"><p>Your cohort is gathering. Share a little about your business before we begin.</p>
<a class="btn btn-primary" href="${B}/app/introductions/edit">Introduce Yourself</a></div>`;
      } else {
        intro = `<div class="teaser"><p>Thanks for introducing yourself.</p><div class="row">
<a class="btn btn-primary" href="${B}/app/introductions">View Cohort Introductions</a>
<a class="btn btn-ghost" href="${B}/app/introductions/edit">Edit My Introduction</a></div></div>`;
      }
      main.innerHTML = `<section class="welcome">
  <p class="eyebrow">Welcome to Smooth Operators</p>
  <h1>You’re in. Let’s build what comes next.</h1>
  <p class="promise">You know how to generate business. We’ll help you build the operations to handle what comes next.</p>
  ${announcementsHtml(home.announcements)}
  ${countdownHtml(c.starts_at)}
  <p class="abs-date">Begins ${esc(startLocal)} <span class="small">(cohort time, ${esc(c.timezone)})</span></p>
  <p class="sr-only">The cohort begins ${esc(startLocal)}.</p>
  <p>Your 21-day experience begins ${esc(startDay)}. From then, a new Guided Audio, Leadership Journal Prompt, and Business Action Toolkit resource unlock here every day, including weekends.</p>
  ${reviewNote(home.review_state)}
  ${gettingReady(home)}
  ${intro}
  ${nextCallBanner(home.next_call)}
  <p>${link('/app/calendar', 'Preview the 21 days')}</p>
</section>`;
      startCountdown(main);
      wireJoin(main);
      return 'Today';
    }

    if (home.phase === 'complete') {
      main.innerHTML = `<section class="stack">
  <p class="eyebrow">After the cohort</p>
  <h1>Keep what you’ve built in motion.</h1>
  <p class="promise">The live 21 days are over. Your work, reflections, and tools are still here.</p>
  ${announcementsHtml(home.announcements)}
  <p>${home.completed_count ? `You marked ${home.completed_count} ${home.completed_count === 1 ? 'day' : 'days'} complete.` : ''} Any day you haven’t finished is still open whenever you’re ready.</p>
  ${home.access && home.access.ends_at ? `<p class="notice">Your access to program materials and call recordings continues through ${esc(accessLastDay(home))}.</p>` : ''}
  <ul class="link-list">
    <li><a href="${B}/app/calendar">The full 21-day calendar<small>Revisit any day and its action.</small></a></li>
    <li><a href="${B}/app/journal">My Journal<small>Every reflection you saved.</small></a></li>
    <li><a href="${B}/app/library">Business Action Toolkit<small>The templates and tools behind your operating foundation.</small></a></li>
    <li><a href="${B}/app/library?tab=practices">Guided Audio<small>Return to the breathwork, meditation, and sound healing audios.</small></a></li>
    ${home.replays_available ? `<li><a href="${B}/app/calls-help">Solutions Seat replays<small>Approved recordings from the live calls.</small></a></li>` : ''}
  </ul>
  ${nextCallBanner(home.next_call)}
</section>`;
      wireJoin(main);
      return 'Today';
    }

    // Live: today's day.
    const day = home.today;
    if (!day) { main.innerHTML = '<p class="empty">Today’s day isn’t set up yet.</p>'; return 'Today'; }
    if (day.state !== 'available') {
      const email = await supportEmail();
      main.innerHTML = `${announcementsHtml(home.announcements)}${dayHeadHtml(day)}<div class="notice"><p>Today’s content is being prepared and will appear here shortly.</p><p>${supportLine(email)}</p></div>
${nextCallBanner(home.next_call)}<p>${link('/app/calendar', 'View all days')}</p>`;
      wireJoin(main);
      return `Today · Day ${day.day_number}`;
    }
    renderDay(main, day, { currentDay: home.current_day, isToday: true, introsOpen: home.intros_open });
    main.insertAdjacentHTML('afterbegin', announcementsHtml(home.announcements));
    return `Today · Day ${day.day_number}`;
  }

  function reviewNote(state) {
    if (state === 'approved') return '<div class="notice notice-success" role="note"><p><strong>You’re enrolled.</strong> Your seat is confirmed.</p></div>';
    return '';
  }

  // Last full day of access, e.g. "January 3, 2028" (access ends at midnight cohort time).
  function accessLastDay(home) {
    if (!home.access || !home.access.ends_at) return '';
    const last = new Date(new Date(home.access.ends_at).getTime() - 60000).toLocaleDateString('en-CA', { timeZone: home.cohort.timezone });
    return SO.fmtCohortDate(last, { weekday: undefined });
  }

  // Onboarding before day 1.
  function gettingReady(home) {
    const ends = accessLastDay(home) || 'January 3, 2028';
    return `<section class="card getting-ready" aria-labelledby="ready-h">
  <h2 id="ready-h">Get ready for day one</h2>
  <ol class="ready-list">
    <li><strong>Plan your daily time.</strong> About 5–10 minutes of guided audio and 20–40 minutes to apply the day’s work. Some activities take up to an hour; lighter ones about 20 minutes.</li>
    <li><strong>Save the live calls.</strong> Solutions Seat group coaching with Omi on Wednesdays, January 6, 13 and 20, 1–2 p.m. PST. ${link('/app/calls-help', 'Add them to your calendar')}</li>
    <li><strong>Make it yours.</strong> ${link('/app/account', 'Add a profile photo')} and check your time zone.</li>
    <li><strong>Questions?</strong> ${link('/app/help', 'Ask Omi')} any time. During the cohort, Omi replies within 24 hours, Monday through Friday.</li>
  </ol>
  <dl class="kv access-kv">
    <dt>Daily guided programming</dt><dd>January 4–24, 2027</dd>
    <dt>Direct Q&amp;A with Omi</dt><dd>During the 21-day cohort, Monday–Friday</dd>
    <dt>Materials &amp; recordings</dt><dd>Through ${esc(ends)}</dd>
  </dl>
</section>`;
  }

  function announcementsHtml(list) {
    if (!list || !list.length) return '';
    return `<section class="announcements" aria-labelledby="ann-h"><h2 id="ann-h">Announcements</h2>
${list.map(a => `<article class="announcement${a.pinned ? ' pinned' : ''}"><p class="small muted" style="margin:0">${a.pinned ? '<span class="pill pill-live">Pinned</span> ' : ''}${esc(new Date(a.posted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}</p>
<h3>${esc(a.title)}</h3>${SO.paras(a.body)}</article>`).join('')}</section>`;
  }

  function nextCallBanner(call) {
    if (!call) return '';
    const tz = SO.viewerTz();
    return `<div class="call-banner"><p><strong>${esc(call.title)}</strong> · ${esc(SO.fmtDateTime(call.starts_at, tz))}</p>
${call.state === 'joinable' ? `<button class="btn btn-primary btn-sm" data-join="${esc(call.id)}">Join on Zoom</button>` : `<a class="btn btn-secondary btn-sm" href="${B}/app/calls-help">Details</a>`}</div>`;
  }
  function wireJoin(el) {
    qa('[data-join]', el).forEach(b => b.addEventListener('click', async () => {
      const w = window.open('', '_blank');
      try {
        const r = await SO.api('POST', `calls/${b.dataset.join}/join`);
        if (w) { w.opener = null; w.location.href = r.url; } else window.location.href = r.url;
      } catch (e) { if (w) w.close(); alert(e.message); }
    }));
  }

  // ============================================================ Day
  function dayHeadHtml(day) {
    const date = day.date ? SO.fmtCohortDate(day.date, { year: undefined }) : '';
    return `<header class="day-head">
  <p class="day-meta">Day ${day.day_number} · ${esc(date)}${day.pillar_label ? ` · Week ${day.week}: ${esc(day.pillar_label)}` : ''}</p>
  <h1>${esc(day.title || `Day ${day.day_number}`)}</h1>
  ${day.purpose ? `<p class="day-purpose">${esc(day.purpose)}</p>` : ''}
</header>`;
  }

  async function viewDay(main, [n], _q, ctx) {
    const r = await SO.api('GET', `day/${n}`);
    if (!ctx.isCurrent()) return;
    const day = r.day;
    if (day.state === 'locked') {
      const tz = SO.viewerTz();
      main.innerHTML = `${r.current_day ? `<a class="back-link" href="${B}/app">Back to Today</a>` : ''}
${dayHeadHtml(day)}
<div class="card"><p><span class="pill pill-upcoming">Upcoming</span></p>
${day.preview_summary ? `<p>${esc(day.preview_summary)}</p>` : ''}
<p>This day unlocks ${esc(SO.fmtDateTime(day.unlock_at, tz))}.</p></div>
<p style="margin-top:1.5rem">${link('/app/calendar', 'View all days')}</p>`;
      return `Day ${day.day_number}`;
    }
    if (day.state === 'preparing') {
      const email = await supportEmail();
      main.innerHTML = `${dayHeadHtml(day)}<div class="notice"><p>This day’s content is being prepared.</p><p>${supportLine(email)}</p></div>
<p>${link('/app/calendar', 'View all days')}</p>`;
      return `Day ${day.day_number}`;
    }
    renderDay(main, day, { currentDay: r.current_day, isToday: r.current_day === day.day_number });
    return `Day ${day.day_number}: ${day.title}`;
  }

  // The single day component used by Today and /app/day/N.
  function renderDay(main, day, { currentDay, isToday, introsOpen }) {
    const tz = SO.viewerTz();
    const back = !isToday && currentDay ? `<a class="back-link" href="${B}/app">Back to Today</a>` : '';
    const callBanner = day.call ? `<div class="call-banner"><p><strong>Solutions Seat today</strong> · ${esc(SO.fmtTime(day.call.starts_at, tz))}</p>
${day.call.state === 'joinable' ? `<button class="btn btn-primary btn-sm" data-join="${esc(day.call.id)}">Join on Zoom</button>` : `<a class="btn btn-secondary btn-sm" href="${B}/app/calls-help">Details</a>`}</div>` : '';
    const content = day.content
      ? (day.content.length > 600
        ? `<details class="more"><summary>Today’s guidance</summary><div class="content-body">${SO.paras(day.content)}</div></details>`
        : `<div class="content-body">${SO.paras(day.content)}</div>`)
      : '';
    const j = day.journal;
    const question = j && j.prompt_snapshot && j.prompt_snapshot !== day.reflection_prompt ? j.prompt_snapshot : day.reflection_prompt;
    const promptNote = j && j.prompt_snapshot && j.prompt_snapshot !== day.reflection_prompt
      ? `<p class="prompt-note">This is the question you answered. It has since been updated to: “${esc(day.reflection_prompt)}”</p>` : '';
    const templates = day.templates.length
      ? `<div class="card" style="margin-top:1rem;padding:.5rem 1.25rem">${day.templates.map(resourceRow).join('')}</div>` : '';
    const done = !!(day.progress && day.progress.completed_at);

    main.innerHTML = `${back}${dayHeadHtml(day)}
${callBanner}
${content}
<section class="step" aria-labelledby="arrive-h">
  <div class="step-label"><span class="n">1</span><h2 id="arrive-h">Guided Audio</h2></div>
  <p class="step-hint">5–10 minutes to arrive.</p>
  <div id="practice">${day.practice ? '' : '<p class="muted">Today’s guided audio will appear here.</p>'}</div>
</section>
<section class="step" aria-labelledby="reflect-h" id="reflect">
  <div class="step-label"><span class="n">2</span><h2 id="reflect-h">Leadership Journal Prompt</h2></div>
  <p class="step-hint">Reflect on how you lead. Saved privately to My Journal.</p>
  <div id="reflect-box"></div>
</section>
<section class="step" aria-labelledby="apply-h">
  <div class="step-label"><span class="n">3</span><h2 id="apply-h">Business Action Toolkit</h2></div>
  <p class="step-hint">About 20–40 minutes to apply today’s work to your business. Some days take up to an hour; lighter days about 20 minutes.</p>
  ${day.action_title && day.action_title !== 'Today’s action' ? `<h3 style="font-family:var(--sans);font-size:1.1rem;font-weight:500">${esc(day.action_title)}</h3>` : ''}
  <div class="content-body">${SO.paras(day.action_body || '')}</div>
  ${templates}
  ${day.week_assignment ? `<p class="small muted" style="margin-top:1rem"><strong>This week:</strong> ${esc(day.week_assignment)} Today’s work feeds into it.</p>` : ''}
</section>
<div class="complete-box ${done ? 'done' : ''}" id="complete-box"></div>
<p class="day-foot">${link('/app/calendar', 'View all days')}${introsOpen ? link('/app/introductions', 'Cohort introductions') : ''}</p>`;

    if (day.practice) practicePlayer(q('#practice', main), day.practice);
    reflectEditor(q('#reflect-box', main), day, question, promptNote);
    completeToggle(q('#complete-box', main), day);
    wireJoin(main);
    wireResourceButtons(main);
  }

  function resourceRow(r) {
    const days = r.related_days && r.related_days.length ? ` · Day ${r.related_days.join(', ')}` : '';
    const action = r.source_type === 'link' || r.file_kind === 'Audio' || r.file_kind === 'Video' ? 'Open' : 'Download';
    return `<div class="resource-item"><div><h3>${esc(r.title)}</h3><p>${esc(r.purpose || r.description || '')}${r.purpose || r.description ? ' · ' : ''}${esc(r.file_kind)}${days}</p></div>
<button class="btn btn-secondary btn-sm" data-open="${esc(r.id)}" data-kind="${action}">${action}<span class="sr-only"> ${esc(r.title)}</span></button></div>`;
  }
  function wireResourceButtons(el) {
    qa('[data-open]', el).forEach(b => b.addEventListener('click', () => openResource(b.dataset.open, { download: b.dataset.kind === 'Download' })));
  }

  // ------------------------------------------------------- practice player
  function practicePlayer(el, p) {
    el.innerHTML = `<div class="card player">
  <div><h3 style="margin:0 0 .2rem">${esc(p.title)}</h3>
  <p class="player-meta">${esc(p.practice_type ? ({ breathwork: 'Breathwork', meditation: 'Meditation', sound_healing: 'Sound healing' }[p.practice_type] || 'Guided audio') : 'Guided audio')}${p.duration_seconds ? ` · ${SO.duration(p.duration_seconds)}` : ''}${p.position_seconds > 5 ? ' · You can pick up where you left off' : ''}</p></div>
  <div data-media><button class="btn btn-primary" data-play>Play practice<span class="sr-only">: ${esc(p.title)}</span></button></div>
  ${p.transcript ? `<details class="more"><summary>Transcript</summary><div class="transcript">${esc(p.transcript)}</div></details>` : ''}
</div>`;
    const mediaBox = q('[data-media]', el);
    let media = null, lastSent = -1, refetched = false;
    const save = () => {
      if (!media || !isFinite(media.currentTime)) return;
      const pos = Math.floor(media.ended ? 0 : media.currentTime);
      if (Math.abs(pos - lastSent) < 3) return;
      lastSent = pos;
      SO.api('POST', 'playback', { resource_id: p.id, position_seconds: pos }).catch(() => {});
    };
    async function load(autoplay) {
      const r = await SO.api('GET', `resource/${p.id}/access`);
      if (r.kind === 'link') { window.open(r.url, '_blank', 'noopener'); return; }
      const tag = p.file_kind === 'Video' ? 'video' : 'audio';
      mediaBox.innerHTML = `<${tag} controls preload="metadata" ${tag === 'video' ? 'playsinline' : ''}></${tag}>`;
      media = q(tag, mediaBox);
      media.setAttribute('aria-label', p.title);
      media.src = r.url;
      media.addEventListener('loadedmetadata', () => {
        if (p.position_seconds > 5 && (!media.duration || p.position_seconds < media.duration - 5)) media.currentTime = p.position_seconds;
      }, { once: true });
      media.addEventListener('pause', save);
      media.addEventListener('ended', save);
      media.addEventListener('error', () => {
        // Signed URL may have expired; fetch a fresh one once.
        if (refetched) { mediaBox.insertAdjacentHTML('beforeend', '<p class="form-error">The audio couldn’t load. Try again in a moment.</p>'); return; }
        refetched = true;
        const at = media.currentTime;
        SO.api('GET', `resource/${p.id}/access`).then(x => { media.src = x.url; media.currentTime = at; }).catch(() => {});
      });
      const t = setInterval(() => { if (media && !media.paused) save(); }, 15000);
      onCleanup(() => { clearInterval(t); save(); });
      if (autoplay) media.play().catch(() => {});
      media.focus();
    }
    q('[data-play]', el).addEventListener('click', () => {
      const btn = q('[data-play]', el);
      btn.disabled = true; btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Loading…';
      load(true).catch(e => { btn.disabled = false; btn.textContent = 'Play practice'; mediaBox.insertAdjacentHTML('beforeend', `<p class="form-error">${esc(e.message)}</p>`); });
    });
  }

  // ------------------------------------------------------ journal autosave
  // Saves after a pause in typing, shows Saving/Saved/Unable to save, keeps a
  // local backup of unsent text, retries with backoff, and refuses to silently
  // overwrite a newer version saved in another tab or device.
  function reflectEditor(el, day, question, promptNote) {
    const n = day.day_number;
    const key = `so-draft-${n}`;
    let revision = day.journal ? day.journal.revision : null;
    let saved = day.journal ? day.journal.body : '';
    let saving = false, timer = null, retryTimer = null, attempt = 0, conflict = false;

    el.innerHTML = `<p class="question" id="q-${n}">${esc(question || '')}</p>${promptNote}
<label class="label" for="reflect-${n}">Your reflection <span class="muted small">(private: only you can see this)</span></label>
<textarea id="reflect-${n}" aria-describedby="q-${n} save-${n}" spellcheck="true"></textarea>
<div class="save-row"><span class="save-state" id="save-${n}" role="status" aria-live="polite"></span><span id="save-actions-${n}"></span></div>
<div class="conflict" id="conflict-${n}" hidden></div>`;
    const ta = q('textarea', el);
    const status = q(`#save-${n}`, el);
    const actions = q(`#save-actions-${n}`, el);
    const conflictBox = q(`#conflict-${n}`, el);
    ta.value = saved;

    const setStatus = (s, text) => { status.dataset.state = s; status.textContent = text; };
    const dirty = () => ta.value !== saved;
    const backup = () => { try { localStorage.setItem(key, JSON.stringify({ body: ta.value, base: revision, t: Date.now() })); } catch { /* storage unavailable */ } };
    const clearBackup = () => { try { localStorage.removeItem(key); } catch { /* ignore */ } };

    // Restore text typed on this device that never reached the server.
    try {
      const b = JSON.parse(localStorage.getItem(key) || 'null');
      if (b && b.body !== saved) {
        if (b.base === revision) { ta.value = b.body; setStatus('dirty', 'Restored unsaved writing from this device.'); schedule(400); }
        else showConflict({ body: saved, revision }, b.body);
      } else if (b) clearBackup();
    } catch { /* ignore */ }
    if (!status.textContent && day.journal) setStatus('saved', `Saved`);

    unsavedGuards.add(() => dirty() || conflict);
    window.addEventListener('online', onOnline);
    onCleanup(() => { window.removeEventListener('online', onOnline); clearTimeout(timer); clearTimeout(retryTimer); if (dirty() && !conflict) save(); });
    function onOnline() { if (dirty() && !conflict) save(); }

    function schedule(ms) { clearTimeout(timer); timer = setTimeout(save, ms); }
    ta.addEventListener('input', () => {
      if (conflict) return;
      backup();
      setStatus('dirty', 'Unsaved changes');
      actions.innerHTML = '';
      schedule(1200);
    });
    ta.addEventListener('blur', () => { if (dirty() && !conflict) save(); });

    async function save(force) {
      clearTimeout(timer);
      if (conflict && !force) return;
      if (saving) { schedule(500); return; }
      if (!dirty() && !force) return;
      const body = ta.value;
      saving = true;
      setStatus('saving', 'Saving…');
      try {
        const r = await SO.api('PUT', `journal/${n}`, { body, base_revision: revision });
        revision = r.revision;
        saved = body;
        attempt = 0;
        actions.innerHTML = '';
        if (!dirty()) { clearBackup(); setStatus('saved', 'Saved'); } else { backup(); schedule(800); }
      } catch (e) {
        if (e.status === 409) { showConflict(e.data.server, body); }
        else if (e.status === 403 || e.status === 400) { setStatus('error', e.message); }
        else {
          attempt++;
          setStatus('error', e.status === 0 ? 'Unable to save: you’re offline. Your writing is kept on this device.' : 'Unable to save. Your writing is kept on this device.');
          actions.innerHTML = '<button class="linklike" type="button">Retry now</button>';
          q('button', actions).addEventListener('click', () => save());
          const delay = [2000, 5000, 10000, 30000][Math.min(attempt - 1, 3)];
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => { if (dirty()) save(); }, delay);
        }
      } finally { saving = false; }
    }

    function showConflict(server, mine) {
      conflict = true;
      setStatus('error', 'This reflection was changed in another tab or device.');
      conflictBox.hidden = false;
      conflictBox.innerHTML = `<div class="notice notice-warn"><p><strong>Two versions exist.</strong> Choose which one to keep. Nothing has been overwritten.</p>
<p class="small">Saved version${server && server.updated_at ? ` (${esc(new Date(server.updated_at).toLocaleString())})` : ''}:</p><pre>${esc(server ? server.body : '')}</pre>
<p class="small">Your version on this screen:</p><pre>${esc(mine)}</pre>
<div class="row"><button class="btn btn-primary btn-sm" data-keep>Keep my version</button><button class="btn btn-secondary btn-sm" data-use>Use saved version</button></div></div>`;
      ta.value = mine;
      q('[data-keep]', conflictBox).addEventListener('click', () => {
        revision = server ? server.revision : null;
        saved = server ? server.body : '';
        conflict = false; conflictBox.hidden = true; ta.value = mine;
        save(true);
      });
      q('[data-use]', conflictBox).addEventListener('click', () => {
        revision = server ? server.revision : null;
        saved = server ? server.body : '';
        conflict = false; conflictBox.hidden = true; ta.value = saved;
        clearBackup(); setStatus('saved', 'Saved');
      });
    }
    return { save };
  }

  function completeToggle(el, day) {
    const draw = done => {
      el.classList.toggle('done', done);
      el.innerHTML = done
        ? `<p><strong>Day ${day.day_number} complete.</strong> Nicely done.</p><button class="btn btn-ghost btn-sm" data-toggle aria-pressed="true">Mark as not complete</button>`
        : `<p>Finished what you wanted from today? Writing, listening, and downloads are optional.</p><button class="btn btn-primary" data-toggle aria-pressed="false">Complete today</button>`;
      q('[data-toggle]', el).addEventListener('click', async () => {
        const btn = q('[data-toggle]', el);
        btn.disabled = true;
        try {
          const r = await SO.api('POST', `progress/${day.day_number}`, { completed: !done });
          draw(!!r.progress.completed_at);
          q('[data-toggle]', el).focus();
        } catch (e) {
          btn.disabled = false;
          el.insertAdjacentHTML('beforeend', `<p class="form-error" role="alert">${esc(e.message)}</p>`);
        }
      });
    };
    draw(!!(day.progress && day.progress.completed_at));
  }

  // ============================================================ Calendar
  async function viewCalendar(main) {
    const r = await SO.api('GET', 'calendar');
    const tz = SO.viewerTz();
    const label = { upcoming: ['Upcoming', 'pill-upcoming'], preparing: ['Being prepared', 'pill-upcoming'], available: ['Available', 'pill-available'], in_progress: ['In progress', 'pill-progress'], complete: ['Complete', 'pill-complete'] };
    const weeks = r.weeks.map(w => {
      const days = r.days.filter(d => d.week === w.week_number);
      return `<section class="week-group" aria-labelledby="wk-${w.week_number}">
  <h2 id="wk-${w.week_number}">Week ${w.week_number} · ${esc(w.title)}</h2>
  ${days.length ? `<p class="week-sub">${esc(SO.fmtCohortDate(days[0].date, { weekday: undefined, year: undefined }))} – ${esc(SO.fmtCohortDate(days[days.length - 1].date, { weekday: undefined, year: undefined }))}</p>` : ''}
  <ul class="day-grid">${days.map(d => {
        const [txt, cls] = label[d.status];
        const today = d.day_number === r.current_day;
        const inner = `<span class="day-card-top"><span>Day ${d.day_number} · ${esc(SO.fmtCohortDate(d.date, { weekday: 'short', year: undefined }))}</span><span class="pill ${cls}">${today ? 'Today' : txt}</span></span>
<span class="day-card-title">${esc(d.title || 'Preview coming soon')}</span>
${d.preview_summary ? `<span class="day-card-sum">${esc(d.preview_summary)}</span>` : ''}
${d.status === 'upcoming' ? `<span class="day-card-sum">Unlocks ${esc(new Date(d.unlock_at).toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' }))}</span>` : ''}`;
        const clickable = ['available', 'in_progress', 'complete'].includes(d.status);
        return `<li>${clickable
          ? `<a class="day-card${today ? ' is-today' : ''}" href="${B}/app/day/${d.day_number}">${inner}</a>`
          : `<div class="day-card is-locked">${inner}</div>`}</li>`;
      }).join('')}</ul></section>`;
    }).join('');
    main.innerHTML = `<div class="page-head"><h1>21-Day Calendar</h1>
<p>Everyone in the cohort follows the same calendar. Days unlock in cohort time (${esc(r.timezone)}). Past days stay open, so you can catch up any time.</p></div>${weeks}`;
    return '21-Day Calendar';
  }

  // ============================================================ Library
  function tabs(el, items, selected, onSelect) {
    el.innerHTML = `<div class="tabs" role="tablist">${items.map(([id, label]) =>
      `<button role="tab" id="tab-${id}" aria-controls="panel" aria-selected="${id === selected}" tabindex="${id === selected ? 0 : -1}" data-tab="${id}">${label}</button>`).join('')}</div>`;
    const btns = qa('[role=tab]', el);
    btns.forEach((b, i) => {
      b.addEventListener('click', () => onSelect(b.dataset.tab));
      b.addEventListener('keydown', e => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const nb = btns[(i + d + btns.length) % btns.length];
        nb.focus(); onSelect(nb.dataset.tab);
      });
    });
  }

  async function viewLibrary(main, _p, query) {
    const lib = await SO.api('GET', 'library');
    let tab = query.tab === 'practices' ? 'practices' : 'templates';
    main.innerHTML = `<div class="page-head"><h1>Library</h1><p>Every template and practice released so far, in one place.</p></div>
<div id="tabs"></div>
<div class="field"><label for="lib-search" class="sr-only">Search the library</label><input id="lib-search" type="search" placeholder="Search released resources"></div>
<div id="panel" role="tabpanel" tabindex="0"></div>`;
    const panel = q('#panel', main);
    const search = q('#lib-search', main);
    const draw = () => {
      const term = search.value.trim().toLowerCase();
      const match = r => !term || `${r.title} ${r.purpose || ''} ${r.description || ''}`.toLowerCase().includes(term);
      panel.setAttribute('aria-labelledby', `tab-${tab}`);
      if (tab === 'templates') {
        const items = lib.templates.filter(match);
        if (!lib.templates.length) { panel.innerHTML = '<p class="empty">Business Action Toolkit resources will appear here as each day unlocks.</p>'; return; }
        if (!items.length) { panel.innerHTML = '<p class="empty">No released templates match that search.</p>'; return; }
        const groups = [['standards', 'Standards'], ['systems', 'Systems'], ['scorecards', 'Scorecards'], [null, 'More tools']];
        panel.innerHTML = groups.map(([k, label]) => {
          const g = items.filter(i => (i.pillar || null) === k);
          if (!g.length) return '';
          return `<section class="pillar-group"><h2>${label}</h2><div class="card" style="padding:.4rem 1.25rem">${g.map(r => `<div class="resource-item"><div>
<h3>${esc(r.title)}</h3><p>${esc(r.purpose || '')}${r.purpose ? ' · ' : ''}${esc(r.file_kind)}${r.related_days.length ? ` · ${r.related_days.map(d => `<a href="${B}/app/day/${d}">Go to Day ${d}</a>`).join(', ')}` : ''}</p></div>
<button class="btn btn-secondary btn-sm" data-open="${esc(r.id)}" data-kind="${r.source_type === 'link' ? 'Open' : 'Download'}">${r.source_type === 'link' ? 'Open' : 'Download'}<span class="sr-only"> ${esc(r.title)}</span></button></div>`).join('')}</div></section>`;
        }).join('');
        wireResourceButtons(panel);
      } else {
        const items = lib.practices.filter(match);
        if (!lib.practices.length) { panel.innerHTML = '<p class="empty">Guided audios will appear here as each day unlocks.</p>'; return; }
        if (!items.length) { panel.innerHTML = '<p class="empty">No released practices match that search.</p>'; return; }
        panel.innerHTML = `<div class="stack">${items.map(r => `<article class="card"><p class="small muted" style="margin:0">${r.related_days.length ? r.related_days.map(d => `Day ${d}`).join(', ') : 'Practice'} · ${esc(r.practice_type || 'practice')}${r.duration_seconds ? ` · ${SO.duration(r.duration_seconds)}` : ''}</p>
<h2 style="font-size:1.4rem;margin:.2rem 0 .6rem">${esc(r.title)}</h2>
<div class="row"><a class="btn btn-secondary btn-sm" href="${B}/app/resource/${esc(r.id)}">Play & transcript</a>
${r.related_days[0] ? `<a href="${B}/app/day/${r.related_days[0]}">Go to Day ${r.related_days[0]}</a>` : ''}</div></article>`).join('')}</div>`;
      }
    };
    tabs(q('#tabs', main), [['templates', 'Business Action Toolkit'], ['practices', 'Guided Audio']], tab, t => {
      tab = t;
      history.replaceState(history.state, '', `${B}/app/library${t === 'practices' ? '?tab=practices' : ''}`);
      qa('[role=tab]', main).forEach(b => { b.setAttribute('aria-selected', String(b.dataset.tab === t)); b.tabIndex = b.dataset.tab === t ? 0 : -1; });
      draw();
    });
    search.addEventListener('input', draw);
    draw();
    return 'Library';
  }

  async function viewResource(main, [id]) {
    const { resource: r } = await SO.api('GET', `resource/${id}`);
    main.innerHTML = `<a class="back-link" href="${B}/app/library${r.kind === 'practice' ? '?tab=practices' : ''}">Back to Library</a>
<div class="page-head"><h1>${esc(r.title)}</h1>${r.purpose ? `<p>${esc(r.purpose)}</p>` : ''}</div>
<div id="body"></div>
${r.description ? `<div class="content-body" style="margin-top:1rem">${SO.paras(r.description)}</div>` : ''}
${r.related_days.length ? `<p style="margin-top:1.5rem">${r.related_days.map(d => `<a href="${B}/app/day/${d.day_number}">Go to Day ${d.day_number}: ${esc(d.title)}</a>`).join('<br>')}</p>` : ''}`;
    const body = q('#body', main);
    if (r.kind === 'practice' || r.file_kind === 'Audio' || r.file_kind === 'Video') practicePlayer(body, r);
    else {
      body.innerHTML = `<div class="card"><p>${esc(r.file_kind)}</p><button class="btn btn-primary" data-open="${esc(r.id)}" data-kind="${r.source_type === 'link' ? 'Open' : 'Download'}">${r.source_type === 'link' ? 'Open' : 'Download'}</button>
<p class="small muted" style="margin-top:.75rem">Downloads are your copy to work in. Changes you make in the file don’t sync back here.</p></div>`;
      wireResourceButtons(body);
    }
    return r.title;
  }

  // ============================================================ Journal
  async function viewJournal(main) {
    const r = await SO.api('GET', 'journal');
    const when = d => esc(new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    const any = r.entries.length || r.notes.length;
    main.innerHTML = `<div class="page-head row-between"><div><h1>My Journal</h1><p>Private to you. Write freely any time, and answer each day’s prompt as it unlocks.</p></div>
<div class="row"><a class="btn btn-primary" href="${B}/app/journal/new">New entry</a>${any ? '<button class="btn btn-secondary btn-sm" id="export">Download my journal</button>' : ''}</div></div>
<section aria-labelledby="mine-h"><h2 id="mine-h" style="font-size:1.5rem">My entries</h2>
${r.notes.length ? `<div class="card" style="padding:.4rem 1.25rem">${r.notes.map(n => `<article class="entry">
  <p class="small muted" style="margin:0">Written ${when(n.created_at)}${n.updated_at !== n.created_at ? ` · updated ${when(n.updated_at)}` : ''}</p>
  <h3 class="entry-q" style="margin:.2rem 0 .4rem"><a href="${B}/app/journal/${esc(n.id)}" style="text-decoration:none">${esc(n.title || 'Untitled entry')}</a></h3>
  <p class="entry-x">${esc(n.excerpt || '')}</p>
  <a class="btn btn-secondary btn-sm" href="${B}/app/journal/${esc(n.id)}">Open</a>
</article>`).join('')}</div>` : '<p class="empty">Nothing here yet. Use “New entry” to write about anything on your mind.</p>'}</section>
<section aria-labelledby="daily-h" style="margin-top:2rem"><h2 id="daily-h" style="font-size:1.5rem">Daily reflections</h2>
${r.entries.length ? `<div class="card" style="padding:.4rem 1.25rem">${r.entries.map(e => `<article class="entry" data-entry="${e.day_number}">
  <p class="small muted" style="margin:0">Day ${e.day_number} · ${esc(e.title)} · Updated ${when(e.updated_at)}</p>
  <p class="entry-q">${esc(e.question || '')}</p>
  <p class="entry-x">${esc(e.excerpt)}</p>
  <div class="row"><button class="btn btn-secondary btn-sm" data-edit="${e.day_number}" aria-expanded="false">Read & edit</button><a href="${B}/app/day/${e.day_number}">Go to Day ${e.day_number}</a></div>
  <div data-editor="${e.day_number}" hidden></div>
</article>`).join('')}</div>` : '<p class="empty">A new prompt unlocks each day of the cohort. Your reflections will appear here.</p>'}</section>`;
    const ex = q('#export', main);
    if (ex) ex.addEventListener('click', () => downloadBlob('journal/export', 'smooth-operators-journal.md').catch(e => alert(e.message)));
    qa('[data-edit]', main).forEach(b => b.addEventListener('click', async () => {
      const n = b.dataset.edit;
      const box = q(`[data-editor="${n}"]`, main);
      if (!box.hidden) { box.hidden = true; b.setAttribute('aria-expanded', 'false'); return; }
      box.hidden = false; b.setAttribute('aria-expanded', 'true');
      box.innerHTML = '<p class="loading"><span class="spinner" aria-hidden="true"></span></p>';
      try {
        const { day } = await SO.api('GET', `day/${n}`);
        const j = day.journal;
        const question = j && j.prompt_snapshot ? j.prompt_snapshot : day.reflection_prompt;
        reflectEditor(box, day, question, '');
        q('textarea', box).focus();
      } catch (e) { box.innerHTML = errorBox(e); }
    }));
    return 'My Journal';
  }

  // A free journal entry: title + text, autosaved, private. Created on first save.
  async function viewNote(main, [idParam]) {
    let id = idParam === 'new' ? null : idParam;
    let note = { title: '', body: '', revision: 0 };
    if (id) note = (await SO.api('GET', `journal/notes/${id}`)).note;
    main.innerHTML = `<a class="back-link" href="${B}/app/journal">My Journal</a>
<div class="page-head"><h1>${id ? 'Journal entry' : 'New journal entry'}</h1><p class="small muted">Private: only you can see this.</p></div>
<div class="field"><label for="n-title">Title <span class="muted small">(optional)</span></label><input id="n-title" type="text" maxlength="140" value="${esc(note.title || '')}"></div>
<div class="field"><label for="n-body">Your entry</label><textarea id="n-body" style="min-height:16rem">${esc(note.body || '')}</textarea></div>
<div class="save-row"><span class="save-state" id="n-state" role="status" aria-live="polite">${id ? 'Saved' : ''}</span><span id="n-actions"></span></div>
<div id="n-conflict" hidden></div>
${id ? '<p style="margin-top:2rem"><button class="btn btn-danger btn-sm" id="n-del">Delete this entry</button></p>' : ''}`;
    const title = q('#n-title', main), body = q('#n-body', main), st = q('#n-state', main), actions = q('#n-actions', main);
    let saved = { title: title.value, body: body.value }, revision = note.revision, saving = false, timer = null, conflict = false, attempt = 0;
    const dirty = () => title.value !== saved.title || body.value !== saved.body;
    const setState = (k, t) => { st.dataset.state = k; st.textContent = t; };
    unsavedGuards.add(() => dirty() || conflict);
    onCleanup(() => { clearTimeout(timer); if (dirty() && !conflict && (id || body.value.trim() || title.value.trim())) save(); });
    async function save() {
      clearTimeout(timer);
      if (saving) { timer = setTimeout(save, 500); return; }
      if (!dirty() || conflict) return;
      if (!id && !body.value.trim() && !title.value.trim()) return;
      const snap = { title: title.value, body: body.value };
      saving = true; setState('saving', 'Saving…');
      try {
        if (!id) {
          const r = await SO.api('POST', 'journal/notes', snap);
          id = r.note.id; revision = r.note.revision;
          history.replaceState(history.state, '', `${B}/app/journal/${id}`);
        } else {
          const r = await SO.api('PUT', `journal/notes/${id}`, { ...snap, base_revision: revision });
          revision = r.revision;
        }
        saved = snap; attempt = 0; actions.innerHTML = '';
        if (dirty()) timer = setTimeout(save, 800); else setState('saved', 'Saved');
      } catch (e) {
        if (e.status === 409) {
          conflict = true;
          setState('error', 'This entry was changed in another tab or device.');
          const box = q('#n-conflict', main); box.hidden = false;
          box.innerHTML = `<div class="notice notice-warn"><p><strong>Two versions exist.</strong> Nothing has been overwritten.</p>
<p class="small">Saved version:</p><pre>${esc(e.data.server.body)}</pre><div class="row"><button class="btn btn-primary btn-sm" data-keep>Keep my version</button><button class="btn btn-secondary btn-sm" data-use>Use saved version</button></div></div>`;
          q('[data-keep]', box).onclick = () => { revision = e.data.server.revision; conflict = false; box.hidden = true; save(); };
          q('[data-use]', box).onclick = () => { revision = e.data.server.revision; body.value = e.data.server.body; saved = { title: title.value, body: body.value }; conflict = false; box.hidden = true; setState('saved', 'Saved'); };
        } else {
          attempt++;
          setState('error', e.status === 0 ? 'Unable to save: you’re offline. Keep this page open and we’ll retry.' : 'Unable to save. We’ll retry.');
          actions.innerHTML = '<button class="linklike" type="button">Retry now</button>';
          q('button', actions).onclick = () => save();
          timer = setTimeout(save, [2000, 5000, 10000, 30000][Math.min(attempt - 1, 3)]);
        }
      } finally { saving = false; }
    }
    const onInput = () => { if (conflict) return; setState('dirty', 'Unsaved changes'); clearTimeout(timer); timer = setTimeout(save, 1200); };
    title.addEventListener('input', onInput); body.addEventListener('input', onInput);
    body.addEventListener('blur', () => { if (dirty()) save(); });
    const del = q('#n-del', main);
    if (del) del.onclick = async () => {
      if (!confirm('Delete this journal entry? This can’t be undone.')) return;
      try { await SO.api('DELETE', `journal/notes/${id}`); saved = { title: title.value, body: body.value }; navigate(`${B}/app/journal`); } catch (e) { alert(e.message); }
    };
    (id ? body : title).focus();
    return id ? (note.title || 'Journal entry') : 'New journal entry';
  }

  // ============================================================ Calls & Help
  async function viewCalls(main, _p, query) {
    let tab = ['support', 'bug'].includes(query.tab) ? query.tab : 'calls';
    main.innerHTML = `<div class="page-head"><h1>Calls & Help</h1></div><div id="tabs"></div><div id="panel" role="tabpanel" tabindex="0"></div>`;
    const panel = q('#panel', main);
    const draw = async () => {
      panel.setAttribute('aria-labelledby', `tab-${tab}`);
      panel.innerHTML = '<p class="loading"><span class="spinner" aria-hidden="true"></span> Loading…</p>';
      try { tab === 'calls' ? await drawCalls(panel) : tab === 'bug' ? drawBug(panel) : await drawSupport(panel); } catch (e) { panel.innerHTML = errorBox(e, true); wireRetry(panel); }
    };
    tabs(q('#tabs', main), [['calls', 'Solutions Seat'], ['support', 'FAQ'], ['bug', 'Report a bug']], tab, t => {
      tab = t;
      history.replaceState(history.state, '', `${B}/app/calls-help${t === 'calls' ? '' : `?tab=${t}`}`);
      qa('[role=tab]', main).forEach(b => { b.setAttribute('aria-selected', String(b.dataset.tab === t)); b.tabIndex = b.dataset.tab === t ? 0 : -1; });
      draw();
    });
    await draw();
    return 'Calls & Help';
  }

  async function drawCalls(panel) {
    const data = await loadCalls(true);
    const tz = SO.viewerTz();
    const differs = tz !== data.cohort_timezone;
    const callCard = c => {
      let actions;
      if (c.state === 'canceled') actions = '<p class="muted" style="margin:0">This call was canceled.</p>';
      else if (c.state === 'ended') actions = c.replay
        ? `<button class="btn btn-secondary btn-sm" data-replay="${esc(c.replay.id)}">Watch the replay</button>`
        : '<p class="muted" style="margin:0">This call has ended.</p>';
      else if (c.state === 'joinable') actions = `<div class="row"><button class="btn btn-primary btn-lg" data-join="${esc(c.id)}">Join on Zoom</button><button class="btn btn-ghost btn-sm" data-ics="${esc(c.id)}">Add to Calendar</button></div>`;
      else actions = `<div class="row"><button class="btn btn-primary" type="button" disabled aria-describedby="jo-${esc(c.id)}">Join on Zoom</button><button class="btn btn-secondary btn-sm" data-ics="${esc(c.id)}">Add to Calendar</button></div>
<p class="small muted" id="jo-${esc(c.id)}" style="margin:.5rem 0 0">The Join button opens at ${esc(SO.fmtTime(c.join_opens_at, tz))}${differs ? ` (${esc(SO.fmtTime(c.join_opens_at, data.cohort_timezone))})` : ''} on the day of the call.</p>`;
      return `<article class="card call-card"><p class="small muted" style="margin:0">${c.state === 'joinable' ? '<span class="pill pill-live">Open now</span>' : ''}</p>
<h3 style="margin:.2rem 0">${esc(c.title)}</h3>
<p class="call-date">${esc(new Date(c.starts_at).toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }))}</p>
<p class="call-when">${esc(SO.fmtTime(c.starts_at, tz))} <span class="small muted">(your time) · on Zoom</span></p>
${differs ? `<p class="call-cohort-time">Cohort time: ${esc(SO.fmtDateTime(c.starts_at, data.cohort_timezone))}</p>` : ''}
${c.description ? `<div class="content-body">${SO.paras(c.description)}</div>` : ''}${actions}</article>`;
    };
    const upcoming = data.calls.filter(c => c.state === 'upcoming' || c.state === 'joinable');
    panel.innerHTML = `<p class="promise" style="font-size:1.3rem">Group coaching led by Omi Bell. Wednesdays, January 6, 13 and 20, 1–2 p.m. PST.</p>
<p>A participant brings a business challenge they’re working through that week, the group contributes ideas and experience, and Omi guides the conversation toward practical next steps. You can learn by bringing your own challenge, contributing to someone else’s, and applying the discussion to your business. Each call is one hour, and recordings are available here afterward.</p>
${data.recording_policy ? `<p class="small muted">${esc(data.recording_policy)}</p>` : ''}
<div class="stack" style="margin:1.5rem 0">${data.calls.length ? data.calls.map(callCard).join('') : '<p class="empty">Solutions Seat dates will appear here once they’re scheduled.</p>'}</div>
<section class="card" aria-labelledby="ch-h">
  <h2 id="ch-h" style="font-size:1.45rem">Submit your challenge <span class="small muted" style="font-family:var(--sans);font-weight:400">(optional)</span></h2>
  <p class="small">Omi and the admin team can read what you submit. It isn’t posted anywhere, and sending it doesn’t guarantee it will be discussed. Please don’t include confidential documents or personal details.</p>
  <form id="ch-form" novalidate>
    ${upcoming.length ? `<div class="field"><label for="ch-call">For which call?</label><select id="ch-call"><option value="">Any upcoming call</option>${upcoming.map(c => `<option value="${esc(c.id)}">${esc(c.title)} · ${esc(SO.fmtDateTime(c.starts_at, tz, { weekday: false }))}</option>`).join('')}</select></div>` : ''}
    <div class="field"><label for="ch-work">What are you working on?</label><textarea id="ch-work" maxlength="800" style="min-height:4.5rem"></textarea></div>
    <div class="field"><label for="ch-stuck">Where are you stuck?</label><textarea id="ch-stuck" maxlength="800" style="min-height:4.5rem"></textarea></div>
    <div class="field"><label for="ch-help">What help or decision do you want?</label><textarea id="ch-help" maxlength="800" style="min-height:4.5rem"></textarea></div>
    <div class="field"><label for="ch-share">May Omi discuss this with the cohort on the call?</label>
      <select id="ch-share" name="ch-share"><option value="">Choose one…</option><option value="yes">Yes, it can be discussed with the group</option><option value="no">No, just for Omi’s context</option></select></div>
    <p class="form-error" id="ch-err" role="alert"></p>
    <button class="btn btn-primary" type="submit">Send to Omi</button>
  </form>
  ${data.challenges.length ? `<h3 style="font-size:1.2rem;margin-top:1.5rem">What you’ve sent</h3>${data.challenges.map(c => `<div class="resource-item"><div><p style="color:var(--text);white-space:pre-wrap">${esc(c.working_on || c.body || '')}</p><p>${esc(new Date(c.created_at).toLocaleDateString())} · ${esc(c.status)}</p></div><button class="btn btn-ghost btn-sm" data-del="${esc(c.id)}">Delete</button></div>`).join('')}` : ''}
</section>
${data.intros_open ? `<p style="margin-top:1.5rem">${link('/app/introductions', 'Cohort introductions')}</p>` : ''}`;
    wireJoin(panel);
    qa('[data-ics]', panel).forEach(b => b.addEventListener('click', () => downloadBlob(`calls/${b.dataset.ics}/ics`, 'solutions-seat.ics').catch(e => alert(e.message))));
    qa('[data-replay]', panel).forEach(b => b.addEventListener('click', () => openResource(b.dataset.replay)));
    qa('[data-del]', panel).forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Delete this submission?')) return;
      try { await SO.api('DELETE', `challenges/${b.dataset.del}`); await drawCalls(panel); } catch (e) { alert(e.message); }
    }));
    q('#ch-form', panel).addEventListener('submit', async e => {
      e.preventDefault();
      const err = q('#ch-err', panel);
      const shareEl = q('#ch-share', panel);
      const share = shareEl && shareEl.value ? shareEl : null;
      const payload = { working_on: q('#ch-work', panel).value.trim(), stuck_on: q('#ch-stuck', panel).value.trim(), help_wanted: q('#ch-help', panel).value.trim(),
        share_permission: share ? share.value === 'yes' : null };
      if (!payload.working_on || !payload.stuck_on || !payload.help_wanted || payload.share_permission === null) { err.textContent = 'Please answer each question.'; return; }
      const sel = q('#ch-call', panel);
      try {
        await SO.api('POST', 'challenges', { ...payload, call_id: sel && sel.value ? sel.value : null });
        await drawCalls(panel);
        panel.insertAdjacentHTML('afterbegin', '<div class="notice notice-success" role="status"><p>Sent. Thank you.</p></div>');
      } catch (ex) { err.textContent = ex.message; }
    });
  }

  function drawBug(panel) {
    panel.innerHTML = `<p>Something not working the way it should? Tell us what happened and we’ll look into it. You’ll see our reply under <a href="${B}/app/help">Ask for help</a>.</p>
<form id="bug" class="card" novalidate>
  <div class="field"><label for="b-sum">What went wrong? (one line)</label><input id="b-sum" type="text" maxlength="140" placeholder="e.g. The audio won’t play on Day 3"></div>
  <div class="field"><label for="b-what">What happened, and what did you expect?</label><textarea id="b-what" maxlength="4000" style="min-height:6rem"></textarea></div>
  <div class="field"><label for="b-where">Where were you? <span class="muted small">(optional: page or day)</span></label><input id="b-where" type="text" maxlength="200"></div>
  <label class="check"><input type="checkbox" id="b-device" checked><span>Include my browser and device type to help us fix it</span></label>
  <p class="form-error" id="b-err" role="alert"></p>
  <button class="btn btn-primary" type="submit">Send bug report</button>
</form>`;
    q('#bug', panel).addEventListener('submit', async e => {
      e.preventDefault();
      const err = q('#b-err', panel);
      const subject = q('#b-sum', panel).value.trim(), what = q('#b-what', panel).value.trim(), where = q('#b-where', panel).value.trim();
      if (!subject || !what) { err.textContent = 'Add a one-line summary and what happened.'; return; }
      const lines = [what];
      if (where) lines.push(`Where: ${where}`);
      if (q('#b-device', panel).checked) lines.push(`Browser: ${navigator.userAgent.slice(0, 300)}`, `Screen: ${window.innerWidth}×${window.innerHeight}`);
      const btn = q('button[type=submit]', panel);
      btn.disabled = true;
      try {
        const t = await SO.api('POST', 'help/threads', { category: 'bug', subject, body: lines.join('\n\n') });
        panel.innerHTML = `<div class="notice notice-success" role="status"><p><strong>Thanks, we got it.</strong> We’ll reply on <a href="${B}/app/help/${esc(t.thread.id)}">your report</a> and email you when we do.</p></div>`;
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
  }

  async function drawSupport(panel) {
    const r = await SO.api('GET', 'faqs');
    panel.innerHTML = `${r.faqs.length ? SO.faqHtml(r.faqs, 'mfaq') : '<p class="empty">Answers to common questions will appear here.</p>'}
<section class="card" style="margin-top:2rem"><h2 style="font-size:1.45rem">Ask Omi</h2>
${r.support.note ? SO.paras(r.support.note) : ''}
<p><a class="btn btn-primary btn-sm" href="${B}/app/help">Ask a question</a></p>
${r.support.email ? `<p class="small">You can also email <a href="mailto:${esc(r.support.email)}">${esc(r.support.email)}</a>.</p>` : ''}
<p class="small">${link('/login/help', 'Trouble signing in?')}</p></section>`;
    SO.initFaq(panel);
  }

  // ============================================================ Introductions
  async function viewIntroductions(main) {
    let data;
    try { data = await SO.api('GET', 'introductions'); } catch (e) {
      if (e.code === 'intros_not_open') { main.innerHTML = `<div class="page-head"><h1>Cohort introductions</h1></div><p class="empty">Introductions open soon. Check Today for the date.</p>`; return 'Introductions'; }
      throw e;
    }
    const mine = data.introductions.find(i => i.is_mine);
    const others = data.introductions.filter(i => !i.is_mine);
    const card = i => `<article class="card intro-card">${i.photo_url ? `<img src="${esc(i.photo_url)}" alt="" width="64" height="64">` : ''}
<h3>${esc(i.preferred_name)}${i.is_mine ? ' <span class="pill">You</span>' : ''}</h3><p class="intro-biz">${esc(i.business_name)}</p>
<p style="margin:0">${esc(i.business_description)}</p>
<p class="small" style="margin:.4rem 0 0"><strong>Working on:</strong> ${esc(i.operating_challenge)}</p>
${i.website_url ? `<p class="small" style="margin:.4rem 0 0"><a href="${esc(i.website_url)}" target="_blank" rel="noopener noreferrer nofollow">Website</a></p>` : ''}
${i.is_mine && i.moderation_state === 'hidden' ? '<p class="small notice-warn" style="padding:.4rem .6rem;border-radius:6px">Hidden from the cohort by an admin. Contact support with questions.</p>' : ''}</article>`;
    main.innerHTML = `<a class="back-link" href="${B}/app">Back to Today</a>
<div class="page-head row-between"><div><h1>Cohort introductions</h1><p>The business owners building alongside you. Visible only to members of this cohort.</p></div>
<a class="btn ${mine ? 'btn-secondary' : 'btn-primary'}" href="${B}/app/introductions/edit">${mine ? 'Edit My Introduction' : 'Introduce Yourself'}</a></div>
<div class="intro-grid">${mine ? card(mine) : ''}${others.map(card).join('')}</div>
${!others.length ? '<p class="empty" style="margin-top:1rem">No one else has introduced themselves yet.</p>' : ''}`;
    return 'Introductions';
  }

  async function viewIntroEdit(main) {
    let mine;
    try { mine = (await SO.api('GET', 'introductions/mine')).introduction; } catch (e) {
      if (e.code === 'intros_not_open') { main.innerHTML = '<h1>Introductions open soon</h1><p>Come back on the date shown on Today.</p>'; return 'Introductions'; }
      throw e;
    }
    const v = mine || {};
    let photoPath; // undefined = unchanged
    main.innerHTML = `<a class="back-link" href="${B}/app">Back to Today</a>
<div class="page-head"><h1>${mine ? 'Edit my introduction' : 'Introduce yourself'}</h1>
<p>Members of this cohort and the admin team can see everything on this form. Don’t include your email, phone number, revenue, or anything confidential.</p></div>
<form id="intro-form" class="card" novalidate>
  <div class="field"><label for="f-name">Preferred name</label><input id="f-name" type="text" maxlength="80" required value="${esc(v.preferred_name || state.me.display_name || '')}"></div>
  <div class="field"><label for="f-biz">Business name</label><input id="f-biz" type="text" maxlength="120" required value="${esc(v.business_name || '')}"></div>
  <div class="field"><label for="f-what">What your business does</label><textarea id="f-what" maxlength="600" required style="min-height:5.5rem">${esc(v.business_description || '')}</textarea></div>
  <div class="field"><label for="f-ch">One operating challenge you want to address</label><textarea id="f-ch" maxlength="600" required style="min-height:5.5rem">${esc(v.operating_challenge || '')}</textarea></div>
  <div class="field"><label for="f-web">Website <span class="muted small">(optional)</span></label><input id="f-web" type="url" maxlength="300" placeholder="https://" value="${esc(v.website_url || '')}"></div>
  <div class="field"><label for="f-photo">Photo <span class="muted small">(optional; JPEG, PNG or WebP, under 5 MB)</span></label>
    <div class="row">${v.photo_url ? `<img id="photo-prev" src="${esc(v.photo_url)}" alt="Your current photo" width="64" height="64" style="border-radius:50%;object-fit:cover">` : '<img id="photo-prev" alt="" width="64" height="64" style="border-radius:50%;object-fit:cover" hidden>'}
    <input id="f-photo" type="file" accept="image/jpeg,image/png,image/webp">
    ${v.photo_url ? '<button type="button" class="linklike" id="rm-photo">Remove photo</button>' : ''}</div>
    <p class="help" id="photo-msg" role="status"></p></div>
  <p class="form-error" id="intro-err" role="alert"></p>
  <div class="row"><button class="btn btn-primary" type="submit">${mine ? 'Save changes' : 'Share my introduction'}</button>
  ${mine ? '<button class="btn btn-danger btn-sm" type="button" id="del-intro">Delete my introduction</button>' : ''}</div>
</form>`;
    const msg = q('#photo-msg', main);
    q('#f-photo', main).addEventListener('change', async e => {
      const f = e.target.files[0];
      if (!f) return;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type) || f.size > 5 * 1024 * 1024) { msg.textContent = 'Choose a JPEG, PNG or WebP image under 5 MB.'; e.target.value = ''; return; }
      msg.textContent = 'Uploading…';
      try {
        const u = await SO.api('POST', 'introductions/photo-upload', { mime_type: f.type, size: f.size });
        const put = await fetch(u.upload_url, { method: 'PUT', headers: { 'Content-Type': f.type, 'x-upsert': 'false' }, body: f });
        if (!put.ok) throw new Error('Upload failed. Please try again.');
        photoPath = u.photo_path;
        const prev = q('#photo-prev', main);
        prev.src = URL.createObjectURL(f); prev.hidden = false; prev.alt = 'Your new photo';
        msg.textContent = 'Photo ready. Save to apply it.';
      } catch (ex) { msg.textContent = ex.message; }
    });
    const rm = q('#rm-photo', main);
    if (rm) rm.addEventListener('click', () => { photoPath = null; q('#photo-prev', main).hidden = true; msg.textContent = 'Photo will be removed when you save.'; });
    const del = q('#del-intro', main);
    if (del) del.addEventListener('click', async () => {
      if (!confirm('Delete your introduction? Other members will no longer see it.')) return;
      try { await SO.api('DELETE', 'introductions/mine'); navigate(`${B}/app`); } catch (e) { q('#intro-err', main).textContent = e.message; }
    });
    q('#intro-form', main).addEventListener('submit', async e => {
      e.preventDefault();
      const err = q('#intro-err', main);
      const payload = {
        preferred_name: q('#f-name', main).value, business_name: q('#f-biz', main).value,
        business_description: q('#f-what', main).value, operating_challenge: q('#f-ch', main).value,
        website_url: q('#f-web', main).value,
      };
      const missing = [['f-name', 'preferred_name'], ['f-biz', 'business_name'], ['f-what', 'business_description'], ['f-ch', 'operating_challenge']].filter(([, k]) => !payload[k].trim());
      qa('input,textarea', main).forEach(i => i.removeAttribute('aria-invalid'));
      if (missing.length) { missing.forEach(([id]) => q(`#${id}`, main).setAttribute('aria-invalid', 'true')); err.textContent = 'Please fill in the required fields.'; q(`#${missing[0][0]}`, main).focus(); return; }
      if (photoPath !== undefined) payload.photo_path = photoPath;
      try { await SO.api('PUT', 'introductions/mine', payload); navigate(`${B}/app/introductions`); }
      catch (ex) { err.textContent = ex.message; }
    });
    return mine ? 'Edit introduction' : 'Introduce yourself';
  }

  // ============================================================ Status
  async function viewStatus(main) {
    const a = await SO.api('GET', 'application');
    const tz = SO.viewerTz();
    const pay = a.payment ? `<section class="card"><h2 style="font-size:1.35rem;margin-top:0">Payment</h2>
<p style="margin:0">${SO.money(a.payment.amount_cents || 0)} paid ${a.payment.paid_at ? esc(SO.fmtDateTime(a.payment.paid_at, tz, { weekday: false })) : ''}</p>
${a.payment.receipt_url ? `<p style="margin:.4rem 0 0"><a href="${esc(a.payment.receipt_url)}" target="_blank" rel="noopener">View your receipt</a></p>` : '<p class="small muted" style="margin:.4rem 0 0">Your receipt was emailed by Stripe.</p>'}</section>` : '';
    const answers = a.intake ? `<details class="more card" style="margin-top:1rem"><summary>Your fit check answers</summary>
<dl class="kv">${a.intake.answers.filter(x => x.answer).map(x => `<dt>${esc(x.question)}</dt><dd style="white-space:pre-wrap">${esc(x.answer)}</dd>`).join('')}</dl>
<p class="small muted">These are private to you and our team. They’re never shown to other members.</p></details>` : '';
    let head;
    if (a.review_state === 'rejected') {
      const r = a.refund;
      const refundLine = !r ? 'No payment needed refunding.'
        : r.status === 'succeeded' || r.status === 'pending' ? `We’ve initiated a full refund of ${SO.money(r.amount_cents || 0)} to your original payment method.`
        : `Your full refund of ${SO.money(r.amount_cents || 0)} is being processed. We’ll email you when it’s on its way; you don’t need to do anything.`;
      head = `<h1>Your enrollment wasn’t approved</h1><p>Thank you for your interest in Smooth Operators. After reviewing your fit check, we decided this cohort isn’t the right match for where your business is right now.</p>
<div class="notice"><p><strong>Refund:</strong> ${esc(refundLine)}</p></div>`;
    } else {
      head = `<h1>Your enrollment is under review</h1>
<p>Thank you for enrolling. Our team reviews every fit check ${esc(a.review_turnaround)}. We’ll email you as soon as there’s a decision.</p>
<div class="notice"><p>${esc(a.refund_policy || '')}</p></div>`;
    }
    main.innerHTML = `<div class="stack">${head}${pay}${answers}
<section class="card"><h2 style="font-size:1.35rem;margin-top:0">Questions?</h2><p>Ask about your application, payment or account and we’ll reply here.</p>
<a class="btn btn-secondary btn-sm" href="${B}/app/help">Ask for help</a></section></div>`;
    return 'My enrollment';
  }

  // ============================================================ Help
  async function viewHelp(main) {
    const r = await SO.api('GET', 'help/threads');
    main.innerHTML = `<div class="page-head"><h1>Ask Omi</h1><p>Send a question and chat back and forth with Omi here. You’ll get an email when there’s a reply.</p>
<p class="small muted">During the 21-day cohort, Omi responds within 24 hours, Monday through Friday. Questions sent over the weekend receive a response by the end of Monday.</p></div>
<form id="ask" class="card" novalidate>
  <div class="field"><label for="h-cat">Topic</label><select id="h-cat">${r.categories.map(c => `<option value="${c.key}">${esc(c.label)}</option>`).join('')}</select></div>
  <div class="field"><label for="h-sub">Subject</label><input id="h-sub" type="text" maxlength="140"></div>
  <div class="field"><label for="h-body">Your question</label><textarea id="h-body" maxlength="5000"></textarea></div>
  <p class="form-error" id="h-err" role="alert"></p><button class="btn btn-primary" type="submit">Send</button>
</form>
<h2 style="font-size:1.5rem;margin-top:2rem">Your questions</h2>
${r.threads.length ? `<div class="card" style="padding:.4rem 1.25rem">${r.threads.map(t => `<div class="resource-item"><div><h3><a href="${B}/app/help/${t.id}">${esc(t.subject)}</a></h3>
<p>${t.status === 'resolved' ? 'Resolved' : t.last_author === 'staff' ? 'New reply from our team' : 'Waiting for our reply'} · ${esc(new Date(t.last_message_at).toLocaleDateString())}</p></div></div>`).join('')}</div>` : '<p class="empty">You haven’t asked anything yet.</p>'}`;
    q('#ask', main).addEventListener('submit', async e => {
      e.preventDefault();
      const err = q('#h-err', main);
      const body = { category: q('#h-cat', main).value, subject: q('#h-sub', main).value.trim(), body: q('#h-body', main).value.trim() };
      if (!body.subject || !body.body) { err.textContent = 'Add a subject and your question.'; return; }
      try { const t = await SO.api('POST', 'help/threads', body); navigate(`${B}/app/help/${t.thread.id}`); } catch (ex) { err.textContent = ex.message; }
    });
    return 'Ask for help';
  }

  async function viewThread(main, [id]) {
    const r = await SO.api('GET', `help/threads/${id}`);
    main.innerHTML = `<a class="back-link" href="${B}/app/help">All questions</a>
<div class="page-head"><h1>${esc(r.thread.subject)}</h1><p>${esc(r.thread.category_label)} · ${r.thread.status === 'resolved' ? 'Resolved' : 'Open'}</p></div>
<div class="stack">${r.messages.map(m => `<article class="card"><p class="small muted" style="margin:0 0 .4rem">${m.author_type === 'staff' ? 'Smooth Operators team' : 'You'} · ${esc(new Date(m.created_at).toLocaleString())}</p>
<div style="white-space:pre-wrap">${esc(m.body)}</div></article>`).join('')}</div>
<form id="rep" class="card" style="margin-top:1rem" novalidate><div class="field"><label for="r-body">Reply</label><textarea id="r-body" maxlength="5000" style="min-height:6rem"></textarea></div>
<p class="form-error" id="r-err" role="alert"></p><button class="btn btn-primary" type="submit">Send reply</button></form>`;
    q('#rep', main).addEventListener('submit', async e => {
      e.preventDefault();
      const body = q('#r-body', main).value.trim();
      if (!body) { q('#r-err', main).textContent = 'Write your reply first.'; return; }
      try { await SO.api('POST', `help/threads/${id}/messages`, { body }); render(); } catch (ex) { q('#r-err', main).textContent = ex.message; }
    });
    return r.thread.subject;
  }

  // ============================================================ Account
  // Square-crop and shrink a chosen photo in the browser so uploads are small and consistent.
  async function squarePhoto(file, px = 480) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That image couldn’t be opened. Try a JPEG or PNG.')); i.src = url; });
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement('canvas');
      c.width = c.height = Math.min(px, side);
      c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, c.width, c.height);
      return await new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('That image couldn’t be processed.'))), 'image/jpeg', 0.88));
    } finally { URL.revokeObjectURL(url); }
  }

  function refundHtml(a) {
    const r = a.refund;
    const tz = (a.cohort && a.cohort.timezone) || 'America/Los_Angeles';
    const deadline = esc(SO.fmtDateTime(new Date(new Date(r.deadline).getTime() - 60000).toISOString(), tz, { weekday: true }));
    if (r.state === 'available') return `<p>You may request a full refund before the cohort begins on January 4, 2027 (through <strong>${deadline}</strong>). Once the cohort begins, all sales are final. You can request it here or email <a href="mailto:hello@omisworld.com">hello@omisworld.com</a>.</p>
<div id="refund-box"><button class="btn btn-secondary btn-sm" type="button" id="refund-open">Request a refund</button></div>`;
    if (r.state === 'requested') return `<div class="notice"><p><strong>Refund requested</strong> on ${esc(new Date(r.requested_at).toLocaleDateString(undefined, { month: 'long', day: 'numeric' }))}. We’ll reply in <a href="${B}/app/help">Ask for help</a> and by email.</p></div>
<button class="btn btn-ghost btn-sm" type="button" id="refund-withdraw">Withdraw my request</button>`;
    if (r.state === 'processing') return '<div class="notice"><p><strong>Your refund is being processed.</strong> It goes back to your original payment method, usually within 5–10 business days.</p></div>';
    if (r.state === 'refunded') return '<div class="notice notice-success"><p><strong>Refunded.</strong> Your payment was returned to your original payment method.</p></div>';
    if (r.state === 'closed') return '<p class="muted">The cohort began on January 4, 2027, so all sales are final and refunds are no longer available.</p>';
    return '';
  }

  async function viewAccount(main) {
    const a = await SO.api('GET', 'account');
    if (state.me) { state.me.avatar_url = a.avatar_url; state.me.display_name = a.display_name; }
    let zones = [];
    try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* older browsers */ }
    const prefs = a.email_prefs || {};
    const since = a.member_since ? new Date(a.member_since).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : '';
    const status = !a.enrolled ? 'Not enrolled' : a.review_state === 'approved' ? 'Enrolled · your seat is confirmed'
      : a.review_state === 'rejected' ? 'Not approved' : 'Under review';
    const pay = a.payment;
    main.innerHTML = `<div class="account-hero">
  <div class="account-photo" data-avatar="lg">${avatarHtml('lg')}</div>
  <div class="account-id">
    <p class="eyebrow" style="margin:0 0 .3rem">My Account</p>
    <h1 id="acct-name">${esc(a.display_name || 'Welcome')}</h1>
    <p class="muted" style="margin:0">${esc(a.email)}${since ? ` · Member since ${esc(since)}` : ''}</p>
    <div class="row" style="margin-top:.9rem">
      <label class="btn btn-secondary btn-sm file-btn">${a.avatar_url ? 'Change photo' : 'Add a profile photo'}<input type="file" id="avatar-file" accept="image/jpeg,image/png,image/webp" class="sr-only"></label>
      ${a.avatar_url ? '<button class="btn btn-ghost btn-sm" type="button" id="avatar-rm">Remove photo</button>' : ''}
    </div>
    <p class="small muted" id="avatar-msg" role="status" style="margin:.5rem 0 0"></p>
  </div>
</div>

<div class="account-grid">
<section class="card account-card" aria-labelledby="h-profile">
  <h2 id="h-profile">Profile</h2>
  <form id="acct" novalidate>
    <div class="field"><label for="a-name">Name</label><input id="a-name" type="text" maxlength="80" autocomplete="name" value="${esc(a.display_name || '')}"></div>
    <div class="field"><label for="a-tz">Time zone</label><input id="a-tz" type="text" list="tz-list" value="${esc(a.timezone || SO.viewerTz())}">
    <datalist id="tz-list">${zones.map(z => `<option value="${esc(z)}">`).join('')}</datalist>
    <p class="help">Call times show in your device’s time zone, with cohort time alongside.</p></div>
    <fieldset class="prefs"><legend class="label">Reminder emails</legend>
    <p class="help" style="margin-top:0">Choose what you’d like to hear about. Enrollment and account emails always arrive.</p>
    ${[['intros_open', 'When introductions open'], ['cohort_begins', 'When the cohort begins'], ['daily_content', 'When each day unlocks'], ['upcoming_calls', 'Before each Solutions Seat']].map(([k, l]) =>
      `<label class="check"><input type="checkbox" data-pref="${k}" ${prefs[k] ? 'checked' : ''}><span>${l}</span></label>`).join('')}</fieldset>
    <p id="acct-msg" role="status"></p>
    <button class="btn btn-primary" type="submit">Save changes</button>
  </form>
</section>

<section class="card account-card" aria-labelledby="h-member">
  <h2 id="h-member">Membership</h2>
  <dl class="kv">
    <dt>Program</dt><dd>${esc((a.cohort && a.cohort.name) || 'Smooth Operators')}</dd>
    ${a.cohort ? `<dt>Begins</dt><dd>${esc(SO.fmtCohortDate(a.cohort.start_date))}</dd>` : ''}
    <dt>Status</dt><dd>${esc(status)}</dd>
    ${pay ? `<dt>Payment</dt><dd>${SO.money(pay.amount_cents || 0)} · ${esc(new Date(pay.paid_at).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }))}${pay.receipt_url ? ` · <a href="${esc(pay.receipt_url)}" target="_blank" rel="noopener">Receipt</a>` : ''}</dd>` : ''}
  </dl>
  ${pay ? `<h3 class="account-sub">Refunds</h3><div id="refund-area">${refundHtml(a)}</div>` : ''}
</section>

<section class="card account-card" aria-labelledby="h-data">
  <h2 id="h-data">Your writing</h2>
  <p>Download everything you’ve written in My Journal as a text file. It’s yours to keep.</p>
  <button class="btn btn-secondary btn-sm" id="export" type="button">Download my journal</button>
</section>

<section class="card account-card" aria-labelledby="h-help">
  <h2 id="h-help">Help</h2>
  <ul class="quick-links">
    <li><a href="${B}/app/help">Ask a question</a></li>
    <li><a href="${B}/app/calls-help?tab=support">FAQ</a></li>
    <li><a href="${B}/app/calls-help?tab=bug">Report a bug</a></li>
    <li><a href="${B}/terms" data-external>Terms</a></li>
    <li><a href="${B}/privacy" data-external>Privacy Policy</a></li>
  </ul>
</section>
</div>

<div class="account-foot">
  <button class="btn btn-primary" type="button" data-signout>Log out</button>
  <details class="danger-zone" id="danger">
    <summary>Delete my account</summary>
    <div class="danger-body">
      ${pay ? `<p>Deleting your account erases your journal, introduction, progress and photo, and ends your access to Smooth Operators. We keep your payment record because the law requires it.</p>
      <p><strong>Deleting your account doesn’t refund your payment.</strong>${a.refund && a.refund.can_request ? ' If you want a refund, request it above first.' : ''}</p>`
      : '<p>Deleting your account permanently removes your sign-in and everything you’ve saved.</p>'}
      <div class="field"><label for="del-confirm">Type DELETE to confirm</label><input id="del-confirm" type="text" autocomplete="off" style="max-width:16rem"></div>
      <p class="form-error" id="del-err" role="alert"></p>
      <button class="btn btn-danger" type="button" id="del-go">Permanently delete my account</button>
    </div>
  </details>
</div>`;
    wireSignout(main);
    refreshAvatars();

    // Profile photo
    const amsg = q('#avatar-msg', main);
    q('#avatar-file', main).addEventListener('change', async e => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (!/^image\//.test(f.type) || f.size > 20 * 1024 * 1024) { amsg.textContent = 'Choose a JPEG, PNG or WebP photo.'; return; }
      amsg.textContent = 'Uploading…';
      try {
        const blob = await squarePhoto(f);
        const u = await SO.api('POST', 'account/avatar-upload', { mime_type: 'image/jpeg', size: blob.size });
        const put = await fetch(u.upload_url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg', 'x-upsert': 'false' }, body: blob });
        if (!put.ok) throw new Error('Upload failed. Please try again.');
        const r = await SO.api('PUT', 'account/avatar', { avatar_path: u.avatar_path });
        if (state.me) state.me.avatar_url = r.avatar_url || URL.createObjectURL(blob);
        render();
      } catch (ex) { amsg.textContent = ex.message; }
    });
    const arm = q('#avatar-rm', main);
    if (arm) arm.addEventListener('click', async () => {
      try { await SO.api('DELETE', 'account/avatar'); if (state.me) state.me.avatar_url = null; render(); } catch (ex) { amsg.textContent = ex.message; }
    });

    q('#export', main).addEventListener('click', () => downloadBlob('journal/export', 'smooth-operators-journal.md').catch(e => alert(e.message)));
    q('#acct', main).addEventListener('submit', async e => {
      e.preventDefault();
      const out = q('#acct-msg', main);
      const email_prefs = {};
      qa('[data-pref]', main).forEach(c => { email_prefs[c.dataset.pref] = c.checked; });
      try {
        const name = q('#a-name', main).value;
        await SO.api('PUT', 'account', { display_name: name, timezone: q('#a-tz', main).value.trim() || null, email_prefs });
        out.className = 'notice notice-success'; out.textContent = 'Saved.';
        if (state.me) state.me.display_name = name.trim() || null;
        q('#acct-name', main).textContent = name.trim() || 'Welcome';
        refreshAvatars();
      } catch (ex) { out.className = 'notice notice-error'; out.textContent = ex.message; }
    });

    // Refunds
    const wireRefund = () => {
      const area = q('#refund-area', main);
      if (!area) return;
      const open = q('#refund-open', area);
      if (open) open.addEventListener('click', () => {
        q('#refund-box', area).innerHTML = `<form id="refund-form" class="refund-form" novalidate>
  <div class="field"><label for="rf-why">Anything you’d like us to know? <span class="muted">(optional)</span></label><textarea id="rf-why" maxlength="2000" style="min-height:5rem"></textarea></div>
  <p class="form-error" id="rf-err" role="alert"></p>
  <div class="row"><button class="btn btn-primary btn-sm" type="submit">Send refund request</button><button class="btn btn-ghost btn-sm" type="button" id="rf-cancel">Never mind</button></div></form>`;
        q('#rf-why', area).focus();
        q('#rf-cancel', area).addEventListener('click', () => { area.innerHTML = refundHtml(a); wireRefund(); });
        q('#refund-form', area).addEventListener('submit', async ev => {
          ev.preventDefault();
          try {
            const r = await SO.api('POST', 'account/refund-request', { reason: q('#rf-why', area).value.trim() });
            a.refund = r.refund; area.innerHTML = refundHtml(a); wireRefund();
          } catch (ex) { q('#rf-err', area).textContent = ex.message; }
        });
      });
      const wd = q('#refund-withdraw', area);
      if (wd) wd.addEventListener('click', async () => {
        try { const r = await SO.api('DELETE', 'account/refund-request'); a.refund = r.refund; area.innerHTML = refundHtml(a); wireRefund(); } catch (ex) { alert(ex.message); }
      });
    };
    wireRefund();

    // Delete account
    q('#del-go', main).addEventListener('click', async () => {
      const err = q('#del-err', main);
      const v = q('#del-confirm', main).value.trim();
      if (v.toUpperCase() !== 'DELETE') { err.textContent = 'Type DELETE in the box to confirm.'; return; }
      const btn = q('#del-go', main);
      btn.disabled = true; err.textContent = '';
      try {
        await SO.api('POST', 'account/delete', { confirm: v });
        await SO.signOut().catch(() => {});
        state.me = null;
        window.location.href = B;
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    return 'My Account';
  }

  // ------------------------------------------------------------- start
  SO.auth().then(client => {
    if (client) client.auth.onAuthStateChange(evt => { if (evt === 'SIGNED_OUT') state.me = null; });
    render();
  });
})();
