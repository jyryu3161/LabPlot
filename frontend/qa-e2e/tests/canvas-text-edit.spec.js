const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

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
    const fig = await (await request.get(`${ENV.BASE}/api/figures/${figId}`, { headers: auth })).json();
    const v = fig.versions.find((x) => x.id === fig.current_version_id) ?? fig.versions[0];
    return v?.options ?? {};
  };

  test('sidecar hit boxes + inline label edit + undo toast + sequential commit', async ({ page, request }) => {
    test.setTimeout(180000); // three R renders (~2-5s each) plus preview renders

    // Sidecar regression guard: the preview layout must carry the U4 hit boxes.
    const prev = await (await request.post(`${ENV.BASE}/api/canvases/preview`, {
      headers: auth, data: { figure_id: ENV.FIG, width_mm: 120, height_mm: 80 },
    })).json();
    for (const key of ['xlab_px', 'ylab_px', 'x_axis_px', 'y_axis_px']) {
      expect(prev.layout?.[key], `layout.${key} missing`).toBeTruthy();
    }

    const c = await (await request.post(`${ENV.BASE}/api/canvases`, {
      headers: auth, data: { name: 'TextEdit QA', width_mm: 210, height_mm: 297 },
    })).json();
    const panel = await (await request.post(`${ENV.BASE}/api/canvases/${c.id}/panels`, {
      headers: auth, data: { figure_id: ENV.FIG, x_mm: 20, y_mm: 20, width_mm: 120, height_mm: 80, label: 'A' },
    })).json();
    const before = await currentOptions(request, ENV.FIG);

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
    await expect.poll(async () => (await currentOptions(request, ENV.FIG)).x_label, { timeout: 30000 })
      .toBe('Dose (mg) QA');

    // 2) one-shot Undo from the toast reverts the edit (a NEW version)
    await page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await currentOptions(request, ENV.FIG)).x_label ?? '', { timeout: 30000 })
      .toBe(before.x_label ?? '');

    // 3) sequential commit from the same editor must NOT 409 (base_version_id
    //    advances after every commit) — edit the title via the sidebar.
    const title = page.getByRole('textbox', { name: 'Title' });
    await title.fill('Panel QA Title');
    await page.getByRole('button', { name: 'Apply text' }).click();
    await expect.poll(async () => (await currentOptions(request, ENV.FIG)).title, { timeout: 30000 })
      .toBe('Panel QA Title');

    // restore original text options for other tests
    await request.post(`${ENV.BASE}/api/figures/${ENV.FIG}/rerender`, {
      headers: auth,
      data: { options: { ...(await currentOptions(request, ENV.FIG)), title: before.title ?? '', x_label: before.x_label ?? '' }, change_note: 'QA: restore text' },
    });
    await request.delete(`${ENV.BASE}/api/canvases/${c.id}`, { headers: auth });
  });

  test('picker "canvas-only copy" places a duplicate, not the original', async ({ page, request }) => {
    const c = await (await request.post(`${ENV.BASE}/api/canvases`, {
      headers: auth, data: { name: 'Copy QA', width_mm: 210, height_mm: 297 },
    })).json();
    // The picker lists ready figures in the API list order — the first ready
    // figure is the card the test clicks.
    const figures = await (await request.get(`${ENV.BASE}/api/figures`, { headers: auth })).json();
    const firstReady = figures.find((f) => f.status === 'ready');

    await authedPage(page, tokens);
    await page.goto(`/canvases/${c.id}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Add figure' }).click();
    const dialog = page.getByRole('dialog', { name: /add a figure/i });
    await dialog.getByRole('checkbox', { name: /canvas-only copy/ }).check();
    await dialog.locator('div.grid > button').first().click();

    await expect.poll(async () => {
      const cv = await (await request.get(`${ENV.BASE}/api/canvases/${c.id}`, { headers: auth })).json();
      return cv.panels.length;
    }, { timeout: 20000 }).toBe(1);
    const cv = await (await request.get(`${ENV.BASE}/api/canvases/${c.id}`, { headers: auth })).json();
    const panelFig = cv.panels[0].figure_id;
    expect(panelFig).not.toBe(firstReady.id); // a fresh duplicate, not the original

    // cleanup: canvas + the duplicate figure
    await request.delete(`${ENV.BASE}/api/canvases/${c.id}`, { headers: auth });
    await request.delete(`${ENV.BASE}/api/figures/${panelFig}`, { headers: auth });
  });
});
