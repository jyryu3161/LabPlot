import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';

test('dataset upload saves purpose, auto-loads AI once, and refreshes with prompt', async ({ page }, testInfo) => {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  test.skip(!email || !password, 'Set E2E_EMAIL and E2E_PASSWORD to run authenticated flow');

  let recommendCalled = false;
  const recommendBodies: unknown[] = [];
  await page.route('**/api/datasets/*/recommend', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    recommendCalled = true;
    let body: unknown = null;
    try {
      body = route.request().postDataJSON();
    } catch {
      body = null;
    }
    recommendBodies.push(body);
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
  let improveBody: unknown = null;

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
      const favoriteRes = await fetch(`/api/figures/${figure.id}`, {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({ is_favorite: true }),
      });
      if (!favoriteRes.ok) throw new Error(await favoriteRes.text());
      return { datasetId: dataset.id, figureId: figure.id, figureName: figure.name };
    }, { headers, jsonHeaders, suffix });
    sourceDatasetId = source.datasetId;
    sourceFigureId = source.figureId;

    await page.route('**/api/figures/*/versions/*/improve', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      try {
        improveBody = route.request().postDataJSON();
      } catch {
        improveBody = null;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.goto(`/figures/${source.figureId}`);
    await page.getByLabel('Optional edit request').fill('Make the palette colorblind-safe and simplify the legend.');
    await page.getByRole('button', { name: /Ask AI to improve/ }).click();
    await expect.poll(() => improveBody, { timeout: 10_000 }).toEqual({
      prompt: 'Make the palette colorblind-safe and simplify the legend.',
    });

    await page.goto('/datasets');
    const csvPath = testInfo.outputPath('ai-purpose-data.csv');
    await fs.writeFile(csvPath, 'dose,response,group\n1,4,A\n2,5,A\n3,8,B\n4,9,B\n', 'utf8');
    await page.locator('input[type="file"]').setInputFiles(csvPath);

    await expect(page.getByText('Dataset purpose')).toBeVisible();
    await page.getByLabel('Dataset purpose').fill('Dose response experiment comparing treatment groups.');
    await expect(page.getByLabel('Column role dose')).toHaveValue('numeric');
    await expect(page.getByLabel('Column role group')).toHaveValue('group');
    await page.getByRole('button', { name: 'Upload and continue' }).click();

    await expect(page).toHaveURL(/\/datasets\/[0-9a-f-]+\?setup=1/i);
    datasetId = page.url().match(/\/datasets\/([0-9a-f-]+)/i)?.[1] ?? null;
    expect(datasetId).toBeTruthy();

    await expect(page.getByRole('button', { name: '1. Choose columns' })).toBeVisible();
    await page.waitForTimeout(500);
    expect(recommendBodies).toHaveLength(0);
    await page.getByRole('button', { name: 'Continue to AI recommendations' }).click();

    await expect(page.getByRole('button', { name: /Refresh AI recommendations|Generate AI recommendations/ })).toBeVisible();
    await expect.poll(() => recommendBodies.length, { timeout: 10_000 }).toBe(1);
    expect(recommendCalled).toBeTruthy();
    expect(recommendBodies[0]).toBeNull();
    await expect(page.getByText('AI dose response scatter')).toBeVisible();
    await page.getByLabel('Optional chart direction').fill('Prefer a scatter plot for dose and response.');
    await page.getByRole('button', { name: /Refresh AI recommendations|Generate AI recommendations/ }).click();
    await expect.poll(() => recommendBodies.length, { timeout: 10_000 }).toBe(2);
    expect(recommendBodies[1]).toEqual({
      refresh: true,
      prompt: 'Prefer a scatter plot for dose and response.',
    });
    await expect(page.getByText('AI dose response scatter')).toBeVisible();
    await page.getByRole('button', { name: /Use this/ }).first().click();

    await expect(page.locator('[data-testid="chart-type-select"] option[value="scatter"]')).toHaveJSProperty('disabled', false);
    await expect(page.locator('[data-testid="chart-type-select"] option[value="line"]')).toHaveJSProperty('disabled', false);
    await expect(page.getByText('Use one of my figures as a template')).toHaveCount(0);

    await page.getByRole('button', { name: 'Back to recommendations' }).click();
    await page.getByRole('button', { name: 'Build manually' }).click();
    const sourceTemplate = page.getByRole('button', { name: `Use figure format ${source.figureName}` });
    await expect(sourceTemplate.getByText('Favorite')).toBeVisible();
    await sourceTemplate.click();
    await expect(page.locator('[data-testid="in-plot-title"]')).toHaveValue('Copied template title');
    await expect(page.locator('[data-testid="chart-type-select"]')).toHaveValue('scatter');

    const saved = await page.evaluate(async ({ datasetId, headers }) => {
      const res = await fetch(`/api/datasets/${datasetId}`, { headers });
      if (!res.ok) throw new Error(await res.text());
      return res.json() as Promise<{ description?: string; statistics?: { descriptive?: Array<{ column: string }> } }>;
    }, { datasetId, headers });
    expect(saved.description).toContain('Dose response experiment');
    expect(saved.statistics?.descriptive?.map((item) => item.column)).toEqual(expect.arrayContaining(['dose', 'response']));
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
