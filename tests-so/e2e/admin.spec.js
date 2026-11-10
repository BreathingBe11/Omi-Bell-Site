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
  await expect(page.getByText('Blocks live sales')).toBeVisible();
  await expect(page.getByText('Post-cohort access policy')).toBeVisible();
  const v = (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations;
  expect(v.map(x => x.id)).toEqual([]);

  await page.goto(`${base()}/smoothoperators/admin#days/7`);
  await expect(page.getByRole('heading', { name: 'Day 7' })).toBeVisible();
  await page.getByLabel('Status').selectOption('published');
  await page.getByRole('button', { name: 'Save day' }).click();
  await expect(page.getByText(/Mark this day’s content as reviewed and final/)).toBeVisible();
  await page.getByLabel(/Content reviewed and final/).check();
  await page.getByRole('button', { name: 'Save day' }).click();
  await expect(page.locator('#dmsg')).toHaveText('Saved.');

  await page.goto(`${base()}/smoothoperators/admin#cohort`);
  await page.getByLabel('Daily unlock time').fill('06:00');
  await page.getByRole('button', { name: 'Preview impact' }).click();
  await expect(page.getByText('Impact preview (not saved)')).toBeVisible();
  await expect(page.locator('td.changed').first()).toBeVisible();

  await page.goto(`${base()}/smoothoperators/admin#preview`);
  await page.getByRole('button', { name: 'Before introductions' }).click();
  await expect(page.getByText(/Welcome \+ countdown; introductions teaser/)).toBeVisible();
  await page.getByRole('button', { name: 'After the cohort' }).click();
  await expect(page.getByText(/completion view/)).toBeVisible();
});

test('/admin hub leads to the blog admin or the Smooth Operators admin; members show fit checks', async ({ page }) => {
  const sql = require('postgres')(process.env.SO_DATABASE_URL, { max: 1, onnotice: () => {} });
  const uid = require('crypto').randomUUID();
  await sql`insert into auth.users (id, email) values (${uid}, 'grace@example.com')`;
  await sql`insert into so_profiles (user_id, email) values (${uid}, 'grace@example.com')`;
  const c = (await sql`select id from so_cohorts where is_default`)[0];
  await sql`insert into so_intakes (user_id, cohort_id, first_name, last_name, business_name, website_url, phone, address_line1, city, state,
            postal_code, business_stage, revenue_to_date, years_in_business, prior_ops_work, has_full_time_staff, team_size, ops_questions, policy_ack_at)
            values (${uid}, ${c.id}, 'Grace', 'Hopper', 'Compiler Co', 'https://compiler.example.com', '555-555-0199', '9 Navy Rd', 'Arlington', 'VA',
            '22201', 'growing', '100k_250k', '6_10', true, true, '6_10', 'How do I build a weekly review?', now())`;
  await sql`insert into so_enrollments (user_id, cohort_id, source) values (${uid}, ${c.id}, 'stripe')`;
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
  await expect(page.getByText('Seats (private)')).toBeVisible();
  await page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: 'Members' }).click();
  await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();
  const card = page.locator('[data-member]').filter({ hasText: 'Grace Hopper' }).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Pending review');
  await expect(card).toContainText('$100K–$250K');
  await expect(card).toContainText('22201');
  await expect(card).toContainText('How do I build a weekly review?');
  const v = (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations;
  expect(v.map(x => x.id)).toEqual([]);
  page.on('dialog', d => (d.type() === 'prompt' ? d.accept('') : d.accept()));
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('[data-member]').filter({ hasText: 'Grace Hopper' }).first()).toContainText('Approved');
  await page.getByRole('link', { name: '← Omi Bell admin' }).click();
  await page.getByRole('button', { name: /Blog admin/ }).click();
  await expect(page.getByRole('button', { name: '+ New Post' })).toBeVisible();
});
