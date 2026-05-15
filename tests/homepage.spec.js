const { test, expect } = require('@playwright/test');

test.describe('Homepage', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('loads and shows hero headline', async ({ page }) => {
    await expect(page).toHaveTitle(/Omi Bell/);
    await expect(page.locator('.hero')).toBeVisible();
  });

  test('hero discovery call button points to Calendly', async ({ page }) => {
    const btn = page.locator('.hero .btn-primary');
    await expect(btn).toHaveAttribute('href', 'https://calendly.com/omitheintuitive/discoverycall');
  });

  test('booking CTA discovery call button points to Calendly', async ({ page }) => {
    const btn = page.locator('.booking .btn-white');
    await expect(btn).toHaveAttribute('href', 'https://calendly.com/omitheintuitive/discoverycall');
  });

  test('nav links are visible', async ({ page }) => {
    await expect(page.locator('nav')).toBeVisible();
    await expect(page.locator('nav a[href="/#about"]')).toBeVisible();
    await expect(page.locator('nav a[href="/#services"]')).toBeVisible();
    await expect(page.locator('nav a[href="/contact"]')).toBeVisible();
  });

  test('newsletter form accepts email and shows success', async ({ page }) => {
    await page.locator('#newsletterForm input[name="email"]').fill('playwright-test@example.com');
    await page.locator('#newsletterForm input[name="name"]').fill('Test');

    await page.route('/api/subscribe', async route => {
      await route.fulfill({ status: 200, body: JSON.stringify({ success: true }) });
    });

    await page.locator('#newsletterForm button[type="submit"]').click();
    await expect(page.locator('#newsletterSuccess')).toBeVisible();
  });

  test('newsletter form requires email', async ({ page }) => {
    await page.locator('#newsletterForm button[type="submit"]').click();
    const emailInput = page.locator('#newsletterForm input[name="email"]');
    await expect(emailInput).toBeFocused();
  });
});
