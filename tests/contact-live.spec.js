const { test, expect } = require('@playwright/test');

// Live integration test — hits the real /api/contact on omibell.com.
// A test subscriber will be created in MailerLite; delete it after confirming.
test('live contact form sends to MailerLite', async ({ page }) => {
  let apiStatus = null;
  let apiBody = null;

  page.on('response', async res => {
    if (res.url().includes('/api/contact')) {
      apiStatus = res.status();
      try { apiBody = await res.json(); } catch {}
    }
  });

  await page.goto('/contact');
  await expect(page.locator('#contactForm')).toBeVisible();

  await page.locator('.inquiry-tab', { hasText: 'General' }).click();
  await page.locator('#firstName').fill('Playwright');
  await page.locator('#lastName').fill('Test');
  await page.locator('#email').fill('test+omilive@omisworld.com');
  await page.locator('#message').fill('Automated live test — safe to delete from MailerLite.');

  await page.locator('button.btn-submit').click();

  // Wait for the success message (or a timeout indicating failure)
  await expect(page.locator('#successMsg')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#contactForm')).toBeHidden();

  // Confirm the API returned 200
  expect(apiStatus).toBe(200);
  expect(apiBody).toMatchObject({ success: true });
});
