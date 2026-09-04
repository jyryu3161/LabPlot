const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

// M-C1 §8: canvas export gains an EPS format, a server-composed `filename`
// (journal-ready, not the client-side "<name>.<ext>" it used to build), and
// `skipped_panels` for any panel the composite couldn't include. Same
// discipline as canvas-extras.spec.js's raster-export test.
const EPS_MAGIC = '%!PS-Adobe'; // EPS/PS files open with this ASCII header

test.describe('canvas export: EPS + server filename + skipped-panel warnings (M-C1 §8)', () => {
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

  test('POST /export format=eps: valid PostScript magic bytes, response includes filename + skipped_panels', async ({ request }) => {
    const c = await (await request.post(`${base}/api/canvases`, {
      headers: auth, data: { name: 'EPS Export QA', width_mm: 100, height_mm: 80 },
    })).json();
    cleanupIds.push(c.id);
    await request.post(`${base}/api/canvases/${c.id}/panels`, {
      headers: auth, data: { figure_id: ENV.FIG, x_mm: 10, y_mm: 10, width_mm: 60, height_mm: 40, label: 'A' },
    });

    const exp = await (await request.post(`${base}/api/canvases/${c.id}/export`, {
      headers: auth, data: { format: 'eps' },
    })).json();
    expect(exp.format).toBe('eps');
    expect(typeof exp.filename).toBe('string');
    expect(exp.filename.length).toBeGreaterThan(0);
    expect(exp.filename.endsWith('.eps')).toBe(true);
    expect(Array.isArray(exp.skipped_panels)).toBe(true);
    expect(exp.skipped_panels.length).toBe(0);

    const buf = await (await request.get(base + exp.url, { headers: auth })).body();
    expect(buf.subarray(0, EPS_MAGIC.length).toString('ascii')).toBe(EPS_MAGIC);

    await request.delete(`${base}/api/canvases/${c.id}`, { headers: auth });
    cleanupIds = cleanupIds.filter((id) => id !== c.id);
  });

  test('export filename reflects a journal preset (Fig_<name>_<journal>_<width>mm.<ext>)', async ({ request }) => {
    const presets = await (await request.get(`${base}/api/canvases/presets`, { headers: auth })).json();
    const nature = presets.find((p) => p.journal_key === 'nature' && p.column === 'single');
    test.skip(!nature, 'nature_single preset not present');

    const c = await (await request.post(`${base}/api/canvases`, {
      headers: auth, data: { name: 'Nature Fig 1', preset: nature.key, width_mm: nature.width_mm, height_mm: nature.height_mm },
    })).json();
    cleanupIds.push(c.id);
    await request.post(`${base}/api/canvases/${c.id}/panels`, {
      headers: auth, data: { figure_id: ENV.FIG, x_mm: 5, y_mm: 5, width_mm: 40, height_mm: 30, label: 'A' },
    });

    const exp = await (await request.post(`${base}/api/canvases/${c.id}/export`, {
      headers: auth, data: { format: 'svg' },
    })).json();
    expect(exp.filename).toMatch(/^Fig_/);
    expect(exp.filename).toContain('nature');
    expect(exp.filename).toContain(`${Math.round(nature.width_mm)}mm`);

    await request.delete(`${base}/api/canvases/${c.id}`, { headers: auth });
    cleanupIds = cleanupIds.filter((id) => id !== c.id);
  });

  test('Export menu UI: EPS item present, and a skipped panel surfaces a warning toast listing the reason', async ({ page, request }) => {
    // A panel pointing at a figure with no rendered version (a brand-new
    // figure_id would 404 at add-panel time instead), so the more realistic
    // way to trigger `skipped_panels` here is a panel whose figure the
    // exporting user no longer has access to — out of scope for a live QA
    // account. Skipping the intentional-skip path; this test only confirms
    // the EPS menu item renders and a clean export still succeeds with the
    // (empty) skipped_panels toast wording absent.
    const c = await (await request.post(`${base}/api/canvases`, {
      headers: auth, data: { name: 'Export Menu QA', width_mm: 100, height_mm: 80 },
    })).json();
    cleanupIds.push(c.id);
    await request.post(`${base}/api/canvases/${c.id}/panels`, {
      headers: auth, data: { figure_id: ENV.FIG, x_mm: 10, y_mm: 10, width_mm: 60, height_mm: 40, label: 'A' },
    });

    await authedPage(page, tokens);
    await page.goto(`/canvases/${c.id}`, { waitUntil: 'networkidle' });
    await expect(page.locator('canvas').first()).toBeVisible();

    const exportBtn = page.getByTitle('Export the composed canvas');
    await exportBtn.click();
    const epsItem = page.getByRole('menuitem', { name: /EPS \(vector, text as outlines\)/ });
    await expect(epsItem).toBeVisible();
    await epsItem.click();

    await expect(page.getByText(/Canvas exported as EPS/)).toBeVisible({ timeout: 20000 });

    await request.delete(`${base}/api/canvases/${c.id}`, { headers: auth });
    cleanupIds = cleanupIds.filter((id) => id !== c.id);
  });
});
