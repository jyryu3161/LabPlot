const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

// U9: canvas rulers/grid/grid-snap, raster (png/tiff) export, canvas
// duplicate, and zoom shortcuts. Same discipline as the other canvas specs —
// user-facing locators, server-truth expect.poll, no waitForTimeout.
//
// Click-point math copied verbatim from canvas-multiselect.spec.js /
// canvas-annotations.spec.js (U7/U8): the Stage is fit-centered via
// fitPxPerMm(canvasW, canvasH, viewport.w, viewport.h, marginPx=48) from
// mm.ts (zoom=1 on initial load / after "Fit to view" — see the U9 zoom-
// shortcut mismatch note below), so this reproduces the exact formula rather
// than hand-tuned viewport fractions.
function fitPxPerMm(canvasWmm, canvasHmm, viewportW, viewportH, marginPx = 48) {
  const availW = Math.max(1, viewportW - marginPx * 2);
  const availH = Math.max(1, viewportH - marginPx * 2);
  const w = canvasWmm > 0 ? availW / canvasWmm : 1;
  const h = canvasHmm > 0 ? availH / canvasHmm : 1;
  const s = Math.min(w, h);
  return Number.isFinite(s) && s > 0 ? s : 1;
}
function sheetOrigin(box, canvasWmm, canvasHmm) {
  const pxPerMm = fitPxPerMm(canvasWmm, canvasHmm, box.width, box.height);
  const cw = canvasWmm * pxPerMm;
  const ch = canvasHmm * pxPerMm;
  return { x: box.x + (box.width - cw) / 2, y: box.y + (box.height - ch) / 2, pxPerMm };
}

// U9: raster export pixel size, verified in-container against the installed
// rsvg-convert (backend report): pixel_dim = CEIL(mm / 25.4 * dpi), not
// round-to-nearest. See the "implementation mismatches" note in the final
// report — the authoring brief assumed round().
function ceilPx(mm, dpi) {
  return Math.ceil((mm / 25.4) * dpi);
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function isPngMagic(buf) {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC);
}
// PNG signature (8 bytes) + first chunk length (4) + type "IHDR" (4) = 16,
// then width (4, big-endian) + height (4, big-endian).
function pngIhdrDims(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
function isTiffMagic(buf) {
  if (buf.length < 4) return false;
  const b = buf.subarray(0, 4);
  return b.equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) // little-endian "II*\0"
    || b.equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])); // big-endian "MM\0*"
}

test.describe('canvas extras (U9: rulers/grid/grid-snap, raster export, duplicate, zoom shortcuts)', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a figure id');
  let tokens, auth, base;
  // Multiple canvases can be created per test (e.g. duplicate); collect every
  // id and sweep them all in afterEach as a safety net if a test fails before
  // its own explicit cleanup runs.
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

  test('raster export: png @300/600dpi and tiff @300dpi have correct magic bytes and pixel dims; bad dpi rejected', async ({ request }) => {
    const c = await (await request.post(`${base}/api/canvases`, {
      headers: auth, data: { name: 'Raster QA', width_mm: 100, height_mm: 80 },
    })).json();
    cleanupIds.push(c.id);
    await request.post(`${base}/api/canvases/${c.id}/panels`, {
      headers: auth, data: { figure_id: ENV.FIG, x_mm: 10, y_mm: 10, width_mm: 60, height_mm: 40, label: 'A' },
    });

    // ---- PNG @ 300 dpi ----
    const exp300 = await (await request.post(`${base}/api/canvases/${c.id}/export`, {
      headers: auth, data: { format: 'png', dpi: 300 },
    })).json();
    expect(exp300.format).toBe('png');
    expect(exp300.dpi).toBe(300);
    const buf300 = await (await request.get(base + exp300.url, { headers: auth })).body();
    expect(isPngMagic(buf300)).toBe(true);
    const dims300 = pngIhdrDims(buf300);
    expect(dims300).toEqual({ width: ceilPx(100, 300), height: ceilPx(80, 300) });

    // ---- PNG @ 600 dpi ----
    // NOTE (mismatch vs the authoring brief): 600dpi does NOT always land on
    // exactly double the 300dpi pixel dims — the backend derives pixel size
    // as ceil(mm/25.4*dpi) (verified in-container), and ceiling independently
    // at each dpi can differ from a clean 2x by a pixel (e.g. width here:
    // 2*1182=2364 vs the true ceil(100/25.4*600)=2363). So this asserts the
    // exact ceil() formula per-dpi instead of assuming an exact doubling.
    const exp600 = await (await request.post(`${base}/api/canvases/${c.id}/export`, {
      headers: auth, data: { format: 'png', dpi: 600 },
    })).json();
    expect(exp600.dpi).toBe(600);
    const buf600 = await (await request.get(base + exp600.url, { headers: auth })).body();
    expect(isPngMagic(buf600)).toBe(true);
    const dims600 = pngIhdrDims(buf600);
    expect(dims600).toEqual({ width: ceilPx(100, 600), height: ceilPx(80, 600) });

    // ---- TIFF @ 300 dpi ----
    const expTiff = await (await request.post(`${base}/api/canvases/${c.id}/export`, {
      headers: auth, data: { format: 'tiff', dpi: 300 },
    })).json();
    expect(expTiff.format).toBe('tiff');
    expect(expTiff.dpi).toBe(300);
    const bufTiff = await (await request.get(base + expTiff.url, { headers: auth })).body();
    expect(isTiffMagic(bufTiff)).toBe(true);

    // ---- invalid dpi ----
    // NOTE (mismatch vs the authoring brief): the brief expected a 400 with a
    // BAD_EXPORT_DPI code. `CanvasExportRequest.dpi` is declared as
    // `Literal[300, 600]` (schemas.py), so FastAPI/pydantic rejects dpi=150
    // at request-body validation time — BEFORE service.export_canvas's own
    // defensive `BAD_EXPORT_DPI` check ever runs. The real HTTP contract is a
    // generic 422 with `{"detail": [...]}` (FastAPI's default validation
    // error shape, NOT the app's `{"detail": {"code": ...}}` AppError shape).
    const bad = await request.post(`${base}/api/canvases/${c.id}/export`, {
      headers: auth, data: { format: 'png', dpi: 150 },
    });
    expect(bad.status()).toBe(422);
    const badBody = await bad.json();
    expect(Array.isArray(badBody.detail)).toBe(true);

    await request.delete(`${base}/api/canvases/${c.id}`, { headers: auth });
    cleanupIds = cleanupIds.filter((id) => id !== c.id);
  });

  test('duplicate: copies panels + annotations verbatim, resets annotations_rev, leaves the source untouched', async ({ request }) => {
    const src = await (await request.post(`${base}/api/canvases`, {
      headers: auth, data: { name: 'Dup Source QA', width_mm: 150, height_mm: 100 },
    })).json();
    cleanupIds.push(src.id);
    await request.post(`${base}/api/canvases/${src.id}/panels`, {
      headers: auth, data: { figure_id: ENV.FIG, x_mm: 10, y_mm: 12, width_mm: 50, height_mm: 30, label: 'A' },
    });
    const ann = {
      id: 'rect-1', type: 'rect', x_mm: 5, y_mm: 6, w_mm: 20, h_mm: 15, z: 0,
      stroke_hex: '#ff0000', stroke_pt: 1.5, fill_hex: '#00ff00',
    };
    const patched = await (await request.patch(`${base}/api/canvases/${src.id}`, {
      headers: auth, data: { annotations: [ann] },
    })).json();
    expect(patched.annotations_rev).toBe(1);

    const before = await (await request.get(`${base}/api/canvases/${src.id}`, { headers: auth })).json();

    const dupRes = await request.post(`${base}/api/canvases/${src.id}/duplicate`, { headers: auth });
    expect(dupRes.status()).toBe(201);
    const dup = await dupRes.json();
    cleanupIds.push(dup.id);

    expect(dup.id).not.toBe(src.id);
    expect(dup.name).toBe(`${before.name} (copy)`);
    expect(dup.name.endsWith(' (copy)')).toBe(true);
    expect(dup.owner_id).toBe(before.owner_id);
    // The source canvas has no project — the copy must be personal, not
    // silently (re-)shared anywhere.
    expect(dup.project_id).toBeNull();
    expect(dup.width_mm).toBe(before.width_mm);
    expect(dup.height_mm).toBe(before.height_mm);
    expect(dup.background).toBe(before.background);
    expect(dup.annotations_rev).toBe(0);

    expect(dup.panels.length).toBe(before.panels.length);
    const geom = (p) => ({
      figure_id: p.figure_id,
      x_mm: p.x_mm,
      y_mm: p.y_mm,
      width_mm: p.width_mm,
      height_mm: p.height_mm,
      z_order: p.z_order,
      label: p.label,
      label_visible: p.label_visible,
    });
    expect(dup.panels.map(geom)).toEqual(before.panels.map(geom));
    // Panel ids are NEW (not shared with the source).
    expect(dup.panels[0].id).not.toBe(before.panels[0].id);

    // Annotations are deep-copied VERBATIM, ids included (design: annotation
    // ids are only unique per-canvas).
    expect(dup.annotations).toEqual(before.annotations);

    // The source is untouched by duplicating it.
    const after = await (await request.get(`${base}/api/canvases/${src.id}`, { headers: auth })).json();
    expect(after.annotations).toEqual(before.annotations);
    expect(after.annotations_rev).toBe(before.annotations_rev);
    expect(after.panels.map(geom)).toEqual(before.panels.map(geom));
    expect(after.panels[0].id).toBe(before.panels[0].id);

    await request.delete(`${base}/api/canvases/${dup.id}`, { headers: auth });
    await request.delete(`${base}/api/canvases/${src.id}`, { headers: auth });
    cleanupIds = cleanupIds.filter((id) => id !== dup.id && id !== src.id);
  });

  test('grid snap (toggle + persistence + drag-to-grid) and zoom shortcuts (1 / Shift+1)', async ({ page, request }) => {
    const c = await (await request.post(`${base}/api/canvases`, {
      headers: auth, data: { name: 'Grid/Zoom QA', width_mm: 180, height_mm: 120 },
    })).json();
    cleanupIds.push(c.id);
    // Panel width/height are themselves multiples of the 5mm grid pitch, so
    // when the LEFT edge lands on a grid line, the right edge and center do
    // too (35, 60, 85mm are all grid lines) — every candidate edge in
    // handleDragMove's nearest-wins scan agrees on the same correction,
    // independent of the real pxPerMm for whatever viewport this runs in.
    await request.post(`${base}/api/canvases/${c.id}/panels`, {
      headers: auth, data: { figure_id: ENV.FIG, x_mm: 33, y_mm: 42, width_mm: 50, height_mm: 30, label: 'A' },
    });

    await authedPage(page, tokens);
    await page.goto(`/canvases/${c.id}`, { waitUntil: 'networkidle' });
    // U9's mm rulers are real <canvas> elements too, but CanvasEditor renders
    // them AFTER the Konva Stage precisely so the Stage stays the document's
    // FIRST <canvas> — preserving the whole suite's `.first()` convention.
    const stage = page.locator('canvas').first();
    await expect(stage).toBeVisible();

    const snapToggle = page.getByRole('button', { name: 'Snap to grid' });
    await expect(snapToggle).toBeVisible();
    await expect(snapToggle).toHaveAttribute('aria-pressed', 'false');
    await snapToggle.click();
    await expect(snapToggle).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => window.localStorage.getItem('labplot.canvas.grid-snap'))).toBe('1');

    // Persistence across reload.
    await page.reload({ waitUntil: 'networkidle' });
    const stage2 = page.locator('canvas').first();
    await expect(stage2).toBeVisible();
    await expect(page.getByRole('button', { name: 'Snap to grid' })).toHaveAttribute('aria-pressed', 'true');

    // ---- drag the panel so its (unsnapped) left edge lands a few screen px
    // past the 35mm grid line; grid-snap should pull it back exactly onto it ----
    const box = await stage2.boundingBox();
    const origin = sheetOrigin(box, 180, 120);
    const startX = origin.x + (33 + 25) * origin.pxPerMm; // panel center: safe mousedown hit
    const startY = origin.y + (42 + 15) * origin.pxPerMm;
    // SNAP_PX (CanvasEditor.tsx) is a fixed 6 SCREEN px threshold at zoom=1
    // (the editor's initial/just-reloaded zoom) — independent of pxPerMm/mm
    // size. +3px keeps this comfortably inside that threshold with margin,
    // while being far too large a raw-drag error to land within the 0.05mm
    // EPS below by chance if grid-snap did NOT engage.
    const deltaXpx = (35 - 33) * origin.pxPerMm + 3;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + deltaXpx / 2, startY, { steps: 5 });
    await page.mouse.move(startX + deltaXpx, startY, { steps: 5 });
    await page.mouse.up();

    await expect.poll(async () => {
      const cv = await (await request.get(`${base}/api/canvases/${c.id}`, { headers: auth })).json();
      return cv.panels[0].x_mm;
    }, { timeout: 15000 }).toBeCloseTo(35, 1); // toBeCloseTo(_, 1) === within 0.05mm

    // ---- zoom shortcuts: '1' = 100%, Shift+1 = fit ----
    const zoomLabel = page.locator('span.tabular-nums');
    await expect(zoomLabel).toBeVisible();
    // Captured while still at the editor's initial/reload fit view. By
    // construction (fitView() in CanvasEditor.tsx always sets zoom:1 — the
    // fit scale is already baked into pxPerMm, so "fit" and "100%" are the
    // SAME zoom level in this app) this reads "100%", but we compare against
    // the captured text rather than hardcoding that, per the brief.
    const fitText = (await zoomLabel.textContent()).trim();

    const zoomInBtn = page.getByRole('button', { name: 'Zoom in' });
    await zoomInBtn.click();
    await zoomInBtn.click();
    await expect(zoomLabel).not.toHaveText(fitText);
    // Clicking a button leaves it focused in Chromium, and the '1'/Shift+1
    // shortcuts are guarded off while a button/switch/etc. has focus (same
    // guard as the U8 tool shortcuts) — blur before dispatching the key.
    await page.evaluate(() => { const el = document.activeElement; if (el && el.blur) el.blur(); });
    await page.keyboard.press('1');
    await expect(zoomLabel).toHaveText('100%');

    await zoomInBtn.click();
    await zoomInBtn.click();
    await expect(zoomLabel).not.toHaveText('100%');
    await page.evaluate(() => { const el = document.activeElement; if (el && el.blur) el.blur(); });
    await page.keyboard.press('Shift+1');
    await expect(zoomLabel).toHaveText(fitText);

    await request.delete(`${base}/api/canvases/${c.id}`, { headers: auth });
    cleanupIds = cleanupIds.filter((id) => id !== c.id);
  });
});
