'use strict';
// End-to-end: landing -> sign in -> verified (test-double) payment -> welcome
// -> day 1 -> private reflection that survives reload. Plus navigation and
// accessibility checks on the main screens.
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const postgres = require('postgres');

const base = () => process.env.SO_E2E_BASE;
let sql;
test.beforeAll(() => { sql = postgres(process.env.SO_DATABASE_URL, { max: 1, onnotice: () => {} }); });
test.afterAll(async () => { await sql.end({ timeout: 1 }); });

async function setPreCohort() {
  await sql`update so_cohorts set start_date = '2027-01-04', intro_opens_at = '2026-12-01T08:00:00Z', price_cutoff_at = '2026-12-01T08:00:00Z' where is_default`;
}
async function setLiveDay1AndPublish() {
  await sql`update so_cohorts set start_date = (now() at time zone timezone)::date, intro_opens_at = now() - interval '30 days' where is_default`;
  await sql`update so_days set status = 'published', is_sample = false, preview_published = true, published_at = now() where day_number in (1, 2)`;
}
async function axe(page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  return r.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);
}

test('business owner pays, is enrolled right away and saves a private reflection', async ({ page }, info) => {
  await setPreCohort();
  const email = `founder-${info.project.name}@example.com`;

  await page.goto(`${base()}/smoothoperators`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your business is growing. Your room to breathe keeps shrinking.');
  await expect(page.getByText('January 4–24, 2027').first()).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.locator('#hero-cta').click();

  // One form, no sign-in first.
  await expect(page.getByRole('heading', { name: 'Join Smooth Operators' })).toBeVisible();
  await expect(page.getByText('Test mode.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send my code' })).toHaveCount(0);
  await expect(page.getByText(/full refund before the cohort begins on January 4, 2027/).first()).toBeVisible();
  expect(await axe(page)).toEqual([]);
  const pay = page.getByRole('button', { name: 'Continue to payment — $997' });
  await page.getByLabel('First name').fill('Ada');
  await page.getByLabel('Last name').fill('Lovelace');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Phone number').fill('(555) 555-0100');
  await page.getByLabel('ZIP code').fill('94612');
  await page.getByLabel('Business name').fill('Analytical Ops');
  await page.getByLabel('Stage of business').selectOption({ label: 'Growing: steady, repeat revenue' });
  await page.getByLabel(/Revenue generated so far/).selectOption({ label: '$100K–$250K' });
  await page.getByLabel('How long have you been in business?').selectOption({ label: '3–5 years' });
  await page.getByLabel(/operations work before/).selectOption({ label: 'No' });
  await page.getByLabel('Do you have full-time staff?').selectOption({ label: 'Yes' });
  await page.getByLabel(/How many people are on your team/).selectOption({ label: '3–5 people' });
  await page.getByLabel('What are your most pressing questions about operations?').fill('How do I hand off client onboarding?');
  await pay.click();
  await expect(page.getByRole('alert')).toContainText(/customers and revenue/);
  await page.getByLabel(/I own a business with customers and revenue/).check();
  await page.getByLabel(/I agree to the Terms/).check();
  await pay.click();

  // Stripe test double's hosted page. The form was saved before Stripe opened.
  await expect(page.locator('#amount')).toHaveText('99700');
  expect((await sql`select status from so_leads where email = ${email}`)[0].status).toBe('started');
  expect((await sql`select revenue_to_date from so_intakes i join so_leads l on l.user_id = i.user_id where l.email = ${email}`)[0].revenue_to_date).toBe('100k_250k');
  await page.locator('#pay').click();

  // Paid: enrolled; set up the account (prefilled email), then into the platform.
  await expect(page.getByRole('heading', { name: 'You’re in.' })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/We’ve emailed/)).toContainText(email);
  expect(await axe(page)).toEqual([]);
  await page.getByRole('link', { name: 'Set up my account' }).click();
  await expect(page.getByLabel('Email address')).toHaveValue(email);
  await page.getByRole('button', { name: 'Send my code' }).click();
  await page.getByLabel('Sign-in code').fill('123456');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'You’re in. Let’s build what comes next.' })).toBeVisible();
  await expect(page.getByText('You know how to generate business. We’ll help you build the operations to handle what comes next.')).toBeVisible();
  await expect(page.getByText(/Meet your cohort starting December 1/)).toBeVisible();
  await expect(page.getByText('You’re enrolled.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Get ready for day one' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Introduce Yourself' })).toHaveCount(0);
  await expect(page.locator('[data-countdown]')).toBeVisible();
  expect(await axe(page)).toEqual([]);

  // My Account (the avatar link beside "My Account"): refunds open until the night before the cohort.
  await page.locator('a[href$="/app/account"]:visible').first().click();
  await expect(page.getByRole('heading', { name: 'Membership' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request a refund' })).toBeVisible();
  await expect(page.getByText(/Jan 3, 2027 · 11:59 PM/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Test Founder');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await expect(page.locator('.account-photo .avatar')).toHaveText('TF');
  expect(await axe(page)).toEqual([]);
  await page.goto(`${base()}/smoothoperators/app`);

  // The cohort goes live and Day 1 is published.
  await setLiveDay1AndPublish();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Where the business depends on you');
  await expect(page.getByText('What stops moving when you step away?')).toBeVisible();
  const box = page.getByLabel(/Your reflection/);
  await box.fill('Invoices stop when I travel. Nobody else knows the follow-up rules.');
  await expect(page.locator('.save-state')).toHaveText('Saved', { timeout: 10000 });
  expect(await axe(page)).toEqual([]);

  await page.reload();
  await expect(page.getByLabel(/Your reflection/)).toHaveValue('Invoices stop when I travel. Nobody else knows the follow-up rules.');
  await page.getByRole('button', { name: 'Complete today' }).click();
  await expect(page.getByText('Day 1 complete.')).toBeVisible();

  // Same record from the calendar and the journal.
  await page.goto(`${base()}/smoothoperators/app/calendar`);
  await expect(page.locator('a.day-card').first()).toContainText('Today');
  await expect(page.locator('.day-card').nth(2)).toContainText('Upcoming');
  expect(await axe(page)).toEqual([]);
  await page.goto(`${base()}/smoothoperators/app/journal`);
  await expect(page.getByText('Invoices stop when I travel.')).toBeVisible();
  // A free entry, without a prompt.
  await page.getByRole('link', { name: 'New entry' }).click();
  await page.getByLabel(/Title/).fill('Ideas for my first hire');
  await page.getByLabel('Your entry').fill('Write down every task I did this week.');
  await expect(page.locator('#n-state')).toHaveText('Saved', { timeout: 10000 });
  await page.goto(`${base()}/smoothoperators/app/journal`);
  await expect(page.getByRole('heading', { name: 'Ideas for my first hire' })).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.goto(`${base()}/smoothoperators/app/day/1`);
  await expect(page.getByLabel(/Your reflection/)).toHaveValue(/Invoices stop/);
  await expect(page.getByText('Day 1 complete.')).toBeVisible();

  // Returning to the landing page offers the cohort, not another purchase.
  await page.goto(`${base()}/smoothoperators`);
  await expect(page.locator('#hero-cta')).toHaveText('Open My Cohort');
});

test('menu: five destinations, keyboard accessible drawer on mobile', async ({ page }, info) => {
  const email = `founder-${info.project.name}@example.com`;
  await page.goto(`${base()}/smoothoperators/login`);
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send my code' }).click();
  await page.getByLabel('Sign-in code').fill('123456');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  const mobile = info.project.name === 'mobile';
  if (mobile) {
    const menu = page.getByRole('button', { name: 'Menu' });
    await menu.click();
    const dialog = page.getByRole('dialog', { name: 'Menu' });
    await expect(dialog).toBeVisible();
    const items = dialog.locator('#drawer-nav a');
    await expect(items).toHaveText(['Today', '21-Day Calendar', 'Library', 'My Journal', 'Calls & Help']);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(menu).toBeFocused();
    await menu.click();
    await page.getByRole('dialog').getByRole('link', { name: 'Library' }).click();
  } else {
    await expect(page.locator('#side-nav a')).toHaveText(['Today', '21-Day Calendar', 'Library', 'My Journal', 'Calls & Help']);
    await page.locator('#side-nav').getByRole('link', { name: 'Library' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Business Action Toolkit' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Guided Audio' }).click();
  await expect(page.getByText('Guided audios will appear here as each day unlocks.')).toBeVisible();
  expect(await axe(page)).toEqual([]);

  await page.goto(`${base()}/smoothoperators/app/calls-help`);
  // The seeded Wednesday Zoom sessions show their date and a Join on Zoom button.
  const firstCall = page.locator('.call-card').first();
  await expect(firstCall).toContainText('Wednesday, January 6');
  await expect(firstCall.getByRole('button', { name: 'Join on Zoom' })).toBeDisabled();
  await expect(firstCall).toContainText('The Join button opens at');
  expect(await axe(page)).toEqual([]);
  await expect(page.getByRole('tab')).toHaveText(['Solutions Seat', 'FAQ', 'Report a bug']);
  await page.getByRole('tab', { name: 'FAQ', exact: true }).click();
  await expect(page.getByRole('button', { name: 'How do I ask Omi questions?' })).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'How do I ask Omi questions?' }).click();
  await expect(page.getByText(/Weekend questions receive a response by the end of Monday/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ask Omi', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Report a bug' }).click();
  await page.getByLabel('What went wrong? (one line)').fill('Test bug');
  await page.getByLabel('What happened, and what did you expect?').fill('Just checking the form.');
  await page.getByRole('button', { name: 'Send bug report' }).click();
  await expect(page.getByText('Thanks, we got it.')).toBeVisible();
});

test('signed-out visitors are sent to sign in; non-members cannot open the cohort', async ({ page }, info) => {
  await page.goto(`${base()}/smoothoperators/app/journal`);
  await expect(page).toHaveURL(/\/smoothoperators\/login\?next=%2Fapp%2Fjournal/);
  await page.getByLabel('Email address').fill(`visitor-${info.project.name}@example.com`);
  await page.getByRole('button', { name: 'Send my code' }).click();
  await page.getByLabel('Sign-in code').fill('123456');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'This space is for enrolled members' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Join the cohort' })).toBeVisible();
});

// Stand-in for Google's script: renders a button and returns an ID token carrying the page's nonce.
const FAKE_GIS = `window.google = { accounts: { id: {
  initialize(c) { window.__gis = c; },
  renderButton(el) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Continue with Google';
    const enc = o => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\\+/g, '-').replace(/\\//g, '_');
    b.onclick = () => window.__gis.callback({ credential: enc({ alg: 'RS256' }) + '.' + enc({ email: 'gis-user@gmail.com', nonce: window.__gis.nonce, aud: window.__gis.client_id }) + '.sig' });
    el.appendChild(b);
  } } } };`;

test('Google’s own button signs in on our page (no redirect), then checkout continues with that email', async ({ page }) => {
  await page.route('https://accounts.google.com/gsi/client', r => r.fulfill({ contentType: 'text/javascript', body: FAKE_GIS }));
  let redirected = false;
  page.on('request', r => { if (r.url().includes('/auth/v1/authorize')) redirected = true; });
  await page.goto(`${base()}/smoothoperators/login?next=%2Fcheckout`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('heading', { name: 'Your application' })).toBeVisible();
  await expect(page.getByLabel('Email address')).toHaveValue('gis-user@gmail.com');
  expect(redirected).toBe(false);
  await page.goto(`${base()}/smoothoperators/login`);
  await expect(page.getByText(/Signed in as/)).toContainText('gis-user@gmail.com');
});

test('if Google’s button can’t load, the fallback Google sign-in still works', async ({ page }) => {
  await page.route('https://accounts.google.com/**', r => r.abort());
  await page.goto(`${base()}/smoothoperators/login?next=%2Fcheckout`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page).toHaveURL(/\/smoothoperators\/checkout/);
  await expect(page.getByRole('heading', { name: 'Your application' })).toBeVisible();
  await page.goto(`${base()}/smoothoperators/login`);
  await expect(page.getByText(/Signed in as/)).toContainText('google-user@gmail.com');
});

test('landing FAQ is an accessible accordion: plus/minus, keyboard, and the same answers in the platform', async ({ page }) => {
  await page.goto(`${base()}/smoothoperators#faq`);
  const first = page.getByRole('button', { name: 'Who is Smooth Operators for?' });
  await expect(first).toHaveAttribute('aria-expanded', 'false');
  const answer = page.locator('#faq-a-0');
  await expect(answer).toBeHidden();
  await first.click();
  await expect(first).toHaveAttribute('aria-expanded', 'true');
  await expect(answer).toBeVisible();
  await first.click();
  await expect(first).toHaveAttribute('aria-expanded', 'false');
  await first.focus();
  await page.keyboard.press('ArrowDown');
  const second = page.getByRole('button', { name: 'Can I participate if I don’t have employees yet?' });
  await expect(second).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(second).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Space');
  await expect(second).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'What is the refund policy?' }).click();
  await expect(page.locator('#faq-a-11')).toContainText('To request a refund before the start date, email hello@omisworld.com');
  expect(await axe(page)).toEqual([]);
});

test('sign-in codes: clear errors, back to the code box after leaving, resend timer', async ({ page }, info) => {
  const email = `code-${info.project.name}@example.com`;
  // Sending fails on the provider side: say so, don't blame the address.
  await page.route('**/auth/v1/otp', r => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 500, error_code: 'unexpected_failure', msg: 'Error sending magic link email' }) }));
  await page.goto(`${base()}/smoothoperators/login`);
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send my code' }).click();
  await expect(page.locator('#email-err')).toContainText('That’s on our side, not your address');
  await page.unroute('**/auth/v1/otp');

  // Too soon after a previous code: show the code box instead of an error.
  await page.route('**/auth/v1/otp', r => r.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ code: 429, error_code: 'over_email_send_rate_limit', msg: 'For security purposes, you can only request this after 45 seconds.' }) }));
  await page.getByRole('button', { name: 'Send my code' }).click();
  await expect(page.locator('#code-intro')).toContainText('We already sent a code to');
  await expect(page.getByRole('button', { name: /Send a new code in \d+s/ })).toBeDisabled();
  await page.unroute('**/auth/v1/otp');

  // A real send, then leave and come back: the code box is waiting.
  await page.getByRole('button', { name: 'Use a different email' }).click();
  await page.getByLabel('Email address').fill(`fresh-${email}`);
  await page.getByRole('button', { name: 'Send my code' }).click();
  await expect(page.getByLabel('Sign-in code')).toBeVisible();
  await page.reload();
  await expect(page.locator('#code-intro')).toContainText(`fresh-${email}`);
  await expect(page.getByRole('button', { name: /Send a new code in \d+s/ })).toBeDisabled();
  expect(await axe(page)).toEqual([]);
  await page.getByLabel('Sign-in code').fill('123456');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /You’re signed in|Join Smooth Operators|This space is for enrolled members/ })).toBeVisible();
});

test('"I already have a code" goes straight to the code box', async ({ page }, info) => {
  await page.goto(`${base()}/smoothoperators/login`);
  await page.getByRole('button', { name: 'I already have a code' }).click();
  await expect(page.locator('#email-err')).toContainText('Enter the email address the code was sent to first.');
  await page.getByLabel('Email address').fill(`have-${info.project.name}@example.com`);
  await page.getByRole('button', { name: 'I already have a code' }).click();
  await expect(page.locator('#code-intro')).toContainText(`have-${info.project.name}@example.com`);
  await expect(page.getByRole('button', { name: 'Send a new code' })).toBeEnabled();
});
