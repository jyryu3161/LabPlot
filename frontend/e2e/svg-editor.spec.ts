import { expect, test } from '@playwright/test';

test('SVG editor keeps selection and supports component edits without resize handles', async ({ page }) => {
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
  const headers = { Authorization: `Bearer ${token}` };
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };
  const suffix = Date.now();
  let datasetId: string | null = null;
  let figureId: string | null = null;

  try {
    const created = await page.evaluate(async ({ headers, jsonHeaders, suffix }) => {
      const fd = new FormData();
      fd.append('file', new File(['dose,response,group\n1,3,A\n2,5,A\n3,6,B\n4,9,B\n'], `svg-editor-${suffix}.csv`, { type: 'text/csv' }));
      fd.append('name', `SVG editor dataset ${suffix}`);
      fd.append('description', 'Temporary dataset for SVG editor interaction testing.');
      fd.append('focus_columns', JSON.stringify(['dose', 'response', 'group']));

      const datasetRes = await fetch('/api/datasets', { method: 'POST', headers, body: fd });
      if (!datasetRes.ok) throw new Error(await datasetRes.text());
      const dataset = await datasetRes.json() as { id: string };

      const figureRes = await fetch('/api/figures', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          dataset_id: dataset.id,
          name: `SVG editor scatter ${suffix}`,
          plot_type: 'scatter',
          mapping: { x: 'dose', y: 'response', color: 'group' },
          options: { size: 'wide' },
          style_preset: 'nature',
        }),
      });
      if (!figureRes.ok) throw new Error(await figureRes.text());
      const figure = await figureRes.json() as { id: string };
      return { datasetId: dataset.id, figureId: figure.id };
    }, { headers, jsonHeaders, suffix });
    datasetId = created.datasetId;
    figureId = created.figureId;

    await page.goto(`/figures/${figureId}`);
    const stage = page.getByTestId('svg-editor-stage');
    await expect(stage.locator('svg')).toBeVisible({ timeout: 60_000 });
    await stage.scrollIntoViewIfNeeded();

    const target = await page.evaluate(() => {
      const stageEl = document.querySelector('[data-testid="svg-editor-stage"]');
      if (!stageEl) return null;
      const candidates = Array.from(stageEl.querySelectorAll('[data-labplot-editable="true"]')) as SVGGraphicsElement[];
      for (const el of candidates) {
        const tag = el.tagName.toLowerCase();
        if (!['circle', 'path', 'rect', 'text'].includes(tag)) continue;
        const box = el.getBoundingClientRect();
        if (box.width >= 5 && box.height >= 5 && box.left >= 0 && box.top >= 0) {
          return {
            index: el.getAttribute('data-labplot-edit-index'),
            x: box.left + box.width / 2,
            y: box.top + box.height / 2,
          };
        }
      }
      return null;
    });
    expect(target).toBeTruthy();
    expect(target?.index).toBeTruthy();

    await page.mouse.click(target!.x, target!.y);
    const selected = stage.locator('[data-labplot-selected="true"]');
    await expect(selected).toHaveCount(1);
    await expect(page.getByTestId('svg-selected-element')).not.toContainText('No element selected');
    await page.waitForTimeout(150);
    await expect(selected).toHaveCount(1);
    await expect(stage.locator('[data-labplot-resize-handle]')).toHaveCount(0);
    await expect(stage.locator('[data-labplot-editor-overlay="true"]')).toHaveCount(0);

    const beforeMove = await selected.first().getAttribute('transform') ?? '';
    await page.mouse.move(target!.x, target!.y);
    await page.mouse.down();
    await page.mouse.move(target!.x + 28, target!.y + 18, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => await selected.first().getAttribute('transform') ?? '').not.toBe(beforeMove);

    const afterMove = await selected.first().getAttribute('transform') ?? '';
    await stage.press('ArrowRight');
    await expect.poll(async () => await selected.first().getAttribute('transform') ?? '').not.toBe(afterMove);
  } finally {
    if (figureId) {
      await page.evaluate(async ({ figureId, headers }) => {
        await fetch(`/api/figures/${figureId}`, { method: 'DELETE', headers });
      }, { figureId, headers });
    }
    if (datasetId) {
      await page.evaluate(async ({ datasetId, headers }) => {
        await fetch(`/api/datasets/${datasetId}`, { method: 'DELETE', headers });
      }, { datasetId, headers });
    }
  }
});
