const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

const authHeaders = (tokens) => ({ Authorization: `Bearer ${tokens.access_token}` });

test('figure editor separates basic and advanced controls without losing drafts', async ({ page, request }) => {
  const tokens = await apiLogin(request);
  const headers = authHeaders(tokens);
  const [figuresResponse, projectsResponse] = await Promise.all([
    request.get(`${ENV.BASE}/api/figures`, { headers }),
    request.get(`${ENV.BASE}/api/projects`, { headers }),
  ]);
  expect(figuresResponse.ok(), 'figures fixture request').toBeTruthy();
  expect(projectsResponse.ok(), 'projects fixture request').toBeTruthy();

  const figures = await figuresResponse.json();
  const projects = await projectsResponse.json();
  const editableProjectIds = new Set(
    projects
      .filter((project) => project.role === 'owner' || project.role === 'editor')
      .map((project) => project.id),
  );
  const isEditable = (figure) => !figure.project_id || editableProjectIds.has(figure.project_id);
  const requestedFixture = ENV.FIG ? figures.find((figure) => figure.id === ENV.FIG && isEditable(figure)) : null;
  const figure = requestedFixture || figures.find(isEditable);
  expect(figure, 'the QA account needs an editable figure').toBeTruthy();

  await authedPage(page, tokens);
  await page.goto(`/figures/${figure.id}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: figure.name, exact: true })).toBeVisible();

  const modeGroup = page.getByRole('group', { name: 'Editor mode' });
  const basic = modeGroup.getByRole('button', { name: 'Basic', exact: true });
  const advanced = modeGroup.getByRole('button', { name: 'Advanced', exact: true });
  const optionSearch = page.getByRole('searchbox', { name: 'Search options' });
  const title = page.getByLabel('In-plot title (usually blank)');

  await expect(modeGroup).toBeVisible();
  await expect(basic).toHaveAttribute('aria-pressed', 'true');
  await expect(advanced).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByLabel('Chart type')).toBeVisible();
  await expect(page.getByLabel('X label')).toBeVisible();
  await expect(page.getByLabel('Y label')).toBeVisible();
  await expect(page.getByLabel('Style')).toBeVisible();
  await expect(optionSearch).toBeHidden();

  const draftTitle = `Mode draft ${Date.now()}`;
  await title.fill(draftTitle);
  await advanced.focus();
  await page.keyboard.press('Space');
  await expect(advanced).toHaveAttribute('aria-pressed', 'true');
  await expect(basic).toHaveAttribute('aria-pressed', 'false');
  await expect(optionSearch).toBeVisible();
  await expect(page.getByText(/Advanced adds plot options/)).toBeVisible();

  await optionSearch.fill('palette');
  await basic.focus();
  await page.keyboard.press('Enter');
  await expect(basic).toHaveAttribute('aria-pressed', 'true');
  await expect(optionSearch).toBeHidden();
  await expect(title).toHaveValue(draftTitle);

  await advanced.click();
  await expect(optionSearch).toBeVisible();
  await expect(optionSearch).toHaveValue('palette');
  await expect(title).toHaveValue(draftTitle);
});
