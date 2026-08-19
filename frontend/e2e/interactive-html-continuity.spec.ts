import { expect, test } from '@playwright/test';

const FIGURE_ID = '81000000-0000-4000-8000-000000000001';
const DATASET_ID = '82000000-0000-4000-8000-000000000001';
const VERSION_ID = '83000000-0000-4000-8000-000000000001';
const GENERATED_VERSION_ID = '83000000-0000-4000-8000-000000000002';

const sourceVersion = {
  id: VERSION_ID,
  version_number: 1,
  mapping: { x: 'Time', y: 'Response' },
  options: { title: 'Interactive continuity' },
  style_preset: 'nature',
  change_note: 'Initial render',
  created_at: '2026-08-18T00:00:00Z',
  png_url: '/interactive-continuity.svg',
  svg_url: '/interactive-continuity.svg',
  r_available: true,
  layout: null,
};

const sourceFigure = {
  id: FIGURE_ID,
  name: 'Interactive HTML continuity fixture',
  plot_type: 'line',
  style_preset: 'nature',
  status: 'ready',
  dataset_id: DATASET_ID,
  project_id: null,
  dataset_name: 'Interactive continuity data',
  description: '',
  legend: '',
  current_version_id: VERSION_ID,
  created_at: '2026-08-18T00:00:00Z',
  updated_at: '2026-08-18T00:00:00Z',
  is_favorite: false,
  is_public: false,
  share_token: null,
  versions: [sourceVersion],
};

const generatedVersion = {
  ...sourceVersion,
  id: GENERATED_VERSION_ID,
  version_number: 2,
  options: { ...sourceVersion.options, interactive_html: true },
  change_note: 'Edited in figure editor',
  created_at: '2026-08-18T00:01:00Z',
  html_url: '/interactive-continuity.html',
};

test('lower Interactive HTML control keeps the complete figure workspace mounted', async ({ page }) => {
  let rerenderStarted = false;
  let releaseRerender: (() => void) | null = null;
  let detailRefetchStarted = false;
  let releaseDetailRefetch: (() => void) | null = null;
  let detailGetCount = 0;

  await page.addInitScript(() => {
    window.localStorage.setItem('access_token', 'deterministic-access-token');
    window.localStorage.setItem('refresh_token', 'deterministic-refresh-token');
    window.localStorage.removeItem('labplot-live-preview');
  });
  await page.route('**/interactive-continuity.svg', (route) => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="540"><rect width="900" height="540" fill="white"/><path d="M80 430 L300 300 L520 340 L800 120" fill="none" stroke="#2F8998" stroke-width="3"/></svg>',
  }));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/auth/me') {
      return route.fulfill({ json: {
        id: '84000000-0000-4000-8000-000000000001',
        email: 'qa@example.test',
        display_name: 'QA',
        is_active: true,
        is_approved: true,
        is_admin: false,
        created_at: '2026-08-18T00:00:00Z',
      } });
    }
    if (pathname === `/api/figures/${FIGURE_ID}` && request.method() === 'GET') {
      detailGetCount += 1;
      if (detailGetCount === 2) {
        detailRefetchStarted = true;
        await new Promise<void>((resolve) => { releaseDetailRefetch = resolve; });
      }
      // Deliberately return the stale v1 detail after creation. The durable
      // POST response must keep v2 and every workspace tool mounted.
      return route.fulfill({ json: sourceFigure });
    }
    if (pathname === `/api/figures/${FIGURE_ID}/rerender` && request.method() === 'POST') {
      rerenderStarted = true;
      await new Promise<void>((resolve) => { releaseRerender = resolve; });
      return route.fulfill({ json: generatedVersion });
    }
    if (pathname === '/api/plot-types') {
      return route.fulfill({ json: { plot_types: [{
        type: 'line',
        label: 'Line plot',
        required: [
          { key: 'x', label: 'X', roles: ['time', 'numeric'] },
          { key: 'y', label: 'Y', roles: ['numeric'] },
        ],
        optional: [],
        options: [],
        color_editable: true,
      }] } });
    }
    if (pathname === '/api/styles') {
      return route.fulfill({ json: { styles: [{ key: 'nature', label: 'Clean Classic' }] } });
    }
    if (pathname === '/api/palettes') return route.fulfill({ json: { palettes: [] } });
    if (pathname === `/api/datasets/${DATASET_ID}`) {
      return route.fulfill({ json: {
        id: DATASET_ID,
        name: 'Interactive continuity data',
        original_filename: 'interactive-continuity.csv',
        format: 'csv',
        n_rows: 4,
        n_cols: 2,
        created_at: '2026-08-18T00:00:00Z',
        column_profile: [
          { name: 'Time', dtype: 'numeric', role: 'time', n_unique: 4, n_missing: 0, sample_values: [0, 1, 2, 3], stats: null },
          { name: 'Response', dtype: 'numeric', role: 'numeric', n_unique: 4, n_missing: 0, sample_values: [1, 2, 3, 4], stats: null },
        ],
        preview: [],
      } });
    }
    if (pathname === '/api/projects/invitations' || pathname.endsWith('/comments')) {
      return route.fulfill({ json: [] });
    }
    if (request.method() === 'GET') return route.fulfill({ json: [] });
    return route.fulfill({ status: 204 });
  });

  await page.goto(`/figures/${FIGURE_ID}`);
  await expect(page.getByRole('heading', { name: sourceFigure.name, exact: true })).toBeVisible();

  const preview = page.getByRole('img', { name: sourceFigure.name, exact: true });
  const editorModes = page.getByRole('group', { name: 'Editor mode' });
  const versions = page.getByText('Versions (1)', { exact: true });
  const exportCard = page.getByRole('region', { name: 'Figure exports' });
  await expect(exportCard.getByText('Export (v1)', { exact: true })).toBeVisible();
  const lowerToggle = exportCard.getByRole('switch', { name: 'Interactive HTML' });
  const previewControls = page.getByRole('group', { name: 'Interactive HTML preview controls' });
  const previewGenerate = previewControls.getByRole('button', { name: 'Generate interactive HTML' });

  await lowerToggle.click();
  await expect(lowerToggle).toBeChecked();
  await expect(previewControls.getByRole('switch', { name: 'Interactive HTML' })).toBeChecked();
  await expect(previewGenerate).toBeEnabled();
  await expect(preview).toBeVisible();
  await expect(editorModes).toBeVisible();
  await expect(editorModes.getByRole('button', { name: 'Basic', exact: true })).toBeVisible();
  await expect(editorModes.getByRole('button', { name: 'Advanced', exact: true })).toBeVisible();
  await expect(versions).toBeVisible();

  // Both entry points use the same request/generate state machine. In
  // particular, the lower control must not strand the user without Generate.
  const lowerGenerate = exportCard.getByRole('button', { name: 'Generate interactive HTML' });
  await expect(lowerGenerate).toBeEnabled();
  await lowerGenerate.click();
  await expect.poll(() => rerenderStarted, { message: 'the lower Generate control should start one rerender' }).toBe(true);

  // Keep the R request pending and prove that none of the workspace is
  // conditionally unmounted while the requested format is being generated.
  await expect(preview).toBeVisible();
  await expect(editorModes).toBeVisible();
  await expect(versions).toBeVisible();
  await expect(lowerGenerate).toBeVisible();
  await expect(previewGenerate).toBeVisible();

  releaseRerender!();
  await expect.poll(() => detailRefetchStarted, { message: 'created v2 should trigger a complete detail refetch' }).toBe(true);
  await expect(page.getByText('Refreshing the complete figure details…', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: sourceFigure.name, exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Editor mode' })).toBeVisible();
  await expect(page.getByText('Versions (2)', { exact: true })).toBeVisible();

  releaseDetailRefetch!();
  await expect(page.getByText('Refreshing the complete figure details…', { exact: true })).toBeHidden();
  await expect(page.getByText('Export (v2)', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Editor mode' })).toBeVisible();
  await expect(page.getByText('Versions (2)', { exact: true })).toBeVisible();
});
