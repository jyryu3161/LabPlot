const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

// U3: project-scoped canvases — project tab + create-in-project, owner move,
// and the project-scoped figure picker with its collaborator warning.
test.describe('project canvases (U3)', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a figure id');
  let tokens, auth;
  test.beforeEach(async ({ request }) => {
    tokens = await apiLogin(request);
    auth = { Authorization: `Bearer ${tokens.access_token}` };
  });

  test('project tab lists canvases; create-in-project attaches project_id', async ({ page, request }) => {
    const proj = await (await request.post(`${ENV.BASE}/api/projects`, {
      headers: auth, data: { name: 'Canvas U3 QA' },
    })).json();

    await authedPage(page, tokens);
    await page.goto(`/projects/${proj.id}`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: /Canvases/ }).click();
    await page.getByRole('button', { name: 'New canvas in this project' }).click();
    await page.getByLabel('Name').fill('Proj Canvas QA');
    await page.getByRole('button', { name: 'Create canvas' }).click();

    // lands in the editor; server truth: canvas belongs to the project
    await expect(page).toHaveURL(/\/canvases\//, { timeout: 15000 });
    const canvasId = page.url().split('/canvases/')[1];
    const detail = await (await request.get(`${ENV.BASE}/api/canvases/${canvasId}`, { headers: auth })).json();
    expect(detail.project_id).toBe(proj.id);

    // breadcrumb links back to the project
    await expect(page.getByRole('link', { name: /Canvas U3 QA/ })).toBeVisible();

    // picker defaults to project scope and offers the show-all toggle
    await page.getByRole('button', { name: 'Add figure' }).click();
    const dialog = page.getByRole('dialog', { name: /add a figure/i });
    const showAll = dialog.getByRole('checkbox', { name: /Show all my figures/ });
    await expect(showAll).toBeVisible();
    // empty project -> no figures under project scope
    await expect(dialog.getByText(/No ready figures yet|No figures match/)).toBeVisible();
    // show all -> personal figures appear with the collaborator warning
    await showAll.check();
    await expect(dialog.locator('div.grid > button').first()).toBeVisible();
    await expect(dialog.getByText('⚠ Not visible to collaborators').first()).toBeVisible();
    await page.keyboard.press('Escape');

    // owner move: detach to personal via API (PATCH project_id null)
    const moved = await (await request.patch(`${ENV.BASE}/api/canvases/${canvasId}`, {
      headers: auth, data: { project_id: null },
    })).json();
    expect(moved.project_id).toBe(null);
    // list under the project no longer contains it
    const inProj = await (await request.get(`${ENV.BASE}/api/canvases?project_id=${proj.id}`, { headers: auth })).json();
    expect(inProj.find((c) => c.id === canvasId)).toBeFalsy();

    await request.delete(`${ENV.BASE}/api/canvases/${canvasId}`, { headers: auth });
    await request.delete(`${ENV.BASE}/api/projects/${proj.id}`, { headers: auth });
  });
});
