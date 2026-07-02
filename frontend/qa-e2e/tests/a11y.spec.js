const { test, expect } = require('@playwright/test');
const { apiLogin, authedPage, runAxe } = require('../helpers');

const PUBLIC = ['/', '/login', '/gallery', '/register'];
for (const p of PUBLIC) {
  test(`a11y (WCAG A/AA) public: ${p}`, async ({ page }) => {
    await page.goto(p, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const v = await runAxe(page);
    const critical = v.filter((x) => x.impact === 'critical');
    const serious = v.filter((x) => x.impact === 'serious');
    console.log(`[a11y ${p}] total=${v.length} critical=${critical.length} serious=${serious.length}`);
    v.forEach((x) => console.log(`   - ${x.impact}: ${x.id} (${x.n}) — ${x.help}`));
    expect(critical, `critical a11y violations on ${p}`).toEqual([]);
  });
}

const AUTHED = ['/figures', '/account', '/datasets'];
for (const p of AUTHED) {
  test(`a11y (WCAG A/AA) authed: ${p}`, async ({ page, request }) => {
    const tokens = await apiLogin(request);
    await authedPage(page, tokens);
    await page.goto(p, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    const v = await runAxe(page);
    const critical = v.filter((x) => x.impact === 'critical');
    console.log(`[a11y ${p}] total=${v.length} critical=${critical.length}`);
    v.forEach((x) => console.log(`   - ${x.impact}: ${x.id} (${x.n}) — ${x.help}`));
    expect(critical, `critical a11y violations on ${p}`).toEqual([]);
  });
}
