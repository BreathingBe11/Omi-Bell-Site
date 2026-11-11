'use strict';
// Admin workspace: role-protected, edits/publishes a day, previews schedule impact
// and lifecycle states without touching real data.
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

const base = () => process.env.SO_E2E_BASE;
test.beforeEach(({ }, info) => { test.skip(info.project.name !== 'desktop', 'admin checks run once'); });

test('admin requires login', async ({ page }) => {
  await page.goto(`${base()}/smoothoperators/admin`);
  await expect(page.getByRole('heading', { name: 'Smooth Operators admin' })).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
});

test('admin overview, day publishing, impact preview and lifecycle preview', async ({ page }) => {
  await page.addInitScript(t => sessionStorage.setItem('ob_admin_token', t), process.env.SO_E2E_ADMIN_TOKEN);
  await page.goto(`${base()}/smoothoperators/admin#overview`);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Needs your attention')).toBeVisible();
  await expect(page.locator('.admin-nav a')).toHaveText(['Overview', 'Members', 'Sales', 'Program', 'Solutions Seat', 'Progress', 'Emails & Settings']);
  const v = (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations;
  expect(v.map(x => x.id)).toEqual([]);

  await page.goto(`${base()}/smoothoperators/admin#settings/readiness`);
  await expect(page.getByText('Blocks live sales')).toBeVisible();
  await expect(page.getByText('Tax treatment statement (published)')).toBeVisible();
  await page.goto(`${base()}/smoothoperators/admin#program/days/7`);
  await expect(page.getByRole('heading', { name: 'Day 7' })).toBeVisible();
  await page.getByLabel('Status').selectOption('published');
  await page.getByRole('button', { name: 'Save day' }).click();
  await expect(page.getByText(/Mark this day’s content as reviewed and final/)).toBeVisible();
  await page.getByLabel(/Content reviewed and final/).check();
  await page.getByRole('button', { name: 'Save day' }).click();
  await expect(page.locator('#dmsg')).toHaveText('Saved.');

  await page.goto(`${base()}/smoothoperators/admin#settings/cohort`);
  await page.getByLabel('Daily unlock time').fill('06:00');
  await page.getByRole('button', { name: 'Preview impact' }).click();
  await expect(page.getByText('Impact preview (not saved)')).toBeVisible();
  await expect(page.locator('td.changed').first()).toBeVisible();

  await page.goto(`${base()}/smoothoperators/admin#program/preview`);
  await page.getByRole('button', { name: 'Before introductions' }).click();
  await expect(page.getByText(/Welcome \+ countdown; introductions teaser/)).toBeVisible();
  await page.getByRole('button', { name: 'After the cohort' }).click();
  await expect(page.getByText(/completion view/)).toBeVisible();
});

test('/admin hub leads to the blog admin or the Smooth Operators admin; refunds replace approvals', async ({ page }) => {
  const sql = require('postgres')(process.env.SO_DATABASE_URL, { max: 1, onnotice: () => {} });
  const uid = require('crypto').randomUUID();
  await sql`insert into auth.users (id, email) values (${uid}, 'grace@example.com')`;
  await sql`insert into so_profiles (user_id, email, display_name) values (${uid}, 'grace@example.com', 'Grace Hopper')`;
  const c = (await sql`select id from so_cohorts where is_default`)[0];
  const p = (await sql`insert into so_purchases (user_id, cohort_id, status, price_tier, amount_cents, amount_paid_cents, paid_at, stripe_payment_intent_id, livemode)
                       values (${uid}, ${c.id}, 'paid', 'intro', 99900, 99900, now(), ${`pi_e2e_${uid.slice(0, 8)}`}, false) returning id`)[0];
  await sql`insert into so_enrollments (user_id, cohort_id, purchase_id, source) values (${uid}, ${c.id}, ${p.id}, 'stripe')`;
  await sql`update so_cohorts set start_date = '2027-01-04' where is_default`;
  await sql.end();
  await page.addInitScript(t => sessionStorage.setItem('ob_admin_token', t), process.env.SO_E2E_ADMIN_TOKEN);
  // The existing /admin loads a CDN script; the offline test sandbox can't reach it.
  await page.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'text/javascript',
    path: require('path').join(__dirname, '../../smoothoperators/assets/vendor/supabase-2.106.1.js') }));
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.goto(`${base()}/admin`);
  await expect(page.getByRole('heading', { name: 'Where would you like to go?' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Blog admin/ })).toBeVisible();
  await page.getByRole('link', { name: /Smooth Operators admin/ }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Enrolled members')).toBeVisible();
  await expect(page.getByText('Profiles awaiting review')).toHaveCount(0);
  await page.goto(`${base()}/smoothoperators/admin#members/all`);
  const row = page.locator('.member-table tr').filter({ hasText: 'Grace Hopper' });
  await row.getByRole('button', { name: 'Grace Hopper' }).click();
  const card = page.getByRole('dialog');
  await expect(card.getByRole('heading', { name: 'Grace Hopper' })).toBeVisible();
  await expect(card.getByText('Enrolled', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Reject' })).toHaveCount(0);
  const v = (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations;
  expect(v.map(x => x.id)).toEqual([]);
  await card.getByRole('button', { name: 'Refund in full…' }).click();
  await expect(card.getByRole('heading', { name: 'Refund $999 in full' })).toBeVisible();
  await card.getByRole('button', { name: 'Cancel' }).click();
  await card.getByRole('button', { name: 'Close' }).click();
  await expect(card).toBeHidden();
  await page.getByRole('link', { name: '← Omi Bell admin' }).click();
  await page.getByRole('button', { name: /Blog admin/ }).click();
  await expect(page.getByRole('button', { name: '+ New Post' })).toBeVisible();
});
