import { expect, test } from '@playwright/test';

const DATASET_ID = '81000000-0000-4000-8000-000000000001';

test('line recommendations prefill one unambiguous group and block ambiguous group intent', async ({ page }) => {
  // REQ-REC-GROUP-1/2: the card-to-builder contract must not silently drop an
  // intent-required series mapping or guess between two legitimate columns.
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.localStorage.setItem('access_token', 'deterministic-access-token');
    window.localStorage.setItem('refresh_token', 'deterministic-refresh-token');
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/auth/me') {
      return route.fulfill({ json: {
        id: '82000000-0000-4000-8000-000000000001',
        email: 'mapping-qa@example.test',
        display_name: 'Mapping QA',
        is_active: true,
        is_approved: true,
        is_admin: false,
        created_at: '2026-08-18T00:00:00Z',
      } });
    }
    if (pathname === `/api/datasets/${DATASET_ID}`) {
      return route.fulfill({ json: {
        id: DATASET_ID,
        name: 'Line mapping data',
        original_filename: 'line-mapping.csv',
        format: 'csv',
        n_rows: 8,
        n_cols: 4,
        project_id: null,
        created_at: '2026-08-18T00:00:00Z',
        focus_columns: ['Time_h', 'Response', 'Genotype', 'Treatment'],
        column_profile: [
          { name: 'Time_h', dtype: 'numeric', role: 'time', n_unique: 2, n_missing: 0 },
          { name: 'Response', dtype: 'numeric', role: 'numeric', n_unique: 8, n_missing: 0 },
          { name: 'Genotype', dtype: 'text', role: 'group', n_unique: 2, n_missing: 0 },
          { name: 'Treatment', dtype: 'text', role: 'group', n_unique: 2, n_missing: 0 },
        ],
        preview: [],
        statistics: { descriptive: [], comparisons: [] },
      } });
    }
    if (pathname === `/api/datasets/${DATASET_ID}/recommendations`) {
      return route.fulfill({ json: {
        cached: true,
        suggestions: [
          {
            plot_type: 'line',
            title: 'Ambiguous grouped line',
            score: 0.92,
            rank: 1,
            source: 'ai',
            suggested_mapping: { x: 'Time_h', y: 'Response' },
            mapping_complete: false,
            missing_required_mappings: [{ key: 'group', label: 'Group/Color' }],
            intent: {
              group_mapping_required: true,
              group_mapping_status: 'selection_required',
              group_mapping_candidates: ['Genotype', 'Treatment'],
            },
          },
          {
            plot_type: 'line',
            title: 'Genotype line',
            score: 0.9,
            rank: 2,
            source: 'ai',
            suggested_mapping: { x: 'Time_h', y: 'Response', group: 'Genotype' },
            mapping_complete: true,
            missing_required_mappings: [],
          },
        ],
      } });
    }
    if (pathname.startsWith(`/api/datasets/${DATASET_ID}/columns/`) && pathname.endsWith('/values')) {
      const column = decodeURIComponent(pathname.split('/').at(-2) ?? '');
      const values = column === 'Genotype' ? ['Control', 'KO'] : ['Vehicle', 'Drug'];
      return route.fulfill({ json: { column, values, distinct_count: values.length, truncated: false } });
    }
    if (pathname === '/api/plot-types') {
      return route.fulfill({ json: { plot_types: [{
        type: 'line',
        label: 'Line plot',
        required: [
          { key: 'x', label: 'X', roles: ['time', 'numeric', 'category'] },
          { key: 'y', label: 'Y', roles: ['numeric'] },
        ],
        optional: [{ key: 'group', label: 'Group/Color', roles: ['group', 'category'] }],
        options: [],
        color_editable: true,
      }] } });
    }
    if (pathname === '/api/styles') {
      return route.fulfill({ json: { styles: [{ key: 'nature', label: 'Clean Classic' }] } });
    }
    if (pathname === '/api/palettes') {
      return route.fulfill({ json: { palettes: [{
        key: 'publication_muted_v2',
        label: 'Muted publication · teal/coral',
        colorblind_safe: false,
        hex: ['#62B9C5', '#E4776B'],
        is_default_for_new_figures: true,
      }] } });
    }
    if (pathname === '/api/figures/template-favorites' || pathname === '/api/figures') {
      return route.fulfill({ json: [] });
    }
    if (request.method() === 'GET') return route.fulfill({ json: [] });
    return route.fulfill({ status: 204 });
  });

  await page.goto(`/datasets/${DATASET_ID}?tab=visualize`);
  await page.getByRole('button', { name: '2. AI recommendations' }).click();

  const ambiguous = page.getByRole('button').filter({ hasText: 'Ambiguous grouped line' });
  await expect(ambiguous).toBeDisabled();
  await expect(ambiguous).toContainText('Select required mapping: Group/Color');
  await expect(ambiguous).toContainText('Complete mapping before applying');

  await page.getByRole('button').filter({ hasText: 'Genotype line' }).click();
  await expect.poll(() => pageErrors).toEqual([]);
  await expect(page.getByTestId('chart-type-select')).toHaveValue('line');
  await expect(page.getByLabel('X', { exact: true })).toHaveValue('Time_h');
  await expect(page.getByLabel('Y', { exact: true })).toHaveValue('Response');
  await expect(page.getByLabel('Group/Color', { exact: true })).toHaveValue('Genotype');
});
