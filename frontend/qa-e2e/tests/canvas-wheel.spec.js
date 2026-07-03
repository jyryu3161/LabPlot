const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

// U1: wheel convention — plain wheel PANS (zoom% unchanged), Ctrl/Cmd+wheel
// ZOOMS (zoom% changes, damped). The toolbar zoom% readout is the observable:
// Konva's internal transform isn't DOM-visible, but the indicator re-renders
// from the same state.
test.describe('canvas wheel: scroll pans, ctrl+scroll zooms', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a figure id');

  test('plain wheel keeps zoom (pan); ctrl+wheel changes zoom', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    const auth = { Authorization: `Bearer ${tokens.access_token}` };
    const c = await (await request.post(`${ENV.BASE}/api/canvases`, {
      headers: auth, data: { name: 'Wheel QA', width_mm: 210, height_mm: 297 },
    })).json();
    await request.post(`${ENV.BASE}/api/canvases/${c.id}/panels`, {
      headers: auth, data: { figure_id: ENV.FIG, x_mm: 20, y_mm: 20, width_mm: 90, height_mm: 60, label: 'A' },
    });

    await authedPage(page, tokens);
    await page.goto(`/canvases/${c.id}`, { waitUntil: 'networkidle' });
    const stage = page.locator('canvas').first();
    await expect(stage).toBeVisible();
    const zoomLabel = page.locator('span').filter({ hasText: /^\d+%$/ });
    await expect(zoomLabel).toBeVisible();
    const initialZoom = await zoomLabel.textContent();

    // Pointer over the stage so wheel events hit the Konva container.
    const box = await stage.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    // Plain wheel = two-finger scroll -> pan, zoom unchanged.
    await page.mouse.wheel(0, 240);
    await expect(zoomLabel).toHaveText(initialZoom);
    await page.mouse.wheel(0, -240);
    await expect(zoomLabel).toHaveText(initialZoom);

    // Ctrl+wheel (pinch equivalent) -> zoom in (negative deltaY), damped.
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await expect(zoomLabel).not.toHaveText(initialZoom);
    const zoomedIn = parseInt(await zoomLabel.textContent(), 10);
    expect(zoomedIn).toBeGreaterThan(parseInt(initialZoom, 10));
    // Damping: a single 120-delta tick must not explode the zoom (<= 1.25x step).
    expect(zoomedIn).toBeLessThanOrEqual(Math.ceil(parseInt(initialZoom, 10) * 1.25) + 1);

    await request.delete(`${ENV.BASE}/api/canvases/${c.id}`, { headers: auth });
  });
});
