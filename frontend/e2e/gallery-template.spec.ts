import { expect, test } from '@playwright/test';
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';

const COMPLEX_XLSX_BASE64 = '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';

test('public gallery exposes template actions', async ({ page }) => {
  await page.goto('/gallery');
  await expect(page.getByRole('heading', { name: 'Gallery' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Use as template' }).first()).toBeVisible();
});

test('authenticated user can open the gallery template flow', async ({ page }) => {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  test.skip(!email || !password, 'Set E2E_EMAIL and E2E_PASSWORD to run authenticated flow');

  await page.goto('/login');
  await page.getByLabel('Email').fill(email!);
  await page.getByLabel('Password').fill(password!);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/\/projects/);

  await page.goto('/gallery');
  await page.getByRole('link', { name: 'Use as template' }).first().click();
  await expect(page.getByText('Selected template')).toBeVisible();
  await expect(page.getByText('1. Choose project')).toBeVisible();
  await expect(page.getByText('2. Upload data for this template')).toBeVisible();
});

test('authenticated user can create a figure from a gallery template with a complex Excel file', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  test.skip(!email || !password, 'Set E2E_EMAIL and E2E_PASSWORD to run authenticated flow');

  await page.goto('/login');
  await page.getByLabel('Email').fill(email!);
  await page.getByLabel('Password').fill(password!);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/\/projects/);

  const token = await page.evaluate(() => window.localStorage.getItem('access_token'));
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const projectName = `Playwright template ${Date.now()}`;
  const project = await page.evaluate(async ({ projectName, headers }) => {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: projectName, description: 'Temporary e2e project' }),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json() as Promise<{ id: string }>;
  }, { projectName, headers });

  try {
    const gallery = await page.evaluate(async () => {
      const res = await fetch('/api/public/gallery?limit=80');
      if (!res.ok) throw new Error(await res.text());
      return res.json() as Promise<{ figures: { id: string; plot_type: string }[] }>;
    });
    const scatter = gallery.figures.find((figure) => figure.plot_type === 'scatter');
    test.skip(!scatter, 'No scatter template is available in the public gallery');

    await page.goto(`/gallery/template/${scatter!.id}`);
    await expect(page.getByText('Selected template')).toBeVisible();
    await page.locator('select').first().selectOption(project.id);

    const xlsxPath = testInfo.outputPath('complex-template-data.xlsx');
    await fs.writeFile(xlsxPath, Buffer.from(COMPLEX_XLSX_BASE64, 'base64'));
    await page.locator('input[type="file"]').setInputFiles(xlsxPath);
    await expect(page.getByText('Check dataset before upload')).toBeVisible();
    await page.locator('select').nth(1).selectOption('Measurements');
    const rangeInputs = page.locator('input[type="number"]');
    await rangeInputs.nth(0).fill('4');
    await rangeInputs.nth(1).fill('5');
    await rangeInputs.nth(2).fill('2');
    await rangeInputs.nth(3).fill('4');
    await rangeInputs.nth(4).fill('8');
    await page.getByRole('button', { name: 'Refresh preview' }).click();
    await expect(page.getByText('Parsed table preview')).toBeVisible();
    await expect(page.getByText('dose')).toBeVisible();
    await expect(page.getByText('response')).toBeVisible();
    await page.getByRole('button', { name: 'Upload and continue' }).click();

    await expect(page.getByText('3. Map your columns')).toBeVisible();
    await page.getByRole('button', { name: 'Create figure' }).click();
    await expect(page).toHaveURL(/\/figures\/[0-9a-f-]+/i, { timeout: 90_000 });
  } finally {
    await page.evaluate(async ({ id, headers }) => {
      await fetch(`/api/projects/${id}`, { method: 'DELETE', headers });
    }, { id: project.id, headers });
  }
});
