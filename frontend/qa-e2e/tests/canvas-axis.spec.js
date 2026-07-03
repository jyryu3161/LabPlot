const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

// U5: click an axis tick strip on a selected panel -> anchored popover edits
// range/ticks/scale via existing universal options; one Apply = one version.
test.describe('canvas axis popover (U5)', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a figure id');

  const currentOptions = async (request, auth, figId) => {
    const fig = await (await request.get(`${ENV.BASE}/api/figures/${figId}`, { headers: auth })).json();
    const v = fig.versions.find((x) => x.id === fig.current_version_id) ?? fig.versions[0];
    return v?.options ?? {};
  };

  test('x-axis min/max apply + toast undo restores auto', async ({ page, request }) => {
    test.setTimeout(180000); // two R renders + preview refetches
    const tokens = await apiLogin(request);
    const auth = { Authorization: `Bearer ${tokens.access_token}` };
    const c = await (await request.post(`${ENV.BASE}/api/canvases`, {
      headers: auth, data: { name: 'Axis QA', width_mm: 210, height_mm: 297 },
    })).json();
    await request.post(`${ENV.BASE}/api/canvases/${c.id}/panels`, {
      headers: auth, data: { figure_id: ENV.FIG, x_mm: 20, y_mm: 20, width_mm: 120, height_mm: 80, label: 'A' },
    });
    // Idempotence guard: a prior interrupted run may have left x_min/x_max set
    // — the popover would then see no change and skip the commit. Reset first.
    let before = await currentOptions(request, auth, ENV.FIG);
    if (before.x_min !== undefined || before.x_max !== undefined) {
      const { x_min, x_max, ...rest } = before;
      await request.post(`${ENV.BASE}/api/figures/${ENV.FIG}/rerender`, {
        headers: auth, data: { options: rest, change_note: 'QA: reset axis range' },
      });
      before = await currentOptions(request, auth, ENV.FIG);
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
      const o = await currentOptions(request, auth, ENV.FIG);
      return [o.x_min, o.x_max].join(',');
    }, { timeout: 30000 }).toBe('0,4000');

    // one-shot Undo restores the pre-edit state (unset -> auto range)
    await page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => {
      const o = await currentOptions(request, auth, ENV.FIG);
      return [o.x_min ?? 'unset', o.x_max ?? 'unset'].join(',');
    }, { timeout: 30000 }).toBe(`${before.x_min ?? 'unset'},${before.x_max ?? 'unset'}`);

    await request.delete(`${ENV.BASE}/api/canvases/${c.id}`, { headers: auth });
  });
});
