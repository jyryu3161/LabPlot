const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

// M-C1 §1/§2: journal preset catalog (GET /api/canvases/presets) and the
// "New canvas" dialog's journal-grouped preset selector. Same discipline as
// canvas-extras.spec.js — server-truth API assertions first, then a thin UI
// check that the grouping actually renders.
test.describe('journal presets (M-C1 §1/§2)', () => {
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

  test('GET /api/canvases/presets: A4 first (no journal), then journal presets grouped single→onehalf→double with max_height_mm', async ({ request }) => {
    const presets = await (await request.get(`${base}/api/canvases/presets`, { headers: auth })).json();
    expect(Array.isArray(presets)).toBe(true);
    expect(presets.length).toBeGreaterThan(2);

    // A4 portrait + landscape lead, with journal: null.
    expect(presets[0].journal).toBeNull();
    expect(presets[1].journal).toBeNull();
    expect(presets[0].width_mm).toBeCloseTo(210, 0);
    expect(presets[0].height_mm).toBeCloseTo(297, 0);

    // Every non-A4 entry carries journal/journal_key/column and a numeric or
    // null max_height_mm, and height_mm never exceeds it.
    const journalPresets = presets.filter((p) => p.journal);
    expect(journalPresets.length).toBeGreaterThan(0);
    for (const p of journalPresets) {
      expect(typeof p.journal_key).toBe('string');
      expect(['single', 'onehalf', 'double']).toContain(p.column);
      expect(p.max_height_mm === null || typeof p.max_height_mm === 'number').toBe(true);
      if (p.max_height_mm != null) expect(p.height_mm).toBeLessThanOrEqual(p.max_height_mm);
    }

    // The new "elsevier" journal entry exists with single/double columns.
    const elsevier = journalPresets.filter((p) => p.journal_key === 'elsevier');
    expect(elsevier.length).toBeGreaterThanOrEqual(2);
    expect(elsevier.some((p) => p.column === 'single')).toBe(true);
    expect(elsevier.some((p) => p.column === 'double')).toBe(true);

    // Within one journal, presets are ordered single -> onehalf (if any) -> double.
    const byJournal = new Map();
    for (const p of journalPresets) {
      const arr = byJournal.get(p.journal_key) ?? [];
      arr.push(p.column);
      byJournal.set(p.journal_key, arr);
    }
    const order = { single: 0, onehalf: 1, double: 2 };
    for (const columns of byJournal.values()) {
      const indices = columns.map((c) => order[c]);
      expect([...indices]).toEqual([...indices].sort((a, b) => a - b));
    }
  });

  test('creating a canvas with a journal preset key sets width/height/preset from the catalog', async ({ request }) => {
    const presets = await (await request.get(`${base}/api/canvases/presets`, { headers: auth })).json();
    const nature = presets.find((p) => p.journal_key === 'nature' && p.column === 'single');
    test.skip(!nature, 'nature_single preset not present');

    const c = await (await request.post(`${base}/api/canvases`, {
      headers: auth, data: { name: 'Journal Preset QA', preset: nature.key, width_mm: nature.width_mm, height_mm: nature.height_mm },
    })).json();
    cleanupIds.push(c.id);
    expect(c.preset).toBe(nature.key);
    expect(c.width_mm).toBeCloseTo(nature.width_mm, 1);
    expect(c.height_mm).toBeCloseTo(nature.height_mm, 1);
  });

  test('New canvas dialog: preset select groups journal presets under a journal heading', async ({ page, request }) => {
    tokens = await apiLogin(request);
    await authedPage(page, tokens);
    await page.goto('/canvases', { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: 'New canvas' }).click();
    const dialog = page.getByRole('dialog', { name: 'New canvas' });
    await expect(dialog).toBeVisible();

    const presetTrigger = dialog.getByLabel('Canvas size preset');
    await expect(presetTrigger).toBeVisible();
    await presetTrigger.click();

    // At least one journal group heading (e.g. "Nature") renders, and its
    // options show the width in mm and (when present) a max height.
    const natureGroup = page.getByText('Nature', { exact: true });
    await expect(natureGroup).toBeVisible();
    await expect(page.getByText(/mm.*max \d+ mm/).first()).toBeVisible();

    await page.keyboard.press('Escape');
  });
});
