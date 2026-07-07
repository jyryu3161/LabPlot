const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage, attachConsole } = require('../helpers');

// External image import (SVG/PNG/JPEG → canvas panels): the "Add image"
// toolbar button + hidden file input, aspect-locked image panels, undo
// re-referencing the same blob (blobs survive panel deletion), SVG
// sanitization, and export embedding. Same discipline as the other canvas
// specs — user-facing locators, server-truth expect.poll, no waitForTimeout.
// No QA_FIG needed: image panels are figure-free by construction.

// 1x1 red PNG (base64) — enough for an upload; the server derives native mm
// size from dimensions/DPI (96dpi default → ~0.26mm, floored to the 10mm
// panel minimum by the server-side fit).
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const CLEAN_SVG = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 400 200">'
  + '<rect width="400" height="200" fill="#3366cc"/><text x="20" y="120" font-size="60">qa-import</text></svg>',
);
const DIRTY_SVG = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 400 200">'
  + '<script>window.__pwned = 1</script>'
  + '<rect width="400" height="200" fill="#cc3366" onclick="window.__pwned = 2"/>'
  + '<image href="https://evil.example/x.png" width="10" height="10"/>'
  + '<text x="20" y="120" font-size="60">qa-dirty</text></svg>',
);

test.describe('canvas image import (external SVG/PNG/JPEG panels)', () => {
  let tokens, auth, base;
  let cleanupIds = [];
  test.beforeEach(async ({ request }) => {
    tokens = await apiLogin(request);
    auth = { Authorization: `Bearer ${tokens.access_token}` };
    base = ENV.BASE;
    cleanupIds = [];
  });
  test.afterEach(async ({ request }) => {
    for (const id of cleanupIds) {
      await request.delete(`${base}/api/canvases/${id}`, { headers: auth }).catch(() => {});
    }
    cleanupIds = [];
  });

  async function makeCanvas(request, name) {
    const c = await (await request.post(`${base}/api/canvases`, {
      headers: auth, data: { name, width_mm: 120, height_mm: 90 },
    })).json();
    cleanupIds.push(c.id);
    return c;
  }
  async function serverPanels(request, canvasId) {
    const r = await request.get(`${base}/api/canvases/${canvasId}`, { headers: auth });
    return (await r.json()).panels ?? [];
  }

  test('Add image: png upload becomes an aspect-locked image panel; delete + undo re-references the same blob', async ({ page, request }) => {
    const errors = [];
    attachConsole(page, errors);
    const c = await makeCanvas(request, 'Image import QA');
    await authedPage(page, tokens);
    await page.goto(`/canvases/${c.id}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'Add image' })).toBeVisible();

    // The button is backed by a hidden file input — drive that directly.
    await page.locator('input[type="file"][accept*="svg"]').setInputFiles({
      name: 'photo.png', mimeType: 'image/png', buffer: TINY_PNG,
    });

    // Server truth: one image panel, labeled A, no figure.
    let panel;
    await expect.poll(async () => {
      const panels = await serverPanels(request, c.id);
      panel = panels.find((p) => p.image_key);
      return panel ? 'created' : 'missing';
    }).toBe('created');
    expect(panel.figure_id).toBeNull();
    expect(panel.image_key).toMatch(/^canvases\/imports\/[0-9a-f]{32}\.png$/);
    expect(panel.label).toBe('A');
    expect(panel.render_url).toBeTruthy();

    // The new panel is auto-selected: the toolbar row says "Image", the
    // Aspect lock is forced (disabled), and there is no "Edit figure".
    await expect(page.getByText(/^Image A ·/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Aspect' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Edit figure' })).toHaveCount(0);

    // Delete the panel (confirm dialog), then undo — the snapshot re-creates
    // it via image_key, so the SAME blob is referenced by the new row.
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect.poll(async () => (await serverPanels(request, c.id)).length).toBe(0);
    await page.keyboard.press('Control+z');
    await expect.poll(async () => {
      const panels = await serverPanels(request, c.id);
      return panels.length === 1 && panels[0].image_key === panel.image_key ? 'restored' : 'waiting';
    }).toBe('restored');

    expect(errors, errors.join('\n')).toHaveLength(0);
  });

  test('svg upload is sanitized (script/on*/external refs stripped) and the export embeds it as vector', async ({ request }) => {
    const c = await makeCanvas(request, 'SVG sanitize QA');
    const up = await request.post(`${base}/api/canvases/${c.id}/panels/image`, {
      headers: auth,
      multipart: {
        file: { name: 'dirty.svg', mimeType: 'image/svg+xml', buffer: DIRTY_SVG },
        x_mm: '40', y_mm: '30', label: 'B',
      },
    });
    expect(up.status()).toBe(201);
    const panel = await up.json();
    expect(panel.image_key).toMatch(/\.svg$/);
    // native size honours the declared physical mm units
    expect(panel.native_width_mm).toBeCloseTo(40, 1);
    expect(panel.native_height_mm).toBeCloseTo(20, 1);

    // The STORED blob is the sanitized serialization.
    const blob = await (await request.get(`${base}${panel.render_url}`)).text();
    expect(blob).toContain('qa-dirty');
    expect(blob).not.toContain('<script');
    expect(blob).not.toContain('onclick');
    expect(blob).not.toContain('evil.example');

    // Vector export: the sanitized SVG nests into the composite (still no script).
    const exp = await (await request.post(`${base}/api/canvases/${c.id}/export`, {
      headers: auth, data: { format: 'svg' },
    })).json();
    const composite = await (await request.get(`${base}${exp.url}`, { headers: auth })).text();
    expect(composite).toContain('qa-dirty');
    expect(composite).not.toContain('<script');
    // Image panels are immutable blobs, not figure versions — never snapshotted.
    expect(exp.snapshot).toEqual({});

    // A raster panel joins as a data-URI <image> and the raster export succeeds.
    const up2 = await request.post(`${base}/api/canvases/${c.id}/panels/image`, {
      headers: auth,
      multipart: { file: { name: 'p.png', mimeType: 'image/png', buffer: TINY_PNG } },
    });
    expect(up2.status()).toBe(201);
    const exp2 = await (await request.post(`${base}/api/canvases/${c.id}/export`, {
      headers: auth, data: { format: 'svg' },
    })).json();
    const composite2 = await (await request.get(`${base}${exp2.url}`, { headers: auth })).text();
    expect(composite2).toContain('data:image/png;base64,');
    const png = await request.post(`${base}/api/canvases/${c.id}/export`, {
      headers: auth, data: { format: 'png', dpi: 300 },
    });
    expect(png.status()).toBe(200);
  });

  test('unsupported files are rejected: UI toast for a text file, 400 for a disguised gif', async ({ page, request }) => {
    const c = await makeCanvas(request, 'Reject QA');

    // API: extension lies, magic bytes decide.
    const bad = await request.post(`${base}/api/canvases/${c.id}/panels/image`, {
      headers: auth,
      multipart: { file: { name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('GIF89a not a png') } },
    });
    expect(bad.status()).toBe(400);

    // UI: the client filter toasts without uploading anything.
    await authedPage(page, tokens);
    await page.goto(`/canvases/${c.id}`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[type="file"][accept*="svg"]').setInputFiles({
      name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello'),
    });
    await expect(page.getByText('Only SVG, PNG, or JPEG images can be imported')).toBeVisible();
    expect(await serverPanels(request, c.id)).toHaveLength(0);
  });

  test('CLEAN_SVG smoke: import via drop-style API placement keeps the panel center at the requested point', async ({ request }) => {
    const c = await makeCanvas(request, 'Drop point QA');
    const up = await request.post(`${base}/api/canvases/${c.id}/panels/image`, {
      headers: auth,
      multipart: {
        file: { name: 'clean.svg', mimeType: 'image/svg+xml', buffer: CLEAN_SVG },
        x_mm: '60', y_mm: '45',
      },
    });
    expect(up.status()).toBe(201);
    const p = await up.json();
    expect(p.x_mm + p.width_mm / 2).toBeCloseTo(60, 1);
    expect(p.y_mm + p.height_mm / 2).toBeCloseTo(45, 1);
    // Aspect of the fitted panel matches the image's native 2:1.
    expect(p.width_mm / p.height_mm).toBeCloseTo(2, 2);
  });
});
