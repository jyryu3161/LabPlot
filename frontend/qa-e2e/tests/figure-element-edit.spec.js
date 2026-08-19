const { test, expect } = require('@playwright/test');
const {
  ENV,
  apiLogin,
  authedPage,
  cleanupAndVerifySourceFigure,
  duplicateFigure,
  figureVersionState,
  getFigure,
} = require('../helpers');

// U6: Prism-style element editing on the FIGURE page — clicking the axis-label
// hit target edits the DRAFT options (no render), and the page's normal Apply
// commits it. Server truth = current version options after Apply.
test.describe('figure page element editing (U6)', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a figure id');
  let tokens, auth, figureId, sourceState;

  const currentOptions = async (request, auth, figId) => {
    const fig = await getFigure(request, auth, figId);
    const v = fig.versions.find((x) => x.id === fig.current_version_id) ?? fig.versions[0];
    return v?.options ?? {};
  };

  test.beforeEach(async ({ request }) => {
    test.setTimeout(180000);
    tokens = await apiLogin(request);
    auth = { Authorization: `Bearer ${tokens.access_token}` };
    figureId = null;
    sourceState = figureVersionState(await getFigure(request, auth, ENV.FIG));
    figureId = (await duplicateFigure(request, auth, ENV.FIG)).id;
  });

  test.afterEach(async ({ request }) => {
    await cleanupAndVerifySourceFigure(request, auth, [
      { collection: 'figures', id: figureId },
    ], ENV.FIG, sourceState);
  });

  test('inline x-label draft edit -> Apply commits a version with the new label', async ({ page, request }) => {
    test.setTimeout(180000); // duplicate + Apply are both real R renders
    const before = await currentOptions(request, auth, figureId);

    await authedPage(page, tokens);
    await page.goto(`/figures/${figureId}`, { waitUntil: 'networkidle' });

    // Element hit target renders over the preview (annotation mode off).
    const target = page.getByRole('button', { name: 'Edit x axis label', exact: true });
    await expect(target).toBeVisible({ timeout: 20000 });
    await target.click();
    const input = page.getByRole('textbox', { name: 'x axis label text' });
    await expect(input).toBeVisible();
    await input.fill('U6 Draft Label');
    await input.press('Enter');

    // Draft only — server unchanged until Apply.
    expect((await currentOptions(request, auth, figureId)).x_label ?? '').toBe(before.x_label ?? '');

    await page.getByRole('button', { name: 'Apply changes (new version)' }).click();
    await expect.poll(async () => (await currentOptions(request, auth, figureId)).x_label, { timeout: 45000 })
      .toBe('U6 Draft Label');
  });
});
