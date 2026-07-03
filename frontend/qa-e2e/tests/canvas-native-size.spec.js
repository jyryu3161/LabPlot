const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

// U2: panels default to the figure's NATIVE physical size (clamped to 90% of
// the canvas, aspect preserved), and "Original size" resets a resized panel.
// Server-truth assertions: the panel response now carries native_width_mm /
// native_height_mm, so expectations are self-consistent for any figure.
const fit = (nw, nh, cw, ch) => {
  let s = Math.min(1, (cw * 0.9) / nw, (ch * 0.9) / nh);
  s = Math.max(s, 10 / nw, 10 / nh); // uniform PANEL_MM_MIN floor (aspect kept)
  return { w: nw * s, h: nh * s };
};

test.describe('canvas native-size placement', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a figure id');
  let tokens, auth;
  test.beforeEach(async ({ request }) => {
    tokens = await apiLogin(request);
    auth = { Authorization: `Bearer ${tokens.access_token}` };
  });

  test('picker-added panel lands at native size (90% clamp, aspect kept)', async ({ page, request }) => {
    const c = await (await request.post(`${ENV.BASE}/api/canvases`, {
      headers: auth, data: { name: 'Native QA', width_mm: 210, height_mm: 297 },
    })).json();
    await authedPage(page, tokens);
    await page.goto(`/canvases/${c.id}`, { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: 'Add figure' }).click();
    await page.getByRole('dialog', { name: /add a figure/i }).locator('div.grid > button').first().click();

    await expect.poll(async () => {
      const cv = await (await request.get(`${ENV.BASE}/api/canvases/${c.id}`, { headers: auth })).json();
      return cv.panels.length;
    }, { timeout: 15000 }).toBe(1);
    const detail = await (await request.get(`${ENV.BASE}/api/canvases/${c.id}`, { headers: auth })).json();
    const panel = detail.panels[0];

    expect(panel.native_width_mm).toBeGreaterThan(0); // U2 field present
    const exp = fit(panel.native_width_mm, panel.native_height_mm, 210, 297);
    expect(Math.abs(panel.width_mm - exp.w)).toBeLessThan(1);
    expect(Math.abs(panel.height_mm - exp.h)).toBeLessThan(1);
    // aspect preserved vs native
    expect(Math.abs(panel.width_mm / panel.height_mm - panel.native_width_mm / panel.native_height_mm)).toBeLessThan(0.02);

    await request.delete(`${ENV.BASE}/api/canvases/${c.id}`, { headers: auth });
  });

  test('journal-preset canvas: panel stays fully ON the sheet', async ({ page, request }) => {
    // Nature single column (88.9×64.01) — the review case where the old 20mm
    // position floor shoved native-size panels off the sheet edge.
    const c = await (await request.post(`${ENV.BASE}/api/canvases`, {
      headers: auth, data: { name: 'Journal fit QA', width_mm: 88.9, height_mm: 64.01 },
    })).json();
    await authedPage(page, tokens);
    await page.goto(`/canvases/${c.id}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Add figure' }).click();
    await page.getByRole('dialog', { name: /add a figure/i }).locator('div.grid > button').first().click();
    await expect.poll(async () => {
      const cv = await (await request.get(`${ENV.BASE}/api/canvases/${c.id}`, { headers: auth })).json();
      return cv.panels.length;
    }, { timeout: 15000 }).toBe(1);
    const cv = await (await request.get(`${ENV.BASE}/api/canvases/${c.id}`, { headers: auth })).json();
    const p = cv.panels[0];
    // fully on-sheet: no overflow on either axis
    expect(p.x_mm + p.width_mm).toBeLessThanOrEqual(88.9 + 0.05);
    expect(p.y_mm + p.height_mm).toBeLessThanOrEqual(64.01 + 0.05);
    expect(p.x_mm).toBeGreaterThanOrEqual(0);
    expect(p.y_mm).toBeGreaterThanOrEqual(0);
    await request.delete(`${ENV.BASE}/api/canvases/${c.id}`, { headers: auth });
  });

  test('"Original size" resets a shrunken panel to native', async ({ page, request }) => {
    const c = await (await request.post(`${ENV.BASE}/api/canvases`, {
      headers: auth, data: { name: 'Native reset QA', width_mm: 210, height_mm: 297 },
    })).json();
    // Panel deliberately at the old 60×45 default.
    const panel = await (await request.post(`${ENV.BASE}/api/canvases/${c.id}/panels`, {
      headers: auth, data: { figure_id: ENV.FIG, x_mm: 20, y_mm: 20, width_mm: 60, height_mm: 45, label: 'A' },
    })).json();
    expect(panel.native_width_mm).toBeGreaterThan(0);

    await authedPage(page, tokens);
    await page.goto(`/canvases/${c.id}`, { waitUntil: 'networkidle' });
    const stage = page.locator('canvas').first();
    await expect(stage).toBeVisible();
    // Select the panel: 60×45mm at (20,20) on a fitted A4 sheet — click inside it.
    const box = await stage.boundingBox();
    await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.16);
    const resetBtn = page.getByRole('button', { name: 'Original size' });
    await expect(resetBtn).toBeVisible();
    await resetBtn.click();

    const exp = fit(panel.native_width_mm, panel.native_height_mm, 210, 297);
    await expect.poll(async () => {
      const cv = await (await request.get(`${ENV.BASE}/api/canvases/${c.id}`, { headers: auth })).json();
      return cv.panels.find((p) => p.id === panel.id)?.width_mm ?? 0;
    }, { timeout: 15000 }).toBeGreaterThan(exp.w - 1);

    await request.delete(`${ENV.BASE}/api/canvases/${c.id}`, { headers: auth });
  });
});
