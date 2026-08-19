const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

function fitPxPerMm(canvasWmm, canvasHmm, viewportW, viewportH, marginPx = 48) {
  return Math.min(
    Math.max(1, viewportW - marginPx * 2) / canvasWmm,
    Math.max(1, viewportH - marginPx * 2) / canvasHmm,
  );
}

function sheetGeometry(box, canvasWmm, canvasHmm) {
  const pxPerMm = fitPxPerMm(canvasWmm, canvasHmm, box.width, box.height);
  return {
    x: box.x + (box.width - canvasWmm * pxPerMm) / 2,
    y: box.y + (box.height - canvasHmm * pxPerMm) / 2,
    localX: (box.width - canvasWmm * pxPerMm) / 2,
    localY: (box.height - canvasHmm * pxPerMm) / 2,
    pxPerMm,
  };
}

function solidSvg() {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="75" viewBox="0 0 100 75"><rect width="100" height="75" fill="#16a34a"/></svg>';
}

async function drag(page, from, to, modifiers = []) {
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
}

async function hasRedRightOutline(stage, sheet, panel) {
  const right = sheet.localX + (panel.x_mm + panel.width_mm) * sheet.pxPerMm;
  const top = sheet.localY + panel.y_mm * sheet.pxPerMm;
  const height = panel.height_mm * sheet.pxPerMm;
  return stage.evaluate((canvas, region) => {
    const ctx = canvas.getContext('2d');
    const scaleX = canvas.width / canvas.clientWidth;
    const scaleY = canvas.height / canvas.clientHeight;
    const x0 = Math.max(0, Math.floor((region.right - 4) * scaleX));
    const y0 = Math.max(0, Math.floor((region.top - 3) * scaleY));
    const x1 = Math.min(canvas.width, Math.ceil((region.right + 4) * scaleX));
    const y1 = Math.min(canvas.height, Math.ceil((region.top + region.height + 3) * scaleY));
    const pixels = ctx.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)).data;
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b, a] = [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
      if (a > 100 && r > 170 && r > g * 1.7 && r > b * 1.7) return true;
    }
    return false;
  }, { right, top, height });
}

test.describe('canvas panel export bounds', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a rendered figure id');

  test('drag, resize, and nudge stay on-sheet unless Alt enables bleed; warning repairs all', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    const auth = { Authorization: `Bearer ${tokens.access_token}` };
    const base = ENV.BASE;
    let canvasId = null;

    try {
      const canvasResponse = await request.post(`${base}/api/canvases`, {
        headers: auth,
        data: { name: 'Panel Bounds QA', width_mm: 180, height_mm: 120 },
      });
      expect(canvasResponse.status()).toBe(201);
      const canvas = await canvasResponse.json();
      canvasId = canvas.id;
      const panelResponse = await request.post(`${base}/api/canvases/${canvasId}/panels`, {
        headers: auth,
        data: {
          figure_id: ENV.FIG,
          x_mm: 140,
          y_mm: 40,
          width_mm: 40,
          height_mm: 30,
          label: 'Bounds',
        },
      });
      expect(panelResponse.status()).toBe(201);
      const createdPanel = await panelResponse.json();

      // A deterministic raster keeps the canvas hit target available while an
      // empty fetch response prevents CanvasColorEditor's DOM SVG overlay from
      // intercepting Transformer anchors in this geometry-focused test.
      await page.route('**/api/canvases/preview', async (route) => {
        await route.fulfill({
          json: { svg_url: '/qa-panel-bounds.svg', cached: false, layout: null },
        });
      });
      await page.route('**/qa-panel-bounds.svg', async (route) => {
        if (route.request().resourceType() === 'image') {
          await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: solidSvg() });
        } else {
          await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '' });
        }
      });

      const getPanel = async () => {
        const response = await request.get(`${base}/api/canvases/${canvasId}`, { headers: auth });
        const detail = await response.json();
        return detail.panels.find((panel) => panel.id === createdPanel.id);
      };
      const waitForPanel = async (predicate) => {
        let value;
        await expect.poll(async () => {
          value = await getPanel();
          return predicate(value);
        }, { timeout: 15_000 }).toBe(true);
        return value;
      };

      await authedPage(page, tokens);
      await page.goto(`/canvases/${canvasId}`, { waitUntil: 'networkidle' });
      const stage = page.locator('canvas').first();
      await expect(stage).toBeVisible();
      const currentSheet = async () => sheetGeometry(await stage.boundingBox(), 180, 120);
      const dragMm = async (fromMm, toMm, modifiers = []) => {
        const sheet = await currentSheet();
        await drag(page, {
          x: sheet.x + fromMm.x * sheet.pxPerMm,
          y: sheet.y + fromMm.y * sheet.pxPerMm,
        }, {
          x: sheet.x + toMm.x * sheet.pxPerMm,
          y: sheet.y + toMm.y * sheet.pxPerMm,
        }, modifiers);
      };
      const clickMm = async (xMm, yMm) => {
        const sheet = await currentSheet();
        await page.mouse.click(sheet.x + xMm * sheet.pxPerMm, sheet.y + yMm * sheet.pxPerMm);
      };

      // At the right edge, an ordinary drag cannot strand the panel outside.
      await dragMm({ x: 160, y: 55 }, { x: 175, y: 55 });
      await expect.poll(async () => (await getPanel()).x_mm).toBe(140);
      await expect(page.getByRole('alert').filter({ hasText: 'outside the export area' })).toBeHidden();

      // Alt is the explicit bleed gesture. It persists the off-sheet position,
      // exposes one unified warning, and paints a red non-export outline.
      await dragMm({ x: 160, y: 55 }, { x: 170, y: 55 }, ['Alt']);
      let panel = await waitForPanel((value) => value.x_mm > 140.5);
      const warning = page.getByRole('alert').filter({ hasText: '1 panel outside the export area' });
      await expect(warning).toBeVisible();
      await page.keyboard.press('Escape');
      await expect.poll(async () => hasRedRightOutline(stage, await currentSheet(), panel)).toBe(true);

      await warning.getByRole('button', { name: 'Move all inside' }).click();
      panel = await waitForPanel((value) => value.x_mm + value.width_mm <= 180.05);
      await expect(warning).toBeHidden();

      // Nudge follows the same contract: normal ArrowRight stops at the edge;
      // Alt+ArrowRight deliberately creates 1mm of bleed.
      await clickMm(panel.x_mm + panel.width_mm / 2, panel.y_mm + panel.height_mm / 2);
      await expect(page.getByRole('textbox', { name: 'Panel label' })).toBeVisible();
      await page.keyboard.press('ArrowRight');
      const nudgeStarted = Date.now();
      await expect.poll(async () => {
        const current = await getPanel();
        return Date.now() - nudgeStarted >= 650 ? current.x_mm : null;
      }).toBe(140);
      await page.keyboard.press('Alt+ArrowRight');
      panel = await waitForPanel((value) => Math.abs(value.x_mm - 141) < 0.05);
      await expect(warning).toBeVisible();
      await warning.getByRole('button', { name: 'Move all inside' }).click();
      panel = await waitForPanel((value) => value.x_mm + value.width_mm <= 180.05);

      // Give the panel 10mm of room, then grow the lower-right Transformer
      // corner beyond the sheet. The ordinary resize lands exactly at/inside
      // the edge; the same gesture with Alt is allowed to cross it.
      await page.keyboard.press('Shift+ArrowLeft');
      await page.keyboard.press('Shift+ArrowLeft');
      panel = await waitForPanel((value) => Math.abs(value.x_mm - 130) < 0.05);
      await dragMm(
        { x: panel.x_mm + panel.width_mm, y: panel.y_mm + panel.height_mm },
        { x: panel.x_mm + panel.width_mm + 20, y: panel.y_mm + panel.height_mm + 15 },
      );
      panel = await waitForPanel((value) => value.width_mm > 40.5);
      expect(panel.x_mm + panel.width_mm).toBeLessThanOrEqual(180.05);
      await expect(warning).toBeHidden();

      await dragMm(
        { x: panel.x_mm + panel.width_mm, y: panel.y_mm + panel.height_mm },
        { x: panel.x_mm + panel.width_mm + 10, y: panel.y_mm + panel.height_mm + 7.5 },
        ['Alt'],
      );
      panel = await waitForPanel((value) => value.x_mm + value.width_mm > 180.5);
      await expect(warning).toBeVisible();
      await warning.getByRole('button', { name: 'Move all inside' }).click();
      await waitForPanel((value) => value.x_mm >= 0 && value.y_mm >= 0
        && value.x_mm + value.width_mm <= 180.05
        && value.y_mm + value.height_mm <= 120.05);
      await expect(warning).toBeHidden();
    } finally {
      if (canvasId) {
        await request.delete(`${base}/api/canvases/${canvasId}`, { headers: auth }).catch(() => {});
      }
    }
  });
});
