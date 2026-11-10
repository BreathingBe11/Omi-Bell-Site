'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { zonedToUtc, localDateStr, isValidTimeZone } = require('../api/_lib/so/time');
const S = require('../api/_lib/so/schedule');

const cohort = {
  start_date: '2027-01-01', days_count: 21, timezone: 'America/Los_Angeles', unlock_time: '00:00',
  intro_opens_at: '2026-12-01T08:00:00Z', price_cutoff_at: '2026-12-01T08:00:00Z',
  regular_price_cents: 149700, intro_price_cents: 99900, currency: 'usd',
  access_policy: 'unset', enrollment_closes_at: null, enrollment_opens_at: null,
};
const at = s => new Date(s);

test('zonedToUtc handles PST, PDT and DST transitions', () => {
  assert.equal(zonedToUtc('2027-01-01', '00:00', 'America/Los_Angeles').toISOString(), '2027-01-01T08:00:00.000Z');
  assert.equal(zonedToUtc('2026-07-01', '00:00', 'America/Los_Angeles').toISOString(), '2026-07-01T07:00:00.000Z');
  // 02:30 does not exist on 2027-03-14 in LA; resolves to just after the jump.
  assert.equal(zonedToUtc('2027-03-14', '02:30', 'America/Los_Angeles').toISOString(), '2027-03-14T10:30:00.000Z');
  // 01:30 happens twice on 2026-11-01; first occurrence (PDT).
  assert.equal(zonedToUtc('2026-11-01', '01:30', 'America/Los_Angeles').toISOString(), '2026-11-01T08:30:00.000Z');
  assert.equal(zonedToUtc('2027-01-01', '00:00', 'Asia/Kolkata').toISOString(), '2026-12-31T18:30:00.000Z');
  assert.ok(isValidTimeZone('America/New_York'));
  assert.ok(!isValidTimeZone('Mars/Base'));
});

test('default schedule: Jan 1–21 2027 in LA, three weeks', () => {
  const s = S.schedule(cohort);
  assert.equal(s.days.length, 21);
  assert.equal(s.start_date, '2027-01-01');
  assert.equal(s.end_date, '2027-01-21');
  assert.equal(s.starts_at.toISOString(), '2027-01-01T08:00:00.000Z');
  assert.equal(s.ends_at.toISOString(), '2027-01-22T08:00:00.000Z');
  assert.deepEqual([1, 7, 8, 14, 15, 21].map(S.weekOf), [1, 1, 2, 2, 3, 3]);
});

test('phases advance at the configured instants', () => {
  assert.equal(S.phase(cohort, at('2026-11-30T12:00:00Z')), 'pre_intros');
  assert.equal(S.phase(cohort, at('2026-12-01T07:59:59Z')), 'pre_intros');
  assert.equal(S.phase(cohort, at('2026-12-01T08:00:00Z')), 'intros_open');
  assert.equal(S.phase(cohort, at('2027-01-01T07:59:59Z')), 'intros_open');
  assert.equal(S.phase(cohort, at('2027-01-01T08:00:00Z')), 'live');
  assert.equal(S.phase(cohort, at('2027-01-22T07:59:59Z')), 'live');
  assert.equal(S.phase(cohort, at('2027-01-22T08:00:00Z')), 'complete');
});

test('current day follows cohort timezone, not the viewer timezone, across the year change', () => {
  // 11pm Dec 31 in LA is already Jan 1 in New York and Tokyo — still not Day 1.
  const nyeLA = at('2027-01-01T07:00:00Z');
  assert.equal(localDateStr(nyeLA, 'America/New_York'), '2027-01-01');
  assert.equal(S.currentDay(cohort, nyeLA), null);
  assert.equal(S.currentDay(cohort, at('2027-01-01T08:00:00Z')), 1);
  assert.equal(S.currentDay(cohort, at('2027-01-02T07:59:59Z')), 1);
  assert.equal(S.currentDay(cohort, at('2027-01-02T08:00:00Z')), 2);
  assert.equal(S.currentDay(cohort, at('2027-01-21T08:00:00Z')), 21);
  assert.equal(S.currentDay(cohort, at('2027-01-25T00:00:00Z')), null);
  assert.equal(S.unlockedThrough(cohort, at('2027-01-25T00:00:00Z')), 21);
  assert.ok(S.isDayUnlocked(cohort, 3, at('2027-01-05T00:00:00Z')));
  assert.ok(!S.isDayUnlocked(cohort, 5, at('2027-01-05T00:00:00Z')));
});

test('a different unlock time and timezone shift every day consistently', () => {
  const c = { ...cohort, timezone: 'America/New_York', unlock_time: '06:00' };
  const s = S.schedule(c);
  assert.equal(s.days[0].unlock_at.toISOString(), '2027-01-01T11:00:00.000Z');
  assert.equal(s.days[20].unlock_at.toISOString(), '2027-01-21T11:00:00.000Z');
  assert.equal(S.currentDay(c, at('2027-01-01T10:59:00Z')), null);
});

test('price switches exactly at the server-side cutoff', () => {
  const before = S.priceAt(cohort, at('2026-12-01T07:59:59.999Z'));
  assert.equal(before.tier, 'intro');
  assert.equal(before.amount_cents, 99900);
  assert.equal(before.savings_cents, 49800);
  const after = S.priceAt(cohort, at('2026-12-01T08:00:00Z'));
  assert.equal(after.tier, 'regular');
  assert.equal(after.amount_cents, 149700);
  assert.equal(after.intro_active, false);
  // No intro configured -> always regular.
  assert.equal(S.priceAt({ ...cohort, intro_price_cents: null }, at('2026-11-01T00:00:00Z')).amount_cents, 149700);
});

test('open-checkout quotes are honoured only until their own expiry', () => {
  const p = { checkout_url: 'https://x', expires_at: '2026-12-01T08:30:00Z' };
  assert.ok(S.quoteStillValid(p, at('2026-12-01T08:10:00Z')));
  assert.ok(!S.quoteStillValid(p, at('2026-12-01T08:29:00Z'))); // inside safety margin
  assert.ok(!S.quoteStillValid({ ...p, checkout_url: null }, at('2026-12-01T08:10:00Z')));
});

test('enrollment window and access policy', () => {
  assert.equal(S.enrollmentWindow(cohort, at('2027-01-10T00:00:00Z')).open, true);
  assert.equal(S.enrollmentWindow(cohort, at('2027-01-22T08:00:00Z')).reason, 'closed');
  assert.equal(S.enrollmentWindow({ ...cohort, enrollment_opens_at: '2026-11-15T00:00:00Z' }, at('2026-11-10T00:00:00Z')).reason, 'not_yet_open');
  const e = { access_state: 'active' };
  assert.equal(S.accessStatus(cohort, e, at('2030-01-01T00:00:00Z')).active, true, 'unset policy never silently expires');
  const limited = { ...cohort, access_policy: 'until_date', access_ends_at: '2027-04-01T07:00:00Z' };
  assert.equal(S.accessStatus(limited, e, at('2027-03-31T00:00:00Z')).active, true);
  assert.equal(S.accessStatus(limited, e, at('2027-04-01T07:00:00Z')).reason, 'access_period_ended');
  assert.equal(S.accessStatus(cohort, { access_state: 'refunded' }, at('2027-01-05T00:00:00Z')).active, false);
  assert.equal(S.accessStatus(cohort, null, at('2027-01-05T00:00:00Z')).reason, 'not_enrolled');
});
