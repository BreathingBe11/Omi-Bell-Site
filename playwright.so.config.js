// Playwright config for the Smooth Operators app (local, offline).
// Boots a fresh database, the dev server and local test doubles in globalSetup.
// Prerequisite: scripts/so-test-db.sh start
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests-so/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: require.resolve('./tests-so/e2e/global-setup.js'),
  use: {
    trace: 'off',
    // Entrance animations are skipped so accessibility checks see final colours.
    contextOptions: { reducedMotion: 'reduce' },
    screenshot: 'only-on-failure',
    // Point at a specific Chromium when the installed Playwright build doesn't match (e.g. CI images).
    ...(process.env.PW_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } } : {}),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
