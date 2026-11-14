'use strict';
// Checkout without signing in first.
//
// Join -> one short form -> "Continue to payment". The form is saved as a lead
// the moment it's submitted (even if the buyer never pays), an account is
// created for the email, and the buyer goes straight to Stripe. After paying
// they get an email to finish setting up sign-in (Google or an email code).
// People who start but don't pay get one reminder email with an unsubscribe link.

const C = require('./core');
const H = require('./http');
const S = require('./schedule');
const env = require('./env');
const email = require('./email');
const payments = require('./payments');
const intake = require('./intake');
const { getAuthUser, requireAdmin } = require('./identity');

const { HttpError } = H;
const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[A-Za-z]{2,}$/;
const REMINDER_AFTER_HOURS = 24;

function normEmail(v) {
  const e = H.text(v, { max: 254, required: true, field: 'Email' }).trim().toLowerCase();
  if (!EMAIL_RE.test(e)) throw new HttpError(400, 'invalid_input', 'Enter a valid email address.');
  return e;
}

// Find the sign-in account for an email, or create one. Accounts are created
// already confirmed so Google sign-in with the same address links to it; nobody
// can get in without proving they own the email (code or Google).
async function findOrCreateUser(sql, addr) {
  const find = async () => (await sql`select id, email from auth.users where lower(email) = ${addr} limit 1`)[0] || null;
  const existing = await find();
  if (existing) return { id: existing.id, email: addr };
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new HttpError(503, 'auth_not_configured', 'Checkout isn’t available right now.');
  let res;
  try {
    res = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: addr, email_confirm: true }),
      signal: AbortSignal.timeout(10000),
    });
  } catch { res = null; }
  if (res && res.ok) {
    const u = await res.json().catch(() => ({}));
    const id = u.id || (u.user && u.user.id);
    if (id) return { id, email: addr };
  }
  // Created by a parallel request (or already registered): look it up again.
  const again = await find();
  if (again) return { id: again.id, email: addr };
  console.error('[so] could not create account', res && res.status);
  throw new HttpError(503, 'auth_unreachable', 'We couldn’t start your checkout just now. Please try again.');
}

async function startCheckout({ sql, req, now }) {
  const b = H.body(req);
  // Bots fill every field; people never see this one.
  if (b.company_website) throw new HttpError(400, 'invalid_input', 'Please try again.');
  const app = intake.parseApplication(b);
  const name = `${app.first_name} ${app.last_name}`;
  if (b.eligible !== true) throw new HttpError(400, 'invalid_input', 'Please confirm you own a business with customers and revenue.');
  if (b.terms !== true) throw new HttpError(400, 'invalid_input', 'Please agree to the Terms, Privacy Policy and refund policy.');
  const signedIn = await getAuthUser(req).catch(() => null);
  const addr = signedIn ? signedIn.email : normEmail(b.email);
  await H.rateLimit(sql, `start:${H.clientIp(req)}`, 20, 3600);
  await H.rateLimit(sql, `start-email:${addr}`, 10, 3600);

  const cohort = await C.loadCohort(sql);
  const user = signedIn || await findOrCreateUser(sql, addr);
  await sql`insert into so_profiles (user_id, email, display_name, eligibility_confirmed_at, terms_accepted_at)
            values (${user.id}, ${addr}, ${name}, now(), now())
            on conflict (user_id) do update set display_name = coalesce(so_profiles.display_name, excluded.display_name),
              eligibility_confirmed_at = coalesce(so_profiles.eligibility_confirmed_at, now()), terms_accepted_at = now(), updated_at = now()`;
  // Saved before payment, so Omi has it even if they never finish.
  await intake.saveApplication(sql, user.id, cohort.id, app);
  await sql`insert into so_leads (cohort_id, email, name, user_id, eligibility_confirmed_at, terms_accepted_at)
            values (${cohort.id}, ${addr}, ${name}, ${user.id}, now(), now())
            on conflict (cohort_id, email) do update set name = excluded.name, user_id = excluded.user_id,
              terms_accepted_at = now(), checkout_count = so_leads.checkout_count + 1, last_checkout_at = now(), updated_at = now()`;

  const out = await payments.checkoutFor(sql, req, now, user);
  // Never reveal enrollment details for an email the visitor hasn't proven they own.
  if (out.state === 'already_enrolled' && !signedIn) {
    return { state: 'already_enrolled', login_url: `${env.BASE_PATH}/login?next=%2Fapp&email=${encodeURIComponent(addr)}` };
  }
  return out;
}

async function markLeadPaid(sql, purchase) {
  await sql`update so_leads set status = 'paid', paid_at = coalesce(paid_at, now()), updated_at = now()
            where cohort_id = ${purchase.cohort_id} and (user_id = ${purchase.user_id}
              or email = (select lower(email) from so_profiles where user_id = ${purchase.user_id}))`;
}

// One reminder, at least 24 hours after their last checkout, while enrollment is open.
async function sendDueReminders(sql, now, { actor = 'system' } = {}) {
  const cohort = await C.loadCohort(sql);
  const sched = S.schedule(cohort);
  if (now >= sched.starts_at) return { sent: 0, reason: 'cohort_started' };
  const content = await C.loadContent(sql);
  const sales = await C.salesReadiness(sql, cohort, content, now);
  if (!sales.can_checkout) return { sent: 0, reason: sales.reason || 'checkout_closed' };
  const cutoff = new Date(now.getTime() - REMINDER_AFTER_HOURS * 3600 * 1000);
  const due = await sql`
    select l.* from so_leads l
    where l.cohort_id = ${cohort.id} and l.status = 'started' and l.reminder_sent_at is null and l.unsubscribed_at is null
      and l.last_checkout_at <= ${cutoff}
      and not exists (select 1 from so_enrollments e where e.user_id = l.user_id and e.cohort_id = l.cohort_id and e.access_state = 'active')
    order by l.last_checkout_at limit 200`;
  const ids = [];
  for (const l of due) {
    const vars = {
      ...(await email.baseVars(sql, cohort, l.user_id)),
      first_name: l.name.trim().split(/\s+/)[0] || 'there',
      checkout_link: `${env.siteUrl()}${env.BASE_PATH}/checkout`,
      unsubscribe_link: `${env.siteUrl()}/api/so/leads/unsubscribe?token=${l.unsubscribe_token}`,
    };
    const m = await email.enqueue(sql, { key: 'checkout_reminder', dedupeKey: `checkout-reminder:${l.id}`, to: l.email, userId: l.user_id,
      cohortId: cohort.id, vars, related: { type: 'lead', id: l.id }, actor });
    await sql`update so_leads set reminder_sent_at = now(), updated_at = now() where id = ${l.id}`;
    if (m) ids.push(m.id);
  }
  if (ids.length) await email.processOutbox(sql, { ids });
  return { sent: ids.length };
}

function page(res, title, body) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 200;
  res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${H.escapeHtml(title)}</title><link rel="stylesheet" href="${env.BASE_PATH}/assets/so.css"></head>
<body><main id="main" class="band"><div class="wrap narrow"><p class="wordmark">Smooth Operators</p><h1>${H.escapeHtml(title)}</h1>${body}</div></main></body></html>`);
  return H.HANDLED;
}

const routes = {
  'POST checkout/start': startCheckout,
  'GET checkout/form': async () => ({ options: intake.OPTIONS }),

  'GET leads/unsubscribe': async ({ sql, query, res }) => {
    const token = String(query.token || '');
    if (!/^[0-9a-f]{20,64}$/.test(token)) return page(res, 'Link not recognized', '<p>This unsubscribe link isn’t valid.</p>');
    await sql`update so_leads set unsubscribed_at = coalesce(unsubscribed_at, now()), updated_at = now() where unsubscribe_token = ${token}`;
    return page(res, 'You’re unsubscribed', '<p>We won’t send you any more reminders about finishing your enrollment.</p>');
  },

  // Vercel Cron (daily). Vercel sends "Authorization: Bearer $CRON_SECRET".
  'GET cron/reminders': async ({ sql, req, now }) => {
    const secret = process.env.CRON_SECRET;
    const given = Buffer.from(String(req.headers.authorization || ''));
    const want = Buffer.from(`Bearer ${secret || ''}`);
    if (!secret || given.length !== want.length || !require('crypto').timingSafeEqual(given, want)) throw new HttpError(401, 'unauthorized', 'Not allowed.');
    return sendDueReminders(sql, now, { actor: 'cron' });
  },

  'GET admin/leads': async ({ sql, req, now }) => {
    await requireAdmin(req, sql, 'view');
    const cohort = await C.loadCohort(sql);
    const rows = await sql`select l.id, l.user_id, l.email, l.name, l.status, l.checkout_count, l.created_at, l.last_checkout_at, l.paid_at,
                              l.reminder_sent_at, l.unsubscribed_at, i.phone, i.postal_code, i.business_name, i.revenue_to_date, i.years_in_business
                           from so_leads l left join so_intakes i on i.user_id = l.user_id and i.cohort_id = l.cohort_id
                           where l.cohort_id = ${cohort.id} order by (l.status = 'started') desc, l.last_checkout_at desc limit 500`;
    const leads = rows.map(r => ({ ...r, revenue_label: r.revenue_to_date ? intake.label('revenue_to_date', r.revenue_to_date) : null,
      years_label: r.years_in_business ? intake.label('years_in_business', r.years_in_business) : null }));
    const cutoff = new Date(now.getTime() - REMINDER_AFTER_HOURS * 3600 * 1000);
    return {
      leads,
      counts: { started: leads.filter(l => l.status === 'started').length, paid: leads.filter(l => l.status === 'paid').length },
      due: leads.filter(l => l.status === 'started' && !l.reminder_sent_at && !l.unsubscribed_at && new Date(l.last_checkout_at) <= cutoff).length,
      cron_configured: !!process.env.CRON_SECRET,
      reminder_after_hours: REMINDER_AFTER_HOURS,
    };
  },

  'POST admin/leads/remind': async ({ sql, req, now }) => {
    const who = await requireAdmin(req, sql, 'settings');
    return sendDueReminders(sql, now, { actor: who.actor });
  },
};

module.exports = { routes, markLeadPaid, sendDueReminders, findOrCreateUser };
