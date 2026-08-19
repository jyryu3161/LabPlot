const { test, expect } = require('@playwright/test');
const { ENV, runAxe } = require('../helpers');

test.describe('gallery discovery and contrast', () => {
  test('searches and filters templates and keeps card text accessible in dark mode', async ({ page, request }) => {
    const response = await request.get(`${ENV.BASE}/api/public/gallery?limit=120`);
    expect(response.ok()).toBeTruthy();
    const payload = await response.json();
    const target = payload.figures[0];
    expect(target, 'the public gallery needs at least one template').toBeTruthy();

    await page.goto('/gallery', { waitUntil: 'domcontentloaded' });
    const resultStatus = page.getByRole('status');
    await expect(resultStatus).toContainText(`of ${payload.figures.length} templates`);

    await page.getByLabel('Search templates').fill(target.name);
    await expect(page.getByRole('img', { name: target.name })).toBeVisible();
    await expect(resultStatus).toContainText(/Showing [1-9]\d* of/);

    await page.getByLabel('Search templates').fill('');
    await page.getByLabel('Research field').selectOption(target.domain_label || 'Other');
    await page.getByLabel('Chart type').selectOption(target.plot_type);
    await expect(page.getByRole('img', { name: target.name })).toBeVisible();
    await page.getByLabel('Sort').selectOption('name');
    await expect(page.getByLabel('Sort')).toHaveValue('name');

    await page.evaluate(() => localStorage.setItem('theme', 'dark'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'View template details' }).first()).toBeVisible();
    const violations = await runAxe(page);
    const severeContrast = violations.filter((item) => (
      item.id === 'color-contrast' && ['critical', 'serious'].includes(item.impact)
    ));
    expect(severeContrast).toEqual([]);
  });
});
