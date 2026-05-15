const { test, expect } = require('@playwright/test');

test.describe('Contact page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/contact');
  });

  test('loads at clean URL /contact', async ({ page }) => {
    await expect(page).toHaveURL('https://omibell.com/contact');
    await expect(page.locator('#contactForm')).toBeVisible();
  });

  test('inquiry type tabs switch correctly', async ({ page }) => {
    await page.locator('.inquiry-tab', { hasText: 'Speaking & Media' }).click();
    await expect(page.locator('#inquiryTypeInput')).toHaveValue('Speaking & Media');

    await page.locator('.inquiry-tab', { hasText: 'Coaching' }).click();
    await expect(page.locator('#inquiryTypeInput')).toHaveValue('Coaching');
  });

  test('form requires first name, email, and message', async ({ page }) => {
    await page.locator('button.btn-submit').click();
    await expect(page.locator('#firstName')).toBeFocused();
  });

  test('successful submission shows success message', async ({ page }) => {
    await page.route('/api/contact', async route => {
      await route.fulfill({ status: 200, body: JSON.stringify({ success: true }) });
    });

    await page.locator('#firstName').fill('Test');
    await page.locator('#lastName').fill('User');
    await page.locator('#email').fill('playwright-test@example.com');
    await page.locator('#message').fill('This is a test message from Playwright.');
    await page.locator('button.btn-submit').click();

    await expect(page.locator('#successMsg')).toBeVisible();
    await expect(page.locator('#contactForm')).toBeHidden();
  });

  test('failed submission shows error', async ({ page }) => {
    await page.route('/api/contact', async route => {
      await route.fulfill({ status: 500, body: JSON.stringify({ error: 'Server error' }) });
    });

    await page.locator('#firstName').fill('Test');
    await page.locator('#lastName').fill('User');
    await page.locator('#email').fill('playwright-test@example.com');
    await page.locator('#message').fill('This is a test message.');

    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('button.btn-submit').click();

    await expect(page.locator('#contactForm')).toBeVisible();
  });

  test('nav Contact link stays on /contact', async ({ page }) => {
    await page.locator('nav a[href="/contact"]').click();
    await expect(page).toHaveURL('https://omibell.com/contact');
    await expect(page.locator('#contactForm')).toBeVisible();
  });
});
