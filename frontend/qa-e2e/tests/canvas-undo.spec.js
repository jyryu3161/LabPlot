const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

// M2/UX: canvas undo/redo + interaction hints. Follows the playwright-automation
// skill discipline — user-facing locators (getByRole/aria-label), web-first
// assertions + expect.poll instead of waitForTimeout, API for state truth.
test.describe('canvas undo/redo + hints', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a figure id');
  let tokens, auth, base;
  test.beforeEach(async ({ request }) => {
    tokens = await apiLogin(request);
    auth = { Authorization: `Bearer ${tokens.access_token}` };
    base = ENV.BASE;
  });

  // A Konva pixel-drag is inherently flaky under Playwright (canvas has no DOM
  // nodes to target), so instead we drive the SAME history engine through two
  // deterministic, DOM-addressable ops: panel-add (via the figure picker) and
  // panel-update (via the auto-selected panel's label field). Redo of the add
  // recreates the panel with a NEW server id, so redo of the label change only
  // lands if CanvasHistory's idMap remap works — the most bug-prone path.
  test('undo/redo across panel add + update, verified against the server', async ({ page, request }) => {
    const c = await (await request.post(`${base}/api/canvases`, { headers: auth, data: { name: 'Undo QA', width_mm: 180, height_mm: 120 } })).json();
    const server = async () => {
      const cv = await (await request.get(`${base}/api/canvases/${c.id}`, { headers: auth })).json();
      return cv.panels;
    };
    const count = async () => (await server()).length;
    const firstLabel = async () => { const p = await server(); return p.length ? p[0].label : null; };

    await authedPage(page, tokens);
    await page.goto(`/canvases/${c.id}`, { waitUntil: 'networkidle' });

    const undoBtn = page.getByRole('button', { name: 'Undo', exact: true });
    const redoBtn = page.getByRole('button', { name: 'Redo', exact: true });
    // Empty canvas -> nothing to undo yet.
    await expect(undoBtn).toBeDisabled();
    await expect(await count()).toBe(0);

    // 1) Add a figure -> a panel appears and is auto-selected.
    await page.getByRole('button', { name: 'Add figure' }).click();
    const picker = page.getByRole('dialog', { name: /add a figure/i });
    await expect(picker).toBeVisible();
    await picker.locator('div.grid > button').first().click();
    await expect.poll(count, { timeout: 15000 }).toBe(1);
    await expect(undoBtn).toBeEnabled();

    // 2) Rename the auto-selected panel -> records a panel-update.
    const labelInput = page.getByRole('textbox', { name: 'Panel label' });
    await expect(labelInput).toBeVisible();
    await labelInput.fill('Z');
    await labelInput.press('Enter');
    await expect.poll(firstLabel, { timeout: 15000 }).toBe('Z');

    // Undo the rename -> label reverts (panel stays).
    await undoBtn.click();
    await expect.poll(firstLabel, { timeout: 15000 }).toBe('A');
    await expect.poll(count).toBe(1);

    // Undo the add -> panel removed.
    await undoBtn.click();
    await expect.poll(count, { timeout: 15000 }).toBe(0);
    await expect(undoBtn).toBeDisabled();

    // Redo the add -> panel recreated with a NEW server id.
    await expect(redoBtn).toBeEnabled();
    await redoBtn.click();
    await expect.poll(count, { timeout: 15000 }).toBe(1);
    await expect.poll(firstLabel).toBe('A');

    // Redo the rename -> only lands if the idMap remapped to the new id.
    await redoBtn.click();
    await expect.poll(firstLabel, { timeout: 15000 }).toBe('Z');

    // Ctrl+Z undoes the rename again (keyboard path; focus is on the Redo
    // button, not an input, so the editor's input-focus guard lets it through).
    await page.keyboard.press('Control+z');
    await expect.poll(firstLabel, { timeout: 15000 }).toBe('A');

    await request.delete(`${base}/api/canvases/${c.id}`, { headers: auth });
  });

  test('interaction hints: help popover + dismissible hints bar', async ({ page, request }) => {
    const c = await (await request.post(`${base}/api/canvases`, { headers: auth, data: { name: 'Hints QA', width_mm: 160, height_mm: 100 } })).json();
    await request.post(`${base}/api/canvases/${c.id}/panels`, { headers: auth, data: { figure_id: ENV.FIG, x_mm: 10, y_mm: 10, width_mm: 70, height_mm: 46, label: 'A' } });
    await authedPage(page, tokens);
    await page.goto(`/canvases/${c.id}`, { waitUntil: 'networkidle' });
    await expect(page.locator('canvas').first()).toBeVisible();

    // Help popover opens and lists gestures
    await page.getByRole('button', { name: 'Canvas editor help' }).click();
    const dialog = page.getByRole('dialog', { name: /gestures|shortcuts/i });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/drag/i);
    await expect(dialog).toContainText(/zoom/i);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Hints bar is present (panels exist) and dismissible + persists
    const dismiss = page.getByRole('button', { name: 'Dismiss hints' });
    await expect(dismiss).toBeVisible();
    await dismiss.click();
    await expect(dismiss).toBeHidden();
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('canvas').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dismiss hints' })).toBeHidden();

    await request.delete(`${base}/api/canvases/${c.id}`, { headers: auth });
  });
});
