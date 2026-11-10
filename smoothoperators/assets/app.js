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
    [/^\/app\/calls-help$/, viewCalls, { shell: true, nav: '/app/calls-help' }],
    [/^\/app\/day\/(\d{1,2})$/, viewDay, { shell: true, nav: '/app/calendar' }],
    [/^\/app\/resource\/([0-9a-f-]{36})$/, viewResource, { shell: true, nav: '/app/library' }],
    [/^\/app\/introductions$/, viewIntroductions, { shell: true, nav: null }],
    [/^\/app\/introductions\/edit$/, viewIntroEdit, { shell: true, nav: null }],
    [/^\/app\/account$/, viewAccount, { shell: true, nav: null, limitedOk: true }],
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
    if (opts.shell) {
      const mode = await ensureMember(path, opts);
      if (!mode || id !== state.renderId) return;
      if (mode === 'limited') {
        state.shell = false;
        root.innerHTML = limitedFrame();
        wireSignout(root);
      } else renderShell(opts.nav);
      container = q('#main');
      container.innerHTML = '<p class="loading" role="status"><span class="spinner" aria-hidden="true"></span> Loading…</p>';
    } else {
      state.shell = false;
      root.innerHTML = publicFrame();
      container = q('#main');
    }
    try {
      const title = await fn(container, params, query, { isCurrent: () => id === state.renderId });
      if (id !== state.renderId) return;
      setTitle(title);
    } catch (err) {
      if (id !== state.renderId) return;
      if (err && err.status === 401) { navigate(`${B}/login?next=${encodeURIComponent(path + location.search)}`, { replace: true }); return; }
      container.innerHTML = errorBox(err, true);
      wireRetry(container);
      setTitle('Something went wrong');
    }
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
<nav aria-label="Account" class="limited-nav">${a('/app/status', 'My enrollment')}${a('/app/help', 'Help')}${a('/app/account', 'Account')}<button class="linklike" data-signout>Sign out</button></nav></header>
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

  function navHtml(active, idPrefix) {
    const items = NAV.map(([p, label]) => `<li><a href="${B}${p}"${p === active ? ' aria-current="page"' : ''}>${label}</a></li>`).join('');
    return `<ul class="nav-list" id="${idPrefix}-nav">${items}</ul>
<ul class="nav-list nav-secondary">
  <li><a href="${B}/app/account">Account</a></li>
  <li><button class="linklike" style="min-height:42px;padding:0 .9rem" data-signout>Sign out</button></li>
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
  </header>
  <nav class="sidebar" aria-label="Main">
    <a class="wordmark" href="${B}/app">Smooth Operators</a>
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
  function loginForm(container, { next, heading = true, intro } = {}) {
    container.innerHTML = `${heading ? '<h1>Sign in</h1>' : ''}
<p>${intro || 'Use the email you enrolled with. We’ll send you a one-time sign-in code. There’s no password to remember.'}</p>
<form id="email-form" novalidate>
  <div class="field"><label for="email">Email address</label>
  <input id="email" type="email" name="email" autocomplete="email" required inputmode="email"></div>
  <p class="form-error" id="email-err" role="alert"></p>
  <button class="btn btn-primary" type="submit">Send my code</button>
</form>
<form id="code-form" hidden novalidate>
  <p id="code-intro"></p>
  <div class="field"><label for="code">Sign-in code</label>
  <input id="code" class="code-input" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="10" required></div>
  <p class="form-error" id="code-err" role="alert"></p>
  <div class="row"><button class="btn btn-primary" type="submit">Sign in</button>
  <button class="linklike" type="button" id="change-email">Use a different email</button></div>
</form>
<p class="small muted" style="margin-top:1.5rem">${link('/login/help', 'Trouble signing in?')}</p>`;
    const ef = q('#email-form', container), cf = q('#code-form', container);
    let email = '';
    ef.addEventListener('submit', async e => {
      e.preventDefault();
      const input = q('#email', container);
      const err = q('#email-err', container);
      email = input.value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = 'Enter a valid email address.'; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
      input.removeAttribute('aria-invalid'); err.textContent = '';
      const btn = q('button[type=submit]', ef);
      btn.disabled = true; btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Sending…';
      const client = await SO.auth();
      if (!client) { err.textContent = 'Sign-in isn’t configured yet. Please try again later.'; btn.disabled = false; btn.textContent = 'Send my code'; return; }
      const { error } = await client.auth.signInWithOtp({
        email, options: { shouldCreateUser: true, emailRedirectTo: `${location.origin}${B}/login?next=${encodeURIComponent(next)}` },
      });
      btn.disabled = false; btn.textContent = 'Send my code';
      if (error) { err.textContent = /rate|seconds/i.test(error.message) ? 'Please wait a minute before requesting another code.' : 'We couldn’t send a code. Check the address and try again.'; return; }
      ef.hidden = true; cf.hidden = false;
      q('#code-intro', container).innerHTML = `We sent a code to <strong>${esc(email)}</strong>. Enter it below, or open the sign-in link in that email.`;
      q('#code', container).focus();
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
      if (error) { err.textContent = 'That code didn’t work or has expired. Check it, or request a new one.'; return; }
      state.me = null;
      navigate(`${B}${next}`, { replace: true });
    });
    q('#change-email', container).addEventListener('click', () => { cf.hidden = true; ef.hidden = false; q('#email', container).focus(); });
  }

  async function viewLogin(main, _p, query) {
    const next = safeNext(query.next);
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
    loginForm(wrap, { next });
    return 'Sign in';
  }

  async function viewLoginHelp(main) {
    const email = await supportEmail();
    main.innerHTML = `<div class="stack">
<a class="back-link" href="${B}/login">Back to sign in</a>
<h1>Trouble signing in?</h1>
<p>Smooth Operators uses one-time codes instead of passwords, so there’s nothing to reset. Request a new code any time from the sign-in page, on any device.</p>
<ul>
  <li>Sign in with the same email address you used to enroll. Your enrollment belongs to that account.</li>
  <li>Codes expire after a short time. If one doesn’t work, request a fresh code.</li>
  <li>Check your spam or promotions folder for the email.</li>
  <li>If you open the sign-in link on a different device than the one you requested it on, enter the code instead.</li>
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
  <p style="margin:0"><span style="font-family:var(--serif);font-size:2.4rem;color:var(--plum-900);font-weight:600">${SO.money(p.amount_cents)}</span> <span class="muted">USD · one-time payment</span></p>
  ${intro}
  <p style="margin:0">${esc(SO.fmtCohortDate(o.cohort.start_date, { weekday: undefined }))} – ${esc(SO.fmtCohortDate(o.cohort.end_date, { weekday: undefined }))} · Hosted by Omi Bell · Everyone follows the same calendar.</p>
  ${o.disclosure.access_terms ? `<p class="small" style="margin:0">${esc(o.disclosure.access_terms)}</p>` : ''}
  ${o.disclosure.refund_policy ? `<p class="small" style="margin:0">${esc(o.disclosure.refund_policy)}</p>` : ''}
  ${o.disclosure.tax_treatment ? `<p class="small" style="margin:0">${esc(o.disclosure.tax_treatment)}</p>` : ''}
  ${o.disclosure.extra ? `<p class="small" style="margin:0">${esc(o.disclosure.extra)}</p>` : ''}
  ${o.disclosure.terms_published || o.disclosure.privacy_published ? `<p class="small muted" style="margin:0">By continuing you agree to the ${o.disclosure.terms_published ? `<a href="${B}/terms" data-external>Terms</a>` : ''}${o.disclosure.terms_published && o.disclosure.privacy_published ? ' and ' : ''}${o.disclosure.privacy_published ? `<a href="${B}/privacy" data-external>Privacy Policy</a>` : ''}.</p>` : ''}
</div>`;
  }

  async function viewCheckout(main, _p, query) {
    const offer = await SO.api('GET', 'offer', undefined, { auth: false });
    const token = await SO.token();
    const me = token ? await SO.api('GET', 'me') : { signed_in: false };
    const test = offer.sales.test_mode ? '<div class="notice notice-warn" role="note"><p><strong>Test mode.</strong> Use a Stripe test card. No real payment is taken.</p></div>' : '';
    const canceled = query.canceled ? '<div class="notice" role="status"><p>Checkout was canceled. You haven’t been charged. You can continue whenever you’re ready.</p></div>' : '';
    main.innerHTML = `<div class="stack"><h1>Join Smooth Operators</h1>${test}${canceled}${offerSummary(offer)}<div id="step"></div></div>`;
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
    if (!me.signed_in) {
      step.innerHTML = '<h2 style="font-size:1.5rem">Step 1: Confirm your email</h2><div id="login"></div>';
      loginForm(q('#login', step), { next: '/checkout', heading: false, intro: 'We’ll send a one-time code to confirm it’s you. Your enrollment and cohort access will belong to this email.' });
      return 'Join';
    }
    const fit = await SO.api('GET', 'intake');
    if (!fit.intake || fit.intake.status !== 'submitted' || query.edit === 'fit') {
      fitCheckForm(step, fit, me);
      return 'Join';
    }
    step.innerHTML = `<p>Signed in as <strong>${esc(me.email)}</strong>. <button class="linklike" data-signout>Not you?</button></p>
<div class="notice notice-success"><p><strong>Fit check complete.</strong> Thanks, ${esc(fit.intake.first_name)}. <a href="${B}/checkout?edit=fit">Review my answers</a></p></div>
${fit.intake.early_stage ? '<div class="notice notice-warn"><p>Smooth Operators is built for founders who already have customers and revenue. You’re welcome to join; just know it may be early for where your business is today.</p></div>' : ''}
<button class="btn btn-primary btn-lg btn-block" id="pay-btn">Continue to secure payment — ${SO.money(offer.price.amount_cents)}</button>
<p class="small muted">You’ll finish on Stripe’s secure checkout page. Your receipt comes from Stripe.</p>
<div id="pay-msg" role="status" aria-live="polite"></div>`;
    wireSignout(step);
    const btn = q('#pay-btn', step), msg = q('#pay-msg', step);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Preparing secure checkout…';
      msg.innerHTML = '';
      try {
        const r = await SO.api('POST', 'checkout/session', {});
        if (r.state === 'redirect') { window.location.assign(r.url); return; }
        const text = {
          already_enrolled: `You’re already enrolled. <a href="${B}/app">Open My Cohort</a>.`,
          pending: 'We’re confirming your enrollment. You won’t need to pay again. Check back in a few minutes.',
          full: 'All seats are full.',
          intake_required: `Please complete the fit check first. <a href="${B}/checkout">Continue</a>`,
          enrollment_closed: 'Enrollment for this cohort has closed.',
          unavailable: 'Enrollment isn’t open right now.',
          contact_support: `Your account needs a quick review before checkout. ${supportLine(offer.support_email)}`,
        }[r.state] || 'Checkout is unavailable right now.';
        msg.innerHTML = `<div class="notice">${text}</div>`;
        btn.hidden = true;
      } catch (e) {
        msg.innerHTML = errorBox(e);
        btn.disabled = false;
        btn.textContent = `Continue to secure payment — ${SO.money(offer.price.amount_cents)}`;
      }
    });
    return 'Join';
  }

  // Fit check: mostly buttons, one open question. Required before payment.
  function fitCheckForm(step, fit, me) {
    const v = fit.intake || {};
    const radios = (name, legend, opts, cur) => `<fieldset class="field fit-group"><legend class="label">${legend}</legend>
<div class="choice-grid">${opts.map(([val, lab]) => `<label class="choice"><input type="radio" name="${name}" value="${esc(String(val))}"${String(cur) === String(val) ? ' checked' : ''} required><span>${esc(lab)}</span></label>`).join('')}</div></fieldset>`;
    const yn = (name, legend, cur) => radios(name, legend, [['yes', 'Yes'], ['no', 'No']], cur === true ? 'yes' : cur === false ? 'no' : '');
    const input = (id, label, val, attrs = '') => `<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${id}" value="${esc(val || '')}" ${attrs}></div>`;
    const isOutside = v.state === fit.outside_us;
    step.innerHTML = `<h2 style="font-size:1.6rem">Fit check</h2>
<p>Smooth Operators is a cohort, so we want everyone in the room at a similar stage. These answers are private: only Omi and the admin team see them. Most questions are a single tap.</p>
<form id="fit" class="card" novalidate>
  <h3 style="font-size:1.25rem">About you</h3>
  <div class="grid-2">${input('first_name', 'First name', v.first_name, 'autocomplete="given-name" required maxlength="80"')}${input('last_name', 'Last name', v.last_name, 'autocomplete="family-name" required maxlength="80"')}</div>
  ${input('phone', 'Phone number', v.phone, 'type="tel" autocomplete="tel" required maxlength="30"')}
  <h3 style="font-size:1.25rem">Your business</h3>
  ${input('business_name', 'Business name', v.business_name, 'autocomplete="organization" required maxlength="160"')}
  ${input('website_url', 'Website', v.website_url, 'type="url" placeholder="https://" maxlength="300"')}
  <label class="check" style="margin-top:-.6rem"><input type="checkbox" id="no_website"${v.no_website ? ' checked' : ''}><span>I don’t have a website yet</span></label>
  <h3 style="font-size:1.25rem">Business address</h3>
  ${input('address_line1', 'Street address', v.address_line1, 'autocomplete="address-line1" required maxlength="200"')}
  ${input('address_line2', 'Apartment, suite, etc. <span class="muted small">(optional)</span>', v.address_line2, 'autocomplete="address-line2" maxlength="200"')}
  <div class="grid-3">
    ${input('city', 'City', v.city, 'autocomplete="address-level2" required maxlength="120"')}
    <div class="field"><label for="state">State</label><select id="state" name="state" required autocomplete="address-level1"><option value="">Choose…</option>
      ${fit.states.map(s => `<option${v.state === s ? ' selected' : ''}>${s}</option>`).join('')}<option value="${fit.outside_us}"${isOutside ? ' selected' : ''}>Outside the US</option></select></div>
    ${input('postal_code', 'ZIP code', v.postal_code, 'autocomplete="postal-code" required maxlength="12" inputmode="numeric"')}
  </div>
  <div id="country-wrap"${isOutside ? '' : ' hidden'}>${input('country', 'Country', v.country && v.country !== 'United States' ? v.country : '', 'autocomplete="country-name" maxlength="80"')}</div>
  <h3 style="font-size:1.25rem">Where you are in business</h3>
  ${radios('business_stage', 'Stage of business', fit.options.business_stage, v.business_stage)}
  ${radios('revenue_to_date', 'Revenue generated so far (total, since you started)', fit.options.revenue_to_date, v.revenue_to_date)}
  ${radios('years_in_business', 'How long have you been in business?', fit.options.years_in_business, v.years_in_business)}
  ${yn('prior_ops_work', 'Have you done any operations work before (SOPs, workflows, role descriptions, scorecards)?', v.prior_ops_work)}
  ${yn('has_full_time_staff', 'Do you have full-time staff?', v.has_full_time_staff)}
  ${radios('team_size', 'How many people are on your team? Count full-time staff and contractors, not including you.', fit.options.team_size, v.team_size)}
  <div class="field"><label for="ops_questions">What are your most pressing questions about operations?</label>
  <textarea id="ops_questions" name="ops_questions" maxlength="3000" required>${esc(v.ops_questions || '')}</textarea></div>
  <div class="notice"><p><strong>How review works.</strong> ${esc(fit.refund_policy || '')} We review ${esc(fit.review_turnaround || '')}.</p>
  <label class="check"><input type="checkbox" id="policy_ack"><span>I understand: if it isn’t the right fit I’ll be refunded in full, and once I’m approved my enrollment is non-refundable.</span></label></div>
  <p class="form-error" id="fit-err" role="alert"></p>
  <button class="btn btn-primary btn-lg btn-block" type="submit">Save and continue to payment</button>
  <p style="text-align:center;margin-top:.75rem"><button class="linklike" type="button" id="save-draft">Save my answers and finish later</button></p>
  <p id="draft-msg" class="small muted" role="status" style="text-align:center"></p>
</form>`;
    const form = q('#fit', step);
    const stateSel = q('#state', form);
    const syncState = () => {
      const out = stateSel.value === fit.outside_us;
      q('#country-wrap', form).hidden = !out;
      q('label[for=postal_code]', form).textContent = out ? 'Postal code' : 'ZIP code';
    };
    stateSel.addEventListener('change', syncState); syncState();
    const noWeb = q('#no_website', form), web = q('#website_url', form);
    const syncWeb = () => { web.disabled = noWeb.checked; if (noWeb.checked) web.value = ''; };
    noWeb.addEventListener('change', syncWeb); syncWeb();
    const collect = () => {
      const radio = n => { const r = form.querySelector(`input[name="${n}"]:checked`); return r ? r.value : null; };
      let site = web.value.trim();
      if (site && !/^https?:\/\//i.test(site)) site = `https://${site}`;
      const payload = {
        first_name: form.first_name.value, last_name: form.last_name.value, phone: form.phone.value,
        business_name: form.business_name.value, website_url: site, no_website: noWeb.checked,
        address_line1: form.address_line1.value, address_line2: form.address_line2.value, city: form.city.value,
        state: stateSel.value, postal_code: form.postal_code.value, country: form.country.value,
        business_stage: radio('business_stage'), revenue_to_date: radio('revenue_to_date'), years_in_business: radio('years_in_business'),
        prior_ops_work: radio('prior_ops_work'), has_full_time_staff: radio('has_full_time_staff'), team_size: radio('team_size'),
        ops_questions: form.ops_questions.value, policy_ack: q('#policy_ack', form).checked,
      };
      return payload;
    };
    q('#save-draft', form).addEventListener('click', async () => {
      const msg = q('#draft-msg', form);
      try { await SO.api('PUT', 'intake', { ...collect(), submit: false }); msg.textContent = 'Saved. Come back any time to finish; we won’t review it until you submit.'; }
      catch (ex) { msg.textContent = ex.message; }
    });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const err = q('#fit-err', form);
      const payload = { ...collect(), submit: true };
      const btn = q('button[type=submit]', form);
      btn.disabled = true;
      try {
        await SO.api('PUT', 'intake', payload);
        navigate(`${B}/checkout`, { replace: true });
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
        err.scrollIntoView({ block: 'center' });
      }
    });
  }

  async function viewSuccess(main, _p, query, ctx) {
    const sid = query.session_id || '';
    const token = await SO.token();
    if (!token) {
      main.innerHTML = '<div class="stack"><h1>Confirm it’s you</h1><div id="login"></div></div>';
      loginForm(q('#login', main), { next: `/checkout/success?session_id=${encodeURIComponent(sid)}`, heading: false, intro: 'Sign in with the email you used at checkout so we can confirm your enrollment.' });
      return 'Confirming enrollment';
    }
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
        show(`<h1>Payment confirmed</h1><p>Thank you. Your receipt is on its way from Stripe.</p>
<p><strong>Your enrollment is under review.</strong> We’ll email you as soon as there’s a decision. If it isn’t the right fit, you’ll be refunded in full.</p>
<a class="btn btn-primary" href="${B}/app/status" id="open-cohort">See my enrollment status</a>`);
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
  ${countdownHtml(c.starts_at)}
  <p class="abs-date">Begins ${esc(startLocal)} <span class="small">(cohort time, ${esc(c.timezone)})</span></p>
  <p class="sr-only">The cohort begins ${esc(startLocal)}.</p>
  <p>Your 21-day experience begins ${esc(startDay)}. Your daily guidance, practices, and tools will appear here when we begin.</p>
  ${reviewNote(home.review_state)}
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
  <p>${home.completed_count ? `You marked ${home.completed_count} ${home.completed_count === 1 ? 'day' : 'days'} complete.` : ''} Any day you haven’t finished is still open whenever you’re ready.</p>
  ${home.access && home.access.ends_at ? `<p class="notice">Your access continues through ${esc(SO.fmtDateTime(home.access.ends_at, c.timezone, { weekday: false }))}.</p>` : ''}
  <ul class="link-list">
    <li><a href="${B}/app/calendar">The full 21-day calendar<small>Revisit any day and its action.</small></a></li>
    <li><a href="${B}/app/journal">My Journal<small>Every reflection you saved.</small></a></li>
    <li><a href="${B}/app/library">Templates<small>The tools behind your operating foundation.</small></a></li>
    <li><a href="${B}/app/library?tab=practices">Breathwork & Meditation<small>Return to the practices.</small></a></li>
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
      main.innerHTML = `${dayHeadHtml(day)}<div class="notice"><p>Today’s content is being prepared and will appear here shortly.</p><p>${supportLine(email)}</p></div>
${nextCallBanner(home.next_call)}<p>${link('/app/calendar', 'View all days')}</p>`;
      wireJoin(main);
      return `Today · Day ${day.day_number}`;
    }
    renderDay(main, day, { currentDay: home.current_day, isToday: true, introsOpen: home.intros_open });
    return `Today · Day ${day.day_number}`;
  }

  function reviewNote(state) {
    if (state === 'pending') return '<div class="notice" role="note"><p><strong>Your fit check is with our team.</strong> We review every enrollment to make sure the cohort is the right match for where your business is. We’ll email you once you’re approved.</p></div>';
    if (state === 'approved') return '<div class="notice notice-success" role="note"><p><strong>You’re approved.</strong> Your seat is confirmed.</p></div>';
    return '';
  }

  function nextCallBanner(call) {
    if (!call) return '';
    const tz = SO.viewerTz();
    return `<div class="call-banner"><p><strong>${esc(call.title)}</strong> · ${esc(SO.fmtDateTime(call.starts_at, tz))}</p>
${call.state === 'joinable' ? `<button class="btn btn-primary btn-sm" data-join="${esc(call.id)}">Join Solutions Seat</button>` : `<a class="btn btn-secondary btn-sm" href="${B}/app/calls-help">Details</a>`}</div>`;
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
${day.call.state === 'joinable' ? `<button class="btn btn-primary btn-sm" data-join="${esc(day.call.id)}">Join Solutions Seat</button>` : `<a class="btn btn-secondary btn-sm" href="${B}/app/calls-help">Details</a>`}</div>` : '';
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
  <div class="step-label"><span class="n">1</span><h2 id="arrive-h">Arrive</h2></div>
  <div id="practice">${day.practice ? '' : '<p class="muted">Today’s guided practice will appear here.</p>'}</div>
</section>
<section class="step" aria-labelledby="reflect-h" id="reflect">
  <div class="step-label"><span class="n">2</span><h2 id="reflect-h">Reflect</h2></div>
  <div id="reflect-box"></div>
</section>
<section class="step" aria-labelledby="apply-h">
  <div class="step-label"><span class="n">3</span><h2 id="apply-h">Apply</h2></div>
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
  <p class="player-meta">${esc(p.practice_type ? p.practice_type[0].toUpperCase() + p.practice_type.slice(1) : 'Guided practice')}${p.duration_seconds ? ` · ${SO.duration(p.duration_seconds)}` : ''}${p.position_seconds > 5 ? ' · You can pick up where you left off' : ''}</p></div>
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
        if (!lib.templates.length) { panel.innerHTML = '<p class="empty">Templates will appear here as each day unlocks.</p>'; return; }
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
        if (!lib.practices.length) { panel.innerHTML = '<p class="empty">Guided practices will appear here as each day unlocks.</p>'; return; }
        if (!items.length) { panel.innerHTML = '<p class="empty">No released practices match that search.</p>'; return; }
        panel.innerHTML = `<div class="stack">${items.map(r => `<article class="card"><p class="small muted" style="margin:0">${r.related_days.length ? r.related_days.map(d => `Day ${d}`).join(', ') : 'Practice'} · ${esc(r.practice_type || 'practice')}${r.duration_seconds ? ` · ${SO.duration(r.duration_seconds)}` : ''}</p>
<h2 style="font-size:1.4rem;margin:.2rem 0 .6rem">${esc(r.title)}</h2>
<div class="row"><a class="btn btn-secondary btn-sm" href="${B}/app/resource/${esc(r.id)}">Play & transcript</a>
${r.related_days[0] ? `<a href="${B}/app/day/${r.related_days[0]}">Go to Day ${r.related_days[0]}</a>` : ''}</div></article>`).join('')}</div>`;
      }
    };
    tabs(q('#tabs', main), [['templates', 'Templates'], ['practices', 'Breathwork & Meditation']], tab, t => {
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
    main.innerHTML = `<div class="page-head row-between"><div><h1>My Journal</h1><p>Your private reflections, by day. Only you can see them.</p></div>
${r.entries.length ? '<button class="btn btn-secondary btn-sm" id="export">Download my journal</button>' : ''}</div>
${r.entries.length ? `<div class="card" style="padding:.4rem 1.25rem">${r.entries.map(e => `<article class="entry" data-entry="${e.day_number}">
  <p class="small muted" style="margin:0">Day ${e.day_number} · ${esc(e.title)} · Updated ${esc(new Date(e.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}</p>
  <p class="entry-q">${esc(e.question || '')}</p>
  <p class="entry-x">${esc(e.excerpt)}</p>
  <div class="row"><button class="btn btn-secondary btn-sm" data-edit="${e.day_number}" aria-expanded="false">Read & edit</button><a href="${B}/app/day/${e.day_number}">Go to Day ${e.day_number}</a></div>
  <div data-editor="${e.day_number}" hidden></div>
</article>`).join('')}</div>` : '<p class="empty">Your reflections will appear here as you move through the cohort.</p>'}`;
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

  // ============================================================ Calls & Help
  async function viewCalls(main, _p, query) {
    let tab = query.tab === 'support' ? 'support' : 'calls';
    main.innerHTML = `<div class="page-head"><h1>Calls & Help</h1></div><div id="tabs"></div><div id="panel" role="tabpanel" tabindex="0"></div>`;
    const panel = q('#panel', main);
    const draw = async () => {
      panel.setAttribute('aria-labelledby', `tab-${tab}`);
      panel.innerHTML = '<p class="loading"><span class="spinner" aria-hidden="true"></span> Loading…</p>';
      try { tab === 'calls' ? await drawCalls(panel) : await drawSupport(panel); } catch (e) { panel.innerHTML = errorBox(e, true); wireRetry(panel); }
    };
    tabs(q('#tabs', main), [['calls', 'Solutions Seat'], ['support', 'FAQs & Support']], tab, t => {
      tab = t;
      history.replaceState(history.state, '', `${B}/app/calls-help${t === 'support' ? '?tab=support' : ''}`);
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
      else if (c.state === 'joinable') actions = `<div class="row"><button class="btn btn-primary" data-join="${esc(c.id)}">Join Solutions Seat</button><button class="btn btn-ghost btn-sm" data-ics="${esc(c.id)}">Add to Calendar</button></div>`;
      else actions = `<div class="row"><button class="btn btn-secondary btn-sm" data-ics="${esc(c.id)}">Add to Calendar</button><span class="small muted">The join button appears ${Math.round((new Date(c.starts_at) - new Date(c.join_opens_at)) / 60000)} minutes before the call.</span></div>`;
      return `<article class="card call-card"><p class="small muted" style="margin:0">${c.state === 'joinable' ? '<span class="pill pill-live">Open now</span>' : ''}</p>
<h3 style="margin:.2rem 0">${esc(c.title)}</h3>
<p class="call-when">${esc(SO.fmtDateTime(c.starts_at, tz))} <span class="small muted">(your time)</span></p>
${differs ? `<p class="call-cohort-time">Cohort time: ${esc(SO.fmtDateTime(c.starts_at, data.cohort_timezone))}</p>` : ''}
${c.description ? `<div class="content-body">${SO.paras(c.description)}</div>` : ''}${actions}</article>`;
    };
    const upcoming = data.calls.filter(c => c.state === 'upcoming' || c.state === 'joinable');
    panel.innerHTML = `<p class="promise" style="font-size:1.3rem">Bring a challenge you’re working through. We’ll think it through together.</p>
<p>In each live Solutions Seat, members bring an operational challenge and the group helps think it through. How much individual time each person gets depends on attendance.</p>
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
    <fieldset class="field fit-group"><legend class="label">May Omi discuss this with the cohort on the call?</legend>
      <div class="choice-grid"><label class="choice"><input type="radio" name="ch-share" value="yes"><span>Yes, it can be discussed with the group</span></label>
      <label class="choice"><input type="radio" name="ch-share" value="no"><span>No, just for Omi’s context</span></label></div></fieldset>
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
      const share = panel.querySelector('input[name="ch-share"]:checked');
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

  async function drawSupport(panel) {
    const r = await SO.api('GET', 'faqs');
    panel.innerHTML = `${r.faqs.length ? `<div class="faq">${r.faqs.map(f => `<details><summary>${esc(f.question)}</summary>${SO.paras(f.answer)}</details>`).join('')}</div>` : '<p class="empty">Answers to common questions will appear here.</p>'}
<section class="card" style="margin-top:2rem"><h2 style="font-size:1.45rem">Support</h2>
${r.support.email ? `<p>Email <a href="mailto:${esc(r.support.email)}">${esc(r.support.email)}</a>.</p>` : '<p>Support contact details will be posted here before the cohort begins.</p>'}
${r.support.note ? SO.paras(r.support.note) : ''}
<p><a class="btn btn-secondary btn-sm" href="${B}/app/help">Ask for help</a></p>
<p class="small">${link('/login/help', 'Trouble signing in?')}</p></section>`;
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
<div class="page-head row-between"><div><h1>Cohort introductions</h1><p>The founders building alongside you. Visible only to members of this cohort.</p></div>
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
    main.innerHTML = `<div class="page-head"><h1>Ask for help</h1><p>Questions about the program, your account, billing or resources. We reply here and email you a link.</p>
<p class="small muted">For a business challenge you’d like to bring to a live call, use Solutions Seat instead.</p></div>
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
  async function viewAccount(main) {
    const a = await SO.api('GET', 'account');
    let zones = [];
    try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* older browsers */ }
    const prefs = a.email_prefs || {};
    main.innerHTML = `<div class="page-head"><h1>Account</h1><p>Signed in as <strong>${esc(a.email)}</strong>.</p></div>
<form id="acct" class="card" novalidate>
  <div class="field"><label for="a-name">Display name</label><input id="a-name" type="text" maxlength="80" value="${esc(a.display_name || '')}"></div>
  <div class="field"><label for="a-tz">Your timezone</label><input id="a-tz" type="text" list="tz-list" value="${esc(a.timezone || SO.viewerTz())}">
  <datalist id="tz-list">${zones.map(z => `<option value="${esc(z)}">`).join('')}</datalist>
  <p class="help">Call times show in your device’s timezone, with cohort time alongside.</p></div>
  <fieldset style="border:0;padding:0;margin:0 0 1rem"><legend class="label">Optional reminder emails</legend>
  <p class="help" style="margin-top:0">Choose what you’d like to hear about. Reminder emails aren’t being sent yet; these choices apply once they start. Enrollment and account emails are always sent.</p>
  ${[['intros_open', 'When introductions open'], ['cohort_begins', 'When the cohort begins'], ['daily_content', 'When each day unlocks'], ['upcoming_calls', 'Before each Solutions Seat']].map(([k, l]) =>
      `<label class="check"><input type="checkbox" data-pref="${k}" ${prefs[k] ? 'checked' : ''}><span>${l}</span></label>`).join('')}</fieldset>
  <p id="acct-msg" role="status"></p>
  <button class="btn btn-primary" type="submit">Save</button>
</form>
<section class="card" style="margin-top:1rem"><h2 style="font-size:1.4rem">Your journal</h2><p>Download every reflection you’ve written as a text file.</p>
<button class="btn btn-secondary btn-sm" id="export">Download my journal</button></section>
<p style="margin-top:1.5rem"><button class="btn btn-ghost" data-signout>Sign out</button></p>`;
    wireSignout(main);
    q('#export', main).addEventListener('click', () => downloadBlob('journal/export', 'smooth-operators-journal.md').catch(e => alert(e.message)));
    q('#acct', main).addEventListener('submit', async e => {
      e.preventDefault();
      const out = q('#acct-msg', main);
      const email_prefs = {};
      qa('[data-pref]', main).forEach(c => { email_prefs[c.dataset.pref] = c.checked; });
      try {
        await SO.api('PUT', 'account', { display_name: q('#a-name', main).value, timezone: q('#a-tz', main).value.trim() || null, email_prefs });
        out.className = 'notice notice-success'; out.textContent = 'Saved.';
        if (state.me) state.me.display_name = q('#a-name', main).value;
      } catch (ex) { out.className = 'notice notice-error'; out.textContent = ex.message; }
    });
    return 'Account';
  }

  // ------------------------------------------------------------- start
  SO.auth().then(client => {
    if (client) client.auth.onAuthStateChange(evt => { if (evt === 'SIGNED_OUT') state.me = null; });
    render();
  });
})();
