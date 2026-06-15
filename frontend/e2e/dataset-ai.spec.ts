import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';

test('dataset upload saves purpose and auto-runs Ask AI recommendations', async ({ page }, testInfo) => {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  test.skip(!email || !password, 'Set E2E_EMAIL and E2E_PASSWORD to run authenticated flow');

  let recommendCalled = false;
  await page.route('**/api/datasets/*/recommend', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    recommendCalled = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          plot_type: 'scatter',
          title: 'AI dose response scatter',
          score: 0.96,
          rank: 1,
          rationale: 'Dose and response are numeric columns suitable for a scatter plot.',
          suggested_mapping: { x: 'dose', y: 'response' },
          source: 'test-ai',
        },
      ]),
    });
  });

  await page.goto('/login');
  await page.getByLabel('Email').fill(email!);
  await page.getByLabel('Password').fill(password!);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/\/projects/);

  const token = await page.evaluate(() => window.localStorage.getItem('access_token'));
  const headers = { Authorization: `Bearer ${token}` };
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };
  const suffix = Date.now();
  let datasetId: string | null = null;
  let sourceDatasetId: string | null = null;
  let sourceFigureId: string | null = null;

  try {
    const source = await page.evaluate(async ({ headers, jsonHeaders, suffix }) => {
      const fd = new FormData();
      fd.append('file', new File(['dose,response,group\n1,3,A\n2,4,A\n3,7,B\n4,9,B\n'], `format-source-${suffix}.csv`, { type: 'text/csv' }));
      fd.append('name', `Format source dataset ${suffix}`);
      fd.append('description', 'Source dataset used to create a reusable figure format.');
      fd.append('focus_columns', JSON.stringify(['dose', 'response', 'group']));

      const datasetRes = await fetch('/api/datasets', { method: 'POST', headers, body: fd });
      if (!datasetRes.ok) throw new Error(await datasetRes.text());
      const dataset = await datasetRes.json() as { id: string };

      const figureName = `Format source scatter ${suffix}`;
      const figureRes = await fetch('/api/figures', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          dataset_id: dataset.id,
          name: figureName,
          plot_type: 'scatter',
          mapping: { x: 'dose', y: 'response', color: 'group' },
          options: { title: 'Copied template title', size: 'single_column' },
          style_preset: 'nature',
        }),
      });
      if (!figureRes.ok) throw new Error(await figureRes.text());
      const figure = await figureRes.json() as { id: string; name: string };
      return { datasetId: dataset.id, figureId: figure.id, figureName: figure.name };
    }, { headers, jsonHeaders, suffix });
    sourceDatasetId = source.datasetId;
    sourceFigureId = source.figureId;

    await page.goto('/datasets');
    const csvPath = testInfo.outputPath('ai-purpose-data.csv');
    await fs.writeFile(csvPath, 'dose,response,group\n1,4,A\n2,5,A\n3,8,B\n4,9,B\n', 'utf8');
    await page.locator('input[type="file"]').setInputFiles(csvPath);

    await expect(page.getByText('Dataset purpose')).toBeVisible();
    await page.getByLabel('Dataset purpose').fill('Dose response experiment comparing treatment groups.');
    await page.getByRole('button', { name: 'Upload and continue' }).click();

    await expect(page).toHaveURL(/\/datasets\/[0-9a-f-]+\?setup=1/i);
    datasetId = page.url().match(/\/datasets\/([0-9a-f-]+)/i)?.[1] ?? null;
    expect(datasetId).toBeTruthy();

    await expect.poll(() => recommendCalled, { timeout: 10_000 }).toBeTruthy();
    await expect(page.getByText('AI dose response scatter')).toBeVisible();
    await expect(page.getByText('Templates that fit this data')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Ask AI for charts/ })).toBeVisible();

    await page.getByRole('button', { name: `Use figure format ${source.figureName}` }).click();
    await expect(page.locator('[data-testid="in-plot-title"]')).toHaveValue('Copied template title');
    await expect(page.locator('[data-testid="chart-type-select"]')).toHaveValue('scatter');

    const saved = await page.evaluate(async ({ datasetId, headers }) => {
      const res = await fetch(`/api/datasets/${datasetId}`, { headers });
      if (!res.ok) throw new Error(await res.text());
      return res.json() as Promise<{ description?: string }>;
    }, { datasetId, headers });
    expect(saved.description).toContain('Dose response experiment');
  } finally {
    if (sourceFigureId) {
      await page.evaluate(async ({ sourceFigureId, headers }) => {
        await fetch(`/api/figures/${sourceFigureId}`, { method: 'DELETE', headers });
      }, { sourceFigureId, headers });
    }
    if (datasetId) {
      await page.evaluate(async ({ datasetId, headers }) => {
        await fetch(`/api/datasets/${datasetId}`, { method: 'DELETE', headers });
      }, { datasetId, headers });
    }
    if (sourceDatasetId) {
      await page.evaluate(async ({ sourceDatasetId, headers }) => {
        await fetch(`/api/datasets/${sourceDatasetId}`, { method: 'DELETE', headers });
      }, { sourceDatasetId, headers });
    }
  }
});
