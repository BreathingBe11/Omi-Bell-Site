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

test('founder pays, gets verified access and saves a private reflection', async ({ page }, info) => {
  await setPreCohort();
  const email = `founder-${info.project.name}@example.com`;

  await page.goto(`${base()}/smoothoperators`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('You’ve built a business. Now stop being what holds it together.');
  await expect(page.getByText('January 4–24, 2027').first()).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.locator('#hero-cta').click();

  await expect(page.getByRole('heading', { name: 'Join Smooth Operators' })).toBeVisible();
  await expect(page.getByText('Test mode.')).toBeVisible();
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send my code' }).click();
  await page.getByLabel('Sign-in code').fill('123456');
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Fit check (required before payment).
  await expect(page.getByRole('heading', { name: 'Fit check' })).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.getByLabel('First name').fill('Ada');
  await page.getByLabel('Last name').fill('Lovelace');
  await page.getByLabel('Phone number').fill('(555) 555-0100');
  await page.getByLabel('Business name').fill('Analytical Ops');
  await page.getByLabel('Website', { exact: true }).fill('analytical.example.com');
  await page.getByLabel('Street address').fill('12 Engine Way');
  await page.getByLabel('City').fill('Oakland');
  await page.getByLabel('State').selectOption('CA');
  await page.getByLabel('ZIP code').fill('94612');
  await page.getByText('Growing: steady, repeat revenue').click();
  await page.getByText('$100K–$250K').click();
  await page.getByText('3–5 years').click();
  await page.getByRole('group', { name: /operations work before/ }).getByText('No').click();
  await page.getByRole('group', { name: /full-time staff/ }).getByText('Yes').click();
  await page.getByText('3–5 people').click();
  await page.getByLabel('What are your most pressing questions about operations?').fill('How do I hand off client onboarding?');
  await page.getByRole('button', { name: 'Save and continue to payment' }).click();
  await expect(page.getByRole('alert')).toContainText(/refund policy/);
  await page.getByLabel(/I understand: if it isn’t the right fit/).check();
  await page.getByRole('button', { name: 'Save and continue to payment' }).click();
  await expect(page.getByText('Fit check complete.')).toBeVisible();

  const pay = page.getByRole('button', { name: 'Continue to secure payment — $999' });
  await expect(pay).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await pay.click();

  // Stripe test double's hosted page.
  await expect(page.locator('#amount')).toHaveText('99900');
  await page.locator('#pay').click();

  await expect(page.getByRole('heading', { name: 'Payment confirmed' })).toBeVisible({ timeout: 15000 });
  await page.getByRole('link', { name: 'See my enrollment status' }).click();

  // Under review: status, receipt and help only. Cohort pages redirect here.
  await expect(page.getByRole('heading', { name: 'Your enrollment is under review' })).toBeVisible();
  await expect(page.getByText(/within 3 business days/)).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.goto(`${base()}/smoothoperators/app/calendar`);
  await expect(page.getByRole('heading', { name: 'Your enrollment is under review' })).toBeVisible();
  await page.goto(`${base()}/smoothoperators`);
  await expect(page.locator('#hero-cta')).toHaveText('My enrollment');

  // Omi approves.
  await sql`update so_enrollments set review_state = 'approved', reviewed_at = now(), reviewed_by = 'e2e'
            where user_id = (select user_id from so_profiles where email = ${email})`;
  await page.goto(`${base()}/smoothoperators/app`);

  await expect(page.getByRole('heading', { name: 'You’re in. Let’s build what comes next.' })).toBeVisible();
  await expect(page.getByText('You know how to generate business. We’ll help you build the operations to handle what comes next.')).toBeVisible();
  await expect(page.getByText(/Meet your cohort starting December 1/)).toBeVisible();
  await expect(page.getByText('You’re approved.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Introduce Yourself' })).toHaveCount(0);
  await expect(page.locator('[data-countdown]')).toBeVisible();
  expect(await axe(page)).toEqual([]);

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
  await expect(page.getByRole('tab', { name: 'Templates' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Breathwork & Meditation' }).click();
  await expect(page.getByText('Guided practices will appear here as each day unlocks.')).toBeVisible();
  expect(await axe(page)).toEqual([]);

  await page.goto(`${base()}/smoothoperators/app/calls-help`);
  await expect(page.getByText('Solutions Seat dates will appear here once they’re scheduled.')).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.getByRole('tab', { name: 'FAQs & Support' }).click();
  await expect(page.getByText('Support contact details will be posted here before the cohort begins.')).toBeVisible();
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

test('Continue with Google signs in and returns to checkout', async ({ page }) => {
  await page.goto(`${base()}/smoothoperators/checkout`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page).toHaveURL(/\/smoothoperators\/checkout/);
  await expect(page.getByRole('heading', { name: 'Fit check' })).toBeVisible();
  await page.goto(`${base()}/smoothoperators/login`);
  await expect(page.getByText(/Signed in as/)).toContainText('google-user@gmail.com');
});
