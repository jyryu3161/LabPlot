const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage, runAxe } = require('../helpers');

test.describe('canvas layers panel', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a rendered figure id');

  test('lists objects front-to-back and selects covered objects with the keyboard', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    const auth = { Authorization: `Bearer ${tokens.access_token}` };
    const base = ENV.BASE;
    let canvasId = null;

    try {
      const canvasResponse = await request.post(`${base}/api/canvases`, {
        headers: auth,
        data: { name: 'Canvas Layers QA', width_mm: 180, height_mm: 120 },
      });
      expect(canvasResponse.status()).toBe(201);
      const canvas = await canvasResponse.json();
      canvasId = canvas.id;

      // These two panels occupy exactly the same rectangle. The Back panel is
      // unreachable by pointer on the stage but must remain selectable in the
      // DOM-based layers list.
      const backResponse = await request.post(`${base}/api/canvases/${canvasId}/panels`, {
        headers: auth,
        data: {
          figure_id: ENV.FIG,
          x_mm: 25,
          y_mm: 20,
          width_mm: 100,
          height_mm: 70,
          z_order: 1,
          label: 'Back',
        },
      });
      expect(backResponse.status()).toBe(201);
      const frontResponse = await request.post(`${base}/api/canvases/${canvasId}/panels`, {
        headers: auth,
        data: {
          figure_id: ENV.FIG,
          x_mm: 25,
          y_mm: 20,
          width_mm: 100,
          height_mm: 70,
          z_order: 8,
          label: 'Front',
        },
      });
      expect(frontResponse.status()).toBe(201);

      const annotationResponse = await request.patch(`${base}/api/canvases/${canvasId}`, {
        headers: auth,
        data: {
          base_annotations_rev: 0,
          annotations: [
            {
              id: 'layers-rect',
              type: 'rect',
              x_mm: 35,
              y_mm: 30,
              w_mm: 50,
              h_mm: 30,
              stroke_hex: '#000000',
              stroke_pt: 1,
              fill_hex: null,
              z: 2,
            },
            {
              id: 'layers-text',
              type: 'text',
              x_mm: 45,
              y_mm: 40,
              text: 'Top note',
              font_pt: 10,
              align: 'left',
              fill_hex: '#000000',
              stroke_hex: '#000000',
              stroke_pt: 1,
              z: 9,
            },
          ],
        },
      });
      expect(annotationResponse.status()).toBe(200);

      await authedPage(page, tokens);
      await page.goto(`/canvases/${canvasId}`, { waitUntil: 'domcontentloaded' });

      const layers = page.getByRole('complementary', { name: 'Layers' });
      await expect(layers).toBeVisible();
      const list = layers.getByRole('list', { name: 'Canvas layers, front to back' });
      await expect(list.getByRole('listitem')).toHaveCount(4);

      const layerButtons = list.getByRole('button');
      await expect(layerButtons).toHaveCount(4);
      await expect(layerButtons.nth(0)).toHaveAccessibleName(/Layer 1 of 4: Text: “Top note”.*z 9/);
      await expect(layerButtons.nth(1)).toHaveAccessibleName(/Layer 2 of 4: Rectangle annotation.*z 2/);
      await expect(layerButtons.nth(2)).toHaveAccessibleName(/Layer 3 of 4: Figure panel Front.*z 8/);
      await expect(layerButtons.nth(3)).toHaveAccessibleName(/Layer 4 of 4: Figure panel Back.*z 1/);

      const backLayer = list.getByRole('button', { name: /Figure panel Back/ });
      await backLayer.focus();
      await page.keyboard.press('Enter');
      await expect(backLayer).toHaveAttribute('aria-pressed', 'true');
      await expect(backLayer).toHaveAttribute('aria-current', 'true');
      await expect(page.getByRole('textbox', { name: 'Panel label' })).toHaveValue('Back');

      const textLayer = list.getByRole('button', { name: /Text: “Top note”/ });
      await textLayer.focus();
      await page.keyboard.press('Space');
      await expect(textLayer).toHaveAttribute('aria-pressed', 'true');
      await expect(textLayer).toHaveAttribute('aria-current', 'true');
      await expect(backLayer).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByRole('textbox', { name: 'Text', exact: true })).toHaveValue('Top note');

      const rectLayer = list.getByRole('button', { name: /Rectangle annotation/ });
      await rectLayer.click({ modifiers: ['Shift'] });
      await expect(textLayer).toHaveAttribute('aria-pressed', 'true');
      await expect(rectLayer).toHaveAttribute('aria-pressed', 'true');
      await expect(textLayer).not.toHaveAttribute('aria-current', 'true');
      await expect(rectLayer).not.toHaveAttribute('aria-current', 'true');
      await expect(page.getByText('2 annotations selected')).toBeVisible();

      const violations = await runAxe(page);
      expect(violations.filter((item) => ['critical', 'serious'].includes(item.impact))).toEqual([]);
    } finally {
      if (canvasId) {
        await request.delete(`${base}/api/canvases/${canvasId}`, { headers: auth }).catch(() => {});
      }
    }
  });
});
