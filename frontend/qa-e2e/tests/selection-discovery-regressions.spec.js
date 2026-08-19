const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage, runAxe } = require('../helpers');

const headersFor = (tokens) => ({ Authorization: `Bearer ${tokens.access_token}` });
const optionName = (dataset) => new RegExp(`^${dataset.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(`);

test.describe('large selection dialogs remain navigable', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a rendered figure id');

  test('Add figure separates sources and exposes chart and version filters', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    const headers = headersFor(tokens);
    let projectId = null;
    let canvasId = null;

    try {
      const projectResponse = await request.post(`${ENV.BASE}/api/projects`, {
        headers,
        data: { name: `Figure picker QA ${Date.now()}` },
      });
      expect(projectResponse.status()).toBe(201);
      projectId = (await projectResponse.json()).id;

      const canvasResponse = await request.post(`${ENV.BASE}/api/canvases`, {
        headers,
        data: { name: 'Figure picker QA', project_id: projectId, width_mm: 180, height_mm: 120 },
      });
      expect(canvasResponse.status()).toBe(201);
      canvasId = (await canvasResponse.json()).id;

      await authedPage(page, tokens);
      await page.goto(`/canvases/${canvasId}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Add figure' }).click();

      const dialog = page.getByRole('dialog', { name: 'Add a figure' });
      const sourceTabs = dialog.getByRole('tablist', { name: 'Figure source' });
      await expect(sourceTabs.getByRole('tab', { name: 'Current project' })).toHaveAttribute('aria-selected', 'true');
      await expect(sourceTabs.getByRole('tab', { name: 'My figures' })).toBeVisible();
      await expect(sourceTabs.getByRole('tab', { name: 'Gallery templates' })).toBeVisible();
      await expect(sourceTabs.getByRole('tab', { name: 'Recent' })).toBeVisible();
      await expect(dialog.getByLabel('Chart type')).toBeVisible();
      await expect(dialog.getByRole('checkbox', { name: 'Latest versions only' })).toBeChecked();

      const myFigures = sourceTabs.getByRole('tab', { name: 'My figures' });
      await myFigures.focus();
      await page.keyboard.press('ArrowRight');
      const galleryTemplates = sourceTabs.getByRole('tab', { name: 'Gallery templates' });
      await expect(galleryTemplates).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(galleryTemplates).toHaveAttribute('aria-selected', 'true');
      const violations = await runAxe(page);
      expect(violations.filter((item) => ['critical', 'serious'].includes(item.impact))).toEqual([]);
    } finally {
      if (canvasId) await request.delete(`${ENV.BASE}/api/canvases/${canvasId}`, { headers }).catch(() => {});
      if (projectId) await request.delete(`${ENV.BASE}/api/projects/${projectId}`, { headers }).catch(() => {});
    }
  });

  test('Gallery template data chooser defaults to the recent project and separates examples', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    const headers = headersFor(tokens);
    const [galleryResponse, projectsResponse] = await Promise.all([
      request.get(`${ENV.BASE}/api/public/gallery?limit=1`),
      request.get(`${ENV.BASE}/api/projects`, { headers }),
    ]);
    expect(galleryResponse.ok()).toBeTruthy();
    expect(projectsResponse.ok()).toBeTruthy();
    const template = (await galleryResponse.json()).figures[0];
    const projects = (await projectsResponse.json())
      .filter((project) => project.role === 'owner' || project.role === 'editor');
    expect(template).toBeTruthy();
    expect(projects.length).toBeGreaterThan(0);

    const recentProject = [...projects].sort((a, b) => (
      new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    ))[0];
    let datasetProject = null;
    let datasets = [];
    for (const project of [...projects].sort((a, b) => b.dataset_count - a.dataset_count)) {
      if (project.dataset_count < 2) continue;
      const response = await request.get(`${ENV.BASE}/api/datasets?project_id=${project.id}`, { headers });
      if (!response.ok()) continue;
      const candidates = await response.json();
      const hasExample = candidates.some((dataset) => /^Gallery seed\b/i.test(dataset.name));
      const hasPersonal = candidates.some((dataset) => !/^Gallery seed\b/i.test(dataset.name));
      if (hasExample && hasPersonal) {
        datasetProject = project;
        datasets = candidates;
        break;
      }
    }
    expect(datasetProject, 'the QA account needs a project with personal and Gallery seed datasets').toBeTruthy();
    const example = datasets.find((dataset) => /^Gallery seed\b/i.test(dataset.name));
    const personal = datasets.find((dataset) => !/^Gallery seed\b/i.test(dataset.name));

    await authedPage(page, tokens);
    await page.goto(`/gallery/template/${template.id}`, { waitUntil: 'domcontentloaded' });
    const projectSelect = page.getByLabel('Project', { exact: true });
    await expect(projectSelect).toHaveValue(recentProject.id);
    await projectSelect.selectOption(datasetProject.id);

    const datasetSearch = page.getByLabel('Search datasets');
    await expect(datasetSearch).toBeVisible();
    const exampleToggle = page.getByRole('button', { name: 'Show example datasets' });
    await expect(exampleToggle).toHaveAttribute('aria-expanded', 'false');
    const datasetSelect = page.getByLabel('Project dataset');
    await expect(datasetSelect.getByRole('option', { name: optionName(example) })).toHaveCount(0);

    await datasetSearch.fill(personal.name);
    await expect(datasetSelect.getByRole('option', { name: optionName(personal) })).toHaveCount(1);
    await datasetSearch.fill('');
    await exampleToggle.click();
    await expect(page.getByRole('button', { name: 'Hide example datasets' })).toHaveAttribute('aria-expanded', 'true');
    await expect(datasetSelect.getByRole('option', { name: optionName(example) })).toHaveCount(1);
  });
});
