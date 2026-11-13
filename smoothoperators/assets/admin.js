/* Smooth Operators — admin workspace. Uses the existing omibell.com admin
   password login (/api/admin-login). Every action is authorized again on the
   server; nothing here is trusted. Journal text is never shown. */
(function () {
  'use strict';
  const SO = window.SO;
  const esc = SO.esc;
  const root = document.getElementById('admin-root');
  const TOKEN_KEY = 'ob_admin_token';
  // Seven primary sections; some have sub-sections (#section/sub/arg).
  const SECTIONS = [
    ['overview', 'Overview'], ['members', 'Members'], ['sales', 'Sales'], ['program', 'Program'],
    ['seat', 'Solutions Seat'], ['progress', 'Progress'], ['settings', 'Emails & Settings'],
  ];
  const SUBS = {
    members: [['all', 'All members'], ['leads', 'Started checkout'], ['intros', 'Introductions']],
    sales: [['summary', 'Sales'], ['access', 'Payments & access tools']],
    program: [['days', '21 days'], ['announcements', 'Announcements'], ['resources', 'Resources'], ['preview', 'Preview']],
    seat: [['sessions', 'Sessions'], ['challenges', 'Challenges'], ['prep', 'Session prep']],
    settings: [['questions', 'Questions'], ['emails', 'Email log'], ['templates', 'Templates & reminders'], ['cohort', 'Cohort settings'],
      ['content', 'Site content & FAQs'], ['readiness', 'Launch readiness'], ['staff', 'Staff'], ['log', 'Audit log']],
  };
  let ARG = null;
  let ME = { perms: [] };
  let COHORT = null;
  const canDo = perm => ME.perms.includes(perm);
  const q = (s, el = document) => el.querySelector(s);
  const qa = (s, el = document) => Array.from(el.querySelectorAll(s));
  const token = () => { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } };
  let cohortTz = 'America/Los_Angeles';

  async function api(method, path, body) {
    if (COHORT && COHORT.id && path.startsWith('admin/') && path !== 'admin/cohorts') path += `${path.includes('?') ? '&' : '?'}cohort=${encodeURIComponent(COHORT.id)}`;
    const res = await fetch(`/api/so/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token()}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).catch(() => { throw new Error('Network error. Check your connection.'); });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) { if (path.startsWith('admin/')) { showLogin('Your admin session ended. Please log in again.'); } }
    if (!res.ok) { const e = new Error(data.message || 'Request failed'); e.status = res.status; e.data = data; throw e; }
    return data;
  }
  const money = c => (c == null ? '—' : SO.money(c));
  const dt = iso => (iso ? SO.fmtDateTime(iso, cohortTz) : '—');
  const val = (el, sel) => q(sel, el).value;
  const flash = (el, msg, ok = true) => { el.innerHTML = `<div class="notice ${ok ? 'notice-success' : 'notice-error'}" role="${ok ? 'status' : 'alert'}"><p>${esc(msg)}</p></div>`; };

  // --------------------------------------------------------------- login
  function showLogin(msg) {
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
    root.innerHTML = `<main id="admin-main" class="main" style="max-width:440px">
<h1>Smooth Operators admin</h1><p class="muted">Log in with the omibell.com admin password.</p>
${msg ? `<div class="notice notice-warn"><p>${esc(msg)}</p></div>` : ''}
<form id="login"><div class="field"><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required></div>
<p class="form-error" id="err" role="alert"></p><button class="btn btn-primary">Log in</button></form>
<p class="small muted" style="margin-top:1rem">Forgot it? Use “Forgot password?” on <a href="/admin">/admin</a>.</p></main>`;
    q('#login').addEventListener('submit', async e => {
      e.preventDefault();
      const r = await fetch('/api/admin-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: q('#pw').value }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { q('#err').textContent = d.error || 'Login failed.'; return; }
      sessionStorage.setItem(TOKEN_KEY, d.token);
      route();
    });
  }

  // --------------------------------------------------------------- shell
  function parts() { return location.hash.replace(/^#/, '').split('/'); }
  function hashArg() { return ARG; }
  async function route() {
    if (!token()) return showLogin();
    const [sec0, sub0, ...rest] = parts();
    const s = SECTIONS.some(x => x[0] === sec0) ? sec0 : 'overview';
    const subs = SUBS[s];
    let sub = subs ? (subs.some(x => x[0] === sub0) ? sub0 : subs[0][0]) : null;
    // Legacy filters like #sales/refunds land on the sales summary with that filter.
    if (s === 'sales' && sub0 && !subs.some(x => x[0] === sub0)) sub = 'summary';
    ARG = subs ? (rest.join('/') || (s === 'sales' && sub === 'summary' && sub0 !== 'summary' ? sub0 : null)) : (sub0 || null);
    if (!COHORT) {
      try {
        const c = await api('GET', 'admin/cohorts');
        ME = c.me;
        let saved = null; try { saved = sessionStorage.getItem('so_admin_cohort'); } catch { /* ignore */ }
        COHORT = { list: c.cohorts, id: (c.cohorts.find(x => x.id === saved) || c.cohorts[0] || {}).id };
      } catch (e) { if (!token()) return; COHORT = { list: [], id: null }; }
    }
    root.innerHTML = `<header class="admin-top"><span class="wordmark">Smooth Operators · Admin</span>
<div class="row">${COHORT.list.length > 1 ? `<label class="small" for="cohort-pick">Cohort</label><select id="cohort-pick" style="min-height:40px;width:auto">${COHORT.list.map(c => `<option value="${c.id}"${c.id === COHORT.id ? ' selected' : ''}>${esc(c.name)} (${esc(String(c.start_date).slice(0, 10))})</option>`).join('')}</select>` : COHORT.list[0] ? `<span class="small muted">${esc(COHORT.list[0].name)}</span>` : ''}
<a href="/admin">← Omi Bell admin</a><a href="/smoothoperators" target="_blank" rel="noopener">View site</a><button class="btn btn-ghost btn-sm" id="logout">Log out</button></div></header>
<nav class="admin-nav" aria-label="Admin sections">${SECTIONS.map(([k, l]) => `<a href="#${k}"${k === s ? ' aria-current="page"' : ''}>${l}${k === 'settings' && NEWQ ? ` <span class="pill pill-live">${NEWQ}</span>` : ''}</a>`).join('')}</nav>
${subs ? `<nav class="admin-subnav" aria-label="${esc(SECTIONS.find(x => x[0] === s)[1])}">${subs.map(([k, l]) => `<a href="#${s}/${k}"${k === sub ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav>` : ''}
<main id="admin-main" class="admin-main" tabindex="-1"><p class="loading">Loading…</p></main>`;
    q('#logout').addEventListener('click', () => { sessionStorage.removeItem(TOKEN_KEY); COHORT = null; showLogin(); });
    const pick = q('#cohort-pick');
    if (pick) pick.addEventListener('change', () => { COHORT.id = pick.value; try { sessionStorage.setItem('so_admin_cohort', pick.value); } catch { /* ignore */ } route(); });
    const main = q('#admin-main');
    const view = VIEWS[subs ? (s === 'members' && sub !== 'intros' && sub !== 'leads' ? 'members' : sub === 'summary' ? 'sales' : sub === 'sessions' ? 'calls' : sub) : s];
    if (s === 'members' && sub !== 'intros' && sub !== 'leads') ARG = sub;
    try { await view(main); } catch (e) { if (token()) main.innerHTML = `<div class="notice notice-error" role="alert"><p>${esc(e.message)}</p><button class="btn btn-secondary btn-sm" onclick="location.reload()">Try again</button></div>`; }
  }
  let NEWQ = 0;
  window.addEventListener('hashchange', () => { if (!q('dialog[open]')) route(); });

  const VIEWS = {};

  // ------------------------------------------------------------ overview
  VIEWS.readiness = async main => {
    const o = await api('GET', 'admin/overview');
    const c = await api('GET', 'admin/cohort');
    cohortTz = c.cohort.timezone;
    const cfg = o.config;
    const alerts = o.content_release.days.filter(d => d.alert);
    const enr = o.enrollments.reduce((a, r) => { a[r.is_test ? 'test' : r.access_state] = (a[r.is_test ? 'test' : r.access_state] || 0) + r.n; return a; }, {});
    main.innerHTML = `<h1>Launch readiness</h1>
<p class="muted">Server time ${esc(dt(o.now))} · Phase: <strong>${esc(o.phase.replace('_', ' '))}</strong>${o.current_day ? ` · Day ${o.current_day}` : ''} · Current price <strong>${money(o.price.amount_cents)}</strong> (${esc(o.price.tier)})</p>
${o.sales.test_mode ? '<div class="notice notice-warn"><p><strong>Stripe is in TEST mode.</strong> Checkouts use test cards and create test enrollments.</p></div>' : ''}
${alerts.length ? `<div class="notice notice-error"><p><strong>${alerts.length} day(s) unlock within 7 days and aren’t ready:</strong> ${alerts.map(d => `Day ${d.day_number}`).join(', ')}.</p></div>` : ''}
${o.pending_reviews ? `<div class="notice notice-warn"><p><strong>${o.pending_reviews} paid member(s) waiting for your review.</strong> <a href="#members/awaiting">Review fit checks</a></p></div>` : ''}
${o.needs_review ? `<div class="notice notice-warn"><p>${o.needs_review} purchase(s) need review. <a href="#sales/access">Payments & access</a></p></div>` : ''}
${o.failed_webhooks ? `<div class="notice notice-error"><p>${o.failed_webhooks} payment webhook(s) failed to process. <a href="#settings/log">See log</a></p></div>` : ''}
<div class="grid-3">
  <div class="card"><p class="muted small">Seats (private)</p><p class="stat">${o.seats.taken}${o.seats.limit ? ` / ${o.seats.limit}` : ''}</p><p class="small muted">${o.seats.limit ? (o.seats.taken >= o.seats.limit ? 'Full: the site says “All seats are full.”' : `${o.seats.limit - o.seats.taken} left. The limit is never shown publicly.`) : 'No limit set.'}</p></div>
  <div class="card"><p class="muted small">Active enrollments</p><p class="stat">${enr.active || 0}</p><p class="small muted">${enr.test ? `${enr.test} test · ` : ''}${['refunded', 'suspended', 'disputed', 'revoked'].map(k => enr[k] ? `${enr[k]} ${k}` : '').filter(Boolean).join(' · ')}</p></div>
  <div class="card"><p class="muted small">Live revenue (confirmed)</p><p class="stat">${money(o.live_revenue_cents)}</p></div>
  <div class="card"><p class="muted small">Funnel</p><p class="small" style="margin:0">CTA clicks ${o.funnel.landing_cta_clicked || 0} · Checkouts ${o.funnel.checkout_started || 0} · Paid ${o.funnel.payment_confirmed || 0}<br>Welcome views ${o.funnel.welcome_viewed || 0} · Days opened ${o.funnel.day_opened || 0} · Completed ${o.funnel.day_completed || 0}<br>Resources opened ${o.funnel.resource_opened || 0} · Call link clicks ${o.funnel.call_link_clicked || 0}</p></div>
</div>
<div class="grid-2" style="margin-top:1rem">
<section class="card"><h2 style="margin-top:0">Blocks live sales</h2>
${o.sales.blockers.length ? `<ul class="checklist-admin">${o.sales.blockers.map(b => `<li>${esc(b.label)}</li>`).join('')}</ul>` : '<p class="notice notice-success">Everything required for live sales is in place.</p>'}
<p class="small muted" style="margin-top:.75rem">Checkout available now: <strong>${o.sales.can_checkout ? 'yes' : 'no'}</strong> (${esc(o.sales.mode)})</p>
${!o.sales.can_checkout && o.sales.reason === 'not_yet_open' ? `<p class="notice notice-warn small">Checkout is off because enrollment hasn’t opened yet: it opens ${esc(dt(o.sales.window.opens_at))}. To open it now, clear “Enrollment opens” in <a href="#settings/cohort">Cohort settings</a> and save.</p>` : ''}
${!o.sales.can_checkout && o.sales.reason === 'enrollment_closed' ? `<p class="notice notice-warn small">Checkout is off because enrollment closed ${esc(dt(o.sales.window.closes_at))}. To reopen it, clear or change “Enrollment closes” in <a href="#settings/cohort">Cohort settings</a> and save.</p>` : ''}
${!o.sales.can_checkout && o.sales.reason === 'not_ready' && !o.sales.blockers.length ? '<p class="notice notice-warn small">Checkout is off even though the list is clear. Redeploy in Vercel so new settings take effect, then reload this page.</p>' : ''}</section>
<section class="card"><h2 style="margin-top:0">Configuration</h2><ul class="checklist-admin">
${[['Database', cfg.database], ['Supabase Auth', cfg.supabase_auth], ['Private storage', cfg.storage], [`Stripe key (${cfg.stripe_mode})`, ['live', 'test'].includes(cfg.stripe_mode)], ['Stripe webhook secret', cfg.stripe_webhook], [`Email delivery: ${cfg.email_mode}`, cfg.email_mode === 'live' && cfg.resend]]
      .map(([l, ok]) => `<li class="${ok ? 'ok' : ''}">${esc(l)}</li>`).join('')}</ul></section></div>
<section style="margin-top:1rem"><h2>Content release checklist</h2>
<p class="small muted">A member sees a day only when it is both <strong>unlocked by time</strong> and <strong>published</strong>. Completion counts never include anyone’s writing.</p>
<div class="table-wrap"><table class="data"><thead><tr><th>Day</th><th>Unlocks</th><th>Status</th><th>Started / Completed</th><th>Open items</th></tr></thead><tbody>
${o.content_release.days.map(d => `<tr><td><a href="#program/days/${d.day_number}">Day ${d.day_number}</a><br><span class="small muted">${esc(d.title)}</span></td><td class="small">${esc(dt(d.unlock_at))}</td>
<td><span class="pill ${d.status === 'published' ? 'pill-complete' : 'pill-draft'}">${d.status}</span>${d.is_sample ? ' <span class="pill pill-draft">sample</span>' : ''}</td><td>${d.started} / ${d.completed}</td>
<td class="small">${d.issues.length ? esc(d.issues.join(' · ')) : '<span style="color:var(--success)">Ready</span>'}</td></tr>`).join('')}
</tbody></table></div>
<p class="small muted">Scheduled calls: ${o.content_release.calls_scheduled} · Sample resources: ${o.content_release.sample_resources}</p></section>`;
  };

  // -------------------------------------------------------------- cohort
  VIEWS.cohort = async main => {
    const { cohort: c, weeks, stripe_mode } = await api('GET', 'admin/cohort');
    cohortTz = c.timezone;
    const f = (id, label, input, help) => `<div class="field"><label for="${id}">${label}</label>${input}${help ? `<p class="help">${help}</p>` : ''}</div>`;
    const loc = (id, v) => `<input id="${id}" type="datetime-local" value="${esc(v || '')}">`;
    main.innerHTML = `<h1>Cohort settings</h1>
<p class="muted">Times below are in the cohort timezone. Changing dates, times, prices or access shows an impact preview before saving, and clears the owner confirmation until you confirm again.</p>
${c.settings_confirmed_at ? `<div class="notice notice-success"><p>Settings confirmed by ${esc(c.settings_confirmed_by)} on ${esc(dt(c.settings_confirmed_at))}.</p></div>` : '<div class="notice notice-warn"><p><strong>Not yet confirmed by the owner.</strong> The values below are the build brief’s recommended defaults until confirmed.</p></div>'}
<form id="cf" class="card">
<div class="grid-2">
${f('name', 'Cohort name', `<input id="name" type="text" value="${esc(c.name)}">`)}
${f('timezone', 'Cohort timezone (IANA)', `<input id="timezone" type="text" value="${esc(c.timezone)}">`, 'e.g. America/Los_Angeles')}
${f('start_date', 'Day 1 date', `<input id="start_date" type="date" value="${esc(c.start_date)}">`, `21 days: ends ${esc(c.end_date)}`)}
${f('unlock_time', 'Daily unlock time', `<input id="unlock_time" type="time" value="${esc(c.unlock_time)}">`)}
${f('intro_opens_local', 'Introductions open', loc('intro_opens_local', c.intro_opens_local))}
${f('enrollment_opens_local', 'Enrollment opens (blank = open now)', loc('enrollment_opens_local', c.enrollment_opens_local))}
${f('enrollment_closes_local', 'Enrollment closes (blank = when the cohort ends)', loc('enrollment_closes_local', c.enrollment_closes_local), 'Late entry: members who join during the cohort see the current day and every earlier released day.')}
${f('price_cutoff_local', 'Introductory price ends', loc('price_cutoff_local', c.price_cutoff_local), 'The intro price applies to checkouts started before this moment.')}
${f('regular', 'Regular price (USD)', `<input id="regular" type="number" min="1" step="1" value="${c.regular_price_cents / 100}">`)}
${f('intro', 'Introductory price (USD, blank = none)', `<input id="intro" type="number" min="1" step="1" value="${c.intro_price_cents ? c.intro_price_cents / 100 : ''}">`)}
${f('ttl', 'Checkout session expiry (minutes)', `<input id="ttl" type="number" min="30" max="1440" value="${c.checkout_ttl_minutes}">`, 'An open checkout keeps its quoted price until it expires (30–1440 minutes, enforced by Stripe). New checkouts after the cutoff use the regular price.')}
${f('seat_limit', 'Seat limit (private; blank = no limit)', `<input id="seat_limit" type="number" min="1" value="${c.seat_limit || ''}">`, 'Never shown publicly. When it’s reached, the site just says “All seats are full.”')}
${f('join', 'Default call join window (minutes before start)', `<input id="join" type="number" min="0" max="240" value="${c.call_join_window_minutes}">`)}
${f('access_policy', 'Post-cohort access policy', `<select id="access_policy">${[['unset', 'Not decided yet (blocks live sales)'], ['until_date', 'Access until a date'], ['indefinite', 'No end date']].map(([v, l]) => `<option value="${v}"${c.access_policy === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`)}
${f('access_ends_local', 'Access ends (for “until a date”)', loc('access_ends_local', c.access_ends_local))}
${f('refund', 'On a full refund', `<select id="refund">${[['suspend', 'Suspend access (data kept)'], ['keep', 'Keep access']].map(([v, l]) => `<option value="${v}"${c.refund_access_action === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`)}
${f('dispute', 'While a payment is disputed', `<select id="dispute">${[['keep', 'Keep access, flag for review'], ['suspend', 'Suspend access (data kept)']].map(([v, l]) => `<option value="${v}"${c.dispute_access_action === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`)}
</div>
<label class="check"><input type="checkbox" id="sales"${c.sales_enabled ? ' checked' : ''}><span><strong>Sales switched on.</strong> Live checkout still stays off until every item on the Overview checklist is complete. (Stripe mode: ${esc(stripe_mode)})</span></label>
<div id="impact"></div>
<div class="row" style="margin-top:1rem"><button class="btn btn-secondary" type="button" id="preview-btn">Preview impact</button><button class="btn btn-primary" type="submit">Save</button>
<button class="btn btn-ghost" type="button" id="confirm-btn">Save and confirm as owner</button></div>
<div id="cmsg"></div></form>
<h2>Weeks</h2><div class="stack">${weeks.map(w => `<form class="card" data-week="${w.week_number}"><div class="grid-2">
<div class="field"><label>Week ${w.week_number} title</label><input type="text" name="title" value="${esc(w.title)}"></div>
<div class="field"><label>Pillar</label><select name="pillar">${['standards', 'systems', 'scorecards'].map(p => `<option${w.pillar === p ? ' selected' : ''}>${p}</option>`).join('')}</select></div></div>
<div class="field"><label>Weekly assignment</label><input type="text" name="assignment" value="${esc(w.assignment || '')}"></div>
<button class="btn btn-secondary btn-sm">Save week</button> <span data-msg></span></form>`).join('')}</div>`;
    const form = q('#cf');
    const payload = () => ({
      name: val(form, '#name'), timezone: val(form, '#timezone').trim(), start_date: val(form, '#start_date'), unlock_time: val(form, '#unlock_time'),
      intro_opens_local: val(form, '#intro_opens_local'), enrollment_opens_local: val(form, '#enrollment_opens_local'),
      enrollment_closes_local: val(form, '#enrollment_closes_local'), price_cutoff_local: val(form, '#price_cutoff_local'),
      regular_price_cents: Math.round(Number(val(form, '#regular')) * 100),
      intro_price_cents: val(form, '#intro') ? Math.round(Number(val(form, '#intro')) * 100) : null,
      checkout_ttl_minutes: Number(val(form, '#ttl')), call_join_window_minutes: Number(val(form, '#join')),
      access_policy: val(form, '#access_policy'), access_ends_local: val(form, '#access_ends_local'),
      seat_limit: val(form, '#seat_limit') ? Number(val(form, '#seat_limit')) : null,
      refund_access_action: val(form, '#refund'), dispute_access_action: val(form, '#dispute'), sales_enabled: q('#sales').checked,
    });
    const showImpact = async () => {
      const r = await api('POST', 'admin/cohort/preview', payload());
      q('#impact').innerHTML = `<h3 style="margin-top:1rem">Impact preview (not saved)</h3><div class="table-wrap"><table class="data impact"><thead><tr><th>What</th><th>Now</th><th>After saving</th></tr></thead><tbody>
${r.impact.rows.map(x => `<tr><td>${esc(x.label)}</td><td>${esc(x.label.includes('UTC') && x.before ? `${dt(x.before)}` : x.before)}</td><td class="${x.changed ? 'changed' : ''}">${esc(x.label.includes('UTC') && x.after ? dt(x.after) : x.after)}</td></tr>`).join('')}</tbody></table></div>
<ul class="small">${r.impact.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`;
      return r;
    };
    q('#preview-btn').addEventListener('click', () => showImpact().catch(e => flash(q('#cmsg'), e.message, false)));
    const save = async confirmSettings => {
      try {
        const r = await showImpact();
        if (r.impact.rows.some(x => x.changed) && !confirm('Save these changes? Review the impact preview above.')) return;
        const out = await api('PUT', 'admin/cohort', { ...payload(), ...(confirmSettings ? { confirm_settings: true } : {}) });
        flash(q('#cmsg'), out.timing_changed.length && !confirmSettings ? `Saved. Changed: ${out.timing_changed.join(', ')}. Owner confirmation was cleared.` : 'Saved.');
        setTimeout(() => VIEWS.cohort(main), 1200);
      } catch (e) { flash(q('#cmsg'), e.message, false); }
    };
    form.addEventListener('submit', e => { e.preventDefault(); save(false); });
    q('#confirm-btn').addEventListener('click', () => save(true));
    qa('[data-week]').forEach(wf => wf.addEventListener('submit', async e => {
      e.preventDefault();
      try {
        await api('PUT', `admin/weeks/${wf.dataset.week}`, { title: wf.title.value, pillar: wf.pillar.value, assignment: wf.assignment.value });
        q('[data-msg]', wf).textContent = 'Saved.';
      } catch (ex) { q('[data-msg]', wf).textContent = ex.message; }
    }));
  };

  // ---------------------------------------------------------------- days
  VIEWS.days = async main => {
    const n = hashArg();
    if (n) return dayEditor(main, n);
    const [{ days }, ov] = await Promise.all([api('GET', 'admin/days'), api('GET', 'admin/overview')]);
    const ready = new Map(ov.content_release.days.map(x => [x.day_number, x]));
    const weeks = [[1, 'Week 1 · Standards'], [2, 'Week 2 · Systems'], [3, 'Week 3 · Scorecards']];
    main.innerHTML = `<h1>21 days</h1><p class="muted">A day reaches members only when it is unlocked by date <strong>and</strong> published. Provisional days from the brief are marked <span class="pill pill-draft">sample</span>; review and mark them final first.</p>
${weeks.map(([w, label]) => `<h2>${label}</h2><div class="table-wrap"><table class="data"><thead><tr><th>Day</th><th>Title</th><th>Unlocks</th><th>Status</th><th>Readiness</th></tr></thead><tbody>
${days.filter(d => Math.ceil(d.day_number / 7) === w).map(d => { const r = ready.get(d.day_number) || { issues: [] }; return `<tr><td>${d.day_number}</td><td><a href="#program/days/${d.day_number}">${esc(d.title)}</a></td>
<td class="small">${esc(dt(r.unlock_at))}</td>
<td><span class="pill ${d.status === 'published' ? 'pill-complete' : 'pill-draft'}">${d.status}</span>${d.is_sample ? ' <span class="pill pill-draft">sample</span>' : ''}${d.publish_at ? `<br><span class="small">publishes ${esc(dt(d.publish_at))}</span>` : ''}</td>
<td class="small">${r.issues.length ? `${r.alert ? '<strong style="color:var(--danger)">Unlocks soon · </strong>' : ''}${esc(r.issues.join(' · '))}` : '<span style="color:var(--success)">Ready</span>'}</td></tr>`; }).join('')}</tbody></table></div>`).join('')}`;
  };

  async function dayEditor(main, n) {
    const [{ day: d }, { resources }] = await Promise.all([api('GET', `admin/days/${n}`), api('GET', 'admin/resources')]);
    const practice = d.links.find(l => l.role === 'practice');
    const others = d.links.filter(l => l.role !== 'practice').map(l => l.resource_id);
    const ta = (id, label, v, rows = 3, help = '') => `<div class="field"><label for="${id}">${label}</label><textarea id="${id}" rows="${rows}" style="min-height:${rows * 1.8}rem">${esc(v || '')}</textarea>${help ? `<p class="help">${help}</p>` : ''}</div>`;
    main.innerHTML = `<a class="back-link" href="#program/days">All days</a><h1>Day ${d.day_number}</h1>
${d.is_sample ? '<div class="notice notice-warn"><p>This is provisional sample content from the build brief. It is not owner-approved.</p></div>' : ''}
<form id="df" class="card">
<div class="field"><label for="title">Title</label><input id="title" type="text" value="${esc(d.title)}"></div>
<div class="field"><label for="purpose">One-sentence purpose</label><input id="purpose" type="text" value="${esc(d.purpose || '')}"></div>
${ta('preview_summary', 'Preview summary (shown on the calendar before the day unlocks, if approved)', d.preview_summary, 2)}
<label class="check"><input type="checkbox" id="preview_published"${d.preview_published ? ' checked' : ''}><span>Approve title and preview summary for locked-day previews</span></label>
${ta('content', 'Guidance (optional; blank lines separate paragraphs, lines starting with “- ” become a list)', d.content, 5)}
${ta('reflection_prompt', 'Reflection question', d.reflection_prompt, 2, `Version ${d.prompt_version}. Editing creates a new version; members who already answered keep the question they saw.`)}
<div class="field"><label for="action_title">Action heading</label><input id="action_title" type="text" value="${esc(d.action_title || '')}"></div>
${ta('action_body', 'Practical action', d.action_body, 4)}
<div class="field"><label for="practice">Guided practice</label><select id="practice"><option value="">None</option>
${resources.filter(r => r.kind === 'practice').map(r => `<option value="${r.id}"${practice && practice.resource_id === r.id ? ' selected' : ''}>${esc(r.title)} (${r.status})</option>`).join('')}</select></div>
<fieldset class="field" style="border:0;padding:0"><legend class="label">Templates & supporting resources</legend>
${resources.filter(r => r.kind === 'template' || r.kind === 'other').map(r => `<label class="check"><input type="checkbox" data-res="${r.id}"${others.includes(r.id) ? ' checked' : ''}><span>${esc(r.title)} <span class="small muted">(${r.status}${r.pillar ? `, ${r.pillar}` : ''})</span></span></label>`).join('') || '<p class="small muted">No templates yet. Add them under Resources.</p>'}</fieldset>
<label class="check"><input type="checkbox" id="final"${!d.is_sample ? ' checked' : ''}><span><strong>Content reviewed and final</strong> (required before publishing)</span></label>
<div class="field"><label for="publish_local">Scheduled publish time (optional, cohort time)</label><input id="publish_local" type="datetime-local" value="${esc(d.publish_local || '')}">
<p class="help">With status Published, members see the day only once it has unlocked <em>and</em> this time has passed. Leave blank to publish as soon as it unlocks.</p></div>
<div class="field"><label for="status">Status</label><select id="status"><option value="draft"${d.status === 'draft' ? ' selected' : ''}>Draft (hidden from members)</option><option value="published"${d.status === 'published' ? ' selected' : ''}>Published (visible once unlocked)</option></select></div>
<div class="row"><button class="btn btn-primary">Save day</button><a href="#program/preview/day-${d.day_number}">Preview this day</a></div><div id="dmsg"></div></form>`;
    q('#df').addEventListener('submit', async e => {
      e.preventDefault();
      const f = q('#df');
      const links = [];
      if (val(f, '#practice')) links.push({ resource_id: val(f, '#practice'), role: 'practice' });
      qa('[data-res]', f).filter(c => c.checked).forEach(c => {
        const r = resources.find(x => x.id === c.dataset.res);
        links.push({ resource_id: c.dataset.res, role: r.kind === 'template' ? 'template' : 'supporting' });
      });
      try {
        await api('PUT', `admin/days/${n}`, {
          title: val(f, '#title'), purpose: val(f, '#purpose'), preview_summary: val(f, '#preview_summary'), content: val(f, '#content'),
          reflection_prompt: val(f, '#reflection_prompt'), action_title: val(f, '#action_title'), action_body: val(f, '#action_body'),
          preview_published: q('#preview_published').checked, is_sample: !q('#final').checked, status: val(f, '#status'), links,
          publish_local: val(f, '#publish_local'),
        });
        flash(q('#dmsg'), 'Saved.');
      } catch (ex) { flash(q('#dmsg'), ex.message, false); }
    });
  }

  // ----------------------------------------------------------- resources
  VIEWS.resources = async main => {
    const { resources } = await api('GET', 'admin/resources');
    const id = hashArg();
    const r = id === 'new' ? { kind: 'template', source_type: 'file', status: 'draft', release_mode: 'with_day' } : resources.find(x => x.id === id);
    if (r) return resourceEditor(main, r, id === 'new');
    main.innerHTML = `<div class="row-between"><h1>Resources</h1><a class="btn btn-primary" href="#program/resources/new">Add resource</a></div>
<p class="muted">Toolkit templates, guided practices, and call replays. Files stay private; members only ever get short-lived links, and only once a resource is published and released.</p>
<div class="table-wrap"><table class="data"><thead><tr><th>Title</th><th>Type</th><th>Source</th><th>Status</th><th>Days</th></tr></thead><tbody>
${resources.length ? resources.map(x => `<tr><td><a href="#program/resources/${x.id}">${esc(x.title)}</a></td><td>${x.kind}${x.practice_type ? ` · ${x.practice_type}` : ''}</td>
<td>${x.source_type === 'link' ? 'Link' : x.has_file ? `${esc(x.file_kind)} v${x.version}` : '<span style="color:var(--danger)">No file</span>'}</td>
<td><span class="pill ${x.status === 'published' ? 'pill-complete' : 'pill-draft'}">${x.status}</span></td><td>${x.links.map(l => l.day_number).join(', ') || '—'}</td></tr>`).join('') : '<tr><td colspan="5">No resources yet.</td></tr>'}</tbody></table></div>`;
  };

  function resourceEditor(main, r, isNew) {
    const opt = (v, cur, l) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l || v}</option>`;
    main.innerHTML = `<a class="back-link" href="#program/resources">All resources</a><h1>${isNew ? 'Add resource' : esc(r.title)}</h1>
<form id="rf" class="card"><div class="grid-2">
<div class="field"><label for="kind">Type</label><select id="kind">${['template', 'practice', 'replay', 'other'].map(k => opt(k, r.kind)).join('')}</select></div>
<div class="field"><label for="source">Source</label><select id="source">${opt('file', r.source_type, 'Uploaded file')}${opt('link', r.source_type, 'External link')}</select></div></div>
<div class="field"><label for="title">Title</label><input id="title" type="text" value="${esc(r.title || '')}"></div>
<div class="field"><label for="purpose">Short purpose</label><input id="purpose" type="text" value="${esc(r.purpose || '')}"></div>
<div class="field"><label for="description">Description</label><textarea id="description" style="min-height:5rem">${esc(r.description || '')}</textarea></div>
<div class="grid-2">
<div class="field"><label for="pillar">Pillar</label><select id="pillar">${opt('', r.pillar || '', 'None')}${['standards', 'systems', 'scorecards'].map(p => opt(p, r.pillar)).join('')}</select></div>
<div class="field"><label for="url">External link (https)</label><input id="url" type="url" value="${esc(r.external_url || '')}"></div>
<div class="field"><label for="ptype">Practice type</label><select id="ptype">${opt('', r.practice_type || '', '—')}${opt('breathwork', r.practice_type)}${opt('meditation', r.practice_type)}${opt('sound_healing', r.practice_type, 'sound healing')}</select></div>
<div class="field"><label for="dur">Duration (seconds)</label><input id="dur" type="number" min="0" value="${r.duration_seconds || ''}"></div>
<div class="field"><label for="release">Release</label><select id="release">${opt('with_day', r.release_mode, 'With its linked day')}${opt('at_time', r.release_mode, 'At a set time')}${opt('immediately', r.release_mode, 'Immediately to enrolled members')}</select></div>
<div class="field"><label for="release_at">Release time (for “at a set time”)</label><input id="release_at" type="datetime-local" value="${r.release_at ? esc(new Date(r.release_at).toISOString().slice(0, 16)) : ''}"><p class="help">Entered in your browser’s timezone.</p></div></div>
<div class="field"><label for="transcript">Transcript (required to publish a practice)</label><textarea id="transcript" style="min-height:7rem">${esc(r.transcript || '')}</textarea></div>
<label class="check"><input type="checkbox" id="sample"${r.is_sample ? ' checked' : ''}><span>Sample placeholder (can’t be published)</span></label>
<div class="field"><label for="publish_local">Scheduled publish time (optional, cohort time)</label><input id="publish_local" type="datetime-local" value="${esc(d.publish_local || '')}">
<p class="help">With status Published, members see the day only once it has unlocked <em>and</em> this time has passed. Leave blank to publish as soon as it unlocks.</p></div>
<div class="field"><label for="status">Status</label><select id="status">${opt('draft', r.status, 'Draft')}${opt('published', r.status, 'Published')}</select></div>
<div class="row"><button class="btn btn-primary">${isNew ? 'Create' : 'Save'}</button>${isNew ? '' : '<button type="button" class="btn btn-danger btn-sm" id="del">Delete</button>'}</div><div id="rmsg"></div></form>
${isNew ? '' : `<section class="card" style="margin-top:1rem"><h2 style="margin-top:0">File</h2>
<p>${r.has_file ? `Current: ${esc(r.file_name)} · ${esc(r.file_kind)} · version ${r.version} <button class="linklike" id="dl">Open</button>` : 'No file uploaded yet.'}</p>
<p class="small muted">Replacing the file keeps the same resource, so every day that links to it updates automatically.</p>
<input type="file" id="file"> <button class="btn btn-secondary btn-sm" id="up">Upload${r.has_file ? ' replacement' : ''}</button><p id="umsg" role="status"></p></section>`}`;
    const f = q('#rf');
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const relAt = val(f, '#release_at');
      const body = {
        kind: val(f, '#kind'), source_type: val(f, '#source'), title: val(f, '#title'), purpose: val(f, '#purpose'), description: val(f, '#description'),
        pillar: val(f, '#pillar') || null, external_url: val(f, '#url'), practice_type: val(f, '#ptype') || null,
        duration_seconds: val(f, '#dur') ? Number(val(f, '#dur')) : null, release_mode: val(f, '#release'),
        release_at: relAt ? new Date(relAt).toISOString() : null, transcript: val(f, '#transcript'), is_sample: q('#sample').checked, status: val(f, '#status'),
      };
      try {
        const out = isNew ? await api('POST', 'admin/resources', body) : await api('PUT', `admin/resources/${r.id}`, body);
        if (isNew) location.hash = `#program/resources/${out.resource.id}`; else flash(q('#rmsg'), 'Saved.');
      } catch (ex) { flash(q('#rmsg'), ex.message, false); }
    });
    if (isNew) return;
    q('#del').addEventListener('click', async () => {
      if (!confirm('Delete this resource and its file? Days that link to it will lose the link.')) return;
      try { await api('DELETE', `admin/resources/${r.id}`); location.hash = '#program/resources'; } catch (ex) { flash(q('#rmsg'), ex.message, false); }
    });
    const dl = q('#dl');
    if (dl) dl.addEventListener('click', async () => { const x = await api('GET', `admin/resources/${r.id}/access`); window.open(x.url, '_blank', 'noopener'); });
    q('#up').addEventListener('click', async () => {
      const file = q('#file').files[0];
      const msg = q('#umsg');
      if (!file) { msg.textContent = 'Choose a file first.'; return; }
      msg.textContent = 'Uploading…';
      try {
        const u = await api('POST', `admin/resources/${r.id}/upload-url`, { file_name: file.name, mime_type: file.type, size: file.size });
        const put = await fetch(u.upload_url, { method: 'PUT', headers: { 'Content-Type': file.type, 'x-upsert': 'false' }, body: file });
        if (!put.ok) throw new Error('The upload failed. Please try again.');
        await api('POST', `admin/resources/${r.id}/file`, { storage_path: u.storage_path, file_name: file.name, mime_type: file.type, size: file.size });
        msg.textContent = 'Uploaded.';
        setTimeout(() => VIEWS.resources(main), 800);
      } catch (ex) { msg.textContent = ex.message; }
    });
  }

  // ---------------------------------------------------------------- calls
  VIEWS.calls = async main => {
    const [{ calls, timezone }, { resources }] = await Promise.all([api('GET', 'admin/calls'), api('GET', 'admin/resources')]);
    cohortTz = timezone;
    const replays = resources.filter(r => r.kind === 'replay');
    const form = (c = {}) => `<form class="card" data-call="${c.id || ''}"><div class="grid-2">
<div class="field"><label>Title</label><input name="title" type="text" value="${esc(c.title || 'Solutions Seat')}"></div>
<div class="field"><label>Starts (cohort time, ${esc(timezone)})</label><input name="starts_local" type="datetime-local" value="${esc(c.starts_local || '')}" required></div>
<div class="field"><label>Duration (minutes)</label><input name="duration" type="number" min="5" value="${c.duration_minutes || 60}"></div>
<div class="field"><label>Join window (minutes before; blank = default)</label><input name="join" type="number" min="0" value="${c.join_window_minutes ?? ''}"></div>
<div class="field"><label>Meeting link (https)</label><input name="url" type="url" value="${esc(c.meeting_url || '')}"></div>
<div class="field"><label>Status</label><select name="status">${['draft', 'scheduled', 'canceled'].map(s => `<option${(c.status || 'draft') === s ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
<div class="field"><label>Replay</label><select name="replay"><option value="">None</option>${replays.map(r => `<option value="${r.id}"${c.replay_resource_id === r.id ? ' selected' : ''}>${esc(r.title)} (${r.status})</option>`).join('')}</select></div>
<label class="check" style="align-self:end"><input type="checkbox" name="replay_pub"${c.replay_published ? ' checked' : ''}><span>Publish replay to members</span></label></div>
<div class="field"><label>Description</label><textarea name="desc" style="min-height:4rem">${esc(c.description || '')}</textarea></div>
<div class="row"><button class="btn btn-primary btn-sm">${c.id ? 'Save' : 'Add call'}</button>${c.id ? '<button type="button" class="btn btn-danger btn-sm" data-del>Delete</button>' : ''}<span data-msg></span></div></form>`;
    main.innerHTML = `<h1>Solutions Seat sessions</h1><p class="muted">The member home banner and Calls & Help use these same records. Members see “scheduled” calls only. Meeting links are handed out only inside the join window. Only add dates Omi has confirmed.</p>
<div class="stack">${calls.map(form).join('')}<h2>Add a call</h2>${form()}</div>
<p class="small muted">Challenge submissions are under <a href="#seat/challenges">Challenges</a>.</p>`;
    qa('[data-call]', main).forEach(f => {
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const body = {
          title: f.title.value, starts_local: f.starts_local.value, duration_minutes: Number(f.duration.value), join_window_minutes: f.join.value === '' ? null : Number(f.join.value),
          meeting_url: f.url.value, status: f.status.value, replay_resource_id: f.replay.value || null, replay_published: f.replay_pub.checked, description: f.desc.value,
        };
        try {
          if (f.dataset.call) await api('PUT', `admin/calls/${f.dataset.call}`, body); else await api('POST', 'admin/calls', body);
          VIEWS.calls(main);
        } catch (ex) { q('[data-msg]', f).textContent = ex.message; }
      });
      const del = q('[data-del]', f);
      if (del) del.addEventListener('click', async () => { if (confirm('Delete this call?')) { await api('DELETE', `admin/calls/${f.dataset.call}`); VIEWS.calls(main); } });
    });
  };

  // -------------------------------------------------------------- members
  VIEWS.access = async main => {
    const [{ enrollments }, { purchases }, { cohort }] = await Promise.all([api('GET', 'admin/enrollments'), api('GET', 'admin/purchases'), api('GET', 'admin/cohort')]);
    cohortTz = cohort.timezone;
    main.innerHTML = `<h1>Payments & access</h1><p class="muted">Completion counts only. Members’ journals are private and are not available here.</p>
<div class="table-wrap"><table class="data"><thead><tr><th>Member</th><th>Access</th><th>Payment</th><th>Days complete</th><th>Intro</th><th></th></tr></thead><tbody>
${enrollments.length ? enrollments.map(e => `<tr><td>${esc(e.display_name || '')}<br><span class="small">${esc(e.email)}</span>${e.is_test ? ' <span class="pill pill-draft">test</span>' : ''}</td>
<td><select data-state="${e.id}">${['active', 'suspended', 'refunded', 'disputed', 'revoked'].map(s => `<option${e.access_state === s ? ' selected' : ''}>${s}</option>`).join('')}</select>
${e.access_ends_at ? `<br><span class="small">ends ${esc(dt(e.access_ends_at))}</span>` : ''}${e.admin_note ? `<br><span class="small muted">${esc(e.admin_note)}</span>` : ''}</td>
<td class="small">${e.source === 'manual' ? 'Manual grant' : `${esc(e.purchase_status || '—')} · ${money(e.amount_paid_cents)} ${esc(e.price_tier || '')}`}${e.needs_review ? `<br><strong style="color:var(--danger)">${esc(e.needs_review)}</strong>` : ''}</td>
<td>${e.days_completed}</td><td>${e.has_intro ? 'Yes' : '—'}</td><td class="small">${esc(dt(e.activated_at))}</td></tr>`).join('') : '<tr><td colspan="6">No enrollments yet.</td></tr>'}</tbody></table></div>
<section class="card" style="margin-top:1rem"><h2 style="margin-top:0">Grant access manually</h2><p class="small muted">For comps or support cases. The person must have signed in once at /smoothoperators/login. Recorded in the audit log.</p>
<form id="grant" class="grid-2"><div class="field"><label for="g-email">Email</label><input id="g-email" type="email" required></div>
<div class="field"><label for="g-note">Reason</label><input id="g-note" type="text" required></div><div><button class="btn btn-secondary btn-sm">Grant access</button> <span id="gmsg"></span></div></form></section>
<h2>Checkout attempts</h2><p class="small muted">“Check with Stripe” re-reads a checkout from Stripe and applies the result (use it if a webhook was missed).</p>
<div class="table-wrap"><table class="data"><thead><tr><th>Email</th><th>Status</th><th>Quote</th><th>Paid</th><th>Created</th><th></th></tr></thead><tbody>
${purchases.length ? purchases.map(p => `<tr><td>${esc(p.email)}</td><td>${esc(p.status)}${p.livemode === false ? ' <span class="pill pill-draft">test</span>' : ''}${p.needs_review ? `<br><strong style="color:var(--danger)">${esc(p.needs_review)}</strong>` : ''}</td>
<td>${money(p.amount_cents)} ${esc(p.price_tier)}</td><td>${money(p.amount_paid_cents)}</td><td class="small">${esc(dt(p.created_at))}</td>
<td>${p.has_session ? `<button class="btn btn-ghost btn-sm" data-rec="${p.id}">Check with Stripe</button>` : ''}</td></tr>`).join('') : '<tr><td colspan="6">None yet.</td></tr>'}</tbody></table></div>`;
    qa('[data-state]', main).forEach(s => s.addEventListener('change', async () => {
      const note = prompt('Reason for this change (saved to the audit log):');
      if (note === null) { VIEWS.members(main); return; }
      try { await api('PUT', `admin/enrollments/${s.dataset.state}`, { access_state: s.value, admin_note: note }); } catch (e) { alert(e.message); }
      VIEWS.members(main);
    }));
    qa('[data-rec]', main).forEach(b => b.addEventListener('click', async () => {
      try { const r = await api('POST', `admin/purchases/${b.dataset.rec}/reconcile`); alert(`Stripe: ${r.provider.status} / ${r.provider.payment_status}. Our record: ${r.status}.`); VIEWS.members(main); }
      catch (e) { alert(e.message); }
    }));
    q('#grant').addEventListener('submit', async e => {
      e.preventDefault();
      try { await api('POST', 'admin/enrollments/manual', { email: q('#g-email').value, note: q('#g-note').value }); VIEWS.members(main); }
      catch (ex) { q('#gmsg').textContent = ex.message; }
    });
  };

  // --------------------------------------------------------------- intros
  // Permanently remove a (test) person so their email can be used again.
  async function deleteMember(userId, email, onDone) {
    const typed = prompt(`Permanently delete ${email}?\n\nThis removes their account, enrollment, test payments, application and journal so the email can be used again. It can’t be undone. People with a real payment can’t be deleted.\n\nType their email to confirm:`);
    if (typed === null) return false;
    try {
      await api('POST', `admin/members/${userId}/delete`, { confirm_email: typed });
      alert(`${email} was deleted.`);
      if (onDone) onDone();
      return true;
    } catch (e) { alert(e.message); return false; }
  }

  VIEWS.leads = async main => {
    const d = await api('GET', 'admin/leads');
    const started = d.leads.filter(l => l.status === 'started');
    const status = l => l.status === 'paid' ? '<span class="pill pill-complete">Paid</span>'
      : l.unsubscribed_at ? '<span class="pill">Unsubscribed</span>'
      : l.reminder_sent_at ? `<span class="pill pill-progress">Reminder sent ${esc(shortDate(l.reminder_sent_at))}</span>` : '<span class="pill pill-draft">Not paid</span>';
    main.innerHTML = `<div class="row-between"><h1>Started checkout <span class="muted" style="font-size:1.2rem">(${started.length} not paid)</span></h1>
${canDo('settings') ? `<button class="btn btn-secondary btn-sm" id="remind"${d.due ? '' : ' disabled'}>Send due reminders (${d.due})</button>` : ''}</div>
<p class="muted small">Everyone who filled in the form and continued to payment, saved even if they didn’t pay. People who haven’t paid after ${d.reminder_after_hours} hours get one reminder email with an unsubscribe link${d.cron_configured ? ', sent automatically each morning.' : '. <strong>Automatic sending is off until CRON_SECRET is set in Vercel</strong>; use the button meanwhile.'}</p>
<div id="lmsg" role="status"></div>
${d.leads.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Name</th><th>Contact</th><th>Business</th><th>Last checkout</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
${d.leads.map(l => `<tr><td>${l.user_id ? `<button class="linklike" data-open="${l.user_id}">${esc(l.name)}</button>` : esc(l.name)}</td><td class="small"><a href="mailto:${esc(l.email)}">${esc(l.email)}</a>${l.phone ? `<br>${esc(l.phone)}` : ''}${l.postal_code ? ` · ${esc(l.postal_code)}` : ''}</td><td class="small">${esc(l.business_name || '—')}${l.revenue_label ? `<br>${esc(l.revenue_label)} revenue` : ''}${l.years_label ? ` · ${esc(l.years_label)}` : ''}</td>
<td class="small">${esc(dt(l.last_checkout_at))}${l.checkout_count > 1 ? ` · ${l.checkout_count} tries` : ''}</td><td>${status(l)}</td><td>${l.user_id && canDo('settings') ? `<button class="btn btn-ghost btn-sm del-btn" data-del-member="${l.user_id}" data-email="${esc(l.email)}">Delete</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="empty">No one has started checkout yet.</p>'}`;
    qa('[data-open]', main).forEach(x => x.addEventListener('click', () => openMember(x.dataset.open, x, () => VIEWS.leads(main))));
    qa('[data-del-member]', main).forEach(x => x.addEventListener('click', () => deleteMember(x.dataset.delMember, x.dataset.email, () => VIEWS.leads(main))));
    const b = q('#remind');
    if (b) b.addEventListener('click', async () => {
      b.disabled = true;
      try { const r = await api('POST', 'admin/leads/remind'); await VIEWS.leads(main); flash(q('#lmsg'), `Sent ${r.sent} reminder${r.sent === 1 ? '' : 's'}.${r.reason ? ` (${r.reason.replace(/_/g, ' ')})` : ''}`, true); }
      catch (e) { flash(q('#lmsg'), e.message, false); b.disabled = false; }
    });
  };

  VIEWS.intros = async main => {
    const { introductions } = await api('GET', 'admin/introductions');
    main.innerHTML = `<h1>Introductions</h1><p class="muted">Hidden introductions stay visible to their author only.</p>
<div class="stack">${introductions.length ? introductions.map(i => `<article class="card"><div class="row-between"><div><h3 style="margin:0">${esc(i.preferred_name)} · ${esc(i.business_name)}</h3><p class="small muted">${esc(i.email)}</p></div>
<span class="pill ${i.moderation_state === 'visible' ? 'pill-complete' : 'pill-draft'}">${i.moderation_state}</span></div>
${i.photo_url ? `<img src="${esc(i.photo_url)}" alt="" width="64" height="64" style="border-radius:50%;object-fit:cover">` : ''}
<p>${esc(i.business_description)}</p><p class="small"><strong>Challenge:</strong> ${esc(i.operating_challenge)}</p>${i.website_url ? `<p class="small">${esc(i.website_url)}</p>` : ''}
<div class="row"><button class="btn btn-secondary btn-sm" data-mod="${i.id}" data-to="${i.moderation_state === 'visible' ? 'hidden' : 'visible'}">${i.moderation_state === 'visible' ? 'Hide' : 'Show'}</button>
<button class="btn btn-danger btn-sm" data-del="${i.id}">Delete</button></div></article>`).join('') : '<p class="empty">No introductions yet.</p>'}</div>`;
    qa('[data-mod]', main).forEach(b => b.addEventListener('click', async () => { await api('PUT', `admin/introductions/${b.dataset.mod}`, { moderation_state: b.dataset.to }); VIEWS.intros(main); }));
    qa('[data-del]', main).forEach(b => b.addEventListener('click', async () => { if (confirm('Delete this introduction?')) { await api('DELETE', `admin/introductions/${b.dataset.del}`); VIEWS.intros(main); } }));
  };

  // -------------------------------------------------------------- content
  VIEWS.content = async main => {
    const [{ content }, { faqs }] = await Promise.all([api('GET', 'admin/content'), api('GET', 'admin/faqs')]);
    const groups = [...new Set(content.map(c => c.group))];
    main.innerHTML = `<h1>Site content & FAQs</h1>
<p class="muted">Landing copy defaults come from the build brief. Publishing an edit replaces the default everywhere at once. Owner-only items (policies, support, bio extras) show nothing until published. Write plain text; blank lines separate paragraphs.</p>
${groups.map(g => `<h2>${esc(g)}</h2><div class="stack">${content.filter(c => c.group === g).map(c => {
      const current = c.value != null ? c.value : c.default;
      return `<form class="card" data-key="${esc(c.key)}"><div class="field"><label>${esc(c.label)} <span class="small muted kbd">${esc(c.key)}</span></label>
${c.multiline ? `<textarea name="v" style="min-height:6rem">${esc(current)}</textarea>` : `<input name="v" type="text" value="${esc(current)}">`}
<p class="help">${c.status ? `${c.status === 'published' ? 'Published' : 'Draft saved'}${c.updated_by ? ` by ${esc(c.updated_by)}` : ''}` : c.default ? 'Using the default from the brief.' : 'Not written yet.'}</p></div>
<div class="row"><button class="btn btn-secondary btn-sm" data-s="draft">Save draft</button><button class="btn btn-primary btn-sm" data-s="published">Publish</button>
${c.status ? '<button type="button" class="linklike" data-reset>Revert to default</button>' : ''}<span data-msg></span></div></form>`;
    }).join('')}</div>`).join('')}
<h2>FAQs</h2><p class="small muted">Only published FAQs with an approved answer appear. “Public” shows on the landing page; “members” shows in Calls & Help.</p>
<div class="stack">${[...faqs, {}].map(f => `<form class="card" data-faq="${f.id || ''}"><div class="field"><label>Question</label><input name="qn" type="text" value="${esc(f.question || '')}"></div>
<div class="field"><label>Approved answer</label><textarea name="an" style="min-height:4rem">${esc(f.answer || '')}</textarea></div>
<div class="grid-3"><div class="field"><label>Order</label><input name="sort" type="number" value="${f.sort || 0}"></div>
<div class="field"><label>Where</label><select name="aud">${['both', 'public', 'members'].map(a => `<option${(f.audience || 'both') === a ? ' selected' : ''}>${a}</option>`).join('')}</select></div>
<div class="field"><label>Status</label><select name="st">${['draft', 'published'].map(a => `<option${(f.status || 'draft') === a ? ' selected' : ''}>${a}</option>`).join('')}</select></div></div>
<div class="row"><button class="btn btn-secondary btn-sm">${f.id ? 'Save' : 'Add FAQ'}</button>${f.id ? '<button type="button" class="btn btn-danger btn-sm" data-del>Delete</button>' : ''}<span data-msg></span></div></form>`).join('')}</div>`;
    qa('[data-key]', main).forEach(f => {
      let status = 'draft';
      qa('[data-s]', f).forEach(b => b.addEventListener('click', () => { status = b.dataset.s; }));
      f.addEventListener('submit', async e => {
        e.preventDefault();
        try { await api('PUT', `admin/content/${encodeURIComponent(f.dataset.key)}`, { value: f.v.value, status }); q('[data-msg]', f).textContent = status === 'published' ? 'Published.' : 'Draft saved.'; }
        catch (ex) { q('[data-msg]', f).textContent = ex.message; }
      });
      const reset = q('[data-reset]', f);
      if (reset) reset.addEventListener('click', async () => { if (confirm('Revert to the default?')) { await api('DELETE', `admin/content/${encodeURIComponent(f.dataset.key)}`); VIEWS.content(main); } });
    });
    qa('[data-faq]', main).forEach(f => {
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const body = { question: f.qn.value, answer: f.an.value, sort: Number(f.sort.value), audience: f.aud.value, status: f.st.value };
        try { if (f.dataset.faq) await api('PUT', `admin/faqs/${f.dataset.faq}`, body); else await api('POST', 'admin/faqs', body); q('[data-msg]', f).textContent = 'Saved.'; if (!f.dataset.faq) VIEWS.content(main); }
        catch (ex) { q('[data-msg]', f).textContent = ex.message; }
      });
      const del = q('[data-del]', f);
      if (del) del.addEventListener('click', async () => { if (confirm('Delete this FAQ?')) { await api('DELETE', `admin/faqs/${f.dataset.faq}`); VIEWS.content(main); } });
    });
  };

  // -------------------------------------------------------------- preview
  VIEWS.preview = async main => {
    const { cohort } = await api('GET', 'admin/cohort');
    cohortTz = cohort.timezone;
    const arg = hashArg();
    const presetDay = arg && arg.startsWith('day-') ? Number(arg.slice(4)) : null;
    const pick = presetDay ? cohort.schedule.days[presetDay - 1].unlock_at : cohort.schedule.starts_at;
    const local = new Date(new Date(pick).getTime() + 3600000);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: cohort.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(local);
    const g = t => parts.find(x => x.type === t).value;
    const def = `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
    main.innerHTML = `<h1>Lifecycle preview</h1>
<div class="notice"><p>Preview what members would see at any moment. This uses a simulated clock on the server for this view only. It never changes billing, enrollments, or what real members see.</p></div>
<form id="pf" class="card"><div class="grid-3">
<div class="field"><label for="at">Moment (cohort time, ${esc(cohort.timezone)})</label><input id="at" type="datetime-local" value="${def}"></div>
<div class="field"><label for="view">View</label><select id="view"><option value="home">Today / home</option><option value="calendar">Calendar</option><option value="day"${presetDay ? ' selected' : ''}>A single day</option><option value="offer">Price & enrollment</option></select></div>
<div class="field"><label for="n">Day</label><input id="n" type="number" min="1" max="${cohort.days_count}" value="${presetDay || 1}"></div></div>
<label class="check"><input type="checkbox" id="drafts"${presetDay ? ' checked' : ''}><span>Show draft day content as if published (single day view)</span></label>
<div class="row" style="margin-top:.6rem">${[['pre_intros', 'Before introductions', cohort.intro_opens_at, -86400000], ['intros_open', 'Introductions open', cohort.intro_opens_at, 3600000], ['day1', 'Day 1', cohort.schedule.starts_at, 3600000], ['day21', 'Day 21', cohort.schedule.days.at(-1).unlock_at, 3600000], ['after', 'After the cohort', cohort.schedule.ends_at, 86400000]]
      .map(([k, l, iso, off]) => `<button type="button" class="btn btn-ghost btn-sm" data-jump="${new Date(new Date(iso).getTime() + off).toISOString()}">${l}</button>`).join('')}</div>
<button class="btn btn-primary" style="margin-top:.6rem">Preview</button></form><div id="out" style="margin-top:1rem"></div>`;
    const toLocalInput = iso => {
      const ps = new Intl.DateTimeFormat('en-CA', { timeZone: cohort.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
      const gg = t => ps.find(x => x.type === t).value;
      return `${gg('year')}-${gg('month')}-${gg('day')}T${gg('hour')}:${gg('minute')}`;
    };
    qa('[data-jump]', main).forEach(b => b.addEventListener('click', () => { q('#at').value = toLocalInput(b.dataset.jump); q('#pf').requestSubmit(); }));
    q('#pf').addEventListener('submit', async e => {
      e.preventDefault();
      // Convert the cohort-local moment to an instant: find the UTC time whose cohort-local rendering matches.
      const [d, t] = q('#at').value.split('T');
      let guess = Date.parse(`${d}T${t}:00Z`);
      for (let i = 0; i < 3; i++) { const shown = Date.parse(`${toLocalInput(new Date(guess).toISOString())}:00Z`); guess += Date.parse(`${d}T${t}:00Z`) - shown; }
      const at = new Date(guess).toISOString();
      const view = q('#view').value;
      const out = q('#out');
      try {
        const r = await api('GET', `admin/preview?view=${view}&at=${encodeURIComponent(at)}&n=${q('#n').value}${q('#drafts').checked ? '&drafts=1' : ''}`);
        out.innerHTML = renderPreview(r);
      } catch (ex) { flash(out, ex.message, false); }
    });
    if (presetDay) q('#pf').requestSubmit();
    function renderPreview(r) {
      const head = `<p class="muted">At ${esc(dt(r.at))}</p>`;
      if (r.view === 'offer') return `<div class="card">${head}<p>Phase: <strong>${esc(r.phase)}</strong></p><p>Price: <strong>${money(r.price.amount_cents)}</strong> (${esc(r.price.tier)})</p><p>Enrollment: ${r.window.open ? 'open' : esc(r.window.reason)}</p></div>`;
      if (r.view === 'calendar') return `<div class="card">${head}<div class="table-wrap"><table class="data"><thead><tr><th>Day</th><th>Members see</th><th>Status</th></tr></thead><tbody>${r.days.map(d => `<tr><td>${d.day_number}</td><td>${esc(d.title || '“Preview coming soon”')}</td><td>${esc(d.status)}</td></tr>`).join('')}</tbody></table></div></div>`;
      const dayHtml = d => {
        if (!d) return '<p>No day.</p>';
        if (d.state !== 'available') return `<p><strong>Day ${d.day_number}</strong>: members see ${d.state === 'locked' ? `a locked preview (“${esc(d.title || 'Preview coming soon')}”), unlocking ${esc(dt(d.unlock_at))}` : '“This day’s content is being prepared.”'}.</p>`;
        return `<p class="eyebrow">Day ${d.day_number} · ${esc(d.date)}${d.pillar_label ? ` · ${esc(d.pillar_label)}` : ''}</p><h2 style="margin-top:0">${esc(d.title)}</h2>${d.purpose ? `<p class="muted">${esc(d.purpose)}</p>` : ''}
${d.content ? SO.paras(d.content) : ''}<h3>Guided Audio</h3><p>${d.practice ? esc(d.practice.title) : '<em>No published audio</em>'}</p>
<h3>Leadership Journal Prompt</h3><p class="question">${esc(d.reflection_prompt || '')}</p><h3>Business Action Toolkit</h3>${SO.paras(d.action_body || '')}
${d.templates.length ? `<p>Templates: ${d.templates.map(t => esc(t.title)).join(', ')}</p>` : ''}${d.call ? `<p>Call banner: ${esc(dt(d.call.starts_at))}</p>` : ''}`;
      };
      if (r.view === 'day') return `<div class="card">${head}${r.draft_preview ? '<p class="notice notice-warn">Showing draft content. Members can’t see this yet.</p>' : ''}${dayHtml(r.day)}</div>`;
      const hm = r.home;
      const label = { pre_intros: 'Welcome + countdown; introductions teaser (no button)', intros_open: 'Welcome + countdown; “Introduce Yourself”', live: `Today = Day ${hm.current_day}`, complete: '“Keep what you’ve built in motion.” completion view' }[hm.phase];
      return `<div class="card">${head}<p>Home state: <strong>${esc(label)}</strong></p>${hm.next_call ? `<p>Next call banner: ${esc(dt(hm.next_call.starts_at))}</p>` : '<p>No call banner.</p>'}${hm.today ? dayHtml(hm.today) : ''}</div>`;
    }
  };

  // ------------------------------------------------------------------ log
  VIEWS.log = async main => {
    const [{ entries }, { events }] = await Promise.all([api('GET', 'admin/audit'), api('GET', 'admin/webhooks')]);
    main.innerHTML = `<h1>Audit log</h1><p class="muted">Price, schedule, access, publishing and payment changes.</p>
<div class="table-wrap"><table class="data"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Item</th></tr></thead><tbody>
${entries.map(e => `<tr><td class="small">${esc(dt(e.created_at))}</td><td>${esc(e.actor)}</td><td>${esc(e.action)}</td><td class="small">${esc(e.entity || '')} ${esc(e.entity_id || '')}</td></tr>`).join('') || '<tr><td colspan="4">Nothing yet.</td></tr>'}</tbody></table></div>
<h2>Payment webhooks</h2><div class="table-wrap"><table class="data"><thead><tr><th>Received</th><th>Type</th><th>Status</th><th>Attempts</th></tr></thead><tbody>
${events.map(e => `<tr><td class="small">${esc(dt(e.received_at))}</td><td>${esc(e.type)}</td><td>${esc(e.status)}${e.error ? ` · ${esc(e.error)}` : ''}</td><td>${e.attempts}</td></tr>`).join('') || '<tr><td colspan="4">None yet.</td></tr>'}</tbody></table></div>`;
  };

  // ================================================================ Overview
  VIEWS.overview = async main => {
    const o = await api('GET', 'admin/home');
    cohortTz = o.cohort.timezone;
    NEWQ = o.new_questions;
    const navQ = q('.admin-nav a[href="#settings"]');
    if (navQ && NEWQ && !navQ.querySelector('.pill')) navQ.insertAdjacentHTML('beforeend', ` <span class="pill pill-live">${NEWQ}</span>`);
    const c = o.cards;
    const card = (label, big, sub, link) => `<a class="card stat-card" href="${link}"><p class="muted small" style="margin:0">${label}</p><p class="stat" style="margin:.35rem 0">${big}</p><p class="small muted" style="margin:0">${sub}</p></a>`;
    main.innerHTML = `<h1>Overview</h1>
<p class="muted">${esc(o.cohort.name)} · ${esc(o.cohort.phase.replace('_', ' '))} · ${esc(dt(o.now))}${o.seats.limit ? ` · Seats ${o.seats.taken} of ${o.seats.limit} (private)` : ''}</p>
<div class="grid-4">
  ${c.sales ? card('Sales collected', money(c.sales.gross_cents), `${esc(c.sales.scope)}${c.sales.data === 'test' ? ' · test-mode data' : ''}`, '#sales') : card('Sales collected', '—', 'Your role doesn’t include finance', '#overview')}
  ${card('Enrolled members', c.paid_members.total, 'Enrolled automatically when payment succeeds.', '#members/all')}
  ${c.next_call ? card('Next Solutions Seat', esc(new Date(c.next_call.starts_at).toLocaleDateString('en-US', { timeZone: cohortTz, month: 'short', day: 'numeric' })), `${esc(SO.fmtTime(c.next_call.starts_at, cohortTz))} · ${c.next_call.challenges} challenge${c.next_call.challenges === 1 ? '' : 's'} submitted${c.next_call.unassigned_challenges ? ` (+${c.next_call.unassigned_challenges} for any call)` : ''}`, '#seat/prep/' + c.next_call.id)
        : card('Next Solutions Seat', '—', 'No call scheduled yet', '#seat/sessions')}
</div>
<section style="margin-top:1.5rem"><div class="row-between"><h2 style="margin:0">Needs your attention</h2>
<a class="btn btn-secondary btn-sm" href="#settings/questions">Questions${o.new_questions ? ` <span class="pill pill-live">${o.new_questions} new</span>` : ''}</a></div>
${o.attention.length ? `<ul class="attention">${o.attention.map(a => `<li class="${a.severity === 'high' ? 'high' : ''}"><a href="${a.link}"><span>${esc(a.text)}</span><span aria-hidden="true">→</span></a></li>`).join('')}</ul>`
        : '<p class="empty">Nothing needs your attention right now.</p>'}</section>`;
  };

  // ================================================================ Members
  const REVIEW_LABEL = { not_enrolled: 'Not enrolled', awaiting_submission: 'Awaiting info', pending: 'Awaiting review', approved: 'Approved', rejected: 'Rejected' };
  const reviewPill = r => `<span class="pill ${r === 'approved' ? 'pill-complete' : r === 'rejected' ? 'pill' : r === 'pending' ? 'pill-progress' : 'pill-upcoming'}">${REVIEW_LABEL[r] || r}</span>`;
  const infoPill = i => `<span class="pill ${i === 'submitted' ? 'pill-available' : 'pill-draft'}">${i === 'submitted' ? 'Submitted' : i === 'incomplete' ? 'Incomplete' : 'Not started'}</span>`;
  const payLabel = p => ({ not_paid: 'Not paid', manual: 'Manual grant', paid: 'Paid', refunded: 'Refunded', partially_refunded: 'Partly refunded', disputed: 'Disputed', pending: 'Pending', failed: 'Failed' }[p] || p);
  const shortDate = d => (d ? new Date(d).toLocaleDateString('en-US', { timeZone: cohortTz, month: 'short', day: 'numeric' }) : '—');

  VIEWS.members = async main => {
    const filter = ARG || 'all';
    const st = VIEWS.members.state = VIEWS.members.state && VIEWS.members.state.filter === filter ? VIEWS.members.state : { filter, q: '', pay: '', page: 1, sort: '' };
    const load = async () => {
      const qs = new URLSearchParams({ filter, page: st.page, ...(st.q ? { q: st.q } : {}), ...(st.pay ? { pay: st.pay } : {}), ...(st.sort ? { sort: st.sort } : {}) });
      return api('GET', `admin/members?${qs}`);
    };
    const d = await load();
    const titles = { all: 'All members' };
    main.innerHTML = `<div class="row-between"><h1>${titles[filter] || 'Members'} <span class="muted" style="font-size:1.2rem">(${d.counts[filter] ?? d.total})</span></h1>
${canDo('finance') ? '<button class="btn btn-secondary btn-sm" id="export">Download CSV</button>' : ''}</div>
<p class="muted small">Everyone who has paid is enrolled automatically. Journals are private and never shown here.</p>
<form id="mfilter" class="row" style="margin:1rem 0" role="search">
  <label class="sr-only" for="m-q">Search by name, business or email</label><input id="m-q" type="search" placeholder="Search name, business or email" value="${esc(st.q)}" style="max-width:20rem">
  <label class="sr-only" for="m-pay">Payment</label><select id="m-pay" style="width:auto">${[['', 'Any payment'], ['paid', 'Paid'], ['not_paid', 'Not paid'], ['manual', 'Manual grant'], ['refunded', 'Refunded'], ['partially_refunded', 'Partly refunded'], ['disputed', 'Disputed'], ['refund', 'Has a refund']].map(([v, l]) => `<option value="${v}"${st.pay === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
  <input type="hidden" id="m-sort" value="">
  <button class="btn btn-secondary btn-sm">Apply</button>
</form>
${d.members.length ? `<div class="table-wrap member-table"><table class="data"><thead><tr><th>Name</th><th>Business</th><th>Payment</th><th>Last active</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
${d.members.map(m => `<tr><td><button class="linklike" data-open="${m.user_id}">${esc(m.name)}</button><br><span class="small muted">${esc(m.email)}</span>${m.is_test ? ' <span class="pill pill-draft">test</span>' : ''}</td>
<td>${esc(m.business || '—')}</td>
<td class="small">${payLabel(m.payment_status)}${m.refund_status ? `<br>refund ${esc(m.refund_status)}` : ''}${m.needs_review ? `<br><strong style="color:var(--danger)">${esc(m.needs_review)}</strong>` : ''}</td>
<td class="small">${shortDate(m.last_active)}</td><td>${canDo('settings') ? `<button class="btn btn-ghost btn-sm del-btn" data-del-member="${m.user_id}" data-email="${esc(m.email)}">Delete</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
<ul class="member-cards">${d.members.map(m => `<li class="card"><button class="linklike" data-open="${m.user_id}" style="font-size:1.1rem">${esc(m.name)}</button>
<p class="small muted" style="margin:.2rem 0">${esc(m.business || '')}</p><div class="row"><span class="pill">${payLabel(m.payment_status)}</span></div>
<p class="small muted" style="margin:.4rem 0 0">Last active ${shortDate(m.last_active)}</p>${canDo('settings') ? `<button class="btn btn-ghost btn-sm del-btn" data-del-member="${m.user_id}" data-email="${esc(m.email)}">Delete</button>` : ''}</li>`).join('')}</ul>
${d.pages > 1 ? `<nav class="row" aria-label="Pages" style="margin-top:1rem"><button class="btn btn-ghost btn-sm" data-page="${d.page - 1}"${d.page <= 1 ? ' disabled' : ''}>Previous</button><span class="small">Page ${d.page} of ${d.pages}</span><button class="btn btn-ghost btn-sm" data-page="${d.page + 1}"${d.page >= d.pages ? ' disabled' : ''}>Next</button></nav>` : ''}`
      : '<p class="empty">No members match.</p>'}`;
    q('#mfilter').addEventListener('submit', e => { e.preventDefault(); st.q = q('#m-q').value.trim(); st.pay = q('#m-pay').value; st.sort = q('#m-sort').value; st.page = 1; VIEWS.members(main); });
    qa('[data-page]', main).forEach(b => b.addEventListener('click', () => { st.page = Number(b.dataset.page); VIEWS.members(main); }));
    qa('[data-open]', main).forEach(b => b.addEventListener('click', () => openMember(b.dataset.open, b, () => VIEWS.members(main))));
    qa('[data-del-member]', main).forEach(b => b.addEventListener('click', () => deleteMember(b.dataset.delMember, b.dataset.email, () => VIEWS.members(main))));
    const ex = q('#export');
    if (ex) ex.addEventListener('click', () => downloadCsv(`admin/members/export?filter=${filter}`, 'smooth-operators-members.csv'));
  };

  async function downloadCsv(path, name) {
    if (COHORT && COHORT.id) path += `${path.includes('?') ? '&' : '?'}cohort=${COHORT.id}`;
    const res = await fetch(`/api/so/${path}`, { headers: { Authorization: `Bearer ${token()}` } });
    if (!res.ok) { alert('Export failed.'); return; }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // Slide-over (desktop) / full-screen (mobile) member card. The list underneath stays put.
  async function openMember(userId, opener, onChange) {
    let dlg = q('#member-dlg');
    if (!dlg) { document.body.insertAdjacentHTML('beforeend', '<dialog id="member-dlg" class="so-dialog slide-over" aria-labelledby="mc-title"></dialog>'); dlg = q('#member-dlg'); }
    dlg.innerHTML = '<div class="dialog-inner"><p class="loading">Loading…</p></div>';
    if (!dlg.open) dlg.showModal();
    let changed = false;
    dlg.onclose = () => { if (opener && document.contains(opener)) opener.focus(); if (changed && onChange) onChange(); };
    async function draw(msg) {
      let m;
      try { m = (await api('GET', `admin/members/${userId}`)).member; } catch (e) { dlg.innerHTML = `<div class="dialog-inner"><p class="notice notice-error">${esc(e.message)}</p><button class="btn btn-secondary" data-close>Close</button></div>`; q('[data-close]', dlg).onclick = () => dlg.close(); return; }
      const e = m.enrollment;
      const rv = e ? (e.review_state === 'pending' && (!m.info || m.info.status !== 'submitted') ? 'awaiting_submission' : e.review_state) : 'not_enrolled';
      const pay = m.payments.find(x => x.paid_at) || m.payments[0];
      const hist = m.history.map(x => x.type === 'decision'
        ? `<li><strong>${esc(x.decision === 'reopened' ? 'Review reopened' : `Decision: ${x.decision}`)}</strong> by ${esc(x.actor)} · ${esc(dt(x.at))}${x.intake_version ? ` · reviewed version ${x.intake_version}` : ''}
${x.member_message ? `<br><span class="small">To member: “${esc(x.member_message)}”</span>` : ''}${x.internal_note ? `<br><span class="small muted">Internal: ${esc(x.internal_note)}</span>` : ''}</li>`
        : `<li>Email <strong>${esc(x.template.replace(/_/g, ' '))}</strong> to ${esc(x.to)} · ${esc(dt(x.at))} · <span class="email-status st-${x.status}">${esc(emailStatus(x.status))}</span>${x.edited ? ' · edited' : ''}${x.resend_of ? ' · resend' : ''}
${x.error ? `<br><span class="small" style="color:var(--danger)">${esc(x.error)}</span>` : ''}${['failed', 'bounced', 'skipped', 'complained'].includes(x.status) && canDo('decide') ? ` <button class="linklike small" data-resend="${x.id}">Resend</button>` : ''}</li>`).join('');
      dlg.innerHTML = `<div class="dialog-inner member-card">
<div class="mc-head"><div class="row" style="gap:1rem">${m.photo_url ? `<img src="${esc(m.photo_url)}" alt="" width="56" height="56" style="border-radius:50%;object-fit:cover">` : ''}
<div><h2 id="mc-title" style="margin:0">${esc(m.name)}</h2><p class="small muted" style="margin:.1rem 0">${esc(m.business || '')} · <a href="mailto:${esc(m.email)}">${esc(m.email)}</a> · ${esc(m.cohort.name)}</p>
<div class="row">${e ? '<span class="pill pill-complete">Enrolled</span>' : '<span class="pill">Not enrolled</span>'}${e ? `<span class="pill">Access: ${esc(e.access.replace(/_/g, ' '))}</span>` : ''}${e && e.is_test ? '<span class="pill pill-draft">test</span>' : ''}</div></div></div>
<button class="close-btn" type="button" data-close>Close</button></div>
${msg ? `<div class="notice ${msg.ok ? 'notice-success' : 'notice-error'}" role="status">${msg.html}</div>` : ''}
${m.info ? `<section><h3>Application ${m.info ? `<span class="small muted" style="font-family:var(--sans)">version ${m.info.version}${m.info.submitted_at ? ` · submitted ${esc(dt(m.info.submitted_at))}` : ' · draft'}${m.info.policy_version ? ` · policy ${esc(m.info.policy_version)}` : ''}</span>` : ''}</h3>
${m.info ? `${m.info.missing.length ? `<p class="notice notice-warn small">Missing: ${esc(m.info.missing.join(', '))}</p>` : ''}<dl class="kv">${m.info.answers.map(a => `<dt>${esc(a.question)}</dt><dd style="white-space:pre-wrap">${a.answer ? esc(a.answer) : '<span class="muted">—</span>'}</dd>`).join('')}</dl>
${m.info.versions.length > 1 ? `<p class="small muted">Earlier versions: ${m.info.versions.slice(1).map(v => `v${v.version} (${shortDate(v.submitted_at)})`).join(', ')}</p>` : ''}` : ''}</section>` : ''}
<section><h3>Private admin notes <span class="small muted" style="font-family:var(--sans)">never sent to the member</span></h3>
${m.notes.map(n => `<p class="small" style="margin:.3rem 0"><strong>${esc(n.author)}</strong> · ${esc(dt(n.created_at))}<br>${esc(n.body)}</p>`).join('') || '<p class="small muted">No notes yet.</p>'}
<form id="note-f" class="row"><label class="sr-only" for="note-b">Add a private note</label><input id="note-b" type="text" maxlength="4000" placeholder="Add a private note" style="flex:1;min-width:12rem"><button class="btn btn-secondary btn-sm">Add note</button></form></section>
<section><h3>Payment</h3>${pay ? `<p style="margin:0">${money(pay.amount_cents)} ${esc((pay.currency || 'usd').toUpperCase())} · ${esc(pay.tier)} · ${esc(payLabel(pay.status))}${pay.paid_at ? ` · ${esc(dt(pay.paid_at))}` : ''}${pay.livemode === false ? ' · <span class="pill pill-draft">test</span>' : ''}</p>
${pay.tax_cents ? `<p class="small" style="margin:.2rem 0">Includes tax ${money(pay.tax_cents)}</p>` : ''}${pay.refunded_cents ? `<p class="small" style="margin:.2rem 0">Refunded ${money(pay.refunded_cents)}</p>` : ''}
${pay.provider_ref ? `<p class="small" style="margin:.2rem 0">Stripe: <a href="${esc(pay.provider_link)}" target="_blank" rel="noopener">${esc(pay.provider_ref)}</a>${pay.receipt_url ? ` · <a href="${esc(pay.receipt_url)}" target="_blank" rel="noopener">Receipt</a>` : ''}${pay.fee_cents != null ? ` · fee ${money(pay.fee_cents)}` : ''}</p>` : ''}
${m.refunds.map(r => `<p class="small" style="margin:.3rem 0">Refund ${money(r.amount_cents)} · <strong>${esc(r.status)}</strong>${r.source === 'external' ? ' (made in Stripe)' : ''} · ${esc(dt(r.updated_at))}${r.failure_reason ? `<br><span style="color:var(--danger)">${esc(r.failure_reason)}</span>` : ''}
${r.status === 'failed' && canDo('finance') ? ` <button class="btn btn-secondary btn-sm" data-retry-refund="${r.id}">Retry refund</button>` : ''}</p>`).join('')}`
        : '<p class="muted">No payment yet.</p>'}
${pay && ['paid', 'partially_refunded'].includes(pay.status) && canDo('finance') && !m.refunds.some(r => ['queued', 'pending', 'succeeded', 'requires_action'].includes(r.status)) ? '<p style="margin-top:.6rem"><button class="btn btn-danger btn-sm" id="refund-full">Refund in full…</button></p><div id="refund-panel"></div>' : ''}</section>
<section><h3>Activity</h3><p class="small" style="margin:0">Days completed ${m.activity.days_completed} · days started ${m.activity.days_started} · introduced ${m.activity.has_intro ? 'yes' : 'no'} · challenges ${m.activity.challenges} · questions ${m.activity.questions}</p>
${m.activity.events.length ? `<details class="more"><summary>Activity timeline</summary><ul class="small timeline">${m.activity.events.map(ev => `<li>${esc(dt(ev.created_at))} · ${esc(ev.name.replace(/_/g, ' '))}${ev.day_number ? ` (day ${ev.day_number})` : ''}</li>`).join('')}</ul>
<p class="small muted">A click or download isn’t completed work; a call-link click isn’t attendance.</p></details>` : ''}</section>
<section><h3>Communication history</h3>${hist ? `<ul class="history">${hist}</ul>` : '<p class="small muted">Nothing yet.</p>'}</section>
${canDo('settings') ? `<section><h3>Delete this person</h3><p class="small muted">Removes their account, enrollment, test payments, application and journal so the email can be used again (useful for clearing test sign-ups). Not available for anyone with a real payment.</p>
<button class="btn btn-danger btn-sm" id="mc-delete">Delete member…</button></section>` : ''}
</div>`;
      q('[data-close]', dlg).onclick = () => dlg.close();
      q('#note-f', dlg).onsubmit = async ev => { ev.preventDefault(); const b = q('#note-b', dlg).value.trim(); if (!b) return; await api('POST', `admin/members/${userId}/notes`, { body: b }); draw(); };
      qa('[data-resend]', dlg).forEach(b => b.onclick = async () => { b.disabled = true; try { const r = await api('POST', `admin/emails/${b.dataset.resend}/resend`); changed = true; draw({ ok: r.status === 'submitted', html: `<p>Resend ${esc(emailStatus(r.status).toLowerCase())}.</p>` }); } catch (x) { draw({ ok: false, html: `<p>${esc(x.message)}</p>` }); } });
      qa('[data-retry-refund]', dlg).forEach(b => b.onclick = async () => { b.disabled = true; try { const r = await api('POST', `admin/refunds/${b.dataset.retryRefund}/retry`); changed = true; draw({ ok: r.refund.status !== 'failed', html: `<p>Refund ${esc(r.refund.status)}.${r.refund.failure_reason ? ` ${esc(r.refund.failure_reason)}` : ''}</p>` }); } catch (x) { draw({ ok: false, html: `<p>${esc(x.message)}</p>` }); } });
      const md = q('#mc-delete', dlg);
      if (md) md.onclick = async () => { if (await deleteMember(userId, m.email)) { changed = true; dlg.close(); } };
      const rf = q('#refund-full', dlg);
      if (rf) rf.onclick = () => {
        const started = Date.now() >= new Date(m.cohort.starts_at || 0).getTime();
        q('#refund-panel', dlg).innerHTML = `<section class="card confirm-panel"><h3 style="margin-top:0">Refund ${money(pay.amount_cents)} in full</h3>
<p class="small">The refund goes back to the original payment method through Stripe. Access follows your refund setting in Cohort settings.</p>
${started ? '<div class="notice notice-warn"><p>The cohort has begun, so the policy says all sales are final. Refunding now is an exception.</p></div><label class="check"><input type="checkbox" id="rf-exc"><span>Refund anyway as a policy exception</span></label>' : ''}
<div class="field"><label for="rf-note">Internal note (optional)</label><input id="rf-note" type="text" maxlength="1000"></div>
<p class="form-error" id="rf-err" role="alert"></p>
<div class="row"><button class="btn btn-danger" id="rf-go">Refund in full</button><button class="btn btn-ghost" id="rf-x">Cancel</button></div></section>`;
        q('#rf-x', dlg).onclick = () => { q('#refund-panel', dlg).innerHTML = ''; };
        q('#rf-go', dlg).onclick = async () => {
          const go = q('#rf-go', dlg); go.disabled = true;
          const exc = q('#rf-exc', dlg);
          try {
            const r = await api('POST', `admin/members/${userId}/refund`, { note: q('#rf-note', dlg).value, exception: !!(exc && exc.checked) });
            changed = true;
            draw({ ok: r.refund.status !== 'failed', html: `<p>Refund ${esc(r.refund.status)}.${r.refund.failure_reason ? ` ${esc(r.refund.failure_reason)}` : ''}</p>` });
          } catch (x) { q('#rf-err', dlg).textContent = x.message; go.disabled = false; }
        };
      };
    }
    async function decisionPanel(m, decision) {
      const panel = q('#decide-panel', dlg);
      const reject = decision === 'reject';
      panel.innerHTML = '<p class="loading">Preparing email preview…</p>';
      let prev;
      try { prev = await api('POST', `admin/members/${userId}/decision-preview`, { decision, member_message: '' }); } catch (x) { panel.innerHTML = `<p class="notice notice-error">${esc(x.message)}</p>`; return; }
      panel.innerHTML = `<section class="card confirm-panel" aria-labelledby="cp-h"><h3 id="cp-h" style="margin-top:0">${reject ? 'Reject, refund and email' : 'Approve and email'}</h3>
<p class="small">To: <strong>${esc(prev.to)}</strong></p>
${reject ? `<div class="notice notice-error"><p><strong>Confirming rejection refunds ${money(prev.refund_cents)} in full through Stripe</strong> and ends cohort access. It can’t be undone here.</p></div>` : '<p class="small">Approval confirms their seat. Their enrollment becomes non-refundable.</p>'}
<div class="field"><label for="cp-msg">${reject ? 'Explanation for the member (required)' : 'Personal note to include (optional)'}</label><textarea id="cp-msg" maxlength="3000" style="min-height:4.5rem"></textarea></div>
<div class="field"><label for="cp-note">Internal note <span class="muted small">(never sent)</span></label><input id="cp-note" type="text" maxlength="3000"></div>
<details class="more"><summary>Edit the email</summary><div class="field"><label for="cp-body">Email body (merge fields allowed${reject ? '; keep {{refund_message}}' : ''})</label><textarea id="cp-body" style="min-height:10rem">${esc(prev.template_body)}</textarea></div></details>
<p class="small" style="margin:.5rem 0 .2rem"><strong>Preview:</strong> ${esc(prev.subject)}</p><pre class="email-preview" id="cp-prev">${esc(prev.body)}</pre>
<p class="form-error" id="cp-err" role="alert"></p>
<div class="row"><button class="btn ${reject ? 'btn-danger' : 'btn-primary'}" id="cp-go">${reject ? 'Reject, Refund & Send Email' : 'Approve & Send Email'}</button><button class="btn btn-ghost" id="cp-cancel">Cancel</button></div></section>`;
      const refresh = async () => {
        try { const p = await api('POST', `admin/members/${userId}/decision-preview`, { decision, member_message: q('#cp-msg', panel).value, body: q('#cp-body', panel).value }); q('#cp-prev', panel).textContent = p.body; q('#cp-err', panel).textContent = ''; }
        catch (x) { q('#cp-err', panel).textContent = x.message; }
      };
      let t; ['#cp-msg', '#cp-body'].forEach(sel => q(sel, panel).addEventListener('input', () => { clearTimeout(t); t = setTimeout(refresh, 500); }));
      q('#cp-msg', panel).focus();
      q('#cp-cancel', panel).onclick = () => { panel.innerHTML = ''; };
      q('#cp-go', panel).onclick = async () => {
        const go = q('#cp-go', panel);
        const msgText = q('#cp-msg', panel).value.trim();
        if (reject && !msgText) { q('#cp-err', panel).textContent = 'Write a short explanation for the member.'; q('#cp-msg', panel).focus(); return; }
        go.disabled = true; go.textContent = 'Working…';
        const bodyText = q('#cp-body', panel).value;
        try {
          const r = await api('POST', `admin/members/${userId}/decision`, { decision, review_version: m.decision.review_version, intake_version: m.decision.intake_version,
            member_message: msgText, internal_note: q('#cp-note', panel).value, ...(bodyText.trim() !== prev.template_body.trim() ? { body: bodyText } : {}) });
          changed = true;
          const refund = r.refund ? `<p>Refund: <strong>${esc(r.refund.status)}</strong>${r.refund.status === 'failed' ? ` · ${esc(r.refund.failure_reason || '')} Use “Retry refund” below once it’s safe.` : ''}</p>` : '';
          const next = r.next_user_id ? `<p><button class="btn btn-secondary btn-sm" id="next-review">Next awaiting review →</button></p>` : '<p>No one else is waiting for review.</p>';
          await draw({ ok: !(r.refund && r.refund.status === 'failed') && r.email !== 'failed', html: `<p><strong>${r.decision === 'approved' ? 'Approved' : 'Rejected'}.</strong> Email: ${esc(emailStatus(r.email))}.</p>${refund}${next}` });
          const nb = q('#next-review', dlg);
          if (nb) nb.onclick = () => { userId = r.next_user_id; draw(); };
        } catch (x) {
          go.disabled = false; go.textContent = reject ? 'Reject, Refund & Send Email' : 'Approve & Send Email';
          q('#cp-err', panel).textContent = x.message + (x.status === 409 ? ' Close and reopen the card to see the latest.' : '');
        }
      };
    }
    draw();
  }

  function emailStatus(st) {
    return { queued: 'Queued (not sent yet)', sending: 'Sending', submitted: 'Accepted by email provider', delivered: 'Delivered', bounced: 'Bounced', complained: 'Marked as spam',
      failed: 'Failed', skipped: 'Not sent: email delivery is off', not_sent: 'Not sent', template_disabled: 'Template switched off' }[st] || st;
  }

  // =================================================================== Sales
  VIEWS.sales = async main => {
    const st = VIEWS.sales.state = VIEWS.sales.state || { from: '', to: '', state: '', review: '', refund: '', tier: '', flagged: '' };
    if (ARG === 'refunds') { st.refund = 'any'; ARG = null; }
    if (ARG === 'flagged') { st.flagged = '1'; ARG = null; }
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(st).filter(([, v]) => v)));
    const d = await api('GET', `admin/sales?${qs}`);
    const t = d.totals;
    const max = Math.max(1, ...d.series.map(x => x.cents));
    const bars = d.series.length ? `<svg class="sales-chart" viewBox="0 0 ${Math.max(d.series.length * 24, 240)} 120" role="img" aria-label="Gross collected per day">
${d.series.map((x, i) => `<g><rect x="${i * 24 + 4}" y="${110 - (x.cents / max) * 100}" width="16" height="${(x.cents / max) * 100}" rx="3"></rect><title>${x.day}: ${money(x.cents)} (${x.n})</title></g>`).join('')}
<line x1="0" y1="110" x2="${Math.max(d.series.length * 24, 240)}" y2="110"></line></svg>
<table class="sr-only"><caption>Gross collected per day</caption>${d.series.map(x => `<tr><td>${x.day}</td><td>${money(x.cents)}</td></tr>`).join('')}</table>
<p class="small muted">${esc(d.series[0].day)} – ${esc(d.series.at(-1).day)} · by payment date (${esc(cohortTz)})</p>` : '<p class="empty">No successful payments in this range.</p>';
    const sel = (id, label, opts, v) => `<div class="field" style="margin:0"><label for="${id}" class="small">${label}</label><select id="${id}">${opts.map(([k, l]) => `<option value="${k}"${v === k ? ' selected' : ''}>${l}</option>`).join('')}</select></div>`;
    main.innerHTML = `<div class="row-between"><h1>Sales</h1><button class="btn btn-secondary btn-sm" id="export">Download CSV (current filters)</button></div>
<p class="muted">${esc(d.scope)}${t.data === 'test' ? ' · <strong>Stripe test-mode data</strong>' : ''}</p>
<form id="sf" class="card"><div class="grid-4">
<div class="field" style="margin:0"><label for="s-from" class="small">From</label><input id="s-from" type="date" value="${esc(st.from)}"></div>
<div class="field" style="margin:0"><label for="s-to" class="small">To</label><input id="s-to" type="date" value="${esc(st.to)}"></div>
${sel('s-state', 'Payment', [['', 'Any'], ['paid', 'Paid'], ['pending', 'Pending'], ['failed', 'Failed'], ['refunded', 'Refunded'], ['partially_refunded', 'Partly refunded'], ['disputed', 'Disputed']], st.state)}
<input type="hidden" id="s-review" value="">
${sel('s-refund', 'Refund', [['', 'Any'], ['any', 'Has a refund'], ['succeeded', 'Completed'], ['pending', 'Pending'], ['failed', 'Failed']], st.refund)}
${sel('s-tier', 'Price', [['', 'Any'], ['intro', '$997 introductory'], ['regular', '$1,497 regular']], st.tier)}
</div><label class="check"><input type="checkbox" id="s-flag"${st.flagged ? ' checked' : ''}><span>Only payments flagged for review</span></label>
<div class="row"><button class="btn btn-primary btn-sm">Apply</button><button class="btn btn-ghost btn-sm" type="button" id="s-clear">Clear</button></div></form>
<div class="grid-4" style="margin-top:1rem">
  <div class="card"><p class="small muted" style="margin:0">Gross collected</p><p class="stat">${money(t.gross_cents)}</p><p class="small muted" style="margin:0">${t.purchases} payment${t.purchases === 1 ? '' : 's'} · ${t.intro_count} at $997 · ${t.regular_count} at $1,497</p></div>
  <div class="card"><p class="small muted" style="margin:0">Refunds</p><p class="stat">${money(t.refunds_completed_cents)}</p><p class="small muted" style="margin:0">completed · ${money(t.refunds_pending_cents)} pending${t.refunds_failed ? ` · <strong style="color:var(--danger)">${t.refunds_failed} failed</strong>` : ''}</p></div>
  <div class="card"><p class="small muted" style="margin:0">Net collected</p><p class="stat">${money(t.net_cents)}</p><p class="small muted" style="margin:0">after completed refunds</p></div>
  <div class="card"><p class="small muted" style="margin:0">After Stripe fees</p><p class="stat">${t.net_after_fees_cents != null ? money(t.net_after_fees_cents) : '—'}</p><p class="small muted" style="margin:0">${t.fee_cents != null ? `fees ${money(t.fee_cents)} (known for ${t.fees_known_for} of ${t.purchases})` : 'fees not reported yet'}. Not profit.</p></div>
</div>

<section class="card">${bars}</section>
<details class="more"><summary>Definitions</summary><ul class="small">${Object.values(d.definitions).map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>
<h2>Transactions</h2>
${d.transactions.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Buyer</th><th>Date</th><th>Paid</th><th>Tax</th><th>Payment</th><th>Refund</th><th>Stripe</th></tr></thead><tbody>
${d.transactions.map(x => `<tr><td><button class="linklike" data-open="${x.user_id}">${esc(x.name)}</button><br><span class="small muted">${esc(x.email)}</span></td>
<td class="small">${esc(dt(x.paid_at || x.created_at))}</td><td>${money(x.amount_paid_cents ?? x.amount_cents)} <span class="small muted">${esc(x.price_tier)}</span></td><td class="small">${x.tax_cents ? money(x.tax_cents) : '—'}</td>
<td>${esc(payLabel(x.status))}${x.livemode === false ? ' <span class="pill pill-draft">test</span>' : ''}${x.needs_review ? `<br><strong class="small" style="color:var(--danger)">${esc(x.needs_review)}</strong>` : ''}</td>
<td class="small">${esc(x.refund_status || '—')}</td>
<td class="small">${x.provider_link ? `<a href="${esc(x.provider_link)}" target="_blank" rel="noopener">Open</a>` : ''}${x.receipt_url ? ` · <a href="${esc(x.receipt_url)}" target="_blank" rel="noopener">Receipt</a>` : ''}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="empty">No transactions match.</p>'}`;
    q('#sf').addEventListener('submit', e => {
      e.preventDefault();
      Object.assign(st, { from: q('#s-from').value, to: q('#s-to').value, state: q('#s-state').value, review: q('#s-review').value, refund: q('#s-refund').value, tier: q('#s-tier').value, flagged: q('#s-flag').checked ? '1' : '' });
      VIEWS.sales(main);
    });
    q('#s-clear').addEventListener('click', () => { VIEWS.sales.state = null; VIEWS.sales(main); });
    q('#export').addEventListener('click', () => downloadCsv(`admin/sales/export?${qs}`, 'smooth-operators-sales.csv'));
    qa('[data-open]', main).forEach(b => b.addEventListener('click', () => openMember(b.dataset.open, b, () => VIEWS.sales(main))));
  };

  // ========================================================== Solutions Seat
  VIEWS.challenges = async main => {
    const [{ challenges }, { calls }] = await Promise.all([api('GET', 'admin/challenges'), api('GET', 'admin/calls')]);
    const filter = ARG || 'all';
    const shown = challenges.filter(c => filter === 'all' || c.status === filter);
    main.innerHTML = `<h1>Challenges</h1><p class="muted">Business challenges members submit for Solutions Seat. Visible to Omi and staff only; submitting doesn’t guarantee selection. Separate from support questions.</p>
<nav class="row" aria-label="Filter challenges" style="margin-bottom:1rem">${[['all', 'All'], ['submitted', 'Submitted'], ['selected', 'Selected'], ['discussed', 'Discussed'], ['follow_up', 'Follow up']].map(([k, l]) => `<a class="btn btn-sm ${filter === k ? 'btn-primary' : 'btn-secondary'}" href="#seat/challenges/${k}"${filter === k ? ' aria-current="page"' : ''}>${l} (${k === 'all' ? challenges.length : challenges.filter(c => c.status === k).length})</a>`).join('')}</nav>
<div class="stack">${shown.length ? shown.map(c => `<article class="card" data-ch="${c.id}"><div class="row-between"><div><button class="linklike" data-open="${c.user_id}" style="font-size:1.1rem">${esc(c.name)}</button>
<span class="small muted"> · ${esc(c.business_name || '')} · ${esc(dt(c.created_at))}</span></div>
<span class="pill ${c.share_permission ? 'pill-available' : 'pill-draft'}">${c.share_permission === false ? 'Not for group discussion' : c.share_permission ? 'OK to discuss with cohort' : 'Permission not given'}</span></div>
${c.working_on ? `<dl class="kv"><dt>Working on</dt><dd>${esc(c.working_on)}</dd><dt>Stuck on</dt><dd>${esc(c.stuck_on)}</dd><dt>Help wanted</dt><dd>${esc(c.help_wanted)}</dd></dl>` : `<p style="white-space:pre-wrap">${esc(c.body || '')}</p>`}
<div class="grid-3"><div class="field" style="margin:0"><label class="small" for="cs-${c.id}">Status</label><select id="cs-${c.id}" name="status">${['submitted', 'selected', 'discussed', 'follow_up'].map(s => `<option value="${s}"${c.status === s ? ' selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}</select></div>
<div class="field" style="margin:0"><label class="small" for="cc-${c.id}">Call</label><select id="cc-${c.id}" name="call"><option value="">Any call</option>${calls.map(x => `<option value="${x.id}"${c.call_id === x.id ? ' selected' : ''}>${esc(x.title)} · ${esc(shortDate(x.starts_at))}</option>`).join('')}</select></div></div>
<div class="field" style="margin:.6rem 0 0"><label class="small" for="cn-${c.id}">Private facilitator note</label><textarea id="cn-${c.id}" name="note" style="min-height:3.5rem">${esc(c.facilitator_note || '')}</textarea></div>
<button class="btn btn-secondary btn-sm" data-save>Save</button> <span data-msg class="small"></span></article>`).join('') : '<p class="empty">No challenges here.</p>'}</div>`;
    qa('[data-ch]', main).forEach(card => {
      q('[data-save]', card).onclick = async () => {
        try { await api('PUT', `admin/challenges/${card.dataset.ch}`, { status: q('[name=status]', card).value, call_id: q('[name=call]', card).value || null, facilitator_note: q('[name=note]', card).value }); q('[data-msg]', card).textContent = 'Saved.'; }
        catch (e) { q('[data-msg]', card).textContent = e.message; }
      };
    });
    qa('[data-open]', main).forEach(b => b.addEventListener('click', () => openMember(b.dataset.open, b)));
  };

  VIEWS.prep = async main => {
    const { calls } = await api('GET', 'admin/calls');
    const upcoming = calls.filter(c => c.status === 'scheduled');
    const id = ARG || (upcoming.find(c => new Date(c.starts_at) > Date.now()) || upcoming[0] || {}).id;
    if (!id) { main.innerHTML = '<h1>Session prep</h1><p class="empty">Schedule a session first.</p>'; return; }
    const d = await api('GET', `admin/calls/${id}/prep`);
    main.innerHTML = `<div class="row-between"><h1>Session prep</h1><button class="btn btn-secondary btn-sm" onclick="window.print()">Print</button></div>
<div class="field" style="max-width:28rem"><label for="prep-call">Session</label><select id="prep-call">${calls.map(c => `<option value="${c.id}"${c.id === id ? ' selected' : ''}>${esc(c.title)} · ${esc(dt(c.starts_at))}</option>`).join('')}</select></div>
<p class="muted">${d.selected.length} selected challenge${d.selected.length === 1 ? '' : 's'} (for this call or any call). Mark challenges “selected” under Challenges.</p>
<div class="stack prep">${d.selected.map((c, i) => `<article class="card"><h2 style="margin:0;font-size:1.35rem">${i + 1}. ${esc(c.name)} <span class="small muted" style="font-family:var(--sans)">${esc(c.business_name || '')}</span></h2>
<p class="small muted">${esc(c.stage || '')} · ${esc(c.revenue || '')} · team ${esc(c.team || '')} · ${c.share_permission ? 'OK to discuss with cohort' : '<strong>Not for group discussion</strong>'}</p>
<dl class="kv"><dt>Working on</dt><dd>${esc(c.working_on || c.body || '')}</dd><dt>Stuck on</dt><dd>${esc(c.stuck_on || '')}</dd><dt>Help wanted</dt><dd>${esc(c.help_wanted || '')}</dd>${c.facilitator_note ? `<dt>Your note</dt><dd>${esc(c.facilitator_note)}</dd>` : ''}</dl></article>`).join('') || '<p class="empty">Nothing selected yet.</p>'}</div>`;
    q('#prep-call').addEventListener('change', e => { location.hash = `#seat/prep/${e.target.value}`; });
  };

  // ================================================================ Progress
  VIEWS.progress = async main => {
    const d = await api('GET', 'admin/progress');
    const filter = ARG || 'all';
    const maxDay = Math.max(1, d.summary.members);
    const shown = d.members.filter(m => filter === 'all' || m.status === filter);
    main.innerHTML = `<h1>Progress</h1><p class="muted">Approved members only. ${esc(d.definitions.caveat)}</p>
<div class="grid-4"><div class="card"><p class="small muted" style="margin:0">Approved members</p><p class="stat">${d.summary.members}</p></div>
<div class="card"><p class="small muted" style="margin:0">Not started</p><p class="stat">${d.summary.not_started}</p></div>
<div class="card"><p class="small muted" style="margin:0">Started</p><p class="stat">${d.summary.started}</p></div>
<div class="card"><p class="small muted" style="margin:0">Recently active</p><p class="stat">${d.summary.recently_active}</p></div></div>
<details class="more"><summary>What these mean</summary><ul class="small"><li>Started: ${esc(d.definitions.started)}</li><li>Completed: ${esc(d.definitions.completed)}</li><li>Recently active: ${esc(d.definitions.recently_active)}</li></ul></details>
<h2>Days voluntarily marked complete</h2>
<div class="day-bars">${d.per_day.map(x => `<div class="day-bar" title="Day ${x.day_number}: ${x.completed} complete, ${x.started} started"><span style="height:${(x.completed / maxDay) * 100}%"></span><small>${x.day_number}</small></div>`).join('')}</div>
<table class="sr-only"><caption>Completions per day</caption>${d.per_day.map(x => `<tr><td>Day ${x.day_number}</td><td>${x.completed} complete</td><td>${x.started} started</td></tr>`).join('')}</table>
<h2>Members</h2><nav class="row" aria-label="Filter" style="margin-bottom:.8rem">${[['all', 'All'], ['not_started', 'Not started'], ['started', 'Started'], ['recently_active', 'Recently active']].map(([k, l]) => `<a class="btn btn-sm ${filter === k ? 'btn-primary' : 'btn-secondary'}" href="#progress/${k}">${l}</a>`).join('')}</nav>
${shown.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Member</th><th>Status</th><th>Days started</th><th>Days completed</th><th>Last active</th></tr></thead><tbody>
${shown.map(m => `<tr><td><button class="linklike" data-open="${m.user_id}">${esc(m.name)}</button><br><span class="small muted">${esc(m.business_name || '')}</span></td><td>${esc(m.status.replace('_', ' '))}</td><td>${m.started}</td><td>${m.completed}</td><td class="small">${shortDate(m.last_active)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No approved members here yet.</p>'}`;
    qa('[data-open]', main).forEach(b => b.addEventListener('click', () => openMember(b.dataset.open, b)));
  };

  // =============================================================== Questions
  VIEWS.questions = async main => {
    if (ARG && /^[0-9a-f-]{36}$/.test(ARG)) return questionThread(main, ARG);
    const filter = ARG || 'open';
    const d = await api('GET', `admin/questions${filter === 'open' ? '' : `?status=${filter}`}`);
    const rows = filter === 'open' ? d.questions.filter(x => x.status !== 'resolved') : d.questions;
    NEWQ = d.counts.new || 0;
    main.innerHTML = `<h1>Questions</h1><p class="muted">Support questions from members and applicants. Business challenges for live calls are under Solutions Seat.</p>
<nav class="row" aria-label="Filter questions" style="margin-bottom:1rem">${[['open', 'Open'], ['new', `New (${d.counts.new || 0})`], ['in_progress', `In progress (${d.counts.in_progress || 0})`], ['resolved', `Resolved (${d.counts.resolved || 0})`]].map(([k, l]) => `<a class="btn btn-sm ${filter === k ? 'btn-primary' : 'btn-secondary'}" href="#settings/questions/${k}">${l}</a>`).join('')}</nav>
${rows.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Member</th><th>Subject</th><th>Status</th><th>Received</th><th>Latest</th></tr></thead><tbody>
${rows.map(x => `<tr><td>${esc(x.name)}<br><span class="small muted">${esc(x.email)}</span></td><td><a href="#settings/questions/${x.id}">${esc(x.subject)}</a><br><span class="small muted">${esc(x.category_label)}</span></td>
<td><span class="pill ${x.status === 'new' ? 'pill-live' : x.status === 'resolved' ? 'pill-complete' : 'pill-progress'}">${esc(x.status.replace('_', ' '))}</span></td><td class="small">${esc(dt(x.created_at))}</td>
<td class="small">${x.latest_author === 'staff' ? 'You: ' : ''}${esc(x.latest || '')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No questions here.</p>'}`;
  };

  async function questionThread(main, id) {
    const d = await api('GET', `admin/questions/${id}`);
    const t = d.thread;
    main.innerHTML = `<a class="back-link" href="#settings/questions">All questions</a>
<div class="row-between"><div><h1 style="margin-bottom:.2rem">${esc(t.subject)}</h1><p class="muted">${esc(t.category_label)} · from <button class="linklike" data-open="${t.user_id}">${esc(t.email)}</button></p></div>
<div class="field" style="margin:0"><label for="t-status" class="small">Status</label><select id="t-status">${['new', 'in_progress', 'resolved'].map(s => `<option value="${s}"${t.status === s ? ' selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}</select></div></div>
<div class="stack">${d.messages.map(m => `<article class="card ${m.internal ? 'internal-note' : ''}"><p class="small muted" style="margin:0 0 .3rem">${m.internal ? '<strong>Internal note</strong> (never shown to the member) · ' : ''}${esc(m.author_type === 'staff' ? m.author : 'Member')} · ${esc(dt(m.created_at))}</p><div style="white-space:pre-wrap">${esc(m.body)}</div></article>`).join('')}</div>
<form id="t-reply" class="card" style="margin-top:1rem"><div class="field"><label for="t-body">Reply to the member</label><textarea id="t-body" maxlength="5000"></textarea>
<p class="help">They’ll get an email with a secure link to read it in the app. The email doesn’t contain your reply.</p></div>
<div class="row"><button class="btn btn-primary btn-sm">Send reply</button><button class="btn btn-secondary btn-sm" type="button" id="t-note">Save as internal note</button></div><p id="t-msg" role="status" class="small"></p></form>`;
    q('#t-status').onchange = e => api('PUT', `admin/questions/${id}`, { status: e.target.value }).catch(x => alert(x.message));
    q('#t-reply').onsubmit = async e => {
      e.preventDefault();
      const body = q('#t-body').value.trim(); if (!body) return;
      try { const r = await api('POST', `admin/questions/${id}/reply`, { body }); q('#t-msg').textContent = `Reply saved. Email: ${emailStatus(r.email)}.`; setTimeout(() => questionThread(main, id), 900); }
      catch (x) { q('#t-msg').textContent = x.message; }
    };
    q('#t-note').onclick = async () => {
      const body = q('#t-body').value.trim(); if (!body) return;
      try { await api('POST', `admin/questions/${id}/note`, { body }); questionThread(main, id); } catch (x) { q('#t-msg').textContent = x.message; }
    };
    qa('[data-open]', main).forEach(b => b.addEventListener('click', () => openMember(b.dataset.open, b)));
  }

  // ================================================================== Emails
  VIEWS.emails = async main => {
    const filter = ARG === 'failed' || ARG === 'emails-failed' ? 'failed' : ARG || '';
    const d = await api('GET', `admin/emails${filter ? `?status=${filter}` : ''}`);
    main.innerHTML = `<div class="row-between"><h1>Email log</h1>${canDo('settings') ? '<button class="btn btn-secondary btn-sm" id="process">Send queued now</button>' : ''}</div>
<div class="notice ${d.mode === 'live' ? '' : 'notice-warn'}"><p>Delivery mode: <strong>${esc(d.mode)}</strong>${d.mode === 'off' ? ' (nothing is sent; messages are recorded as “not sent”)' : d.mode === 'sandbox' ? ' (everything goes to the sandbox address)' : ''}.
${d.resend_configured ? '' : ' Resend API key not set.'} ${d.delivery_webhook ? 'Delivery and bounce updates are on.' : 'Delivery tracking webhook isn’t set up, so “accepted” is the last status you’ll see.'}</p></div>
<nav class="row" aria-label="Filter" style="margin-bottom:1rem">${[['', 'All'], ['failed', 'Failed or bounced'], ['queued', 'Queued'], ['submitted', 'Accepted'], ['delivered', 'Delivered'], ['skipped', 'Not sent']].map(([k, l]) => `<a class="btn btn-sm ${filter === k ? 'btn-primary' : 'btn-secondary'}" href="#settings/emails${k ? `/${k}` : ''}">${l}</a>`).join('')}</nav>
${d.emails.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>When</th><th>To</th><th>Purpose</th><th>Status</th><th></th></tr></thead><tbody>
${d.emails.map(m => `<tr><td class="small">${esc(dt(m.created_at))}</td><td class="small">${esc(m.to_email)}</td><td>${esc(m.template_key.replace(/_/g, ' '))} <span class="small muted">v${m.template_version ?? 0}${m.edited ? ' · edited' : ''}${m.resend_of ? ' · resend' : ''}${m.category === 'test' ? ' · test' : ''}</span><br><span class="small">${esc(m.subject)}</span></td>
<td><span class="email-status st-${m.status}">${esc(emailStatus(m.status))}</span>${m.last_error ? `<br><span class="small" style="color:var(--danger)">${esc(m.last_error)}</span>` : ''}</td>
<td>${['failed', 'bounced', 'skipped', 'complained'].includes(m.status) && canDo('decide') ? `<button class="btn btn-ghost btn-sm" data-resend="${m.id}">Resend</button>` : ''}${m.user_id ? `<button class="btn btn-ghost btn-sm" data-open="${m.user_id}">Member</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No emails here.</p>'}`;
    const pr = q('#process');
    if (pr) pr.onclick = async () => { const r = await api('POST', 'admin/emails/process'); alert(`${r.results.length} processed.`); VIEWS.emails(main); };
    qa('[data-resend]', main).forEach(b => b.onclick = async () => { b.disabled = true; try { const r = await api('POST', `admin/emails/${b.dataset.resend}/resend`); alert(`Resend: ${emailStatus(r.status)}. The underlying decision or refund was not repeated.`); VIEWS.emails(main); } catch (x) { alert(x.message); b.disabled = false; } });
    qa('[data-open]', main).forEach(b => b.addEventListener('click', () => openMember(b.dataset.open, b)));
  };

  VIEWS.templates = async main => {
    const [{ templates }, { calls }] = await Promise.all([api('GET', 'admin/email-templates'), api('GET', 'admin/calls')]);
    const key = ARG && templates.some(t => t.key === ARG) ? ARG : templates[0].key;
    const t = templates.find(x => x.key === key);
    main.innerHTML = `<h1>Templates & reminders</h1>
<div class="grid-2" style="grid-template-columns:minmax(12rem,16rem) 1fr;align-items:start">
<nav aria-label="Templates"><ul class="nav-list">${templates.map(x => `<li><a href="#settings/templates/${x.key}"${x.key === key ? ' aria-current="page"' : ''}>${esc(x.label)}<span class="small" style="margin-left:auto;opacity:.75">${x.category === 'optional' ? 'optional' : ''}</span></a></li>`).join('')}</ul></nav>
<div><form id="tf" class="card"><h2 style="margin-top:0">${esc(t.label)} <span class="small muted" style="font-family:var(--sans)">${t.category} · version ${t.version}${t.customized ? '' : ' (default)'}</span></h2>
<div class="field"><label for="t-subj">Subject</label><input id="t-subj" type="text" value="${esc(t.subject)}"></div>
<div class="field"><label for="t-bodyx">Body</label><textarea id="t-bodyx" style="min-height:16rem">${esc(t.body)}</textarea>
<p class="help">Merge fields: ${t.fields.map(f => `<span class="kbd">{{${f}}}</span>`).join(' ')}${key === 'rejection' ? '. Keep {{refund_message}}: it states the real refund status.' : ''}</p></div>
${t.category === 'optional' ? `<label class="check"><input type="checkbox" id="t-enabled"${t.enabled ? ' checked' : ''}><span>Enabled</span></label>` : ''}
<div class="row"><button class="btn btn-primary btn-sm">Save new version</button><button class="btn btn-secondary btn-sm" type="button" id="t-prev">Preview</button>
<label class="sr-only" for="t-to">Test recipient</label><input id="t-to" type="email" placeholder="test@your-email.com" style="max-width:15rem"><button class="btn btn-ghost btn-sm" type="button" id="t-test">Send test</button></div>
<p id="t-out" class="small" role="status"></p><pre class="email-preview" id="t-preview" hidden></pre></form>
<details class="more"><summary>Version history</summary><div id="t-versions" class="small">Loading…</div></details>
${t.category === 'optional' ? `<section class="card" style="margin-top:1rem"><h2 style="margin-top:0">Send this reminder</h2>
<p class="small">Goes only to <strong>approved</strong> members who opted in to this kind of reminder in their account. This isn’t a marketing campaign.</p>
${key === 'call_reminder' ? `<div class="field"><label for="b-call">Session</label><select id="b-call">${calls.filter(c => c.status === 'scheduled').map(c => `<option value="${c.id}">${esc(c.title)} · ${esc(dt(c.starts_at))}</option>`).join('')}</select></div>` : ''}
<button class="btn btn-secondary btn-sm" id="b-check">Check recipients</button> <span id="b-out" class="small" role="status"></span></section>` : ''}
</div></div>`;
    const out = q('#t-out');
    q('#tf').onsubmit = async e => {
      e.preventDefault();
      try { const r = await api('PUT', `admin/email-templates/${key}`, { subject: q('#t-subj').value, body: q('#t-bodyx').value, ...(q('#t-enabled') ? { enabled: q('#t-enabled').checked } : {}) }); out.textContent = `Saved as version ${r.template.version}.`; }
      catch (x) { out.textContent = x.message; }
    };
    q('#t-prev').onclick = async () => {
      try { const r = await api('POST', `admin/email-templates/${key}/preview`, { subject: q('#t-subj').value, body: q('#t-bodyx').value }); const pv = q('#t-preview'); pv.hidden = false; pv.textContent = `Subject: ${r.subject}\n\n${r.body}`; out.textContent = 'Preview uses sample details.'; }
      catch (x) { out.textContent = x.message; }
    };
    q('#t-test').onclick = async () => {
      try { const r = await api('POST', `admin/email-templates/${key}/test`, { to: q('#t-to').value }); out.textContent = `Test email: ${emailStatus(r.status)}. (Uses the saved version.)`; }
      catch (x) { out.textContent = x.message; }
    };
    api('GET', `admin/email-templates/${key}/versions`).then(v => { q('#t-versions').innerHTML = v.versions.length ? v.versions.map(x => `<p><strong>v${x.version}</strong> · ${esc(dt(x.created_at))} · ${esc(x.created_by || '')}<br>${esc(x.subject)}</p>`).join('') : 'Using the default text (no edits yet).'; }).catch(() => {});
    const bc = q('#b-check');
    if (bc) bc.onclick = async () => {
      const body = { key, ...(q('#b-call') ? { call_id: q('#b-call').value } : {}) };
      try {
        const r = await api('POST', 'admin/emails/broadcast', body);
        if (!r.recipients) { q('#b-out').textContent = 'No approved members have opted in to this reminder.'; return; }
        if (!confirm(`Send “${t.label}” to ${r.recipients} opted-in approved member(s)?`)) return;
        const s2 = await api('POST', 'admin/emails/broadcast', { ...body, confirm: true });
        q('#b-out').textContent = `Queued ${s2.queued}. ${Object.entries(s2.results).map(([k, n]) => `${n} ${emailStatus(k).toLowerCase()}`).join(', ')}.`;
      } catch (x) { q('#b-out').textContent = x.message; }
    };
  };

  // =========================================================== Announcements
  VIEWS.announcements = async main => {
    const d = await api('GET', 'admin/announcements');
    const form = (a = {}) => `<form class="card" data-ann="${a.id || ''}">
<div class="field"><label>Title</label><input name="title" type="text" maxlength="160" value="${esc(a.title || '')}" required></div>
<div class="field"><label>Message</label><textarea name="body" style="min-height:6rem">${esc(a.body || '')}</textarea><p class="help">Blank lines start a new paragraph; lines starting with “- ” become a list.</p></div>
<div class="grid-3">
<div class="field"><label>Status</label><select name="status"><option value="draft"${a.status !== 'published' ? ' selected' : ''}>Draft (hidden)</option><option value="published"${a.status === 'published' ? ' selected' : ''}>Published</option></select></div>
<div class="field"><label>Show from (optional, ${esc(d.timezone)})</label><input name="publish_local" type="datetime-local" value="${esc(a.publish_local || '')}"></div>
<label class="check" style="align-self:end"><input type="checkbox" name="pinned"${a.pinned ? ' checked' : ''}><span>Pin to the top</span></label></div>
<div class="row"><button class="btn btn-primary btn-sm">${a.id ? 'Save' : 'Add announcement'}</button>${a.id ? '<button type="button" class="btn btn-danger btn-sm" data-del>Delete</button>' : ''}<span data-msg class="small"></span></div></form>`;
    main.innerHTML = `<h1>Announcements</h1>
<p class="muted">Shown at the top of members’ Today page (approved members only), newest first, up to five at a time. Pinned ones stay on top. Use “Show from” to schedule one ahead of time.</p>
<h2>New announcement</h2>${form()}
<h2>All announcements</h2><div class="stack">${d.announcements.length ? d.announcements.map(form).join('') : '<p class="empty">No announcements yet.</p>'}</div>`;
    qa('[data-ann]', main).forEach(f => {
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const body = { title: f.title.value, body: f.body.value, status: f.status.value, pinned: f.pinned.checked, publish_local: f.publish_local.value };
        try {
          if (f.dataset.ann) await api('PUT', `admin/announcements/${f.dataset.ann}`, body); else await api('POST', 'admin/announcements', body);
          VIEWS.announcements(main);
        } catch (ex) { q('[data-msg]', f).textContent = ex.message; }
      });
      const del = q('[data-del]', f);
      if (del) del.addEventListener('click', async () => { if (confirm('Delete this announcement?')) { await api('DELETE', `admin/announcements/${f.dataset.ann}`); VIEWS.announcements(main); } });
    });
  };

  // =================================================================== Staff
  VIEWS.staff = async main => {
    if (!canDo('staff')) { main.innerHTML = '<h1>Staff</h1><p class="empty">Only the owner can manage staff.</p>'; return; }
    const d = await api('GET', 'admin/staff');
    main.innerHTML = `<h1>Staff</h1><p class="muted">Owner (the omibell.com admin password) can do everything. <strong>Admin</strong>: everything except staff. <strong>Support</strong>: members, questions, challenges and progress; no decisions, refunds, sales, exports or settings.</p>
<div class="table-wrap"><table class="data"><thead><tr><th>Email</th><th>Role</th></tr></thead><tbody>${d.staff.map(x => `<tr><td>${esc(x.email)}</td><td>${esc(x.role)}</td></tr>`).join('') || '<tr><td colspan="2">Only you (owner) so far.</td></tr>'}</tbody></table></div>
<form id="sf2" class="card" style="margin-top:1rem"><p class="small">The person must sign in once at /smoothoperators/login first. Nobody can give themselves a role.</p><div class="grid-3">
<div class="field"><label for="st-email">Email</label><input id="st-email" type="email" required></div>
<div class="field"><label for="st-role">Role</label><select id="st-role"><option value="support">Support</option><option value="admin">Admin</option><option value="member">Remove staff access</option></select></div></div>
<button class="btn btn-primary btn-sm">Save</button> <span id="st-msg" class="small" role="status"></span></form>`;
    q('#sf2').onsubmit = async e => { e.preventDefault(); try { await api('PUT', 'admin/staff', { email: q('#st-email').value, role: q('#st-role').value }); VIEWS.staff(main); } catch (x) { q('#st-msg').textContent = x.message; } };
  };

  route();
})();
