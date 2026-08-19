const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

const INITIAL_FILL = '#e11d48';
const UPDATED_FILL = '#2563eb';

function solidSvg(fill) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="70" viewBox="0 0 100 70"><rect width="100" height="70" fill="${fill}"/></svg>`;
}

function fitPxPerMm(canvasWmm, canvasHmm, viewportW, viewportH, marginPx = 48) {
  return Math.min(
    Math.max(1, viewportW - marginPx * 2) / canvasWmm,
    Math.max(1, viewportH - marginPx * 2) / canvasHmm,
  );
}

async function panelPixelClass(page) {
  const stage = page.locator('canvas').first();
  await expect(stage).toBeVisible();
  const box = await stage.boundingBox();
  const pxPerMm = fitPxPerMm(180, 120, box.width, box.height);
  const sheetX = (box.width - 180 * pxPerMm) / 2;
  const sheetY = (box.height - 120 * pxPerMm) / 2;
  // Sample the panel's upper-left quadrant, away from its label and the
  // centered rendering/error text.
  const x = sheetX + 45 * pxPerMm;
  const y = sheetY + 38 * pxPerMm;
  const [r, g, b] = await stage.evaluate((canvas, point) => {
    const scaleX = canvas.width / canvas.clientWidth;
    const scaleY = canvas.height / canvas.clientHeight;
    const pixel = canvas.getContext('2d').getImageData(
      Math.round(point.x * scaleX),
      Math.round(point.y * scaleY),
      1,
      1,
    ).data;
    return [pixel[0], pixel[1], pixel[2]];
  }, { x, y });
  if (r > 180 && g < 100 && b < 140) return 'initial-red';
  if (b > 150 && r < 100 && g < 160) return 'updated-blue';
  return 'blank-or-status';
}

test.describe('canvas figure-version synchronization', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a rendered figure id');

  test('a cross-tab version event replaces the rendered image before reporting Latest and supports retry', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    const auth = { Authorization: `Bearer ${tokens.access_token}` };
    const base = ENV.BASE;
    let canvasId = null;
    let figureId = null;
    let createdVersionId = null;
    let releaseFirstNewImage = null;
    let announceFirstNewImage = null;
    const firstNewImageRequested = new Promise((resolve) => { announceFirstNewImage = resolve; });
    let newImageAttempts = 0;

    try {
      const duplicateResponse = await request.post(`${base}/api/figures/${ENV.FIG}/duplicate`, { headers: auth });
      expect(duplicateResponse.status()).toBe(201);
      const figure = await duplicateResponse.json();
      figureId = figure.id;
      const initial = figure.versions.find((version) => version.id === figure.current_version_id)
        ?? figure.versions[figure.versions.length - 1];
      expect(initial?.id).toBeTruthy();

      const canvasResponse = await request.post(`${base}/api/canvases`, {
        headers: auth,
        data: { name: 'Version Sync QA', width_mm: 180, height_mm: 120 },
      });
      expect(canvasResponse.status()).toBe(201);
      const canvas = await canvasResponse.json();
      canvasId = canvas.id;
      const panelResponse = await request.post(`${base}/api/canvases/${canvasId}/panels`, {
        headers: auth,
        data: { figure_id: figureId, x_mm: 20, y_mm: 20, width_mm: 100, height_mm: 70, label: 'Sync' },
      });
      expect(panelResponse.status()).toBe(201);

      const previewVersionIds = [];
      let previewSequence = 0;
      await page.route('**/api/canvases/preview', async (route) => {
        const body = route.request().postDataJSON();
        const versionId = body?.version_id ?? 'latest';
        previewVersionIds.push(versionId);
        previewSequence += 1;
        await route.fulfill({
          json: {
            svg_url: `/qa-panel-images/${encodeURIComponent(versionId)}-${previewSequence}.svg`,
            cached: false,
            layout: null,
          },
        });
      });
      await page.route('**/qa-panel-images/**', async (route) => {
        const outgoing = route.request();
        const versionInPath = decodeURIComponent(new URL(outgoing.url()).pathname)
          .split('/').pop().replace(/-\d+\.svg$/, '');

        // CanvasColorEditor fetches SVG text for its edit overlay. Keep that
        // overlay empty so pixel assertions exercise CanvasPanelNode's actual
        // HTMLImageElement/Konva image, not a second visual layer.
        if (outgoing.resourceType() !== 'image') {
          await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '' });
          return;
        }

        if (createdVersionId && versionInPath === createdVersionId) {
          newImageAttempts += 1;
          if (newImageAttempts === 1) {
            announceFirstNewImage();
            await new Promise((resolve) => { releaseFirstNewImage = resolve; });
            await route.fulfill({ status: 503, contentType: 'text/plain', body: 'transient image failure' });
            return;
          }
          await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: solidSvg(UPDATED_FILL) });
          return;
        }

        await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: solidSvg(INITIAL_FILL) });
      });

      await authedPage(page, tokens);
      await page.goto(`/canvases/${canvasId}`, { waitUntil: 'networkidle' });
      await expect.poll(() => previewVersionIds.includes(initial.id)).toBe(true);
      await expect.poll(() => panelPixelClass(page)).toBe('initial-red');

      const layers = page.getByRole('complementary', { name: 'Layers' });
      await layers.getByRole('button', { name: /Figure panel Sync/ }).click();
      await expect(page.getByText(`Latest v${initial.version_number}`, { exact: true })).toBeVisible();

      const rerenderResponse = await request.post(`${base}/api/figures/${figureId}/rerender`, {
        headers: auth,
        data: {
          options: { ...initial.options, title: `Version sync ${Date.now()}` },
          change_note: 'Canvas cross-tab sync regression',
          base_version_id: initial.id,
        },
        timeout: 60_000,
      });
      expect(rerenderResponse.ok()).toBe(true);
      const created = await rerenderResponse.json();
      expect(created.id).not.toBe(initial.id);
      createdVersionId = created.id;

      // Keep the canvas page in the background: a visibilitychange-only fix
      // cannot pass. The explicit channel event must update it immediately.
      const broadcaster = await page.context().newPage();
      await broadcaster.goto('/', { waitUntil: 'domcontentloaded' });
      await broadcaster.evaluate((event) => {
        const channel = new BroadcastChannel('labplot.figure-versions');
        channel.postMessage(event);
        channel.close();
      }, {
        figureId,
        versionId: created.id,
        versionNumber: created.version_number,
        source: 'figure-editor',
        createdAt: Date.now(),
      });

      await expect.poll(() => previewVersionIds.includes(created.id), { timeout: 30_000 }).toBe(true);
      await firstNewImageRequested;

      // The new key has begun loading. The previous red image must no longer
      // be drawn, and "Latest" must not be announced before image.onload.
      await expect(page.getByText(`Updating to v${created.version_number}`, { exact: true })).toBeVisible();
      await expect.poll(() => panelPixelClass(page)).toBe('blank-or-status');

      // Fail the first actual image request (the preview API itself succeeded).
      // The UI must expose the partial failure and a deterministic retry.
      releaseFirstNewImage();
      releaseFirstNewImage = null;
      await expect(page.getByText(`Update failed v${created.version_number}`, { exact: true })).toBeVisible();
      const retry = page.getByRole('button', { name: 'Retry panel render' });
      await expect(retry).toBeVisible();
      await retry.click();

      await expect(page.getByText(`Latest v${created.version_number}`, { exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect.poll(() => panelPixelClass(page)).toBe('updated-blue');
      expect(newImageAttempts).toBe(2);
      await broadcaster.close();
    } finally {
      releaseFirstNewImage?.();
      if (canvasId) await request.delete(`${base}/api/canvases/${canvasId}`, { headers: auth }).catch(() => {});
      if (figureId) await request.delete(`${base}/api/figures/${figureId}`, { headers: auth }).catch(() => {});
    }
  });
});
