const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

// U7: multi-select (rubber-band marquee + shift-click), the align/distribute
// toolbar, and keyboard arrow-key nudge. Same discipline as the other canvas
// specs — user-facing locators, server-truth expect.poll, no waitForTimeout.
//
// Click-point math: CanvasEditor's fitView() centers the canvas sheet inside
// the Stage using fitPxPerMm(canvasW, canvasH, viewport.w, viewport.h,
// marginPx=48) from mm.ts (zoom=1, view.x/y = the centering offset, on the
// editor's initial load). We reproduce that exact formula here — instead of
// the hand-tuned viewport-fraction constants the other canvas specs use —
// because the marquee's mousedown has a hard geometric requirement (see the
// comment in test 1) that only a precise sheet origin lets us satisfy
// reliably regardless of how tall the top bar / hints bar happen to render.
function fitPxPerMm(canvasWmm, canvasHmm, viewportW, viewportH, marginPx = 48) {
  const availW = Math.max(1, viewportW - marginPx * 2);
  const availH = Math.max(1, viewportH - marginPx * 2);
  const w = canvasWmm > 0 ? availW / canvasWmm : 1;
  const h = canvasHmm > 0 ? availH / canvasHmm : 1;
  const s = Math.min(w, h);
  return Number.isFinite(s) && s > 0 ? s : 1;
}
// `box` is the <canvas> element's boundingBox, which equals the Stage's own
// box (Stage width/height are bound to the measured container size). Returns
// the sheet's page-pixel origin (top-left corner) and the mm->px scale, so
// any (x_mm, y_mm) canvas point converts to a page coordinate via
// origin.{x,y} + mm * origin.pxPerMm.
function sheetOrigin(box, canvasWmm, canvasHmm) {
  const pxPerMm = fitPxPerMm(canvasWmm, canvasHmm, box.width, box.height);
  const cw = canvasWmm * pxPerMm;
  const ch = canvasHmm * pxPerMm;
  return { x: box.x + (box.width - cw) / 2, y: box.y + (box.height - ch) / 2, pxPerMm };
}

test.describe('canvas multi-select + align/distribute + nudge (U7)', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a figure id');
  let tokens, auth, base;
  test.beforeEach(async ({ request }) => {
    tokens = await apiLogin(request);
    auth = { Authorization: `Bearer ${tokens.access_token}` };
    base = ENV.BASE;
  });

  test('rubber-band selects two panels; align-left equalizes x (server truth)', async ({ page, request }) => {
    const c = await (await request.post(`${base}/api/canvases`, {
      headers: auth, data: { name: 'Multi QA', width_mm: 210, height_mm: 297 },
    })).json();
    await request.post(`${base}/api/canvases/${c.id}/panels`, {
      headers: auth, data: { figure_id: ENV.FIG, x_mm: 30, y_mm: 30, width_mm: 40, height_mm: 30, label: 'A' },
    });
    await request.post(`${base}/api/canvases/${c.id}/panels`, {
      headers: auth, data: { figure_id: ENV.FIG, x_mm: 120, y_mm: 90, width_mm: 40, height_mm: 30, label: 'B' },
    });

    await authedPage(page, tokens);
    await page.goto(`/canvases/${c.id}`, { waitUntil: 'networkidle' });
    const stage = page.locator('canvas').first();
    await expect(stage).toBeVisible();
    const box = await stage.boundingBox();
    const origin = sheetOrigin(box, 210, 297);

    // Natural gesture: start INSIDE the sheet on empty space (the sheet Rect
    // is listening={false}, so the mousedown reaches the Stage and arms the
    // marquee — the primary "여백 드래그" use case). Panels start at 30mm, so
    // 5mm inset is safely empty.
    const startX = origin.x + 5 * origin.pxPerMm;
    const startY = origin.y + 5 * origin.pxPerMm;
    // Past panel B's bottom-right corner (120+40=160, 90+30=120mm).
    const endX = origin.x + 180 * origin.pxPerMm;
    const endY = origin.y + 150 * origin.pxPerMm;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move((startX + endX) / 2, (startY + endY) / 2, { steps: 5 });
    await page.mouse.move(endX, endY, { steps: 5 });
    await page.mouse.up();

    const alignLeft = page.getByRole('button', { name: 'Align left', exact: true });
    await expect(alignLeft).toBeVisible();
    await alignLeft.click();

    await expect.poll(async () => {
      const cv = await (await request.get(`${base}/api/canvases/${c.id}`, { headers: auth })).json();
      const xs = cv.panels.map((p) => p.x_mm);
      return Math.max(...xs) - Math.min(...xs);
    }, { timeout: 15000 }).toBeLessThan(0.1);

    await request.delete(`${base}/api/canvases/${c.id}`, { headers: auth });
  });

  test('arrow-key nudge moves a selected panel by exactly 1mm (Shift=5mm)', async ({ page, request }) => {
    const c = await (await request.post(`${base}/api/canvases`, {
      headers: auth, data: { name: 'Nudge QA', width_mm: 210, height_mm: 297 },
    })).json();
    await request.post(`${base}/api/canvases/${c.id}/panels`, {
      headers: auth, data: { figure_id: ENV.FIG, x_mm: 50, y_mm: 50, width_mm: 60, height_mm: 40, label: 'A' },
    });

    await authedPage(page, tokens);
    await page.goto(`/canvases/${c.id}`, { waitUntil: 'networkidle' });
    const stage = page.locator('canvas').first();
    await expect(stage).toBeVisible();
    const box = await stage.boundingBox();
    const origin = sheetOrigin(box, 210, 297);
    // Panel center: (50+60/2, 50+40/2) = (80, 70) mm. A plain click there
    // hits the panel's own Konva Group (handlePanelMouseDown/Click) — a
    // different hit-test path than the Stage-emptiness check test 1 relies
    // on, so this click is safe anywhere inside the panel's box.
    const centerX = origin.x + 80 * origin.pxPerMm;
    const centerY = origin.y + 70 * origin.pxPerMm;
    await page.mouse.click(centerX, centerY);

    const labelInput = page.getByRole('textbox', { name: 'Panel label' });
    await expect(labelInput).toBeVisible(); // single-panel toolbar confirms selection

    const xMm = async () => {
      const cv = await (await request.get(`${base}/api/canvases/${c.id}`, { headers: auth })).json();
      return cv.panels[0].x_mm;
    };
    await expect.poll(xMm).toBe(50);

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    // Nudge commits are debounced ~400ms after the last key press; 50+1+1+5=57.
    await expect.poll(async () => Math.abs((await xMm()) - 57), { timeout: 10000 }).toBeLessThan(0.1);

    // Escape clears the selection -> the single-panel toolbar disappears.
    await page.keyboard.press('Escape');
    await expect(labelInput).toBeHidden();

    await request.delete(`${base}/api/canvases/${c.id}`, { headers: auth });
  });
});
