const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

function fitPxPerMm(canvasWmm, canvasHmm, viewportW, viewportH, marginPx = 48) {
  return Math.min(
    Math.max(1, viewportW - marginPx * 2) / canvasWmm,
    Math.max(1, viewportH - marginPx * 2) / canvasHmm,
  );
}

function solidSvg(fill = '#2563eb') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="70" viewBox="0 0 100 70"><rect width="100" height="70" fill="${fill}"/></svg>`;
}

test.describe('canvas direct-edit state', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a rendered figure id');

  test('keeps the submitted text and delays success until the panel-size render completes', async ({ page, request }) => {
    test.setTimeout(120_000);
    const tokens = await apiLogin(request);
    const auth = { Authorization: `Bearer ${tokens.access_token}` };
    const base = ENV.BASE;
    let canvasId = null;
    let figureId = null;
    let releasePreview = () => {};
    let releaseImage = () => {};

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
        data: { name: 'Canvas edit status QA', width_mm: 180, height_mm: 120 },
      });
      expect(canvasResponse.status()).toBe(201);
      const canvas = await canvasResponse.json();
      canvasId = canvas.id;
      const panelResponse = await request.post(`${base}/api/canvases/${canvasId}/panels`, {
        headers: auth,
        data: { figure_id: figureId, x_mm: 20, y_mm: 20, width_mm: 100, height_mm: 70 },
      });
      expect(panelResponse.status()).toBe(201);

      // Hold only the NEW version's panel-size preview. This gives the test a
      // deterministic window to prove that success is not announced while R
      // is still preparing the canvas artifact.
      let allowNewPreview;
      const previewGate = new Promise((resolve) => { allowNewPreview = resolve; });
      releasePreview = () => allowNewPreview();
      let allowNewImage;
      const imageGate = new Promise((resolve) => { allowNewImage = resolve; });
      releaseImage = () => allowNewImage();
      let newImageRequests = 0;
      await page.route('**/api/canvases/preview', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const body = route.request().postDataJSON();
        if (body?.version_id && body.version_id !== initial.id) {
          await previewGate;
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              svg_url: `/qa-canvas-edit-images/${body.version_id}.svg`,
              cached: false,
              layout: null,
            }),
          });
        }
        return route.continue();
      });
      await page.route('**/qa-canvas-edit-images/*.svg', async (route) => {
        // CanvasColorEditor fetches the same SVG as text for its overlay. Only
        // gate the HTMLImageElement request that CanvasEditor actually paints.
        if (route.request().resourceType() === 'image') {
          newImageRequests += 1;
          await imageGate;
        }
        await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: solidSvg() });
      });

      await authedPage(page, tokens);
      await page.goto(`/canvases/${canvasId}`, { waitUntil: 'domcontentloaded' });
      const stage = page.locator('canvas').first();
      await expect(stage).toBeVisible();
      const box = await stage.boundingBox();
      const pxPerMm = fitPxPerMm(180, 120, box.width, box.height);
      const sheetX = box.x + (box.width - 180 * pxPerMm) / 2;
      const sheetY = box.y + (box.height - 120 * pxPerMm) / 2;
      await page.mouse.click(sheetX + 70 * pxPerMm, sheetY + 55 * pxPerMm);

      const title = page.getByRole('textbox', { name: 'Title', exact: true });
      await expect(title).toBeVisible();
      const submittedTitle = `Canvas state ${Date.now()}`;
      await title.fill(submittedTitle);
      await page.getByRole('button', { name: 'Apply text' }).click();

      const progress = page.getByTestId('canvas-edit-progress');
      await expect(progress).toContainText('rendering in R');
      await expect(title).toHaveValue(submittedTitle);
      await expect(progress).toContainText('updating canvas', { timeout: 60_000 });
      await expect(title).toHaveValue(submittedTitle);
      await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Text updated' })).toHaveCount(0);

      releasePreview();
      await expect.poll(() => newImageRequests).toBeGreaterThan(0);
      await expect(progress).toContainText('updating canvas');
      await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Text updated' })).toHaveCount(0);

      releaseImage();
      await expect(progress).toBeHidden({ timeout: 30_000 });
      await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Text updated' })).toBeVisible();
      await expect.poll(async () => {
        const response = await request.get(`${base}/api/figures/${figureId}`, { headers: auth });
        const latest = await response.json();
        const version = latest.versions.find((item) => item.id === latest.current_version_id);
        return version?.options?.title;
      }).toBe(submittedTitle);
    } finally {
      releasePreview();
      releaseImage();
      if (canvasId) await request.delete(`${base}/api/canvases/${canvasId}`, { headers: auth }).catch(() => {});
      if (figureId) await request.delete(`${base}/api/figures/${figureId}`, { headers: auth }).catch(() => {});
    }
  });

  test('reports an image-apply failure without announcing edit success and offers retry', async ({ page, request }) => {
    test.setTimeout(120_000);
    const tokens = await apiLogin(request);
    const auth = { Authorization: `Bearer ${tokens.access_token}` };
    const base = ENV.BASE;
    let canvasId = null;
    let figureId = null;

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
        data: { name: 'Canvas image apply failure QA', width_mm: 180, height_mm: 120 },
      });
      expect(canvasResponse.status()).toBe(201);
      canvasId = (await canvasResponse.json()).id;
      const panelResponse = await request.post(`${base}/api/canvases/${canvasId}/panels`, {
        headers: auth,
        data: { figure_id: figureId, x_mm: 20, y_mm: 20, width_mm: 100, height_mm: 70 },
      });
      expect(panelResponse.status()).toBe(201);

      await page.route('**/api/canvases/preview', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const body = route.request().postDataJSON();
        if (body?.version_id && body.version_id !== initial.id) {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              svg_url: `/qa-canvas-edit-failure/${body.version_id}.svg`,
              cached: false,
              layout: null,
            }),
          });
        }
        return route.continue();
      });
      let imageAttempts = 0;
      await page.route('**/qa-canvas-edit-failure/*.svg', async (route) => {
        if (route.request().resourceType() !== 'image') {
          return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '' });
        }
        imageAttempts += 1;
        if (imageAttempts === 1) {
          return route.fulfill({ status: 503, contentType: 'text/plain', body: 'image apply failed' });
        }
        return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: solidSvg('#16a34a') });
      });

      await authedPage(page, tokens);
      await page.goto(`/canvases/${canvasId}`, { waitUntil: 'domcontentloaded' });
      const stage = page.locator('canvas').first();
      await expect(stage).toBeVisible();
      const box = await stage.boundingBox();
      const pxPerMm = fitPxPerMm(180, 120, box.width, box.height);
      const sheetX = box.x + (box.width - 180 * pxPerMm) / 2;
      const sheetY = box.y + (box.height - 120 * pxPerMm) / 2;
      await page.mouse.click(sheetX + 70 * pxPerMm, sheetY + 55 * pxPerMm);

      const title = page.getByRole('textbox', { name: 'Title', exact: true });
      await expect(title).toBeVisible();
      await title.fill(`Canvas image failure ${Date.now()}`);
      await page.getByRole('button', { name: 'Apply text' }).click();

      await expect.poll(() => imageAttempts, { timeout: 60_000 }).toBe(1);
      await expect(page.getByTestId('canvas-edit-progress')).toBeHidden();
      await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'canvas preview could not update' })).toBeVisible();
      await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Text updated' })).toHaveCount(0);

      const retry = page.getByRole('button', { name: 'Retry panel render' });
      await expect(retry).toBeVisible();
      await retry.click();
      await expect.poll(() => imageAttempts).toBe(2);
      await expect(page.getByText(/Latest v\d+/)).toBeVisible();
      await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Text updated' })).toHaveCount(0);
    } finally {
      if (canvasId) await request.delete(`${base}/api/canvases/${canvasId}`, { headers: auth }).catch(() => {});
      if (figureId) await request.delete(`${base}/api/figures/${figureId}`, { headers: auth }).catch(() => {});
    }
  });

  test('keeps a text draft and succeeds on retry after another tab advances the figure', async ({ page, request }) => {
    test.setTimeout(120_000);
    const tokens = await apiLogin(request);
    const auth = { Authorization: `Bearer ${tokens.access_token}` };
    const base = ENV.BASE;
    let canvasId = null;
    let figureId = null;

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
        data: { name: 'Canvas conflict retry QA', width_mm: 180, height_mm: 120 },
      });
      expect(canvasResponse.status()).toBe(201);
      canvasId = (await canvasResponse.json()).id;
      const panelResponse = await request.post(`${base}/api/canvases/${canvasId}/panels`, {
        headers: auth,
        data: { figure_id: figureId, x_mm: 20, y_mm: 20, width_mm: 100, height_mm: 70 },
      });
      expect(panelResponse.status()).toBe(201);

      await authedPage(page, tokens);
      await page.goto(`/canvases/${canvasId}`, { waitUntil: 'domcontentloaded' });
      const stage = page.locator('canvas').first();
      await expect(stage).toBeVisible();
      const box = await stage.boundingBox();
      const pxPerMm = fitPxPerMm(180, 120, box.width, box.height);
      const sheetX = box.x + (box.width - 180 * pxPerMm) / 2;
      const sheetY = box.y + (box.height - 120 * pxPerMm) / 2;
      await page.mouse.click(sheetX + 70 * pxPerMm, sheetY + 55 * pxPerMm);

      const title = page.getByRole('textbox', { name: 'Title', exact: true });
      await expect(title).toBeVisible();
      const submittedTitle = `Conflict retry ${Date.now()}`;
      await title.fill(submittedTitle);

      // Advance the same figure without publishing the cross-tab event. The
      // editor must discover this through the backend's base-version 409.
      const externalResponse = await request.post(`${base}/api/figures/${figureId}/rerender`, {
        headers: auth,
        data: {
          options: { ...initial.options, subtitle: `External ${Date.now()}` },
          change_note: 'Canvas conflict retry regression setup',
          base_version_id: initial.id,
        },
        timeout: 60_000,
      });
      expect(externalResponse.ok()).toBe(true);

      await page.getByRole('button', { name: 'Apply text' }).click();
      await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'latest version is loaded' })).toBeVisible({ timeout: 30_000 });
      await expect(title).toHaveValue(submittedTitle);

      // The original defect kept the stale base id in a ref, making every
      // retry return 409. A single explicit retry must now create a version.
      await page.getByRole('button', { name: 'Apply text' }).click();
      await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Text updated' })).toBeVisible({ timeout: 60_000 });
      await expect.poll(async () => {
        const response = await request.get(`${base}/api/figures/${figureId}`, { headers: auth });
        const latest = await response.json();
        const version = latest.versions.find((item) => item.id === latest.current_version_id);
        return version?.options?.title;
      }).toBe(submittedTitle);
    } finally {
      if (canvasId) await request.delete(`${base}/api/canvases/${canvasId}`, { headers: auth }).catch(() => {});
      if (figureId) await request.delete(`${base}/api/figures/${figureId}`, { headers: auth }).catch(() => {});
    }
  });
});
