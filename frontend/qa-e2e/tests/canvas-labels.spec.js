const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

// M-C1 §3/§4/§5: canvas.style.label (format/bold/pt/placement/offset_mm) and
// the "Relabel A→Z" reading-order action. Server-truth expect.poll, no
// waitForTimeout — same discipline as canvas-annotations.spec.js.
test.describe('panel labels (M-C1 §3/§4/§5)', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a figure id');
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

  test('PATCH canvas.style.label: sanitized defaults on a fresh canvas, then round-trips valid values', async ({ request }) => {
    const c = await (await request.post(`${base}/api/canvases`, {
      headers: auth, data: { name: 'Label Style QA', width_mm: 150, height_mm: 100 },
    })).json();
    cleanupIds.push(c.id);

    // Defaults: format A, bold true, pt 12, placement inside, offset 1.0mm.
    expect(c.style?.label).toEqual({ format: 'A', bold: true, pt: 12, placement: 'inside', offset_mm: 1 });

    const patched = await (await request.patch(`${base}/api/canvases/${c.id}`, {
      headers: auth,
      data: { style: { label: { format: '(A)', bold: false, pt: 9, placement: 'outside', offset_mm: 2.5 } } },
    })).json();
    expect(patched.style.label).toEqual({ format: '(A)', bold: false, pt: 9, placement: 'outside', offset_mm: 2.5 });

    // Out-of-range pt (>18) is rejected with CANVAS_STYLE_INVALID (400).
    const bad = await request.patch(`${base}/api/canvases/${c.id}`, {
      headers: auth, data: { style: { label: { format: 'A', bold: true, pt: 99, placement: 'inside', offset_mm: 1 } } },
    });
    expect(bad.status()).toBe(400);
  });

  test('Relabel A→Z button: reassigns letters in row-major reading order in one click', async ({ page, request }) => {
    const c = await (await request.post(`${base}/api/canvases`, {
      headers: auth, data: { name: 'Relabel QA', width_mm: 200, height_mm: 150 },
    })).json();
    cleanupIds.push(c.id);
    // Place three panels out of reading order: bottom-left, top-right, top-left.
    // Row-major reading order (top-to-bottom, then left-to-right within a row)
    // must yield top-left -> top-right -> bottom-left, i.e. A/B/C respectively
    // — none of which match each panel's current (deliberately wrong) label.
    const bottomLeft = await (await request.post(`${base}/api/canvases/${c.id}/panels`, {
      headers: auth, data: { figure_id: ENV.FIG, x_mm: 10, y_mm: 90, width_mm: 60, height_mm: 40, label: 'X' },
    })).json();
    const topRight = await (await request.post(`${base}/api/canvases/${c.id}/panels`, {
      headers: auth, data: { figure_id: ENV.FIG, x_mm: 120, y_mm: 10, width_mm: 60, height_mm: 40, label: 'Y' },
    })).json();
    const topLeft = await (await request.post(`${base}/api/canvases/${c.id}/panels`, {
      headers: auth, data: { figure_id: ENV.FIG, x_mm: 10, y_mm: 10, width_mm: 60, height_mm: 40, label: 'Z' },
    })).json();

    await authedPage(page, tokens);
    await page.goto(`/canvases/${c.id}`, { waitUntil: 'networkidle' });
    const stage = page.locator('canvas').first();
    await expect(stage).toBeVisible();

    const relabelBtn = page.getByRole('button', { name: 'Relabel A→Z' });
    await expect(relabelBtn).toBeEnabled();
    await relabelBtn.click();

    await expect.poll(async () => {
      const cv = await (await request.get(`${base}/api/canvases/${c.id}`, { headers: auth })).json();
      const byId = Object.fromEntries(cv.panels.map((p) => [p.id, p.label]));
      return [byId[topLeft.id], byId[topRight.id], byId[bottomLeft.id]];
    }, { timeout: 15000 }).toEqual(['A', 'B', 'C']);

    // A second click with labels already in order is a no-op (no new history
    // entry) — confirm via the info toast rather than an unchanged network call.
    await relabelBtn.click();
    await expect(page.getByText('Labels already match reading order')).toBeVisible();
  });

  test('Journal panel: label format buttons patch canvas.style.label', async ({ page, request }) => {
    const c = await (await request.post(`${base}/api/canvases`, {
      headers: auth, data: { name: 'Label Controls QA', width_mm: 150, height_mm: 100 },
    })).json();
    cleanupIds.push(c.id);

    await authedPage(page, tokens);
    await page.goto(`/canvases/${c.id}`, { waitUntil: 'networkidle' });
    await expect(page.locator('canvas').first()).toBeVisible();

    const journalToggle = page.getByRole('button', { name: 'Journal', exact: true });
    await journalToggle.click();
    await expect(journalToggle).toHaveAttribute('aria-pressed', 'true');

    const lowerFormatBtn = page.getByRole('button', { name: 'a', exact: true });
    await expect(lowerFormatBtn).toBeVisible();
    await lowerFormatBtn.click();

    await expect.poll(async () => {
      const cv = await (await request.get(`${base}/api/canvases/${c.id}`, { headers: auth })).json();
      return cv.style?.label?.format;
    }, { timeout: 15000 }).toBe('a');

    const boldToggle = page.getByRole('switch', { name: 'Bold' });
    await boldToggle.click();
    await expect.poll(async () => {
      const cv = await (await request.get(`${base}/api/canvases/${c.id}`, { headers: auth })).json();
      return cv.style?.label?.bold;
    }, { timeout: 15000 }).toBe(false);
  });

  test('non-canonical label: editor input and exported SVG <text> agree (frontend formatLabel === backend _format_label)', async ({ page, request }) => {
    // Mirrors panelLabel.ts's formatLabel (M-C1 §4 / finding [1]): trim, and
    // lowercase ONLY for format 'a' — never uppercase a free-text label. The
    // backend's _format_label (canvases/service.py) must produce the exact
    // same string for the exported SVG <text> to match what the editor shows.
    function formatLabel(raw, format) {
      const letter = (raw ?? '').trim();
      if (!letter) return letter;
      switch (format) {
        case 'a': return letter.toLowerCase();
        case '(A)': return `(${letter})`;
        case 'A.': return `${letter}.`;
        default: return letter;
      }
    }

    const c = await (await request.post(`${base}/api/canvases`, {
      headers: auth, data: { name: 'Non-canonical Label QA', width_mm: 150, height_mm: 100 },
    })).json();
    cleanupIds.push(c.id);
    const panel = await (await request.post(`${base}/api/canvases/${c.id}/panels`, {
      headers: auth, data: { figure_id: ENV.FIG, x_mm: 10, y_mm: 10, width_mm: 60, height_mm: 40, label: 'X' },
    })).json();

    await authedPage(page, tokens);
    await page.goto(`/canvases/${c.id}`, { waitUntil: 'networkidle' });
    const stage = page.locator('canvas').first();
    await expect(stage).toBeVisible();

    // Select the panel (click its mm-space center on the stage, same
    // fit-to-viewport geometry as canvas-panel-bounds.spec.js) then type a
    // deliberately non-canonical, lowercase, free-text label.
    const box = await stage.boundingBox();
    const pxPerMm = Math.min(Math.max(1, box.width - 96) / 150, Math.max(1, box.height - 96) / 100);
    const sheetX = box.x + (box.width - 150 * pxPerMm) / 2;
    const sheetY = box.y + (box.height - 100 * pxPerMm) / 2;
    await page.mouse.click(sheetX + 40 * pxPerMm, sheetY + 30 * pxPerMm); // panel center (10..70, 10..50 mm)
    const labelInput = page.getByRole('textbox', { name: 'Panel label' });
    await expect(labelInput).toBeVisible();
    const rawLabel = 'sig';
    await labelInput.fill(rawLabel);
    await labelInput.blur();

    await expect.poll(async () => {
      const cv = await (await request.get(`${base}/api/canvases/${c.id}`, { headers: auth })).json();
      return cv.panels.find((p) => p.id === panel.id)?.label;
    }, { timeout: 15000 }).toBe(rawLabel);

    // Format is still the canonical default 'A' — the fixed formatLabel must
    // NOT uppercase it, so the expected export text is the raw label itself.
    const expectedText = formatLabel(rawLabel, 'A');
    expect(expectedText).toBe(rawLabel); // sanity: this is the whole point of finding [1]

    const exp = await (await request.post(`${base}/api/canvases/${c.id}/export`, {
      headers: auth, data: { format: 'svg' },
    })).json();
    const svgBuf = await (await request.get(base + exp.url, { headers: auth })).body();
    const svgText = svgBuf.toString('utf-8');
    const labelTextRe = /<text[^>]*font-family="Helvetica, Arial, sans-serif"[^>]*>([^<]*)<\/text>/g;
    const matches = [...svgText.matchAll(labelTextRe)].map((m) => m[1]);
    expect(matches).toContain(expectedText);
    // The old (buggy) frontend would have uppercased this to 'SIG' — make
    // sure that string is nowhere in the label texts.
    expect(matches).not.toContain(rawLabel.toUpperCase());
  });
});
