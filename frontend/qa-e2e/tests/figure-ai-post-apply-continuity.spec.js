const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

const authHeaders = (tokens) => ({ Authorization: `Bearer ${tokens.access_token}` });

test('AI apply keeps the figure tools mounted while the new version detail is refetched', async ({ page, request }) => {
  test.skip(!ENV.FIG, 'set QA_FIG to an editable figure id');

  const tokens = await apiLogin(request);
  const figureResponse = await request.get(`${ENV.BASE}/api/figures/${ENV.FIG}`, {
    headers: authHeaders(tokens),
  });
  expect(figureResponse.ok(), 'figure fixture request').toBeTruthy();
  const sourceFigure = await figureResponse.json();
  const sourceVersion = sourceFigure.versions.find((item) => item.id === sourceFigure.current_version_id)
    || sourceFigure.versions[sourceFigure.versions.length - 1];
  expect(sourceVersion?.id, 'the QA figure needs a saved version').toBeTruthy();

  // Keep the local frontend same-origin. This generic route proxies only API
  // traffic to the configured backend; the narrower deterministic mocks below
  // are registered later and therefore take precedence in Playwright.
  await page.route('**/api/**', async (route) => {
    const incoming = new URL(route.request().url());
    const response = await route.fetch({
      url: `${ENV.BASE}${incoming.pathname}${incoming.search}`,
    });
    await route.fulfill({ response });
  });
  await authedPage(page, tokens);
  await page.goto(`/figures/${ENV.FIG}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: sourceFigure.name, exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.__qaFigureVersionEvents = [];
    window.__qaFigureVersionChannel = new BroadcastChannel('labplot.figure-versions');
    window.__qaFigureVersionChannel.onmessage = (event) => {
      window.__qaFigureVersionEvents.push(event.data);
    };
  });

  const improvementId = '71111111-1111-4111-8111-111111111111';
  const appliedVersion = {
    ...sourceVersion,
    id: '73333333-3333-4333-8333-333333333333',
    version_number: sourceVersion.version_number + 1,
    options: { ...(sourceVersion.options || {}), title: 'Post-apply continuity' },
    change_note: 'AI post-apply continuity regression',
    created_at: '2026-08-17T12:00:00Z',
  };
  const refreshedFigure = {
    ...sourceFigure,
    current_version_id: appliedVersion.id,
    style_preset: appliedVersion.style_preset,
    versions: [...sourceFigure.versions, appliedVersion],
  };

  await page.route('**/api/figures/*/versions/*/improve', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        id: improvementId,
        figure_version_id: sourceVersion.id,
        suggestion_type: 'Title',
        current_state: 'The current title is unchanged.',
        recommended: 'Set the requested title.',
        param_patch: { options: { title: 'Post-apply continuity' } },
        priority: 'high',
        applied: false,
        skipped: [],
        unsupported: [],
        created_at: '2026-08-17T11:59:00Z',
      }]),
    });
  });
  await page.route('**/api/figures/*/improvements/apply', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: appliedVersion,
        applied_changes: [{
          key: 'options.title',
          from: sourceVersion.options?.title ?? null,
          to: 'Post-apply continuity',
        }],
        dropped_keys: [],
        verification: { attempts: 1, satisfied: true, feedback: 'The requested title is visible.' },
      }),
    });
  });

  let releaseDetailRefetch;
  const detailRefetchGate = new Promise((resolve) => { releaseDetailRefetch = resolve; });
  let detailRefetchStarted = false;
  const exactFigureUrl = new RegExp(`/api/figures/${ENV.FIG}(?:\\?.*)?$`);
  await page.route(exactFigureUrl, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    detailRefetchStarted = true;
    await detailRefetchGate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      // Model a stale intermediary/cache response. The mutation response above
      // is already authoritative for the durable version, so this must not
      // erase it or unmount the detail tools.
      body: JSON.stringify(sourceFigure),
    });
  });

  const aiEditor = page.getByRole('heading', { name: /AI editor/ })
    .locator('xpath=ancestor::*[@data-slot="card"][1]');
  await aiEditor.getByRole('textbox', { name: 'Edit request' }).fill('Change the title to Post-apply continuity.');
  await aiEditor.getByRole('button', { name: 'Review change plan' }).click();
  const changePlan = aiEditor.getByRole('region', { name: 'AI interpretation and settings plan' });
  await changePlan.getByRole('checkbox', { name: 'Select proposed change: Title' }).click();
  await changePlan.getByRole('button', { name: 'Apply selected (1)' }).click();

  await expect.poll(() => detailRefetchStarted, { message: 'AI apply should refetch the complete figure detail' }).toBe(true);
  await expect.poll(
    () => page.evaluate((versionId) => window.__qaFigureVersionEvents.some(
      (event) => event?.figureId === window.location.pathname.split('/').pop()
        && event?.versionId === versionId
        && event?.source === 'figure-editor',
    ), appliedVersion.id),
    { message: 'the real AI apply path should publish the canvas synchronization event' },
  ).toBe(true);
  const syncStatus = page.getByText('Refreshing the complete figure details…', { exact: true });

  try {
    // The response already contains the durable new version. The page must keep
    // that version in its local detail model while the authoritative GET is in
    // flight, instead of entering a selected-id-without-version gap.
    await expect(page.getByRole('heading', { name: `AI editor (v${appliedVersion.version_number})`, exact: true })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Editor mode' })).toBeVisible();
    await expect(page.getByText(`Versions (${refreshedFigure.versions.length})`, { exact: true })).toBeVisible();
    await expect(page.getByText('AI Figure Review', { exact: true })).toBeVisible();
    await expect(page.getByLabel('New comment')).toBeVisible();
    await expect(syncStatus).toBeVisible();
  } finally {
    releaseDetailRefetch();
  }
  await expect(syncStatus).toBeHidden();
  await expect(page.getByRole('heading', { name: `AI editor (v${appliedVersion.version_number})`, exact: true })).toBeVisible();
  await expect(page.getByText(`Versions (${refreshedFigure.versions.length})`, { exact: true })).toBeVisible();
  await expect(page.getByText(`v${appliedVersion.version_number} ·`, { exact: false })).toBeVisible();
});
