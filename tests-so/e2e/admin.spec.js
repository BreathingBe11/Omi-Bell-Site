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
