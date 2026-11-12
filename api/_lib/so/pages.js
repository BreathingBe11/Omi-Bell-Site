'use strict';
// Server-rendered public pages: landing, terms, privacy. Rendering on the
// server means the price and CTA always reflect server time and cohort config
// (an expired offer is never shown), and copy edits from admin apply at once.
// Everything interpolated is HTML-escaped; owner text is rendered as plain
// paragraphs, never as raw HTML.

const S = require('./schedule');
const C = require('./core');
const { escapeHtml: e } = require('./http');
const payments = require('./payments');
const env = require('./env');

const B = env.BASE_PATH;
const money = cents => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0 })}`;

function paras(s) {
  return String(s || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
    .map(p => `<p>${e(p).replace(/\n/g, '<br>')}</p>`).join('');
}
// Legal documents: "## " headings, "- " bullets, blank-line paragraphs. Everything is escaped.
function legalHtml(text) {
  return String(text || '').split(/\n\s*\n/).map(block => {
    const ls = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (!ls.length) return '';
    if (ls.length === 1 && ls[0].startsWith('## ')) return `<h2>${e(ls[0].slice(3))}</h2>`;
    if (ls.every(l => l.startsWith('- '))) return `<ul>${ls.map(l => `<li>${e(l.slice(2))}</li>`).join('')}</ul>`;
    const head = ls[0].startsWith('## ') ? `<h2>${e(ls.shift().slice(3))}</h2>` : '';
    return `${head}<p>${ls.map(e).join('<br>')}</p>`;
  }).join('\n');
}

// Shared accordion markup (the member platform renders the same structure in so-core.js).
// Answers start open so the page works without JavaScript; the script collapses them.
function faqHtml(list, prefix = 'faq') {
  return `<div class="faq-list" data-faq>${list.map((f, i) => `
  <div class="faq-item">
    <h3 class="faq-q"><button type="button" id="${prefix}-q-${i}" aria-expanded="true" aria-controls="${prefix}-a-${i}">
      <span>${e(f.question)}</span><span class="faq-icon" aria-hidden="true"></span></button></h3>
    <div class="faq-a" id="${prefix}-a-${i}" role="region" aria-labelledby="${prefix}-q-${i}">${paras(f.answer)}</div>
  </div>`).join('')}
</div>`;
}

// YouTube / Vimeo / direct video file -> embed. Anything else is ignored.
function videoEmbed(url, title) {
  let u;
  try { u = new URL(url, 'https://omibell.com'); } catch { return ''; }
  if (!/^https?:$/.test(u.protocol)) return '';
  let id;
  if (/(^|\.)youtube\.com$/.test(u.hostname)) id = u.searchParams.get('v') || (u.pathname.match(/\/(?:embed|shorts)\/([\w-]{6,})/) || [])[1];
  if (u.hostname === 'youtu.be') id = u.pathname.slice(1);
  if (id && /^[\w-]{6,}$/.test(id)) return `<iframe src="https://www.youtube-nocookie.com/embed/${e(id)}" title="${e(title)}" loading="lazy" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
  const vm = /(^|\.)vimeo\.com$/.test(u.hostname) && (u.pathname.match(/\/(\d{6,})/) || [])[1];
  if (vm) return `<iframe src="https://player.vimeo.com/video/${vm}" title="${e(title)}" loading="lazy" allow="fullscreen; picture-in-picture" allowfullscreen></iframe>`;
  if (/\.(mp4|webm|mov)$/i.test(u.pathname)) return `<video controls preload="metadata" src="${e(u.href)}" title="${e(title)}"></video>`;
  return '';
}

function lines(s) { return String(s || '').split('\n').map(x => x.trim()).filter(Boolean); }

function fmtDate(dateStr, opts = {}) {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', ...opts });
}
function tzAbbr(d, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(d).find(x => x.type === 'timeZoneName');
  return p ? p.value : tz;
}
// "11:59 p.m. PST on November 30, 2026"
function deadlineLabel(cutoff, tz) {
  const last = new Date(cutoff.getTime() - 60000);
  const time = last.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).replace('AM', 'a.m.').replace('PM', 'p.m.');
  const date = last.toLocaleDateString('en-US', { timeZone: tz, month: 'long', day: 'numeric', year: 'numeric' });
  const dayOnly = last.toLocaleDateString('en-US', { timeZone: tz, month: 'long', day: 'numeric' });
  return { full: `${time} ${tzAbbr(last, tz)} on ${date}`, day: dayOnly };
}

function shell({ title, description, body, robots, scripts = '' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(description)}">
${robots ? `<meta name="robots" content="${robots}">` : ''}
<meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(description)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${B}/assets/so.css">
</head>
<body class="so-public">
<a class="skip" href="#main">Skip to content</a>
${body}
${scripts}
</body>
</html>`;
}

function header(signInHref = `${B}/login`) {
  return `<header class="pub-header">
  <a class="wordmark" href="${B}">Smooth Operators</a>
  <nav aria-label="Account"><a class="pub-signin" href="${signInHref}" data-so-signin>Sign in</a></nav>
</header>`;
}

function footer(content) {
  const links = [];
  if (content.get('legal.terms')) links.push(`<a href="${B}/terms">Terms</a>`);
  if (content.get('legal.privacy')) links.push(`<a href="${B}/privacy">Privacy</a>`);
  if (content.get('support.email')) {
    const em = content.get('support.email');
    links.push(`<a href="mailto:${e(em)}">${e(em)}</a>`);
  }
  return `<footer class="pub-footer"><div class="wrap">
  <p class="wordmark">Smooth Operators</p>
  <p>A live, guided cohort with Omi Bell.</p>
  ${links.length ? `<p class="pub-footer-links">${links.join('<span aria-hidden="true"> · </span>')}</p>` : ''}
  <p class="muted small">BLYMI is a separate breathwork app and is not part of this cohort.</p>
</div></footer>`;
}

function cta(offer, { id, variant = 'primary' } = {}) {
  const label = `Join the Cohort — ${money(offer.price.amount_cents)}`;
  if (!offer.sales.can_checkout) {
    const msg = offer.sales.reason === 'full' ? 'All seats are full.'
      : offer.sales.reason === 'enrollment_closed' ? 'Enrollment for this cohort has closed.' : 'Enrollment opens soon.';
    return `<p class="cta-closed" data-so-cta-closed>${e(msg)}</p>`;
  }
  return `<a class="btn btn-${variant} btn-lg" href="${B}/checkout" data-so-cta ${id ? `id="${id}"` : ''}>${e(label)}</a>`;
}

function priceDetail(offer, tz) {
  const p = offer.price;
  if (p.intro_active) {
    const dl = deadlineLabel(new Date(p.cutoff_at), tz);
    return `<p class="price-detail">Save ${money(p.savings_cents)} through ${e(dl.day)}. Regular enrollment: ${money(p.regular_cents)}.</p>
<p class="price-deadline">Introductory price ends ${e(dl.full)} (${e(tz)}).</p>`;
  }
  return '';
}

// Used only if the database can't be reached: the public page still loads
// (with the default copy and the seeded cohort dates) and checkout stays off.
function fallbackOffer(now) {
  const S = require('./schedule');
  const cohort = { start_date: '2027-01-04', days_count: 21, timezone: 'America/Los_Angeles', unlock_time: '00:00',
    regular_price_cents: 149700, intro_price_cents: 99700, price_cutoff_at: '2026-12-01T08:00:00Z', currency: 'usd' };
  const sched = S.schedule(cohort);
  const p = S.priceAt(cohort, now);
  return {
    cohort: { name: 'Smooth Operators', timezone: cohort.timezone, start_date: sched.start_date, end_date: sched.end_date },
    price: { ...p, cutoff_at: p.cutoff_at ? p.cutoff_at.toISOString() : null },
    sales: { mode: 'disabled', can_checkout: false, reason: 'not_ready', test_mode: false },
    disclosure: {},
  };
}

async function landing({ sql, now, res }) {
  let offer, content, faqs = [];
  try {
    offer = await payments.offerPayload(sql, now);
    content = await C.loadContent(sql);
    faqs = await sql`select question, answer from so_faqs where status = 'published' and audience in ('public', 'both') order by sort, question`;
  } catch (err) {
    console.error('[so] landing fallback:', err.code || err.message);
    const { SITE_CONTENT } = require('./content');
    offer = fallbackOffer(now);
    content = { get: k => (SITE_CONTENT.find(c => c.key === k) || {}).default || '', isPublished: () => false };
    faqs = require('./content').FAQ_SEED.map(([question, answer]) => ({ question, answer }));
  }
  const g = k => content.get(k);
  const tz = offer.cohort.timezone;
  const start = offer.cohort.start_date, end = offer.cohort.end_date;
  const dates = `${fmtDate(start)}–${start.slice(5, 7) === end.slice(5, 7) ? Number(end.slice(8)) : fmtDate(end)}, ${end.slice(0, 4)}`;
  const credentials = lines(g('about.credentials'));
  const photo = g('about.photo_url');
  const pub = k => content.isPublished(k);
  const heroPhoto = pub('hero.photo_url') ? g('hero.photo_url') : '';
  const video = pub('video.url') ? videoEmbed(g('video.url'), g('video.headline')) : '';
  const testimonials = [1, 2, 3].map(n => ({ quote: g(`testimonial.${n}.quote`), name: g(`testimonial.${n}.name`), context: g(`testimonial.${n}.context`),
    ok: pub(`testimonial.${n}.quote`) && pub(`testimonial.${n}.name`) })).filter(t => t.ok);
  const perk = pub('perks.session_discount') ? g('perks.session_discount') : '';
  const access = lines(g('access.summary')).map(l => { const i = l.indexOf(':'); return i > 0 ? [l.slice(0, i), l.slice(i + 1).trim()] : ['', l]; });
  const testBanner = offer.sales.test_mode
    ? `<div class="test-banner" role="note"><strong>Test mode.</strong> Payments use Stripe test cards only. No real charges.</div>` : '';
  const disclosures = [
    offer.disclosure.access_terms && `<p>${e(offer.disclosure.access_terms)}</p>`,
    offer.disclosure.refund_policy && `<p>${e(offer.disclosure.refund_policy)}</p>`,
  ].filter(Boolean).join('');

  const body = `${testBanner}
${header()}
<main id="main">
  <section class="hero" aria-labelledby="hero-h">
    <div class="wrap hero-grid">
      <div>
        <p class="eyebrow">${e(g('hero.eyebrow'))}</p>
        <h1 id="hero-h">${e(g('hero.headline'))}</h1>
        <div class="lede">${paras(g('hero.body'))}</div>
        <ul class="hero-facts" aria-label="Cohort details">
          <li><span class="fact-label">Dates</span> ${e(dates)}</li>
          <li><span class="fact-label">Host</span> Omi Bell</li>
          <li><span class="fact-label">Live calls</span> Wednesdays · Jan 6, 13 &amp; 20</li>
          <li><span class="fact-label">Access</span> 12 months of materials and recordings</li>
        </ul>
        <div class="hero-cta">
          ${cta(offer, { id: 'hero-cta' })}
          <a class="text-link" href="#weeks">See the three weeks</a>
        </div>
        ${offer.sales.can_checkout ? priceDetail(offer, tz) : ''}
      </div>
      <div class="hero-side">
      ${heroPhoto ? `<img class="hero-photo" src="${e(heroPhoto)}" alt="${e(g('hero.photo_alt'))}" width="560" height="640" fetchpriority="high">` : ''}
      <aside class="hero-card" aria-label="The promise">
        <p class="hero-card-kicker">In 21 days</p>
        <p class="hero-card-text">${e(g('hero.promise'))}</p>
        <ol class="pillar-mini">
          <li><span>Week 1</span> Standards</li>
          <li><span>Week 2</span> Systems</li>
          <li><span>Week 3</span> Scorecards</li>
        </ol>
      </aside>
      </div>
    </div>
  </section>

  <section class="band band-soft" aria-labelledby="problem-h">
    <div class="wrap narrow">
      <h2 id="problem-h">${e(g('problem.headline'))}</h2>
      ${paras(g('problem.body'))}
      <p class="transition">${e(g('problem.transition'))}</p>
    </div>
  </section>
${video ? `
  <section class="band" aria-labelledby="video-h">
    <div class="wrap narrow">
      <h2 id="video-h">${e(g('video.headline'))}</h2>
      <div class="video-frame">${video}</div>
      ${pub('video.caption') ? paras(g('video.caption')) : ''}
    </div>
  </section>` : ''}

  <section class="band" id="weeks" aria-labelledby="method-h">
    <div class="wrap">
      <p class="eyebrow">The method</p>
      <h2 id="method-h">${e(g('method.headline'))}</h2>
      <div class="pillars">
        ${[['standards', 'Standards'], ['systems', 'Systems'], ['scorecards', 'Scorecards']].map(([k, label], i) => `
        <article class="pillar">
          <p class="pillar-week">Week ${i + 1} · ${e(weekRange(start, i))}</p>
          <h3>${label}</h3>
          <p>${e(g(`method.${k}`))}</p>
        </article>`).join('')}
      </div>
      <div class="mid-cta">${cta(offer, { variant: 'secondary' })}</div>
    </div>
  </section>

  <section class="band band-soft" id="how" aria-labelledby="days-h">
    <div class="wrap days-grid">
      <div>
        <p class="eyebrow">The daily experience</p>
        <h2 id="days-h">${e(g('days.headline'))}</h2>
        ${paras(g('days.body'))}
        <ul class="daily-parts">
          <li><span class="part-n">01</span><div><h3>Guided Audio</h3><p>A new breathwork, meditation, or sound healing audio to help you arrive.</p></div></li>
          <li><span class="part-n">02</span><div><h3>Leadership Journal Prompt</h3><p>One question to reflect on how you lead, saved privately in your journal.</p></div></li>
          <li><span class="part-n">03</span><div><h3>Business Action Toolkit</h3><p>A practical template or tool, with instructions for applying it to your business.</p></div></li>
        </ul>
        <h3 class="h-small">Your daily time</h3>
        ${paras(g('days.time'))}
        <p class="promise-line">${e(g('days.promise'))}</p>
      </div>
      <figure class="sample-screen" aria-label="Sample daily screen (illustration)">
        <figcaption class="sample-label">Sample screen · illustration only, not final content</figcaption>
        <div class="sample-body" aria-hidden="true">
          <p class="sample-meta">Day 4 · Standards</p>
          <p class="sample-title">Give people a way to make decisions without you.</p>
          <div class="sample-step"><span>Guided Audio</span>Breathwork · audio</div>
          <div class="sample-step"><span>Leadership Journal Prompt</span>What decisions keep coming back to you because you haven’t explained what a good decision looks like?</div>
          <div class="sample-step"><span>Business Action Toolkit</span>Decision rights template: choose one recurring decision and define its owner, boundaries, and escalation point.</div>
          <div class="sample-complete">Complete today</div>
        </div>
      </figure>
    </div>
  </section>

  <section class="band" aria-labelledby="calls-h">
    <div class="wrap">
      <div class="support-grid">
        <div>
          <p class="eyebrow">Live with Omi</p>
          <h2 id="calls-h">Solutions Seat group coaching</h2>
          ${paras(g('days.calls'))}
          ${paras(g('days.calls_schedule'))}
        </div>
        <div>
          <p class="eyebrow">Between calls</p>
          <h2>Ask Omi directly</h2>
          ${paras(g('days.support'))}
        </div>
      </div>
      ${access.length ? `<dl class="access-list" aria-label="What’s included and for how long">${access.map(([k, v]) => `<div><dt>${e(k)}</dt><dd>${e(v)}</dd></div>`).join('')}</dl>` : ''}
    </div>
  </section>

  <section class="band" aria-labelledby="outcomes-h">
    <div class="wrap narrow">
      <h2 id="outcomes-h">${e(g('outcomes.headline'))}</h2>
      <ul class="checklist">${lines(g('outcomes.list')).map(l => `<li>${e(l)}</li>`).join('')}</ul>
      <p class="note">${e(g('outcomes.note'))}</p>
    </div>
  </section>

  <section class="band band-soft" aria-labelledby="fit-h">
    <div class="wrap narrow">
      <h2 id="fit-h">${e(g('fit.headline'))}</h2>
      ${paras(g('fit.body'))}
    </div>
  </section>

  <section class="band" aria-labelledby="about-h">
    <div class="wrap about-grid ${photo ? '' : 'no-photo'}">
      ${photo ? `<img class="about-photo" src="${e(photo)}" alt="${e(g('about.photo_alt'))}" loading="lazy" width="480" height="600">` : ''}
      <div>
        <h2 id="about-h">${e(g('about.headline'))}</h2>
        ${paras(g('about.bio'))}
        ${credentials.length ? `<ul class="credentials">${credentials.map(c => `<li>${e(c)}</li>`).join('')}</ul>` : ''}
      </div>
    </div>
  </section>

${testimonials.length ? `
  <section class="band band-soft" aria-labelledby="proof-h">
    <div class="wrap">
      <h2 id="proof-h" class="center">In their words</h2>
      <div class="testimonials">${testimonials.map(t => `<figure class="testimonial"><blockquote>${paras(t.quote)}</blockquote>
        <figcaption><strong>${e(t.name)}</strong>${t.context ? `<span>${e(t.context)}</span>` : ''}</figcaption></figure>`).join('')}</div>
    </div>
  </section>` : ''}
  <section class="band band-plum" id="enroll" aria-labelledby="enroll-h">
    <div class="wrap narrow center">
      <h2 id="enroll-h">${e(g('enroll.headline'))}</h2>
      <p class="enroll-price"><span class="amount">${money(offer.price.amount_cents)}</span> <span class="unit">one-time payment</span></p>
      ${offer.price.intro_active && offer.sales.can_checkout ? `<p class="enroll-regular">Regular enrollment: ${money(offer.price.regular_cents)}</p>` : ''}
      <p>${e(dates)} · Live cohort · Hosted by Omi Bell</p>
      <ul class="includes">${lines(g('enroll.includes')).map(l => `<li>${e(l)}</li>`).join('')}${perk ? `<li>${e(perk)}</li>` : ''}</ul>
      <div class="enroll-cta">${cta(offer, { variant: 'light', id: 'footer-cta' })}</div>
      ${offer.sales.can_checkout && offer.price.intro_active ? priceDetail(offer, tz) : ''}
      <p class="small">${e(g('enroll.footer_cta_note'))}</p>
      ${disclosures ? `<div class="disclosures small">${disclosures}</div>` : ''}
    </div>
  </section>

  ${faqs.length ? `<section class="band" id="faq" aria-labelledby="faq-h">
    <div class="wrap narrow">
      <p class="eyebrow">FAQ</p>
      <h2 id="faq-h">Questions, answered</h2>
      ${faqHtml(faqs)}
    </div>
  </section>` : ''}
</main>
${footer(content)}`;

  const html = shell({
    title: 'Smooth Operators — a live 21-day cohort with Omi Bell',
    description: g('hero.promise'),
    body,
    robots: offer.sales.mode === 'live' ? null : 'noindex',
    scripts: `<script src="${B}/assets/vendor/supabase-2.106.1.js" defer></script>
<script src="${B}/assets/so-core.js" defer></script>
<script src="${B}/assets/landing.js" defer></script>`,
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Short shared cache; the price boundary is re-checked by checkout regardless.
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=30');
  res.statusCode = 200;
  res.end(html);
  return require('./http').HANDLED;
}

function weekRange(start, i) {
  const { addDays } = require('./time');
  const a = addDays(start, i * 7), b = addDays(start, i * 7 + 6);
  const m = d => fmtDate(d, { month: 'long' }).split(' ')[0];
  return m(a) === m(b) ? `${m(a)} ${Number(a.slice(8))}–${Number(b.slice(8))}` : `${fmtDate(a)}–${fmtDate(b)}`;
}

// Always available (Google sign-in and buyers need them), even before the
// database is configured: falls back to the built-in default text.
function legalPage(key, title) {
  return async ({ sql, res }) => {
    let content;
    try { content = await C.loadContent(sql); } catch {
      const { SITE_CONTENT } = require('./content');
      const get = k => (SITE_CONTENT.find(c => c.key === k) || {}).default || '';
      content = { get, isPublished: () => false };
    }
    const body = `${header()}
<main id="main" class="band"><div class="wrap narrow legal">
  <h1>${e(title)}</h1>
  ${legalHtml(content.get(key))}
</div></main>
${footer(content)}`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300');
    res.statusCode = 200;
    res.end(shell({ title: `${title} — Smooth Operators`, description: `${title} for Smooth Operators, a live cohort with Omi Bell.`, body }));
    return require('./http').HANDLED;
  };
}

const routes = {
  'GET page/landing': landing,
  'GET page/terms': legalPage('legal.terms', 'Terms of Purchase and Use'),
  'GET page/privacy': legalPage('legal.privacy', 'Privacy Policy'),
  // Public, non-secret client configuration (the anon key is designed to be public).
  'GET public-config': async () => ({
    supabase_url: process.env.SUPABASE_URL || null,
    supabase_anon_key: process.env.SUPABASE_ANON_KEY || null,
    // Google OAuth web client ID (public by design). Enables Google's own sign-in button.
    google_client_id: process.env.SO_GOOGLE_CLIENT_ID || null,
    base_path: B,
  }),
};

module.exports = { routes, deadlineLabel, money, faqHtml, videoEmbed };
