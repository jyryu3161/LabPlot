const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [['list']],
  use: {
    // Keep the API fixture target (QA_BASE) independent from the page under
    // test so a locally built frontend can exercise the real QA backend.
    baseURL: process.env.QA_PAGE_BASE || process.env.QA_BASE || 'https://labplotai.com',
    viewport: { width: 1440, height: 1400 },
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // Opt-in for a locally served frontend that intentionally calls a QA API
    // on another origin. Deployed-site runs never set this flag.
    launchOptions: process.env.QA_LOCAL_CROSS_ORIGIN === '1'
      ? { args: ['--disable-web-security'] }
      : undefined,
  },
});
