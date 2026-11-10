'use strict';
// Fit check (the application). Required before payment.
//
// Drafts are saved as-is; only an explicit, fully validated submission becomes
// status 'submitted', increments the version and writes an immutable snapshot
// to so_intake_versions. Review decisions are tied to the version reviewed.
// The policy text the buyer accepted is recorded with a version hash.
// Answers are private to the applicant and authorized staff: never shown in
// introductions, analytics or logs.

const crypto = require('crypto');
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

// The questions, in order, as shown to reviewers. `required` drives completeness.
const QUESTIONS = [
  ['first_name', 'First name', true], ['last_name', 'Last name', true], ['phone', 'Phone', true],
  ['business_name', 'Business name', true], ['website_url', 'Website', false],
  ['address_line1', 'Street address', true], ['address_line2', 'Address line 2', false], ['city', 'City', true],
  ['state', 'State', true], ['postal_code', 'ZIP / postal code', true], ['country', 'Country', true],
  ['business_stage', 'Stage of business', true], ['revenue_to_date', 'Revenue generated so far', true],
  ['years_in_business', 'Years in business', true], ['prior_ops_work', 'Done operations work before', true],
  ['has_full_time_staff', 'Has full-time staff', true], ['team_size', 'Team size (staff + contractors)', true],
  ['ops_questions', 'Most pressing operations questions', true],
];

const label = (field, value) => {
  const o = (OPTIONS[field] || []).find(([v]) => v === value);
  return o ? o[1] : value;
};

function earlyStage(i) { return i.business_stage === 'idea' || i.revenue_to_date === 'under_10k'; }

function missingFields(i) {
  if (!i) return QUESTIONS.filter(q => q[2]).map(q => q[0]);
  const miss = QUESTIONS.filter(([k, , req]) => req && (i[k] === null || i[k] === undefined || i[k] === '')).map(q => q[0]);
  if (!i.no_website && !i.website_url) miss.push('website_url');
  if (!i.policy_ack_at) miss.push('policy_ack');
  return miss;
}

// Answers as reviewers see them (labels instead of codes).
function answersOut(i) {
  return QUESTIONS.map(([k, q]) => {
    let v = i ? i[k] : null;
    if (k === 'website_url' && i && i.no_website) v = 'No website yet';
    else if (OPTIONS[k]) v = v ? label(k, v) : null;
    else if (typeof v === 'boolean') v = v ? 'Yes' : 'No';
    else if (k === 'state' && v === OUTSIDE_US) v = 'Outside the US';
    return { key: k, question: q, answer: v == null || v === '' ? null : String(v) };
  });
}

const optText = (v, max, field, multiline = false) => H.text(v, { max, field, multiline }) || null;

// Draft: accept what's there (types/lengths checked). Submit: everything required and valid.
function parseIntake(b, { submit }) {
  const need = (v, msg) => { if (submit && (v === null || v === undefined || v === '')) throw new HttpError(400, 'invalid_input', msg); return v; };
  const choice = (field, name) => {
    const v = b[field];
    if (v === null || v === undefined || v === '') return need(null, `Choose an answer for “${name}”.`);
    if (!OPTIONS[field].some(([k]) => k === v)) throw new HttpError(400, 'invalid_input', `Choose an answer for “${name}”.`);
    return v;
  };
  const yesNo = (field, name) => {
    const v = b[field];
    if (v === true || v === 'yes') return true;
    if (v === false || v === 'no') return false;
    return need(null, `Choose yes or no for “${name}”.`);
  };
  let state = optText(b.state, 20, 'State');
  state = state ? state.toUpperCase() : null;
  const outside = state === OUTSIDE_US;
  if (state && !outside && !US_STATES.includes(state)) throw new HttpError(400, 'invalid_input', 'Choose your state.');
  need(state, 'Choose your state.');
  const postal = optText(b.postal_code, 12, outside ? 'Postal code' : 'ZIP code');
  need(postal, outside ? 'Enter your postal code.' : 'Enter your ZIP code.');
  if (postal && state && !outside && !/^\d{5}(-\d{4})?$/.test(postal)) throw new HttpError(400, 'invalid_input', 'Enter a 5-digit ZIP code.');
  const phone = optText(b.phone, 30, 'Phone number');
  need(phone, 'Enter your phone number.');
  if (phone && submit) {
    const d = phone.replace(/\D/g, '');
    if (d.length < 10 || d.length > 15) throw new HttpError(400, 'invalid_input', 'Enter a phone number we can reach you at.');
  }
  const noWebsite = b.no_website === true;
  const website = noWebsite ? null : H.optionalUrl(b.website_url, { field: 'Website' });
  if (submit && !noWebsite && !website) throw new HttpError(400, 'invalid_input', 'Add your website, or tick “I don’t have a website yet”.');
  if (submit && b.policy_ack !== true) throw new HttpError(400, 'invalid_input', 'Please confirm you understand the review and refund policy.');
  const country = outside ? optText(b.country, 80, 'Country') : (state ? 'United States' : null);
  if (outside) need(country, 'Enter your country.');
  return {
    first_name: need(optText(b.first_name, 80, 'First name'), 'Enter your first name.'),
    last_name: need(optText(b.last_name, 80, 'Last name'), 'Enter your last name.'),
    business_name: need(optText(b.business_name, 160, 'Business name'), 'Enter your business name.'),
    website_url: website, no_website: noWebsite, phone,
    address_line1: need(optText(b.address_line1, 200, 'Street address'), 'Enter your street address.'),
    address_line2: optText(b.address_line2, 200, 'Address line 2'),
    city: need(optText(b.city, 120, 'City'), 'Enter your city.'),
    state, postal_code: postal, country: country || 'United States',
    business_stage: choice('business_stage', 'Stage of business'),
    revenue_to_date: choice('revenue_to_date', 'Revenue generated so far'),
    years_in_business: choice('years_in_business', 'Years in business'),
    prior_ops_work: yesNo('prior_ops_work', 'Have you done operations work before?'),
    has_full_time_staff: yesNo('has_full_time_staff', 'Do you have full-time staff?'),
    team_size: choice('team_size', 'Team size'),
    ops_questions: need(optText(b.ops_questions, 3000, 'Your most pressing operations questions', true), 'Tell us your most pressing operations questions.'),
  };
}

async function loadIntake(sql, userId, cohortId) {
  return (await sql`select * from so_intakes where user_id = ${userId} and cohort_id = ${cohortId}`)[0] || null;
}

function policyFor(cohort, content) {
  const text = `${content.get('purchase.refund_policy')}\nReview timeframe: ${cohort.review_turnaround}`;
  return { text, version: crypto.createHash('sha256').update(text).digest('hex').slice(0, 12) };
}

function intakeOut(i) {
  if (!i) return null;
  const { id, user_id, cohort_id, policy_text, ...rest } = i;
  return { ...rest, early_stage: earlyStage(i), missing: i.status === 'submitted' ? [] : missingFields(i) };
}

const routes = {
  'GET intake': async ({ sql, req }) => {
    const user = await requireUser(req);
    await ensureProfile(sql, user);
    const cohort = await C.loadCohort(sql);
    const content = await C.loadContent(sql);
    return {
      intake: intakeOut(await loadIntake(sql, user.id, cohort.id)),
      options: OPTIONS, states: US_STATES, outside_us: OUTSIDE_US,
      refund_policy: content.get('purchase.refund_policy'),
      review_turnaround: cohort.review_turnaround,
    };
  },
  // body.submit === true submits; otherwise the answers are saved as a draft.
  'PUT intake': async ({ sql, req }) => {
    const user = await requireUser(req);
    await ensureProfile(sql, user);
    const cohort = await C.loadCohort(sql);
    const enrollment = await C.loadEnrollment(sql, user.id, cohort.id);
    if (enrollment && enrollment.review_state !== 'pending') {
      throw new HttpError(409, 'locked', 'Your fit check has already been reviewed. Contact support to update it.');
    }
    const b = H.body(req);
    const submit = b.submit === true;
    const v = parseIntake(b, { submit });
    await H.rateLimit(sql, `intake:${user.id}`, 60, 3600);
    const content = await C.loadContent(sql);
    const policy = policyFor(cohort, content);

    const out = await sql.begin(async tx => {
      const cur = (await tx`select * from so_intakes where user_id = ${user.id} and cohort_id = ${cohort.id} for update`)[0];
      if (!submit && cur && cur.status === 'submitted') {
        throw new HttpError(409, 'already_submitted', 'Your fit check is already submitted. Submit again to update it.');
      }
      const fields = { ...v, status: submit ? 'submitted' : 'draft', updated_at: new Date() };
      if (submit) Object.assign(fields, { submitted_at: new Date(), policy_ack_at: new Date(), policy_version: policy.version, policy_text: policy.text });
      let row;
      if (!cur) {
        row = (await tx`insert into so_intakes ${tx({ ...fields, user_id: user.id, cohort_id: cohort.id, version: submit ? 1 : 0 })} returning *`)[0];
      } else {
        row = (await tx`update so_intakes set ${tx({ ...fields, version: submit ? cur.version + 1 : cur.version })}
                        where id = ${cur.id} returning *`)[0];
      }
      if (submit) {
        await tx`insert into so_intake_versions (intake_id, user_id, cohort_id, version, data, policy_version)
                 values (${row.id}, ${user.id}, ${cohort.id}, ${row.version}, ${tx.json(Object.fromEntries(QUESTIONS.map(([k]) => [k, row[k]]).concat([['no_website', row.no_website]])))}, ${policy.version})
                 on conflict (intake_id, version) do nothing`;
      }
      return row;
    });
    if (submit) await sql`update so_profiles set display_name = coalesce(display_name, ${v.first_name}) where user_id = ${user.id}`;
    // Paid already (e.g. updating while pending): confirm receipt of the new version.
    if (submit && enrollment) {
      const email = require('./email');
      const m = await email.enqueue(sql, { key: 'submission_received', dedupeKey: `submission:${out.id}:v${out.version}`, to: user.email, userId: user.id,
        cohortId: cohort.id, vars: await email.baseVars(sql, cohort, user.id), related: { type: 'intake', id: out.id }, actor: 'member' });
      if (m) await email.processOutbox(sql, { ids: [m.id] });
    }
    return { intake: intakeOut(out) };
  },
};

module.exports = { routes, OPTIONS, US_STATES, OUTSIDE_US, QUESTIONS, label, earlyStage, missingFields, answersOut, loadIntake, parseIntake };
