const { test, expect } = require('@playwright/test');
const {
  ENV, apiLogin, authedPage, cleanupAndVerifySourceFigure, duplicateFigure, figureVersionState, getFigure,
} = require('../helpers');

// M-C1 §6: POST /api/canvases/{id}/typography — applies a canvas-wide
// typography patch to every distinct figure panel, bumping each figure's
// version. Uses a DUPLICATE of QA_FIG as the panel's figure (never the
// source) so this spec never mutates the shared fixture — same isolation
// pattern as canvas-axis.spec.js. Cleanup goes through cleanupAndVerify
// SourceFigure so a failed delete FAILS the test loudly instead of being
// swallowed, and QA_FIG's own version state is asserted unchanged.
const currentOptions = async (request, auth, figId) => {
  const fig = await getFigure(request, auth, figId);
  const v = fig.versions.find((x) => x.id === fig.current_version_id) ?? fig.versions[fig.versions.length - 1];
  return v?.options ?? {};
};

test.describe('canvas typography (M-C1 §6)', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a figure id');
  let tokens, auth, base, sourceState, figureId, canvasId;
  test.beforeEach(async ({ request }) => {
    tokens = await apiLogin(request);
    auth = { Authorization: `Bearer ${tokens.access_token}` };
    base = ENV.BASE;
    figureId = null;
    canvasId = null;
    sourceState = figureVersionState(await getFigure(request, auth, ENV.FIG));
  });
  test.afterEach(async ({ request }) => {
    await cleanupAndVerifySourceFigure(request, auth, [
      { collection: 'canvases', id: canvasId },
      { collection: 'figures', id: figureId },
    ], ENV.FIG, sourceState);
  });

  test('POST /typography: bumps the panel figure to a new version, and the new version actually carries the typography', async ({ request }) => {
    const copy = await duplicateFigure(request, auth, ENV.FIG);
    figureId = copy.id;
    const before = figureVersionState(copy);

    const c = await (await request.post(`${base}/api/canvases`, {
      headers: auth, data: { name: 'Typography QA', width_mm: 150, height_mm: 100 },
    })).json();
    canvasId = c.id;
    await request.post(`${base}/api/canvases/${c.id}/panels`, {
      headers: auth, data: { figure_id: copy.id, x_mm: 10, y_mm: 10, width_mm: 60, height_mm: 40, label: 'A' },
    });

    const res = await request.post(`${base}/api/canvases/${c.id}/typography`, {
      headers: auth, data: { base_pt: 8, axis_line_width_pt: 0.5 },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.updated).toContain(copy.id);
    expect(body.skipped).not.toContain(copy.id);

    const after = figureVersionState(await getFigure(request, auth, copy.id));
    expect(after.versionCount).toBe(before.versionCount + 1);
    expect(after.currentVersionId).not.toBe(before.currentVersionId);

    // The wrapper reporting "updated" isn't proof the typography landed —
    // read the NEW version's own render options back (finding, dropped-list
    // item: "must verify the typography actually reached the new figure
    // version"). base_pt maps to the figure's absolute base_size (rounded).
    const opts = await currentOptions(request, auth, copy.id);
    expect(opts.base_size).toBe(8);
    expect(opts.axis_line_width_pt).toBe(0.5);

    // The canvas's own style.typography persists the patch for future panels.
    const cv = await (await request.get(`${base}/api/canvases/${c.id}`, { headers: auth })).json();
    expect(cv.style?.typography?.base_pt).toBe(8);
    expect(cv.style?.typography?.axis_line_width_pt).toBe(0.5);
  });

  test('POST /typography with an empty body is rejected (at least one key required)', async ({ request }) => {
    const c = await (await request.post(`${base}/api/canvases`, {
      headers: auth, data: { name: 'Typography Empty QA', width_mm: 150, height_mm: 100 },
    })).json();
    canvasId = c.id;
    const res = await request.post(`${base}/api/canvases/${c.id}/typography`, { headers: auth, data: {} });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('Journal panel UI: Apply typography shows the confirm dialog with the figure count, then applies and the new version carries it', async ({ page, request }) => {
    const copy = await duplicateFigure(request, auth, ENV.FIG);
    figureId = copy.id;
    const before = figureVersionState(copy);

    const c = await (await request.post(`${base}/api/canvases`, {
      headers: auth, data: { name: 'Typography UI QA', width_mm: 150, height_mm: 100 },
    })).json();
    canvasId = c.id;
    await request.post(`${base}/api/canvases/${c.id}/panels`, {
      headers: auth, data: { figure_id: copy.id, x_mm: 10, y_mm: 10, width_mm: 60, height_mm: 40, label: 'A' },
    });

    await authedPage(page, tokens);
    await page.goto(`/canvases/${c.id}`, { waitUntil: 'networkidle' });
    await expect(page.locator('canvas').first()).toBeVisible();

    await page.getByRole('button', { name: 'Journal' }).click();
    await page.getByLabel('Base font size (pt, 5–14)').fill('9');

    page.once('dialog', (dialog) => {
      expect(dialog.message()).toContain('Re-renders 1 figure');
      dialog.accept();
    });
    await page.getByRole('button', { name: 'Apply typography' }).click();

    await expect(page.getByText(/Typography applied to 1 figure/)).toBeVisible({ timeout: 20000 });
    await expect.poll(async () => {
      const after = figureVersionState(await getFigure(request, auth, copy.id));
      return after.versionCount;
    }, { timeout: 20000 }).toBe(before.versionCount + 1);

    const opts = await currentOptions(request, auth, copy.id);
    expect(opts.base_size).toBe(9);
  });
});
