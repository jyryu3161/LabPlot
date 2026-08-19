const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage, cleanupApiResources } = require('../helpers');

// U3: project-scoped canvases — project tab + create-in-project, owner move,
// and the project-scoped figure picker with its collaborator warning.
test.describe('project canvases (U3)', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a figure id');
  let tokens, auth, projectId, canvasId;
  test.beforeEach(async ({ request }) => {
    tokens = await apiLogin(request);
    auth = { Authorization: `Bearer ${tokens.access_token}` };
    projectId = null;
    canvasId = null;
  });
  test.afterEach(async ({ request }) => {
    const canvasIds = new Set(canvasId ? [canvasId] : []);
    const failures = [];
    if (projectId) {
      try {
        const response = await request.get(`${ENV.BASE}/api/canvases?project_id=${projectId}`, { headers: auth });
        if (response.ok()) {
          for (const canvas of await response.json()) canvasIds.add(canvas.id);
        } else {
          failures.push(`discover project canvases failed (${response.status()})`);
        }
      } catch (error) {
        failures.push(`discover project canvases failed: ${error?.message || error}`);
      }
    }
    try {
      await cleanupApiResources(request, auth, [
        ...[...canvasIds].map((id) => ({ collection: 'canvases', id })),
        { collection: 'projects', id: projectId },
      ]);
    } catch (error) {
      failures.push(error?.message || String(error));
    }
    if (failures.length) throw new Error(`Project canvas cleanup failed:\n${failures.join('\n')}`);
  });

  test('project tab lists canvases; create-in-project attaches project_id', async ({ page, request }) => {
    const proj = await (await request.post(`${ENV.BASE}/api/projects`, {
      headers: auth, data: { name: 'Canvas U3 QA' },
    })).json();
    projectId = proj.id;

    await authedPage(page, tokens);
    await page.goto(`/projects/${proj.id}`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: /Canvases/ }).click();
    await page.getByRole('button', { name: 'New canvas in this project' }).click();
    await page.getByLabel('Name').fill('Proj Canvas QA');
    const createCanvasResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/canvases'
    ));
    await page.getByRole('button', { name: 'Create canvas' }).click();
    const createCanvasResponse = await createCanvasResponsePromise;
    expect(createCanvasResponse.status(), 'create project canvas').toBe(201);
    canvasId = (await createCanvasResponse.json()).id;

    // lands in the editor; server truth: canvas belongs to the project
    await expect(page).toHaveURL(/\/canvases\//, { timeout: 15000 });
    expect(new URL(page.url()).pathname).toBe(`/canvases/${canvasId}`);
    const detail = await (await request.get(`${ENV.BASE}/api/canvases/${canvasId}`, { headers: auth })).json();
    expect(detail.project_id).toBe(proj.id);

    // breadcrumb links back to the project
    await expect(page.getByRole('link', { name: /Canvas U3 QA/ })).toBeVisible();

    // picker defaults to project scope and offers an explicit all-figures tab
    await page.getByRole('button', { name: 'Add figure' }).click();
    const dialog = page.getByRole('dialog', { name: /add a figure/i });
    const showAll = dialog.getByRole('tab', { name: 'My figures' });
    await expect(showAll).toBeVisible();
    // empty project -> no figures under project scope
    await expect(dialog.getByText(/No ready figures yet|No figures match/)).toBeVisible();
    // show all -> personal figures appear with the collaborator warning
    await showAll.click();
    await expect(showAll).toHaveAttribute('aria-selected', 'true');
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
  });
});
