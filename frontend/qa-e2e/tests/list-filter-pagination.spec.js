const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

test.describe('list project filters and pagination', () => {
  test('figures list filters by project and limits each page', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    const headers = { Authorization: `Bearer ${tokens.access_token}` };
    const [figuresResponse, projectsResponse] = await Promise.all([
      request.get(`${ENV.BASE}/api/figures`, { headers }),
      request.get(`${ENV.BASE}/api/projects`, { headers }),
    ]);
    const figures = await figuresResponse.json();
    const projects = await projectsResponse.json();

    await authedPage(page, tokens);
    await page.goto('/figures', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Figures', exact: true })).toBeVisible();
    const actions = page.getByRole('button', { name: /^Figure actions for / });
    await expect(actions).toHaveCount(Math.min(24, figures.length));
    if (figures.length > 24) {
      await expect(page.getByRole('navigation', { name: 'Figures pagination' })).toContainText(`of ${Math.ceil(figures.length / 24)}`);
    }

    const project = projects.find((candidate) => figures.some((figure) => figure.project_id === candidate.id));
    if (project) {
      const expected = figures.filter((figure) => figure.project_id === project.id).length;
      await page.getByLabel('Filter figures by project').selectOption(project.id);
      await expect(actions).toHaveCount(Math.min(24, expected));
    }
  });

  test('canvases list filters by project and limits each page', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    const headers = { Authorization: `Bearer ${tokens.access_token}` };
    const [canvasesResponse, projectsResponse] = await Promise.all([
      request.get(`${ENV.BASE}/api/canvases`, { headers }),
      request.get(`${ENV.BASE}/api/projects`, { headers }),
    ]);
    const canvases = await canvasesResponse.json();
    const projects = await projectsResponse.json();

    await authedPage(page, tokens);
    await page.goto('/canvases', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Canvases', exact: true })).toBeVisible();
    const actions = page.getByRole('button', { name: /^Canvas actions for / });
    await expect(actions).toHaveCount(Math.min(18, canvases.length));
    if (canvases.length > 18) {
      await expect(page.getByRole('navigation', { name: 'Canvases pagination' })).toContainText(`of ${Math.ceil(canvases.length / 18)}`);
    }

    const project = projects.find((candidate) => canvases.some((canvas) => canvas.project_id === candidate.id));
    if (project) {
      const expected = canvases.filter((canvas) => canvas.project_id === project.id).length;
      await page.getByLabel('Filter canvases by project').selectOption(project.id);
      await expect(actions).toHaveCount(Math.min(18, expected));
    }
  });
});
