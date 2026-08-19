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

// U4 P1: Prism-style click-to-edit for title / axis labels inside the canvas.
// Server truth = the figure's current version options after each commit.
test.describe('canvas text editing (U4)', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a figure id');
  let tokens, auth;
  test.beforeEach(async ({ request }) => {
    tokens = await apiLogin(request);
    auth = { Authorization: `Bearer ${tokens.access_token}` };
  });

  const currentOptions = async (request, figId) => {
    const fig = await getFigure(request, auth, figId);
    const v = fig.versions.find((x) => x.id === fig.current_version_id) ?? fig.versions[0];
    return v?.options ?? {};
  };

  test.describe('server-backed text mutations', () => {
    let figureId, canvasId, sourceState;

    test.beforeEach(async ({ request }) => {
      test.setTimeout(180000);
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

    test('sidecar hit boxes + inline label edit + undo toast + sequential commit', async ({ page, request }) => {
      test.setTimeout(180000); // duplicate + R renders + preview renders

      // Sidecar regression guard: the preview layout must carry the U4 hit boxes.
      const prev = await (await request.post(`${ENV.BASE}/api/canvases/preview`, {
        headers: auth, data: { figure_id: figureId, width_mm: 120, height_mm: 80 },
      })).json();
      for (const key of ['xlab_px', 'ylab_px', 'x_axis_px', 'y_axis_px']) {
        expect(prev.layout?.[key], `layout.${key} missing`).toBeTruthy();
      }

      const c = await (await request.post(`${ENV.BASE}/api/canvases`, {
        headers: auth, data: { name: 'TextEdit QA', width_mm: 210, height_mm: 297 },
      })).json();
      canvasId = c.id;
      await request.post(`${ENV.BASE}/api/canvases/${c.id}/panels`, {
        headers: auth, data: { figure_id: figureId, x_mm: 20, y_mm: 20, width_mm: 120, height_mm: 80, label: 'A' },
      });
      const before = await currentOptions(request, figureId);

      await authedPage(page, tokens);
      await page.goto(`/canvases/${c.id}`, { waitUntil: 'networkidle' });
      const stage = page.locator('canvas').first();
      await expect(stage).toBeVisible();
      const box = await stage.boundingBox();
      await page.mouse.click(box.x + box.width * 0.46, box.y + box.height * 0.30); // select panel

      // 1) inline x-label edit via the overlay hit target
      await page.getByRole('button', { name: 'Edit x axis label' }).click();
      const input = page.getByRole('textbox', { name: 'x axis label text' });
      await expect(input).toBeVisible();
      await input.fill('Dose (mg) QA');
      await input.press('Enter');
      await expect.poll(async () => (await currentOptions(request, figureId)).x_label, { timeout: 30000 })
        .toBe('Dose (mg) QA');

      // 2) one-shot Undo from the toast reverts the edit (a NEW version)
      await page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' }).click();
      await expect.poll(async () => (await currentOptions(request, figureId)).x_label ?? '', { timeout: 30000 })
        .toBe(before.x_label ?? '');

      // 3) sequential commit from the same editor must NOT 409 (base_version_id
      //    advances after every commit) — edit the title via the sidebar.
      const title = page.getByRole('textbox', { name: 'Title' });
      await title.fill('Panel QA Title');
      await page.getByRole('button', { name: 'Apply text' }).click();
      await expect.poll(async () => (await currentOptions(request, figureId)).title, { timeout: 30000 })
        .toBe('Panel QA Title');
    });
  });

  test('picker "Independent copy" places a duplicate, not the original', async ({ page, request }) => {
    test.setTimeout(180000);
    let canvasId = null;
    let panelFig = null;
    let seedFigureId = null;
    let sourceState = null;
    try {
      sourceState = figureVersionState(await getFigure(request, auth, ENV.FIG));
      const seedFigure = await duplicateFigure(request, auth, ENV.FIG);
      seedFigureId = seedFigure.id;
      const seedName = `QA picker isolated ${seedFigureId.slice(0, 8)}`;
      const renameResponse = await request.patch(`${ENV.BASE}/api/figures/${seedFigureId}`, {
        headers: auth,
        data: { name: seedName },
      });
      expect(renameResponse.ok(), 'rename isolated picker figure').toBeTruthy();

      const c = await (await request.post(`${ENV.BASE}/api/canvases`, {
        headers: auth, data: { name: 'Copy QA', width_mm: 210, height_mm: 297 },
      })).json();
      canvasId = c.id;

      await authedPage(page, tokens);
      await page.goto(`/canvases/${c.id}`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Add figure' }).click();
      const dialog = page.getByRole('dialog', { name: /add a figure/i });
      await dialog.getByRole('radio', { name: /Independent copy/ }).check();
      await dialog.getByLabel('Search figures').fill(seedName);
      const duplicateResponsePromise = page.waitForResponse((response) => (
        response.request().method() === 'POST'
        && new URL(response.url()).pathname === `/api/figures/${seedFigureId}/duplicate`
      ));
      await dialog.locator('div.grid > button').filter({ hasText: seedName }).click();
      const duplicateResponse = await duplicateResponsePromise;
      expect(duplicateResponse.status(), 'independent-copy figure duplication').toBe(201);
      panelFig = (await duplicateResponse.json()).id;

      // Duplicating a rendered figure may copy several artifacts before the
      // panel POST starts; wait on server truth without a fixed delay.
      await expect.poll(async () => {
        const cv = await (await request.get(`${ENV.BASE}/api/canvases/${c.id}`, { headers: auth })).json();
        return cv.panels.length;
      }, { timeout: 45000 }).toBe(1);
      const cv = await (await request.get(`${ENV.BASE}/api/canvases/${c.id}`, { headers: auth })).json();
      expect(cv.panels[0].figure_id).toBe(panelFig);
      expect(panelFig).not.toBe(seedFigureId); // a fresh duplicate, not the picker source
    } finally {
      // Cleanup remains safe even if the UI request completed just after an
      // assertion timeout: discover the duplicate from the canvas first.
      const response = canvasId
        ? await request.get(`${ENV.BASE}/api/canvases/${canvasId}`, { headers: auth }).catch(() => null)
        : null;
      if (response?.ok()) {
        const current = await response.json();
        panelFig = panelFig ?? current.panels?.[0]?.figure_id ?? null;
      }
      await cleanupAndVerifySourceFigure(request, auth, [
        { collection: 'canvases', id: canvasId },
        { collection: 'figures', id: panelFig && panelFig !== seedFigureId ? panelFig : null },
        { collection: 'figures', id: seedFigureId },
      ], ENV.FIG, sourceState);
    }
  });
});
