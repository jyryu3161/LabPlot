const { test, expect } = require('@playwright/test');
const { ENV, attachConsole, apiLogin, authedPage } = require('../helpers');

const PUBLIC = ['/', '/login', '/register', '/gallery', '/forgot-password'];
for (const p of PUBLIC) {
  test(`public page loads clean: ${p}`, async ({ page }) => {
    const errors = [];
    attachConsole(page, errors);
    const resp = await page.goto(p, { waitUntil: 'networkidle' });
    expect(resp.status(), `HTTP status for ${p}`).toBeLessThan(400);
    await page.waitForTimeout(800);
    expect(errors, `console errors on ${p}: ${errors.join(' | ')}`).toEqual([]);
  });
}

const AUTHED = ['/figures', '/datasets', '/projects', '/account', '/admin', '/gallery'];
for (const p of AUTHED) {
  test(`authed page loads clean: ${p}`, async ({ page, request }) => {
    const errors = [];
    attachConsole(page, errors);
    const tokens = await apiLogin(request);
    await authedPage(page, tokens);
    const resp = await page.goto(p, { waitUntil: 'networkidle' });
    expect(resp.status(), `HTTP status for ${p}`).toBeLessThan(400);
    await page.waitForTimeout(1200);
    expect(errors, `console errors on ${p}: ${errors.join(' | ')}`).toEqual([]);
  });
}
