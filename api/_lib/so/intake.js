'use strict';
// Fit check: required before payment. Answers are private to the member and
// admins. They are never shown in introductions or written to analytics/logs.

const C = require('./core');
const H = require('./http');
const { requireUser, ensureProfile } = require('./identity');

const { HttpError } = H;

const OPTIONS = {
  business_stage: [
    ['idea', 'Idea stage: not selling yet'],
    ['early', 'Early: first paying customers'],
    ['growing', 'Growing: steady, repeat revenue'],
    ['established', 'Established: ready to scale'],
  ],
  revenue_to_date: [
    ['under_10k', 'Under $10K'], ['10k_50k', '$10K–$50K'], ['50k_100k', '$50K–$100K'], ['100k_250k', '$100K–$250K'],
    ['250k_500k', '$250K–$500K'], ['500k_1m', '$500K–$1M'], ['1m_5m', '$1M–$5M'], ['over_5m', 'Over $5M'],
  ],
  years_in_business: [
    ['under_1', 'Less than 1 year'], ['1_2', '1–2 years'], ['3_5', '3–5 years'], ['6_10', '6–10 years'], ['over_10', 'More than 10 years'],
  ],
  team_size: [
    ['0', 'Just me'], ['1_2', '1–2 people'], ['3_5', '3–5 people'], ['6_10', '6–10 people'], ['11_25', '11–25 people'], ['over_25', 'More than 25 people'],
  ],
};

const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
  'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'PR', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'];
const OUTSIDE_US = 'OUTSIDE_US';

const label = (field, value) => {
  const o = (OPTIONS[field] || []).find(([v]) => v === value);
  return o ? o[1] : value;
};

// Gentle note for people who may be early for this cohort. Never a block.
function earlyStage(intake) {
  return intake.business_stage === 'idea' || intake.revenue_to_date === 'under_10k';
}

function yesNo(v, field) {
  if (v === true || v === 'yes') return true;
  if (v === false || v === 'no') return false;
  throw new HttpError(400, 'invalid_input', `Choose yes or no for “${field}”.`);
}

function parseIntake(b) {
  const pick = (field, name) => {
    const v = b[field];
    if (!OPTIONS[field].some(([k]) => k === v)) throw new HttpError(400, 'invalid_input', `Choose an answer for “${name}”.`);
    return v;
  };
  const state = H.text(b.state, { max: 20, required: true, field: 'State' }).toUpperCase();
  const outside = state === OUTSIDE_US;
  if (!outside && !US_STATES.includes(state)) throw new HttpError(400, 'invalid_input', 'Choose your state.');
  const postal = H.text(b.postal_code, { max: 12, required: true, field: outside ? 'Postal code' : 'ZIP code' });
  if (!outside && !/^\d{5}(-\d{4})?$/.test(postal)) throw new HttpError(400, 'invalid_input', 'Enter a 5-digit ZIP code.');
  const phone = H.text(b.phone, { max: 30, required: true, field: 'Phone number' });
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) throw new HttpError(400, 'invalid_input', 'Enter a phone number we can reach you at.');
  const noWebsite = b.no_website === true;
  const website = noWebsite ? null : H.optionalUrl(b.website_url, { field: 'Website' });
  if (!noWebsite && !website) throw new HttpError(400, 'invalid_input', 'Add your website, or tick “I don’t have a website yet”.');
  if (b.policy_ack !== true) throw new HttpError(400, 'invalid_input', 'Please confirm you understand the review and refund policy.');
  return {
    first_name: H.text(b.first_name, { max: 80, required: true, field: 'First name' }),
    last_name: H.text(b.last_name, { max: 80, required: true, field: 'Last name' }),
    business_name: H.text(b.business_name, { max: 160, required: true, field: 'Business name' }),
    website_url: website,
    no_website: noWebsite,
    phone,
    address_line1: H.text(b.address_line1, { max: 200, required: true, field: 'Street address' }),
    address_line2: H.text(b.address_line2, { max: 200, field: 'Address line 2' }) || null,
    city: H.text(b.city, { max: 120, required: true, field: 'City' }),
    state,
    postal_code: postal,
    country: outside ? H.text(b.country, { max: 80, required: true, field: 'Country' }) : 'United States',
    business_stage: pick('business_stage', 'Stage of business'),
    revenue_to_date: pick('revenue_to_date', 'Revenue generated so far'),
    years_in_business: pick('years_in_business', 'Years in business'),
    prior_ops_work: yesNo(b.prior_ops_work, 'Have you done operations work before?'),
    has_full_time_staff: yesNo(b.has_full_time_staff, 'Do you have full-time staff?'),
    team_size: pick('team_size', 'Team size'),
    ops_questions: H.text(b.ops_questions, { max: 3000, required: true, field: 'Your most pressing operations questions', multiline: true }),
  };
}

async function loadIntake(sql, userId, cohortId) {
  return (await sql`select * from so_intakes where user_id = ${userId} and cohort_id = ${cohortId}`)[0] || null;
}

function intakeOut(i) {
  if (!i) return null;
  const { id, user_id, cohort_id, ...rest } = i;
  return { ...rest, early_stage: earlyStage(i) };
}

const routes = {
  'GET intake': async ({ sql, req }) => {
    const user = await requireUser(req);
    await ensureProfile(sql, user);
    const cohort = await C.loadCohort(sql);
    const content = await C.loadContent(sql);
    return {
      intake: intakeOut(await loadIntake(sql, user.id, cohort.id)),
      options: OPTIONS,
      states: US_STATES,
      outside_us: OUTSIDE_US,
      refund_policy: content.get('purchase.refund_policy'),
    };
  },
  'PUT intake': async ({ sql, req }) => {
    const user = await requireUser(req);
    await ensureProfile(sql, user);
    const cohort = await C.loadCohort(sql);
    const enrollment = await C.loadEnrollment(sql, user.id, cohort.id);
    if (enrollment && enrollment.review_state !== 'pending') {
      throw new HttpError(409, 'locked', 'Your fit check has already been reviewed. Contact support to update it.');
    }
    const v = parseIntake(H.body(req));
    await H.rateLimit(sql, `intake:${user.id}`, 30, 3600);
    const rows = await sql`
      insert into so_intakes ${sql({ ...v, user_id: user.id, cohort_id: cohort.id, policy_ack_at: new Date() })}
      on conflict (user_id, cohort_id) do update set ${sql({ ...v, policy_ack_at: new Date(), updated_at: new Date() })}
      returning *`;
    // Keep the display name in step with the name they gave us.
    await sql`update so_profiles set display_name = coalesce(display_name, ${v.first_name}) where user_id = ${user.id}`;
    return { intake: intakeOut(rows[0]) };
  },
};

module.exports = { routes, OPTIONS, US_STATES, OUTSIDE_US, label, earlyStage, loadIntake, parseIntake };
