const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

// U11: two pure-frontend figure-page conveniences. Both tests are read-only
// against QA_FIG (many versions expected) - no version is created or mutated.
test.describe('figure page conveniences (U11)', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a figure id');

  // Generic per-type option labels (mirrors backend/app/r_engine/templates.py
  // PLOT_TYPES) that the option-search box filters. Only scatter/line are
  // covered because qa-e2e/README.md documents QA_FIG as "a continuous-axis
  // figure (scatter/line)". Both types define `y2_column` / `y2_label`
  // themselves, so the option-search box's own hardcoded "Secondary Y
  // column/label" fallback rows (only shown for OTHER plot types) never
  // render here - the labels below come from the generic per-type list.
  const OPTION_LABELS_BY_TYPE = {
    scatter: ['Regression line', 'Show fit stats (R², slope)', 'Secondary Y column', 'Secondary Y-axis label'],
    line: ['Line type', 'Point shape', 'Line color', 'Secondary Y column', 'Secondary Y-axis label'],
  };

  test('version compare slider: open, drag, keyboard, reset-on-select-change, close', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    const auth = { Authorization: `Bearer ${tokens.access_token}` };
    const fig = await (await request.get(`${ENV.BASE}/api/figures/${ENV.FIG}`, { headers: auth })).json();
    expect(fig.versions.length, 'QA_FIG needs >=2 versions for Compare').toBeGreaterThanOrEqual(2);

    await authedPage(page, tokens);
    await page.goto(`/figures/${ENV.FIG}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);

    const compareBtn = page.getByRole('button', { name: 'Compare versions' });
    await compareBtn.scrollIntoViewIfNeeded();
    await expect(compareBtn).toBeEnabled();
    await compareBtn.click();

    const dialog = page.getByRole('dialog', { name: 'Compare versions' });
    await expect(dialog).toBeVisible();

    // two version selects, each offering every version
    const baseSelect = dialog.locator('#compare-base-select');
    const compareSelect = dialog.locator('#compare-compare-select');
    await expect(baseSelect).toBeVisible();
    await expect(compareSelect).toBeVisible();
    expect(await baseSelect.locator('option').count()).toBe(fig.versions.length);
    expect(await compareSelect.locator('option').count()).toBe(fig.versions.length);

    // two overlay layers - each is a real <img> or the "no render" fallback
    const baseLayer = dialog.locator('img[alt^="Base: v"]').or(dialog.getByText(/No rendered image for v/));
    const compareLayer = dialog.locator('img[alt^="Compare: v"]').or(dialog.getByText(/No rendered image for v/));
    await expect(baseLayer.first()).toBeVisible();
    await expect(compareLayer.first()).toBeVisible();

    const divider = dialog.getByRole('slider', { name: 'Comparison divider' });
    await expect(divider).toBeVisible();

    const leftPercent = async () => {
      const style = await divider.getAttribute('style');
      const m = style && style.match(/left:\s*([\d.]+)%/);
      return m ? parseFloat(m[1]) : null;
    };

    const initialLeft = await leftPercent();
    expect(initialLeft).not.toBeNull();
    expect(initialLeft, 'divider starts centered').toBeCloseTo(50, 0);

    // drag the divider ~25% to the left with the mouse
    const container = divider.locator('xpath=..');
    const box = await container.boundingBox();
    expect(box, 'compare container has a bounding box').toBeTruthy();
    const startX = box.x + box.width * (initialLeft / 100);
    const startY = box.y + box.height / 2;
    const targetX = box.x + box.width * 0.25;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(targetX, startY, { steps: 12 });
    await page.mouse.up();

    const afterDragLeft = await leftPercent();
    expect(afterDragLeft, 'divider moved toward ~25% after drag').toBeCloseTo(25, -1);
    expect(Math.abs(afterDragLeft - initialLeft), 'drag actually changed the divider position').toBeGreaterThan(10);
    // aria-valuenow tracks the same value
    const valueNowAfterDrag = Number(await divider.getAttribute('aria-valuenow'));
    expect(Math.abs(valueNowAfterDrag - afterDragLeft)).toBeLessThanOrEqual(1);

    // keyboard: focus + ArrowLeft moves it a further fixed step
    await divider.focus();
    await page.keyboard.press('ArrowLeft');
    const afterArrowLeft = await leftPercent();
    expect(afterDragLeft - afterArrowLeft, 'ArrowLeft decreased divider by ~5%').toBeCloseTo(5, 0);

    // Changing either select resets the divider back to center (documented
    // behavior: the reset effect keys off [baseId, compareId], not dialog
    // open/close - see mismatch note in the final report).
    const baseValues = await baseSelect.locator('option').evaluateAll((opts) => opts.map((o) => o.value));
    const currentBaseValue = await baseSelect.inputValue();
    const otherBaseValue = baseValues.find((v) => v !== currentBaseValue);
    expect(otherBaseValue, 'QA_FIG has a second version to switch Base to').toBeTruthy();
    await baseSelect.selectOption(otherBaseValue);
    // The reset runs in a passive effect AFTER the select's commit+paint, so a
    // one-shot style read can sample the pre-reset value on a loaded runner.
    // aria-valuenow tracks dividerPct identically and toHaveAttribute
    // auto-retries — use it as the retrying oracle for the reset.
    await expect(divider).toHaveAttribute('aria-valuenow', '50');

    // close
    const closeBtn = dialog.getByRole('button', { name: 'Close' });
    await closeBtn.click();
    await expect(dialog).toBeHidden();
  });

  test('option search: filters plot-specific rows by label/key match with highlighting', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    const auth = { Authorization: `Bearer ${tokens.access_token}` };
    const fig = await (await request.get(`${ENV.BASE}/api/figures/${ENV.FIG}`, { headers: auth })).json();
    const labels = OPTION_LABELS_BY_TYPE[fig.plot_type];
    test.skip(!labels, `QA_FIG plot_type "${fig.plot_type}" is not one this spec has an option map for (expected scatter/line)`);

    await authedPage(page, tokens);
    await page.goto(`/figures/${ENV.FIG}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);

    const search = page.getByRole('searchbox', { name: 'Search options' });
    await search.scrollIntoViewIfNeeded();
    await expect(search).toBeVisible();

    const visibleCount = async () => {
      let n = 0;
      for (const label of labels) {
        if (await page.getByText(label, { exact: true }).count() > 0) n++;
      }
      return n;
    };

    // baseline: every generic option row for this plot type is visible
    const originalCount = await visibleCount();
    expect(originalCount, 'all known option rows visible before searching').toBe(labels.length);

    // a query that substring-matches exactly one row's label ("Secondary Y
    // column") and not the sibling "Secondary Y-axis label" row.
    const query = 'Secondary Y column';
    await search.fill(query);
    expect(await visibleCount(), 'only the matching row remains visible').toBe(1);
    // the surviving row highlights the matched substring (the whole label,
    // since the query matches it from index 0 to its full length)
    const highlighted = page.locator('mark', { hasText: query });
    await expect(highlighted).toBeVisible();
    await expect(highlighted).toHaveText(query);

    // gibberish query -> no matches, empty-state message shown
    await search.fill('zzzqqqxxnope');
    await expect(page.getByText(/No plot-specific options match/i)).toBeVisible();
    expect(await visibleCount(), 'no known option rows visible for gibberish query').toBe(0);

    // clear restores the original set
    const clearBtn = page.getByRole('button', { name: 'Clear option search' });
    await clearBtn.click();
    await expect(search).toHaveValue('');
    expect(await visibleCount(), 'original option-row count restored after clearing').toBe(originalCount);
    await expect(page.getByText(/No plot-specific options match/i)).toHaveCount(0);
  });
});
