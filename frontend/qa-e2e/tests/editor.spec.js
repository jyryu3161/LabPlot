const { test, expect } = require('@playwright/test');
const {
  ENV,
  attachConsole,
  apiLogin,
  authedPage,
} = require('../helpers');

// The drag-to-place figure annotation tools (Text/Arrow/Box/Bracket behind a
// "Place on figure" toggle) were REMOVED on request (2026-08-19): the flow
// was confusing next to the AI editor's marks and its draft edits kept
// feeding the live-preview pipeline (runaway "Live preview" versions). The
// former placement/drag/delete tests are gone with the feature; this spec now
// asserts the control surface, including that the removed UI stays gone.
test.describe('figure editor', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a continuous-axis figure id to run editor E2E');
  let tokens;
  test.beforeEach(async ({ request }) => { tokens = await apiLogin(request); });

  test('new controls are present, removed annotation UI stays gone, page is error-free', async ({ page }) => {
    const errors = []; attachConsole(page, errors);
    await authedPage(page, tokens);
    await page.goto(`/figures/${ENV.FIG}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Advanced', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Advanced', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const body = await page.evaluate(() => document.body.innerText);
    const required = ['Live preview', 'Duplicate', 'Interactive view', 'Secondary Y', 'X axis type',
      'Legend position', 'Legend direction', 'X tick angle'];
    for (const label of required) expect(body, `control "${label}"`).toContain(label);
    // The removed placement feature must not resurface.
    expect(body, 'Place on figure UI removed').not.toContain('Place on figure');
    await expect(page.getByRole('switch', { name: 'Toggle visual annotation placement' })).toHaveCount(0);
    // export formats
    for (const fmt of ['PNG', 'SVG', 'TIFF', 'PDF', 'EPS', 'R script', 'Python code', 'LaTeX']) expect(body).toContain(fmt);
    // break-axis controls
    expect(body.toLowerCase()).toMatch(/break [xy] axis/);
    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
