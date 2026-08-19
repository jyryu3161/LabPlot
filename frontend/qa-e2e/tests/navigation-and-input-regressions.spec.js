const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

const authHeaders = (tokens) => ({ Authorization: `Bearer ${tokens.access_token}` });

test.describe('URL-backed workspace navigation', () => {
  test('project tabs survive refresh, back navigation, and a direct new-tab URL', async ({ page, request, context }) => {
    const tokens = await apiLogin(request);
    const projectsResponse = await request.get(`${ENV.BASE}/api/projects`, { headers: authHeaders(tokens) });
    expect(projectsResponse.ok(), 'projects fixture request').toBeTruthy();
    const projects = await projectsResponse.json();
    expect(projects.length, 'the QA account needs at least one project').toBeGreaterThan(0);
    const projectPath = `/projects/${projects[0].id}`;

    await authedPage(page, tokens);
    await page.goto(projectPath, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('tab', { name: /^Datasets/ })).toHaveAttribute('aria-selected', 'true');

    await page.getByRole('tab', { name: /^Figures/ }).click();
    await expect(page).toHaveURL(`${projectPath}?tab=figures`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('tab', { name: /^Figures/ })).toHaveAttribute('aria-selected', 'true');

    await page.getByRole('tab', { name: /^Canvases/ }).click();
    await expect(page).toHaveURL(`${projectPath}?tab=canvases`);
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(`${projectPath}?tab=figures`);
    await expect(page.getByRole('tab', { name: /^Figures/ })).toHaveAttribute('aria-selected', 'true');

    const deepLinkPage = await context.newPage();
    await deepLinkPage.goto(`${projectPath}?tab=canvases`, { waitUntil: 'domcontentloaded' });
    await expect(deepLinkPage.getByRole('tab', { name: /^Canvases/ })).toHaveAttribute('aria-selected', 'true');
    await deepLinkPage.close();
  });

  test('dataset tabs use the URL as state across direct load, refresh, and back', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    const datasetsResponse = await request.get(`${ENV.BASE}/api/datasets`, { headers: authHeaders(tokens) });
    expect(datasetsResponse.ok(), 'datasets fixture request').toBeTruthy();
    const datasets = await datasetsResponse.json();
    expect(datasets.length, 'the QA account needs at least one dataset').toBeGreaterThan(0);
    const datasetPath = `/datasets/${datasets[0].id}`;

    await authedPage(page, tokens);
    await page.goto(`${datasetPath}?tab=stats`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('tab', { name: 'Statistics' })).toHaveAttribute('aria-selected', 'true');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('tab', { name: 'Statistics' })).toHaveAttribute('aria-selected', 'true');

    await page.getByRole('tab', { name: 'Preview' }).click();
    await expect(page).toHaveURL(`${datasetPath}?tab=preview`);
    await page.getByRole('tab', { name: /^Figures/ }).click();
    await expect(page).toHaveURL(`${datasetPath}?tab=figures`);
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(`${datasetPath}?tab=preview`);
    await expect(page.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'true');
  });

  test('detail links keep canvas, project, dataset, and figure route identity', async ({ page, request, context }) => {
    test.setTimeout(180_000);
    const tokens = await apiLogin(request);
    const headers = authHeaders(tokens);
    const [projectsResponse, datasetsResponse, figuresResponse, canvasesResponse] = await Promise.all([
      request.get(`${ENV.BASE}/api/projects`, { headers }),
      request.get(`${ENV.BASE}/api/datasets`, { headers }),
      request.get(`${ENV.BASE}/api/figures`, { headers }),
      request.get(`${ENV.BASE}/api/canvases`, { headers }),
    ]);
    for (const [label, response] of [
      ['projects', projectsResponse],
      ['datasets', datasetsResponse],
      ['figures', figuresResponse],
      ['canvases', canvasesResponse],
    ]) {
      expect(response.ok(), `${label} fixture request`).toBeTruthy();
    }
    const projects = await projectsResponse.json();
    const datasets = await datasetsResponse.json();
    const figures = await figuresResponse.json();
    const canvases = await canvasesResponse.json();
    const project = projects.find((candidate) => (
      datasets.some((dataset) => dataset.project_id === candidate.id)
      && figures.some((figure) => figure.project_id === candidate.id)
    ));
    expect(project, 'the QA account needs a project containing a dataset and figure').toBeTruthy();
    const dataset = datasets.find((candidate) => candidate.project_id === project.id);
    const figure = figures.find((candidate) => candidate.project_id === project.id);
    const canvas = canvases[0];
    expect(canvas, 'the QA account needs an existing canvas').toBeTruthy();

    await authedPage(page, tokens);
    const canvasPath = `/canvases/${canvas.id}`;
    await page.goto(canvasPath, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(canvasPath);
    await expect(page.getByRole('button', { name: canvas.name, exact: true })).toBeVisible();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(canvasPath);

    const projectsNav = page.getByRole('navigation').getByRole('link', { name: 'Projects', exact: true });
    await projectsNav.click();
    await expect(page).toHaveURL('/projects');
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(canvasPath);
    await expect(page.getByRole('button', { name: canvas.name, exact: true })).toBeVisible();
    await projectsNav.click();

    const projectPath = `/projects/${project.id}`;
    await page.locator(`a[href="${projectPath}"]`).click();
    await expect(page).toHaveURL(projectPath);
    await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();

    const datasetPath = `/datasets/${dataset.id}`;
    await page.locator(`a[href="${datasetPath}"]`).click();
    await expect(page).toHaveURL(datasetPath);
    await expect(page.getByRole('heading', { name: new RegExp(`^${dataset.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) })).toBeVisible();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(datasetPath);
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(projectPath);

    await page.getByRole('tab', { name: /^Figures/ }).click();
    const projectFiguresPath = `${projectPath}?tab=figures`;
    await expect(page).toHaveURL(projectFiguresPath);
    const figurePath = `/figures/${figure.id}`;
    await page.locator(`a[href="${figurePath}"]`).first().click();
    await expect(page).toHaveURL(figurePath);
    await expect(page.getByRole('heading', { name: figure.name, exact: true })).toBeVisible();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(figurePath);

    await page.goBack({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(projectFiguresPath);
    const figureLink = page.locator(`a[href="${figurePath}"]`).first();
    const [deepLinkPage] = await Promise.all([
      context.waitForEvent('page'),
      figureLink.click({ modifiers: ['Control'] }),
    ]);
    await deepLinkPage.waitForLoadState('domcontentloaded');
    await expect(deepLinkPage).toHaveURL(figurePath);
    await expect(deepLinkPage.getByRole('heading', { name: figure.name, exact: true })).toBeVisible();
    await deepLinkPage.close();

    await expect(page).toHaveURL(projectFiguresPath);
    await expect(page.getByRole('tab', { name: /^Figures/ })).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('canvas and figure input regressions', () => {
  test('Nature double-column canvas keeps decimal millimetres and rejects an invalid custom size', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    const headers = authHeaders(tokens);
    let canvasId = null;

    try {
      await authedPage(page, tokens);
      await page.goto('/canvases', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /new canvas/i }).click();
      const dialog = page.getByRole('dialog', { name: 'New canvas' });

      await dialog.getByRole('combobox', { name: 'Canvas size preset' }).click();
      await page.getByRole('option', { name: 'Custom size' }).click();
      await dialog.getByLabel('Width (mm)').fill('19.99');
      await dialog.getByLabel('Height (mm)').fill('131.67');
      await expect(dialog.getByText('Each side must be between 20 and 500 mm.')).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Create canvas' })).toBeDisabled();

      await dialog.getByRole('combobox', { name: 'Canvas size preset' }).click();
      await page.getByRole('option', { name: /Nature.*double column/i }).click();
      await expect(dialog.getByLabel('Width (mm)')).toHaveValue('182.88');
      await expect(dialog.getByLabel('Height (mm)')).toHaveValue('131.67');
      await dialog.getByLabel('Name').fill(`Nature decimal QA ${Date.now()}`);

      const createResponsePromise = page.waitForResponse((response) => (
        response.url() === `${ENV.BASE}/api/canvases`
        && response.request().method() === 'POST'
      ));
      await dialog.getByRole('button', { name: 'Create canvas' }).click();
      const createResponse = await createResponsePromise;
      expect(createResponse.ok(), 'canvas create response').toBeTruthy();
      const createdCanvas = await createResponse.json();
      canvasId = createdCanvas.id;
      expect(createdCanvas.width_mm).toBe(182.88);
      expect(createdCanvas.height_mm).toBe(131.67);

      const persistedResponse = await request.get(`${ENV.BASE}/api/canvases/${canvasId}`, { headers });
      expect(persistedResponse.ok(), 'persisted canvas response').toBeTruthy();
      const persistedCanvas = await persistedResponse.json();
      expect(persistedCanvas.width_mm).toBe(182.88);
      expect(persistedCanvas.height_mm).toBe(131.67);
    } finally {
      if (canvasId) {
        const cleanupResponse = await request.delete(`${ENV.BASE}/api/canvases/${canvasId}`, { headers });
        expect(cleanupResponse.ok(), 'created canvas cleanup').toBeTruthy();
      }
    }
  });

  test('legacy object data never leaks as [object Object] into a figure text input', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    const headers = authHeaders(tokens);
    const [figuresResponse, plotTypesResponse] = await Promise.all([
      request.get(`${ENV.BASE}/api/figures`, { headers }),
      request.get(`${ENV.BASE}/api/plot-types`, { headers }),
    ]);
    expect(figuresResponse.ok(), 'figures fixture request').toBeTruthy();
    expect(plotTypesResponse.ok(), 'plot types fixture request').toBeTruthy();
    const figures = await figuresResponse.json();
    const plotTypes = await plotTypesResponse.json();
    const hasTextOption = (item) => (
      plotTypes.plot_types.find((definition) => definition.type === item.plot_type)
        ?.options?.some((option) => option.type === 'text')
    );
    const requestedFixture = ENV.FIG ? figures.find((item) => item.id === ENV.FIG) : null;
    const figureFixture = (requestedFixture && hasTextOption(requestedFixture))
      ? requestedFixture
      : figures.find(hasTextOption);
    expect(figureFixture, 'the QA account needs a figure with a text option').toBeTruthy();
    const figureId = figureFixture.id;
    const figureResponse = await request.get(`${ENV.BASE}/api/figures/${figureId}`, { headers });
    expect(figureResponse.ok(), 'figure fixture request').toBeTruthy();
    const figure = await figureResponse.json();
    const definition = plotTypes.plot_types.find((item) => item.type === figure.plot_type);
    const textOption = definition?.options?.find((item) => item.type === 'text');
    expect(textOption, `plot type ${figure.plot_type} needs a text option for this regression`).toBeTruthy();

    const mockedFigure = {
      ...figure,
      versions: figure.versions.map((version) => ({
        ...version,
        options: { ...(version.options ?? {}), [textOption.key]: { legacy: 'structured value' } },
      })),
    };
    await page.route(`**/api/figures/${figureId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockedFigure),
      });
    });

    await authedPage(page, tokens);
    await page.goto(`/figures/${figureId}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Advanced', exact: true }).click();
    const input = page.getByRole('textbox', { name: textOption.label });
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('');
  });
});
