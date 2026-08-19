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

// U5: click an axis tick strip on a selected panel -> anchored popover edits
// range/ticks/scale via existing universal options; one Apply = one version.
test.describe('canvas axis popover (U5)', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a figure id');
  let tokens, auth, figureId, canvasId, sourceState;

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
    canvasId = null;
    sourceState = figureVersionState(await getFigure(request, auth, ENV.FIG));
    figureId = (await duplicateFigure(request, auth, ENV.FIG)).id;
  });

  test.afterEach(async ({ request }) => {
    await cleanupAndVerifySourceFigure(request, auth, [
      { collection: 'canvases', id: canvasId },
      { collection: 'figures', id: figureId },
    ], ENV.FIG, sourceState);
  });

  test('x-axis min/max apply + toast undo restores auto', async ({ page, request }) => {
    test.setTimeout(180000); // two R renders + preview refetches
    const c = await (await request.post(`${ENV.BASE}/api/canvases`, {
      headers: auth, data: { name: 'Axis QA', width_mm: 210, height_mm: 297 },
    })).json();
    canvasId = c.id;
    await request.post(`${ENV.BASE}/api/canvases/${c.id}/panels`, {
      headers: auth, data: { figure_id: figureId, x_mm: 20, y_mm: 20, width_mm: 120, height_mm: 80, label: 'A' },
    });
    // The duplicate inherits the source's current options. Normalize its range
    // so the popover always has a real change to commit.
    let before = await currentOptions(request, auth, figureId);
    if (before.x_min !== undefined || before.x_max !== undefined) {
      const rest = { ...before };
      delete rest.x_min;
      delete rest.x_max;
      await request.post(`${ENV.BASE}/api/figures/${figureId}/rerender`, {
        headers: auth, data: { options: rest, change_note: 'QA: reset axis range' },
      });
      before = await currentOptions(request, auth, figureId);
    }

    await authedPage(page, tokens);
    await page.goto(`/canvases/${c.id}`, { waitUntil: 'networkidle' });
    const stage = page.locator('canvas').first();
    await expect(stage).toBeVisible();
    const box = await stage.boundingBox();
    await page.mouse.click(box.x + box.width * 0.46, box.y + box.height * 0.30); // select panel

    await page.getByRole('button', { name: 'Edit x axis', exact: true }).click();
    const popover = page.getByRole('dialog', { name: 'Edit x axis' });
    await expect(popover).toBeVisible();
    await popover.getByLabel('Min').fill('0');
    await popover.getByLabel('Max').fill('4000');
    await popover.getByRole('button', { name: 'Apply axis' }).click();

    await expect.poll(async () => {
      const o = await currentOptions(request, auth, figureId);
      return [o.x_min, o.x_max].join(',');
    }, { timeout: 30000 }).toBe('0,4000');

    // one-shot Undo restores the pre-edit state (unset -> auto range)
    await page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => {
      const o = await currentOptions(request, auth, figureId);
      return [o.x_min ?? 'unset', o.x_max ?? 'unset'].join(',');
    }, { timeout: 30000 }).toBe(`${before.x_min ?? 'unset'},${before.x_max ?? 'unset'}`);
  });
});
