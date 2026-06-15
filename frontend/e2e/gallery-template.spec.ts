import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';

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

test('authenticated user can create a figure from a gallery template', async ({ page }, testInfo) => {
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

    const csvPath = testInfo.outputPath('template-data.csv');
    await fs.writeFile(csvPath, 'x,y,group\n1,4,A\n2,5,A\n3,6,B\n4,7,B\n', 'utf8');
    await page.locator('input[type="file"]').setInputFiles(csvPath);
    await expect(page.getByText('Parsed table preview')).toBeVisible();
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
