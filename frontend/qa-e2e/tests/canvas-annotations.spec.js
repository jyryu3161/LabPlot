const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

// U8: canvas text/shape annotation objects (toolbar tools, inline text edit,
// drag-to-create shapes, server-side sanitization, SVG export parity). Same
// discipline as the other canvas specs — user-facing locators, server-truth
// expect.poll, no waitForTimeout.
//
// Click-point math copied verbatim from canvas-multiselect.spec.js (U7): the
// Stage is fit-centered via fitPxPerMm(canvasW, canvasH, viewport.w,
// viewport.h, marginPx=48) from mm.ts (zoom=1 on initial load), so this
// reproduces the exact formula rather than hand-tuned viewport fractions —
// shape-creation drags have a real geometric minimum (MIN_CREATE_DRAG_MM) so
// the click math needs to be precise, not just "somewhere on the sheet".
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

// Mirrors the backend's `_num()` formatter exactly (service.py: "trim noise,
// never scientific" — 4 decimal places, strip trailing zeros/dot) so a
// server-truth mm value can be matched byte-for-byte against an SVG attribute.
function numFmt(v) {
  let s = Number(v).toFixed(4);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '' ? '0' : s;
}

test.describe('canvas annotations (U8)', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a figure id');
  let tokens, auth, base;
  let cleanupCanvasId = null;
  test.beforeEach(async ({ request }) => {
    tokens = await apiLogin(request);
    auth = { Authorization: `Bearer ${tokens.access_token}` };
    base = ENV.BASE;
    cleanupCanvasId = null;
  });
  // Safety net: if a test fails before its own explicit cleanup runs, still
  // remove the canvas so QA_FIG's account doesn't accumulate junk canvases.
  test.afterEach(async ({ request }) => {
    if (cleanupCanvasId) {
      await request.delete(`${base}/api/canvases/${cleanupCanvasId}`, { headers: auth }).catch(() => {});
      cleanupCanvasId = null;
    }
  });

  test('text tool: click-create, inline edit, export parity, undo removes it', async ({ page, request }) => {
    const c = await (await request.post(`${base}/api/canvases`, {
      headers: auth, data: { name: 'Ann Text QA', width_mm: 180, height_mm: 120 },
    })).json();
    cleanupCanvasId = c.id;

    const serverAnnotations = async () => {
      const cv = await (await request.get(`${base}/api/canvases/${c.id}`, { headers: auth })).json();
      return cv.annotations;
    };
    await expect.poll(async () => (await serverAnnotations()).length).toBe(0);

    await authedPage(page, tokens);
    await page.goto(`/canvases/${c.id}`, { waitUntil: 'networkidle' });
    const stage = page.locator('canvas').first();
    await expect(stage).toBeVisible();
    const box = await stage.boundingBox();
    const origin = sheetOrigin(box, 180, 120);

    await page.getByRole('button', { name: 'Text tool (T)' }).click();
    // Center of the sheet — comfortably clear of the tool palette pinned at
    // the top-left corner (left-2 top-2 in CanvasAnnotationToolbar.tsx).
    const clickX = origin.x + 90 * origin.pxPerMm;
    const clickY = origin.y + 60 * origin.pxPerMm;
    await page.mouse.click(clickX, clickY);

    // The inline editor only mounts once `textEditingAnn` resolves against the
    // live annotations array (CanvasEditor.tsx's textEditRect is null, and the
    // portal doesn't render, until then) — `patchAnnotations`'s `onMutate`
    // writes the new annotation into the query cache optimistically, so this
    // resolves on the next tick rather than waiting for the real PATCH
    // round-trip; `expect(...).toBeVisible()` covers either timing.
    const input = page.getByRole('textbox', { name: 'Annotation text' });
    await expect(input).toBeVisible();

    const marker = `QA annotation ${Date.now()}`;
    await input.fill(marker);
    await input.press('Enter');

    await expect.poll(async () => {
      const anns = await serverAnnotations();
      return anns.length === 1 ? anns[0].text : null;
    }, { timeout: 15000 }).toBe(marker);
    const created = (await serverAnnotations())[0];
    expect(created.type).toBe('text');

    // Export SVG (API) and confirm the committed string round-trips into a
    // real <text> element (export parity, not just DB storage).
    const exp = await (await request.post(`${base}/api/canvases/${c.id}/export`, {
      headers: auth, data: { format: 'svg' },
    })).json();
    const svg = await (await request.get(base + exp.url, { headers: auth })).text();
    expect(svg).toContain(`>${marker}</text>`);

    // Undo. A freshly-placed text annotation is local-only until its first
    // real text commits, which records ONE combined 'add text' history entry
    // (before = pre-creation array) — so a SINGLE Ctrl+Z removes the
    // annotation entirely.
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await serverAnnotations()).length, { timeout: 15000 }).toBe(0);

    await request.delete(`${base}/api/canvases/${c.id}`, { headers: auth });
    cleanupCanvasId = null;
  });

  test('rect tool: drag-create, export ordering after panels, invalid PATCH rejected', async ({ page, request }) => {
    const c = await (await request.post(`${base}/api/canvases`, {
      headers: auth, data: { name: 'Ann Rect QA', width_mm: 180, height_mm: 120 },
    })).json();
    cleanupCanvasId = c.id;
    await request.post(`${base}/api/canvases/${c.id}/panels`, {
      headers: auth, data: { figure_id: ENV.FIG, x_mm: 8, y_mm: 8, width_mm: 78, height_mm: 52, label: 'A' },
    });

    const serverAnnotations = async () => {
      const cv = await (await request.get(`${base}/api/canvases/${c.id}`, { headers: auth })).json();
      return cv.annotations;
    };

    await authedPage(page, tokens);
    await page.goto(`/canvases/${c.id}`, { waitUntil: 'networkidle' });
    const stage = page.locator('canvas').first();
    await expect(stage).toBeVisible();
    const box = await stage.boundingBox();
    const origin = sheetOrigin(box, 180, 120);

    await page.getByRole('button', { name: 'Rectangle tool (R)' }).click();
    // Drag-create a 60x40mm rect well clear of the toolbar. Panels are
    // `listening={false}` while a creation tool is active (CanvasEditor.tsx),
    // so it's fine that this box overlaps the panel placed above.
    const x0 = origin.x + 60 * origin.pxPerMm;
    const y0 = origin.y + 40 * origin.pxPerMm;
    const x1 = origin.x + 120 * origin.pxPerMm;
    const y1 = origin.y + 80 * origin.pxPerMm;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 5 });
    await page.mouse.move(x1, y1, { steps: 5 });
    await page.mouse.up();

    await expect.poll(async () => (await serverAnnotations()).length, { timeout: 15000 }).toBe(1);
    const rect = (await serverAnnotations())[0];
    expect(rect.type).toBe('rect');
    // Plausible size for a 60x40mm drag (allow for pixel/mm rounding).
    expect(rect.w_mm).toBeGreaterThan(30);
    expect(rect.h_mm).toBeGreaterThan(20);
    expect(rect.x_mm).toBeGreaterThan(0);
    expect(rect.y_mm).toBeGreaterThan(0);

    // Export SVG and confirm the rect renders AFTER the panel's nested <svg>
    // markup (§ "annotations always paint above panels").
    const exp = await (await request.post(`${base}/api/canvases/${c.id}/export`, {
      headers: auth, data: { format: 'svg' },
    })).json();
    const svg = await (await request.get(base + exp.url, { headers: auth })).text();
    const panelSvgIdx = svg.indexOf('<svg x="');
    expect(panelSvgIdx, 'composite SVG should nest the panel as <svg x="...">').toBeGreaterThan(-1);
    const rectPrefix = `<rect x="${numFmt(rect.x_mm)}" y="${numFmt(rect.y_mm)}" `
      + `width="${numFmt(rect.w_mm)}" height="${numFmt(rect.h_mm)}" stroke="#000000"`;
    const rectIdx = svg.indexOf(rectPrefix);
    expect(rectIdx, `expected to find ${rectPrefix} in the export`).toBeGreaterThan(-1);
    expect(rectIdx, 'annotation rect must be emitted after the panel markup').toBeGreaterThan(panelSvgIdx);

    // Invalid annotation via direct API PATCH: a bad `type` must 400 with
    // BAD_ANNOTATIONS and must NOT touch the existing valid annotation.
    const before = await serverAnnotations();
    const bad = await request.patch(`${base}/api/canvases/${c.id}`, {
      headers: auth, data: { annotations: [{ type: 'blob' }] },
    });
    expect(bad.status()).toBe(400);
    const badBody = await bad.json();
    expect(badBody.detail.code).toBe('BAD_ANNOTATIONS');
    const after = await serverAnnotations();
    expect(after).toEqual(before);

    await request.delete(`${base}/api/canvases/${c.id}`, { headers: auth });
    cleanupCanvasId = null;
  });

  // Fable-review hardening (F0/F3/F4/F1): XML-invalid control chars are
  // STRIPPED (a NUL would otherwise 500 the jsonb write and a BEL would
  // permanently break SVG/PDF exports), duplicate ids and trailing-newline
  // hex are REJECTED, and the whole-array replace carries an optimistic-
  // concurrency rev (stale base -> 409, never silent clobber). Pure API test.
  test('sanitizer hardening: control chars stripped, dup ids / newline hex rejected, rev conflict 409s', async ({ request }) => {
    const c = await (await request.post(`${base}/api/canvases`, {
      headers: auth, data: { name: 'Ann Hardening QA', width_mm: 180, height_mm: 120 },
    })).json();
    cleanupCanvasId = c.id;

    // Control chars (BEL, NUL) stripped from text; PATCH succeeds and the
    // export stays a well-formed SVG.
    const ann = { id: 'hardening-1', type: 'text', x_mm: 20, y_mm: 20, text: 'no\u0007te\u0000QA', z: 0 };
    const r1 = await request.patch(`${base}/api/canvases/${c.id}`, { headers: auth, data: { annotations: [ann] } });
    expect(r1.status()).toBe(200);
    const d1 = await r1.json();
    expect(d1.annotations[0].text).toBe('noteQA');
    expect(d1.annotations_rev).toBe(1);
    const exp = await (await request.post(`${base}/api/canvases/${c.id}/export`, { headers: auth, data: { format: 'svg' } })).json();
    const svg = await (await request.get(base + exp.url, { headers: auth })).text();
    expect(svg).toContain('>noteQA</text>');

    // Duplicate ids -> 400; trailing-newline hex -> 400; stored state intact.
    const dup = await request.patch(`${base}/api/canvases/${c.id}`, {
      headers: auth,
      data: { annotations: [{ ...ann, id: 'x' }, { id: 'x', type: 'rect', x_mm: 1, y_mm: 1, w_mm: 5, h_mm: 5, z: 1 }] },
    });
    expect(dup.status()).toBe(400);
    expect((await dup.json()).detail.code).toBe('BAD_ANNOTATIONS');
    const badHex = await request.patch(`${base}/api/canvases/${c.id}`, {
      headers: auth,
      data: { annotations: [{ id: 'h', type: 'rect', x_mm: 1, y_mm: 1, w_mm: 5, h_mm: 5, stroke_hex: '#ff0000\n', z: 0 }] },
    });
    expect(badHex.status()).toBe(400);

    // Optimistic concurrency: stale base rev 409s without clobbering; the
    // matching rev succeeds and increments.
    const stale = await request.patch(`${base}/api/canvases/${c.id}`, {
      headers: auth, data: { annotations: [], base_annotations_rev: 0 },
    });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).detail.code).toBe('ANNOTATIONS_CONFLICT');
    const cur = await (await request.get(`${base}/api/canvases/${c.id}`, { headers: auth })).json();
    expect(cur.annotations[0].text).toBe('noteQA');
    const ok = await request.patch(`${base}/api/canvases/${c.id}`, {
      headers: auth, data: { annotations: [], base_annotations_rev: cur.annotations_rev },
    });
    expect(ok.status()).toBe(200);
    expect((await ok.json()).annotations_rev).toBe(cur.annotations_rev + 1);

    await request.delete(`${base}/api/canvases/${c.id}`, { headers: auth });
    cleanupCanvasId = null;
  });
});
