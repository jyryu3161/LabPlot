const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage, runAxe } = require('../helpers');

function fitPxPerMm(canvasWmm, canvasHmm, viewportW, viewportH, marginPx = 48) {
  return Math.min(
    Math.max(1, viewportW - marginPx * 2) / canvasWmm,
    Math.max(1, viewportH - marginPx * 2) / canvasHmm,
  );
}

test.describe('canvas accessibility state', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a rendered figure id');

  test('Grid, Snap, and Aspect expose pressed state and work from the keyboard', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    const auth = { Authorization: `Bearer ${tokens.access_token}` };
    const base = ENV.BASE;
    let canvasId = null;

    try {
      const canvasResponse = await request.post(`${base}/api/canvases`, {
        headers: auth,
        data: { name: 'Canvas ARIA QA', width_mm: 180, height_mm: 120 },
      });
      expect(canvasResponse.status()).toBe(201);
      const canvas = await canvasResponse.json();
      canvasId = canvas.id;
      const panelResponse = await request.post(`${base}/api/canvases/${canvasId}/panels`, {
        headers: auth,
        data: { figure_id: ENV.FIG, x_mm: 20, y_mm: 20, width_mm: 100, height_mm: 70 },
      });
      expect(panelResponse.status()).toBe(201);

      await authedPage(page, tokens);
      await page.evaluate(() => {
        localStorage.removeItem('labplot.canvas.grid');
        localStorage.removeItem('labplot.canvas.grid-snap');
      });
      await page.goto(`/canvases/${canvasId}`, { waitUntil: 'domcontentloaded' });

      const grid = page.getByRole('button', { name: 'Show grid' });
      await expect(grid).toHaveAttribute('aria-pressed', 'false');
      await grid.focus();
      await page.keyboard.press('Space');
      await expect(grid).toHaveAttribute('aria-pressed', 'true');

      const snap = page.getByRole('button', { name: 'Snap to grid' });
      await expect(snap).toHaveAttribute('aria-pressed', 'false');
      await snap.focus();
      await page.keyboard.press('Space');
      await expect(snap).toHaveAttribute('aria-pressed', 'true');

      const stage = page.locator('canvas').first();
      await expect(stage).toBeVisible();
      const box = await stage.boundingBox();
      const pxPerMm = fitPxPerMm(180, 120, box.width, box.height);
      const sheetX = box.x + (box.width - 180 * pxPerMm) / 2;
      const sheetY = box.y + (box.height - 120 * pxPerMm) / 2;
      await page.mouse.click(sheetX + 70 * pxPerMm, sheetY + 55 * pxPerMm);

      const aspect = page.getByRole('button', { name: /Aspect/ });
      await expect(aspect).toHaveAttribute('aria-pressed', 'true');
      await aspect.focus();
      await page.keyboard.press('Space');
      await expect(aspect).toHaveAttribute('aria-pressed', 'false');

      const violations = await runAxe(page);
      expect(violations.filter((item) => ['critical', 'serious'].includes(item.impact))).toEqual([]);
    } finally {
      if (canvasId) await request.delete(`${base}/api/canvases/${canvasId}`, { headers: auth }).catch(() => {});
    }
  });

  test('decimal canvas dimensions remain readable in the toolbar', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    const auth = { Authorization: `Bearer ${tokens.access_token}` };
    let canvasId = null;

    try {
      const response = await request.post(`${ENV.BASE}/api/canvases`, {
        headers: auth,
        data: { name: 'Canvas size readability QA', width_mm: 182.88, height_mm: 131.67 },
      });
      expect(response.status()).toBe(201);
      canvasId = (await response.json()).id;

      await authedPage(page, tokens);
      await page.goto(`/canvases/${canvasId}`, { waitUntil: 'domcontentloaded' });
      const width = page.getByLabel('Canvas width in mm');
      const height = page.getByLabel('Canvas height in mm');
      await expect(width).toHaveValue('182.88');
      await expect(height).toHaveValue('131.67');
      expect((await width.boundingBox()).width).toBeGreaterThanOrEqual(88);
      expect((await height.boundingBox()).width).toBeGreaterThanOrEqual(88);
    } finally {
      if (canvasId) await request.delete(`${ENV.BASE}/api/canvases/${canvasId}`, { headers: auth }).catch(() => {});
    }
  });

  test('choosing a theme closes the menu and returns focus to its trigger', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    await authedPage(page, tokens);
    await page.goto('/canvases', { waitUntil: 'domcontentloaded' });

    const trigger = page.getByRole('button', { name: 'Toggle theme' });
    await trigger.click();
    const light = page.getByRole('menuitemradio', { name: 'Light' });
    await expect(light).toBeVisible();
    await light.click();
    await expect(light).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});
