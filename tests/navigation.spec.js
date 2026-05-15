const { test, expect } = require('@playwright/test');

test.describe('Navigation & clean URLs', () => {
  const pages = [
    { path: '/', title: /Omi Bell/ },
    { path: '/contact', title: /Contact/ },
    { path: '/blog', title: /Blog/ },
  ];

  for (const { path, title } of pages) {
    test(`${path} loads without 404`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res.status()).not.toBe(404);
      await expect(page).toHaveTitle(title);
    });
  }

  test('no .html extension needed for /contact', async ({ page }) => {
    const res = await page.goto('/contact');
    expect(res.status()).toBe(200);
  });

  test('no .html extension needed for /blog', async ({ page }) => {
    const res = await page.goto('/blog');
    expect(res.status()).toBe(200);
  });
});
