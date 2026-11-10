/* Smooth Operators — admin workspace. Uses the existing omibell.com admin
   password login (/api/admin-login). Every action is authorized again on the
   server; nothing here is trusted. Journal text is never shown. */
(function () {
  'use strict';
  const SO = window.SO;
  const esc = SO.esc;
  const root = document.getElementById('admin-root');
  const TOKEN_KEY = 'ob_admin_token';
  const SECTIONS = [
    ['overview', 'Overview'], ['people', 'Members'], ['cohort', 'Cohort settings'], ['days', '21 days'], ['resources', 'Resources'],
    ['calls', 'Calls'], ['members', 'Payments & access'], ['intros', 'Introductions'], ['content', 'Site content & FAQs'],
    ['preview', 'Preview'], ['log', 'Audit log'],
  ];
  const q = (s, el = document) => el.querySelector(s);
  const qa = (s, el = document) => Array.from(el.querySelectorAll(s));
  const token = () => { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } };
  let cohortTz = 'America/Los_Angeles';

  async function api(method, path, body) {
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
  function section() { const s = location.hash.replace('#', '').split('/')[0]; return SECTIONS.some(x => x[0] === s) ? s : 'overview'; }
  function hashArg() { return location.hash.split('/')[1] || null; }
  async function route() {
    if (!token()) return showLogin();
    const s = section();
    root.innerHTML = `<header class="admin-top"><span class="wordmark">Smooth Operators · Admin</span>
<div class="row"><a href="/admin">← Omi Bell admin</a><a href="/smoothoperators" target="_blank" rel="noopener">View landing page</a><button class="btn btn-ghost btn-sm" id="logout">Log out</button></div></header>
<nav class="admin-nav" aria-label="Admin sections">${SECTIONS.map(([k, l]) => `<a href="#${k}"${k === s ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
<main id="admin-main" class="admin-main" tabindex="-1"><p class="loading">Loading…</p></main>`;
    q('#logout').addEventListener('click', () => { sessionStorage.removeItem(TOKEN_KEY); showLogin(); });
    const main = q('#admin-main');
    try { await VIEWS[s](main); } catch (e) { if (token()) main.innerHTML = `<div class="notice notice-error"><p>${esc(e.message)}</p></div>`; }
  }
  window.addEventListener('hashchange', route);

  const VIEWS = {};

  // ------------------------------------------------------------ overview
  VIEWS.overview = async main => {
    const o = await api('GET', 'admin/overview');
    const c = await api('GET', 'admin/cohort');
    cohortTz = c.cohort.timezone;
    const cfg = o.config;
    const alerts = o.content_release.days.filter(d => d.alert);
    const enr = o.enrollments.reduce((a, r) => { a[r.is_test ? 'test' : r.access_state] = (a[r.is_test ? 'test' : r.access_state] || 0) + r.n; return a; }, {});
    main.innerHTML = `<h1>Overview</h1>
<p class="muted">Server time ${esc(dt(o.now))} · Phase: <strong>${esc(o.phase.replace('_', ' '))}</strong>${o.current_day ? ` · Day ${o.current_day}` : ''} · Current price <strong>${money(o.price.amount_cents)}</strong> (${esc(o.price.tier)})</p>
${o.sales.test_mode ? '<div class="notice notice-warn"><p><strong>Stripe is in TEST mode.</strong> Checkouts use test cards and create test enrollments.</p></div>' : ''}
${alerts.length ? `<div class="notice notice-error"><p><strong>${alerts.length} day(s) unlock within 7 days and aren’t ready:</strong> ${alerts.map(d => `Day ${d.day_number}`).join(', ')}.</p></div>` : ''}
${o.pending_reviews ? `<div class="notice notice-warn"><p><strong>${o.pending_reviews} paid member(s) waiting for your review.</strong> <a href="#people">Review fit checks</a></p></div>` : ''}
${o.needs_review ? `<div class="notice notice-warn"><p>${o.needs_review} purchase(s) need review. <a href="#members">Members & payments</a></p></div>` : ''}
${o.failed_webhooks ? `<div class="notice notice-error"><p>${o.failed_webhooks} payment webhook(s) failed to process. <a href="#log">See log</a></p></div>` : ''}
<div class="grid-3">
  <div class="card"><p class="muted small">Seats (private)</p><p class="stat">${o.seats.taken}${o.seats.limit ? ` / ${o.seats.limit}` : ''}</p><p class="small muted">${o.seats.limit ? (o.seats.taken >= o.seats.limit ? 'Full: the site says “All seats are full.”' : `${o.seats.limit - o.seats.taken} left. The limit is never shown publicly.`) : 'No limit set.'}</p></div>
  <div class="card"><p class="muted small">Active enrollments</p><p class="stat">${enr.active || 0}</p><p class="small muted">${enr.test ? `${enr.test} test · ` : ''}${['refunded', 'suspended', 'disputed', 'revoked'].map(k => enr[k] ? `${enr[k]} ${k}` : '').filter(Boolean).join(' · ')}</p></div>
  <div class="card"><p class="muted small">Live revenue (confirmed)</p><p class="stat">${money(o.live_revenue_cents)}</p></div>
  <div class="card"><p class="muted small">Funnel</p><p class="small" style="margin:0">CTA clicks ${o.funnel.landing_cta_clicked || 0} · Checkouts ${o.funnel.checkout_started || 0} · Paid ${o.funnel.payment_confirmed || 0}<br>Welcome views ${o.funnel.welcome_viewed || 0} · Days opened ${o.funnel.day_opened || 0} · Completed ${o.funnel.day_completed || 0}<br>Resources opened ${o.funnel.resource_opened || 0} · Call link clicks ${o.funnel.call_link_clicked || 0}</p></div>
</div>
<div class="grid-2" style="margin-top:1rem">
<section class="card"><h2 style="margin-top:0">Blocks live sales</h2>
${o.sales.blockers.length ? `<ul class="checklist-admin">${o.sales.blockers.map(b => `<li>${esc(b.label)}</li>`).join('')}</ul>` : '<p class="notice notice-success">Everything required for live sales is in place.</p>'}
<p class="small muted" style="margin-top:.75rem">Checkout available now: <strong>${o.sales.can_checkout ? 'yes' : 'no'}</strong> (${esc(o.sales.mode)})</p></section>
<section class="card"><h2 style="margin-top:0">Configuration</h2><ul class="checklist-admin">
${[['Database', cfg.database], ['Supabase Auth', cfg.supabase_auth], ['Private storage', cfg.storage], [`Stripe key (${cfg.stripe_mode})`, ['live', 'test'].includes(cfg.stripe_mode)], ['Stripe webhook secret', cfg.stripe_webhook], [`Email delivery: ${cfg.email_mode}`, cfg.email_mode === 'live' && cfg.resend]]
      .map(([l, ok]) => `<li class="${ok ? 'ok' : ''}">${esc(l)}</li>`).join('')}</ul></section></div>
<section style="margin-top:1rem"><h2>Content release checklist</h2>
<p class="small muted">A member sees a day only when it is both <strong>unlocked by time</strong> and <strong>published</strong>. Completion counts never include anyone’s writing.</p>
<div class="table-wrap"><table class="data"><thead><tr><th>Day</th><th>Unlocks</th><th>Status</th><th>Started / Completed</th><th>Open items</th></tr></thead><tbody>
${o.content_release.days.map(d => `<tr><td><a href="#days/${d.day_number}">Day ${d.day_number}</a><br><span class="small muted">${esc(d.title)}</span></td><td class="small">${esc(dt(d.unlock_at))}</td>
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
    const { days } = await api('GET', 'admin/days');
    main.innerHTML = `<h1>21 days</h1><p class="muted">Provisional days from the brief are marked <span class="pill pill-draft">sample</span>. Review, edit and mark each one final before publishing.</p>
<div class="table-wrap"><table class="data"><thead><tr><th>Day</th><th>Title</th><th>Status</th><th>Preview</th><th>Linked</th></tr></thead><tbody>
${days.map(d => `<tr><td>${d.day_number}</td><td><a href="#days/${d.day_number}">${esc(d.title)}</a></td>
<td><span class="pill ${d.status === 'published' ? 'pill-complete' : 'pill-draft'}">${d.status}</span>${d.is_sample ? ' <span class="pill pill-draft">sample</span>' : ''}</td>
<td>${d.preview_published ? 'Approved' : '—'}</td><td class="small">${d.links.map(l => `${esc(l.title)} (${l.role})`).join(', ') || '—'}</td></tr>`).join('')}</tbody></table></div>`;
  };

  async function dayEditor(main, n) {
    const [{ day: d }, { resources }] = await Promise.all([api('GET', `admin/days/${n}`), api('GET', 'admin/resources')]);
    const practice = d.links.find(l => l.role === 'practice');
    const others = d.links.filter(l => l.role !== 'practice').map(l => l.resource_id);
    const ta = (id, label, v, rows = 3, help = '') => `<div class="field"><label for="${id}">${label}</label><textarea id="${id}" rows="${rows}" style="min-height:${rows * 1.8}rem">${esc(v || '')}</textarea>${help ? `<p class="help">${help}</p>` : ''}</div>`;
    main.innerHTML = `<a class="back-link" href="#days">All days</a><h1>Day ${d.day_number}</h1>
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
<div class="field"><label for="status">Status</label><select id="status"><option value="draft"${d.status === 'draft' ? ' selected' : ''}>Draft (hidden from members)</option><option value="published"${d.status === 'published' ? ' selected' : ''}>Published (visible once unlocked)</option></select></div>
<div class="row"><button class="btn btn-primary">Save day</button><a href="#preview/day-${d.day_number}">Preview this day</a></div><div id="dmsg"></div></form>`;
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
    main.innerHTML = `<div class="row-between"><h1>Resources</h1><a class="btn btn-primary" href="#resources/new">Add resource</a></div>
<p class="muted">Toolkit templates, guided practices, and call replays. Files stay private; members only ever get short-lived links, and only once a resource is published and released.</p>
<div class="table-wrap"><table class="data"><thead><tr><th>Title</th><th>Type</th><th>Source</th><th>Status</th><th>Days</th></tr></thead><tbody>
${resources.length ? resources.map(x => `<tr><td><a href="#resources/${x.id}">${esc(x.title)}</a></td><td>${x.kind}${x.practice_type ? ` · ${x.practice_type}` : ''}</td>
<td>${x.source_type === 'link' ? 'Link' : x.has_file ? `${esc(x.file_kind)} v${x.version}` : '<span style="color:var(--danger)">No file</span>'}</td>
<td><span class="pill ${x.status === 'published' ? 'pill-complete' : 'pill-draft'}">${x.status}</span></td><td>${x.links.map(l => l.day_number).join(', ') || '—'}</td></tr>`).join('') : '<tr><td colspan="5">No resources yet.</td></tr>'}</tbody></table></div>`;
  };

  function resourceEditor(main, r, isNew) {
    const opt = (v, cur, l) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l || v}</option>`;
    main.innerHTML = `<a class="back-link" href="#resources">All resources</a><h1>${isNew ? 'Add resource' : esc(r.title)}</h1>
<form id="rf" class="card"><div class="grid-2">
<div class="field"><label for="kind">Type</label><select id="kind">${['template', 'practice', 'replay', 'other'].map(k => opt(k, r.kind)).join('')}</select></div>
<div class="field"><label for="source">Source</label><select id="source">${opt('file', r.source_type, 'Uploaded file')}${opt('link', r.source_type, 'External link')}</select></div></div>
<div class="field"><label for="title">Title</label><input id="title" type="text" value="${esc(r.title || '')}"></div>
<div class="field"><label for="purpose">Short purpose</label><input id="purpose" type="text" value="${esc(r.purpose || '')}"></div>
<div class="field"><label for="description">Description</label><textarea id="description" style="min-height:5rem">${esc(r.description || '')}</textarea></div>
<div class="grid-2">
<div class="field"><label for="pillar">Pillar</label><select id="pillar">${opt('', r.pillar || '', 'None')}${['standards', 'systems', 'scorecards'].map(p => opt(p, r.pillar)).join('')}</select></div>
<div class="field"><label for="url">External link (https)</label><input id="url" type="url" value="${esc(r.external_url || '')}"></div>
<div class="field"><label for="ptype">Practice type</label><select id="ptype">${opt('', r.practice_type || '', '—')}${opt('breathwork', r.practice_type)}${opt('meditation', r.practice_type)}</select></div>
<div class="field"><label for="dur">Duration (seconds)</label><input id="dur" type="number" min="0" value="${r.duration_seconds || ''}"></div>
<div class="field"><label for="release">Release</label><select id="release">${opt('with_day', r.release_mode, 'With its linked day')}${opt('at_time', r.release_mode, 'At a set time')}${opt('immediately', r.release_mode, 'Immediately to enrolled members')}</select></div>
<div class="field"><label for="release_at">Release time (for “at a set time”)</label><input id="release_at" type="datetime-local" value="${r.release_at ? esc(new Date(r.release_at).toISOString().slice(0, 16)) : ''}"><p class="help">Entered in your browser’s timezone.</p></div></div>
<div class="field"><label for="transcript">Transcript (required to publish a practice)</label><textarea id="transcript" style="min-height:7rem">${esc(r.transcript || '')}</textarea></div>
<label class="check"><input type="checkbox" id="sample"${r.is_sample ? ' checked' : ''}><span>Sample placeholder (can’t be published)</span></label>
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
        if (isNew) location.hash = `#resources/${out.resource.id}`; else flash(q('#rmsg'), 'Saved.');
      } catch (ex) { flash(q('#rmsg'), ex.message, false); }
    });
    if (isNew) return;
    q('#del').addEventListener('click', async () => {
      if (!confirm('Delete this resource and its file? Days that link to it will lose the link.')) return;
      try { await api('DELETE', `admin/resources/${r.id}`); location.hash = '#resources'; } catch (ex) { flash(q('#rmsg'), ex.message, false); }
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
    const [{ calls, timezone }, { resources }, { challenges }] = await Promise.all([api('GET', 'admin/calls'), api('GET', 'admin/resources'), api('GET', 'admin/challenges')]);
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
    main.innerHTML = `<h1>Solutions Seat calls</h1><p class="muted">Members see “scheduled” calls only. Meeting links are handed out only inside the join window. Only add dates Omi has confirmed.</p>
<div class="stack">${calls.map(form).join('')}<h2>Add a call</h2>${form()}</div>
<h2>Submitted challenges</h2><p class="small muted">Private to the member and admins.</p>
<div class="table-wrap"><table class="data"><thead><tr><th>From</th><th>Question</th><th>Submitted</th><th>Status</th></tr></thead><tbody>
${challenges.length ? challenges.map(c => `<tr><td>${esc(c.preferred_name || c.display_name || c.email)}</td><td style="white-space:pre-wrap">${esc(c.body)}</td><td class="small">${esc(dt(c.created_at))}</td>
<td><select data-ch="${c.id}">${['submitted', 'reviewed', 'discussed', 'archived'].map(s => `<option${c.status === s ? ' selected' : ''}>${s}</option>`).join('')}</select></td></tr>`).join('') : '<tr><td colspan="4">None yet.</td></tr>'}</tbody></table></div>`;
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
    qa('[data-ch]', main).forEach(s => s.addEventListener('change', () => api('PUT', `admin/challenges/${s.dataset.ch}`, { status: s.value }).catch(e => alert(e.message))));
  };

  // --------------------------------------------------------------- people
  VIEWS.people = async main => {
    const data = await api('GET', 'admin/members');
    const filter = hashArg() || 'all';
    const counts = { all: data.members.length, pending: 0, approved: 0, not_a_fit: 0 };
    data.members.forEach(m => { counts[m.review_state] = (counts[m.review_state] || 0) + 1; });
    const shown = data.members.filter(m => filter === 'all' || m.review_state === filter);
    const reviewPill = m => ({ pending: '<span class="pill pill-progress">Pending review</span>', approved: '<span class="pill pill-complete">Approved</span>', not_a_fit: '<span class="pill">Not a fit · refunded</span>' }[m.review_state]);
    const detail = i => i ? `<dl class="kv">
<dt>Phone</dt><dd><a href="tel:${esc(i.phone)}">${esc(i.phone)}</a></dd>
<dt>Business</dt><dd>${esc(i.business_name)}${i.no_website ? ' · <span class="muted">no website yet</span>' : i.website_url ? ` · <a href="${esc(i.website_url)}" target="_blank" rel="noopener noreferrer">${esc(i.website_url.replace(/^https?:\/\//, ''))}</a>` : ''}</dd>
<dt>Address</dt><dd>${esc(i.address_line1)}${i.address_line2 ? `, ${esc(i.address_line2)}` : ''}, ${esc(i.city)}, ${esc(i.state === 'OUTSIDE_US' ? i.country : i.state)} ${esc(i.postal_code)}</dd>
<dt>Stage</dt><dd>${esc(i.labels.business_stage)}</dd>
<dt>Revenue so far</dt><dd>${esc(i.labels.revenue_to_date)}</dd>
<dt>In business</dt><dd>${esc(i.labels.years_in_business)}</dd>
<dt>Ops work before</dt><dd>${i.prior_ops_work ? 'Yes' : 'No'}</dd>
<dt>Full-time staff</dt><dd>${i.has_full_time_staff ? 'Yes' : 'No'}</dd>
<dt>Team size</dt><dd>${esc(i.labels.team_size)}</dd>
<dt>Pressing questions</dt><dd style="white-space:pre-wrap">${esc(i.ops_questions)}</dd></dl>` : '<p class="muted small">No fit check on file (for example, access granted manually).</p>';
    main.innerHTML = `<div class="row-between"><h1>Members</h1><button class="btn btn-secondary btn-sm" id="export">Download spreadsheet (CSV)</button></div>
<p class="muted">Seats: <strong>${data.seats.taken}${data.seats.limit ? ` of ${data.seats.limit}` : ''}</strong> (private). Everything people shared in their fit check is here. Their journals stay private.</p>
<nav class="row" aria-label="Filter members" style="margin-bottom:1rem">${[['all', 'All'], ['pending', 'Pending review'], ['approved', 'Approved'], ['not_a_fit', 'Not a fit']].map(([k, l]) =>
      `<a class="btn btn-sm ${filter === k ? 'btn-primary' : 'btn-secondary'}" href="#people/${k}"${filter === k ? ' aria-current="page"' : ''}>${l} (${counts[k] || 0})</a>`).join('')}</nav>
<div class="stack">${shown.length ? shown.map(m => {
      const i = m.intake;
      const name = i ? `${i.first_name} ${i.last_name}` : (m.email);
      return `<article class="card" data-member="${m.id}">
<div class="row-between"><div><h2 style="margin:0;font-size:1.5rem">${esc(name)}</h2>
<p class="small muted" style="margin:.2rem 0 0"><a href="mailto:${esc(m.email)}">${esc(m.email)}</a> · ${m.source === 'manual' ? 'Manual grant' : `${esc(m.purchase_status || '—')} ${money(m.amount_paid_cents)}`} · enrolled ${esc(dt(m.activated_at))}${m.is_test ? ' · <span class="pill pill-draft">test</span>' : ''}</p></div>
<div>${reviewPill(m)}${i && i.early_stage ? ' <span class="pill pill-draft">Early stage</span>' : ''}${m.needs_review ? ` <span class="pill pill-live">${esc(m.needs_review)}</span>` : ''}</div></div>
<details class="more" ${m.review_state === 'pending' ? 'open' : ''}><summary>Fit check answers</summary>${detail(i)}</details>
<p class="small muted" style="margin:.4rem 0">Days completed: ${m.days_completed} · Introduced: ${m.has_intro ? 'yes' : 'no'}${m.reviewed_by ? ` · Reviewed by ${esc(m.reviewed_by)} ${esc(dt(m.reviewed_at))}` : ''}${m.review_note ? ` · Note: ${esc(m.review_note)}` : ''}</p>
<div class="row">${m.review_state === 'pending' ? `<button class="btn btn-primary btn-sm" data-review="approved">Approve</button>
<button class="btn btn-danger btn-sm" data-review="not_a_fit">Not a fit: refund in full</button>` : ''}
${m.review_state === 'approved' ? '<button class="btn btn-ghost btn-sm" data-review="pending">Move back to pending</button>' : ''}</div>
</article>`;
    }).join('') : '<p class="empty">No one here yet.</p>'}</div>
<h2>Fit checks without payment</h2><p class="small muted">People who filled out the fit check but haven’t paid. Useful for a personal follow-up.</p>
<div class="table-wrap"><table class="data"><thead><tr><th>Name</th><th>Email / phone</th><th>Business</th><th>Stage · revenue</th><th>Checkout</th><th>Submitted</th></tr></thead><tbody>
${data.unpaid.length ? data.unpaid.map(u => `<tr><td>${esc(u.intake.first_name)} ${esc(u.intake.last_name)}</td><td class="small">${esc(u.email)}<br>${esc(u.intake.phone)}</td>
<td>${esc(u.intake.business_name)}<br><span class="small muted">${esc(u.intake.city)}, ${esc(u.intake.state === 'OUTSIDE_US' ? u.intake.country : u.intake.state)}</span></td>
<td class="small">${esc(u.intake.labels.business_stage)}<br>${esc(u.intake.labels.revenue_to_date)}</td><td class="small">${esc(u.last_checkout || 'not started')}</td><td class="small">${esc(dt(u.intake.submitted_at))}</td></tr>`).join('') : '<tr><td colspan="6">None.</td></tr>'}</tbody></table></div>`;
    q('#export').addEventListener('click', async () => {
      const res = await fetch('/api/so/admin/members/export', { headers: { Authorization: `Bearer ${token()}` } });
      if (!res.ok) { alert('Export failed.'); return; }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a'); a.href = url; a.download = 'smooth-operators-members.csv'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
    qa('[data-member]', main).forEach(card => qa('[data-review]', card).forEach(b => b.addEventListener('click', async () => {
      const decision = b.dataset.review;
      const name = q('h2', card).textContent;
      if (decision === 'not_a_fit' && !confirm(`Mark ${name} as not a fit?\n\nThis refunds their payment in full through Stripe and ends their access. It can’t be undone. You may want to reach out to them personally.`)) return;
      if (decision === 'approved' && !confirm(`Approve ${name}?\n\nOnce approved, their enrollment is non-refundable, and they’ll get an approval email (if email sending is on).`)) return;
      const note = decision === 'pending' ? null : prompt('Optional note (only admins see this):', '') ;
      if (note === null && decision !== 'pending') return;
      b.disabled = true;
      try { await api('POST', `admin/enrollments/${card.dataset.member}/review`, { decision, note: note || '' }); VIEWS.people(main); }
      catch (e) { alert(e.message); b.disabled = false; }
    })));
  };

  // -------------------------------------------------------------- members
  VIEWS.members = async main => {
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
${d.content ? SO.paras(d.content) : ''}<h3>Arrive</h3><p>${d.practice ? esc(d.practice.title) : '<em>No published practice</em>'}</p>
<h3>Reflect</h3><p class="question">${esc(d.reflection_prompt || '')}</p><h3>Apply</h3>${SO.paras(d.action_body || '')}
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

  route();
})();
