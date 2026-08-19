const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

const DATASET_ID = process.env.QA_DATASET;
const authHeaders = (tokens) => ({ Authorization: `Bearer ${tokens.access_token}` });

test.describe('dataset statistics safety', () => {
  test.skip(!DATASET_ID, 'set QA_DATASET to a group + time audit dataset');

  test('structural columns are not outcomes and tiny p-values are not shown as zero', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    const response = await request.get(`${ENV.BASE}/api/datasets/${DATASET_ID}`, {
      headers: authHeaders(tokens),
    });
    expect(response.ok(), 'dataset fixture request').toBeTruthy();
    const dataset = await response.json();
    const comparisons = dataset.statistics?.comparisons ?? [];
    expect(comparisons, 'group + time must not expose pooled one-factor results').toEqual([]);
    expect(comparisons.map((item) => item.value_column)).not.toContain('Time_h');
    expect(comparisons.map((item) => item.value_column)).not.toContain('Replicate');

    await authedPage(page, tokens);
    await page.goto(`/datasets/${DATASET_ID}?tab=stats`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('group-time-statistics-notice')).toContainText('two-way model');
    await expect(page.getByTestId('group-time-statistics-notice')).toContainText('suppressed');

    const comparisonCard = page.locator('[data-slot="card"]').filter({ hasText: 'Group comparisons' });
    await expect(comparisonCard).toBeVisible();
    await expect(comparisonCard).toContainText('No automatic group comparison is shown');
    await expect(comparisonCard).not.toContainText('Time_h by');
    await expect(comparisonCard).not.toContainText('Replicate by');
    await expect(comparisonCard).not.toContainText('p = 0');
  });
});
