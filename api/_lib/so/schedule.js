'use strict';
// Pure cohort-schedule, pricing and access rules. Every function takes the
// cohort row and an explicit `now` so the rules can be tested and previewed
// with a simulated clock without touching real data.

const { zonedToUtc, addDays, toDateStr, toTimeStr } = require('./time');

function schedule(cohort) {
  const start = toDateStr(cohort.start_date);
  const unlock = toTimeStr(cohort.unlock_time);
  const tz = cohort.timezone;
  const n = cohort.days_count || 21;
  const days = [];
  for (let i = 1; i <= n; i++) {
    const date = addDays(start, i - 1);
    days.push({ day_number: i, date, unlock_at: zonedToUtc(date, unlock, tz) });
  }
  return {
    timezone: tz,
    start_date: start,
    end_date: addDays(start, n - 1),
    starts_at: days[0].unlock_at,
    // The cohort is over once the unlock moment after the final day arrives.
    ends_at: zonedToUtc(addDays(start, n), unlock, tz),
    days,
  };
}

function weekOf(dayNumber) { return Math.ceil(dayNumber / 7); }

// 'pre_intros' -> 'intros_open' -> 'live' -> 'complete'
function phase(cohort, now) {
  const s = schedule(cohort);
  const t = now.getTime();
  if (t >= s.ends_at.getTime()) return 'complete';
  if (t >= s.starts_at.getTime()) return 'live';
  if (t >= new Date(cohort.intro_opens_at).getTime()) return 'intros_open';
  return 'pre_intros';
}

function introsOpen(cohort, now) {
  return now.getTime() >= new Date(cohort.intro_opens_at).getTime();
}

// Highest unlocked day number (0 before the cohort starts).
function unlockedThrough(cohort, now) {
  const s = schedule(cohort);
  let n = 0;
  for (const d of s.days) if (now.getTime() >= d.unlock_at.getTime()) n = d.day_number;
  return n;
}

// The day Today shows: the current cohort day while live, null otherwise.
function currentDay(cohort, now) {
  return phase(cohort, now) === 'live' ? unlockedThrough(cohort, now) : null;
}

function isDayUnlocked(cohort, dayNumber, now) {
  return dayNumber >= 1 && dayNumber <= unlockedThrough(cohort, now);
}

// Server-side price selection. The client never supplies an amount.
function priceAt(cohort, now) {
  const cutoff = cohort.price_cutoff_at ? new Date(cohort.price_cutoff_at) : null;
  const introActive = !!(cohort.intro_price_cents && cutoff && now.getTime() < cutoff.getTime());
  return {
    tier: introActive ? 'intro' : 'regular',
    amount_cents: introActive ? cohort.intro_price_cents : cohort.regular_price_cents,
    regular_cents: cohort.regular_price_cents,
    intro_cents: cohort.intro_price_cents || null,
    savings_cents: introActive ? cohort.regular_price_cents - cohort.intro_price_cents : 0,
    cutoff_at: cutoff,
    intro_active: introActive,
    currency: cohort.currency || 'usd',
  };
}

function enrollmentWindow(cohort, now) {
  const s = schedule(cohort);
  const opens = cohort.enrollment_opens_at ? new Date(cohort.enrollment_opens_at) : null;
  const closes = cohort.enrollment_closes_at ? new Date(cohort.enrollment_closes_at) : s.ends_at;
  if (opens && now.getTime() < opens.getTime()) return { open: false, reason: 'not_yet_open', opens_at: opens, closes_at: closes };
  if (now.getTime() >= closes.getTime()) return { open: false, reason: 'closed', opens_at: opens, closes_at: closes };
  return { open: true, reason: null, opens_at: opens, closes_at: closes };
}

// Whether an enrollment currently grants access to cohort content.
function accessStatus(cohort, enrollment, now) {
  if (!enrollment) return { active: false, reason: 'not_enrolled' };
  if (enrollment.access_state !== 'active') {
    // A dispute only suspends access when the owner chose that policy; the
    // enrollment state is set accordingly by the payment handler.
    return { active: false, reason: enrollment.access_state };
  }
  const ends = enrollment.access_ends_at
    ? new Date(enrollment.access_ends_at)
    : (cohort.access_policy === 'until_date' ? new Date(cohort.access_ends_at) : null);
  if (ends && now.getTime() >= ends.getTime()) return { active: false, reason: 'access_period_ended', ends_at: ends };
  return { active: true, reason: null, ends_at: ends };
}

// Would a still-open checkout session with this quote be honoured right now?
// Policy: a session quoted before the cutoff keeps its quoted price until its
// own (provider-enforced) expiry. New sessions always use priceAt(now).
function quoteStillValid(purchase, now, marginMs = 2 * 60 * 1000) {
  if (!purchase || !purchase.expires_at || !purchase.checkout_url) return false;
  return new Date(purchase.expires_at).getTime() - marginMs > now.getTime();
}

module.exports = {
  schedule, weekOf, phase, introsOpen, unlockedThrough, currentDay, isDayUnlocked,
  priceAt, enrollmentWindow, accessStatus, quoteStillValid,
};
