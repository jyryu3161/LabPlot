import { expect, test } from '@playwright/test';

const DATASET_ID = '71000000-0000-4000-8000-000000000001';
const CREATED_FIGURE_ID = '72000000-0000-4000-8000-000000000001';

test('fresh figure builder submits the muted publication defaults explicitly', async ({ page }) => {
  // R-PUB-1/R-PUB-5: this is a browser contract test, not a screenshot color
  // test. It checks the visible defaults and the exact persisted-create payload.
  const createBodies: Record<string, unknown>[] = [];

  await page.addInitScript(() => {
    window.localStorage.setItem('access_token', 'deterministic-access-token');
    window.localStorage.setItem('refresh_token', 'deterministic-refresh-token');
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/auth/me') {
      return route.fulfill({ json: {
        id: '73000000-0000-4000-8000-000000000001',
        email: 'qa@example.test',
        display_name: 'QA',
        is_active: true,
        is_approved: true,
        is_admin: false,
        created_at: '2026-08-18T00:00:00Z',
      } });
    }
    if (pathname === `/api/datasets/${DATASET_ID}` && request.method() === 'GET') {
      return route.fulfill({ json: {
        id: DATASET_ID,
        name: 'Publication defaults data',
        description: 'Grouped expression measurements.',
        original_filename: 'publication-defaults.csv',
        format: 'csv',
        n_rows: 4,
        n_cols: 3,
        project_id: null,
        created_at: '2026-08-18T00:00:00Z',
        focus_columns: ['Genotype', 'Expression', 'Time_h'],
        column_profile: [
          { name: 'Genotype', dtype: 'text', role: 'group', n_unique: 2, n_missing: 0, sample_values: ['Control', 'KO'], stats: null },
          { name: 'Expression', dtype: 'numeric', role: 'numeric', n_unique: 4, n_missing: 0, sample_values: [1, 2, 3, 4], stats: null },
          { name: 'Time_h', dtype: 'text', role: 'time', n_unique: 2, n_missing: 0, sample_values: ['0h', '24h'], stats: null },
        ],
        preview: [
          { Genotype: 'Control', Expression: 1, Time_h: '0h' },
          { Genotype: 'KO', Expression: 2, Time_h: '24h' },
        ],
        statistics: { descriptive: [], comparisons: [] },
      } });
    }
    if (pathname === `/api/datasets/${DATASET_ID}/recommendations`) {
      return route.fulfill({ json: { cached: true, suggestions: [] } });
    }
    if (pathname.startsWith(`/api/datasets/${DATASET_ID}/columns/`) && pathname.endsWith('/values')) {
      const column = decodeURIComponent(pathname.split('/').at(-2) ?? '');
      const values = column === 'Time_h' ? ['0h', '24h'] : ['Control', 'KO'];
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
        options: [
          { key: 'line_type', label: 'Line type', type: 'select', choices: ['solid', 'dashed', 'dotted'], default: 'solid' },
          { key: 'point_shape', label: 'Point shape', type: 'select', choices: ['circle', 'square', 'triangle', 'none'], default: 'circle' },
        ],
        color_editable: true,
      }] } });
    }
    if (pathname === '/api/styles') {
      return route.fulfill({ json: { styles: [{ key: 'nature', label: 'Clean Classic' }] } });
    }
    if (pathname === '/api/palettes') {
      return route.fulfill({ json: { palettes: [
        {
          key: 'publication_muted_v2',
          label: 'Muted publication · teal/coral',
          colorblind_safe: false,
          is_default_for_new_figures: true,
          usage_note: 'Teal/coral-first fills with darker line strokes. Grouped line charts also use marker and line-type redundancy; verify dense figures in grayscale.',
          hex: ['#62B9C5', '#E4776B', '#7569AE', '#61A574', '#E7A85A', '#C36CA5', '#8BB8D4', '#B5BAC0'],
        },
        { key: 'journal_muted', label: 'LabPlot Academic muted', colorblind_safe: false, hex: ['#4C6F91', '#B24745'] },
      ] } });
    }
    if (pathname === '/api/figures' && request.method() === 'POST') {
      createBodies.push(request.postDataJSON());
      if (createBodies.length < 3) {
        // Keep the builder open after capturing the preserved-template and
        // untouched-fresh payloads, then let the explicit-style submit finish.
        return route.fulfill({ status: 422, json: { detail: 'deterministic first-submit probe' } });
      }
      return route.fulfill({ json: { id: CREATED_FIGURE_ID } });
    }
    if (pathname === '/api/figures/template-favorites') {
      return route.fulfill({ json: [{
        id: '74000000-0000-4000-8000-000000000001',
        figure_id: '75000000-0000-4000-8000-000000000001',
        source_version_id: '76000000-0000-4000-8000-000000000001',
        name: 'Accessible grouped line',
        figure_name: 'Accessible grouped line',
        plot_type: 'line',
        style_preset: 'nature',
        source_version_number: 1,
        mapping: { x: 'Time_h', y: 'Expression', group: 'Genotype' },
        options: {
          palette_name: 'publication_muted_v2',
          font_family: 'dejavu_sans',
          base_size: 7,
          linewidth_scale: 1,
          axis_line_width_pt: 0.5,
          data_line_width_pt: 0.8,
          redundant_series_encoding: true,
        },
        status: 'ready',
        dataset_id: DATASET_ID,
        project_id: null,
        created_at: '2026-08-18T00:00:00Z',
        updated_at: '2026-08-18T00:00:00Z',
        figure_updated_at: '2026-08-18T00:00:00Z',
        is_favorite: true,
      }] });
    }
    if (pathname === '/api/figures') {
      return route.fulfill({ json: [] });
    }
    if (pathname === '/api/projects/invitations') return route.fulfill({ json: [] });
    if (request.method() === 'GET') return route.fulfill({ json: [] });
    return route.fulfill({ status: 204 });
  });

  await page.goto(`/datasets/${DATASET_ID}?tab=visualize`);
  await page.getByRole('button', { name: '2. AI recommendations' }).click();
  await page.getByRole('button', { name: 'Use favorite figure template Accessible grouped line' }).click();
  await expect(page.getByLabel('Line type')).toHaveValue('__series_auto__');
  await page.getByRole('button', { name: 'Generate figure' }).click();
  await expect.poll(() => createBodies.length).toBe(1);
  expect(createBodies[0]).toMatchObject({ defaults_profile: 'preserve' });
  const preservedOptions = createBodies[0].options as Record<string, unknown>;
  expect(preservedOptions.redundant_series_encoding).toBe(true);
  expect(preservedOptions).not.toHaveProperty('line_type');
  expect(preservedOptions).not.toHaveProperty('point_shape');

  await page.getByRole('button', { name: 'Back to recommendations' }).click();
  await page.getByRole('button', { name: 'Build manually' }).click();
  await page.getByTestId('chart-type-select').selectOption('');
  await page.getByRole('button', { name: '3. Build figure' }).click();
  await page.getByTestId('chart-type-select').selectOption('line');

  const palette = page.getByLabel('Color palette');
  await expect(palette).toHaveValue('publication_muted_v2');
  await expect(palette.getByRole('option', { name: /Nature Genetics|official/i })).toHaveCount(0);
  await expect(page.getByText('New figure default')).toBeVisible();
  await expect(page.getByText(/marker and line-type redundancy/)).toBeVisible();
  await expect(page.getByLabel('Font family')).toHaveValue('dejavu_sans');
  await expect(page.getByText(/^Exported R uses the installed Arial-compatible fallback:/i)).toBeVisible();

  await expect(page.getByLabel('Line type')).toHaveValue('__series_auto__');
  await expect(page.getByLabel('Point shape')).toHaveValue('__series_auto__');
  await expect(page.getByLabel('Line type').getByRole('option', { name: 'Auto by series (accessible)' })).toHaveCount(1);

  await page.getByLabel('X', { exact: true }).selectOption('Time_h');
  await page.getByLabel('Y', { exact: true }).selectOption('Expression');
  await page.getByLabel('Group/Color', { exact: true }).selectOption('Genotype');
  await page.getByRole('button', { name: 'Generate figure' }).click();

  await expect.poll(() => createBodies.length).toBe(2);
  expect(createBodies[1]).toMatchObject({
    dataset_id: DATASET_ID,
    plot_type: 'line',
    mapping: { x: 'Time_h', y: 'Expression', group: 'Genotype' },
    style_preset: 'nature',
    defaults_profile: 'publication_v2',
    options: {
      palette_name: 'publication_muted_v2',
      font_family: 'dejavu_sans',
      base_size: 7,
      linewidth_scale: 1,
      axis_line_width_pt: 0.5,
      data_line_width_pt: 0.8,
      redundant_series_encoding: true,
    },
  });
  const untouchedOptions = createBodies[1].options as Record<string, unknown>;
  expect(untouchedOptions).not.toHaveProperty('line_type');
  expect(untouchedOptions).not.toHaveProperty('point_shape');

  await page.getByLabel('Line type').selectOption('dashed');
  await page.getByLabel('Point shape').selectOption('square');
  await page.getByRole('button', { name: 'Generate figure' }).click();
  await expect.poll(() => createBodies.length).toBe(3);
  expect(createBodies[2]).toMatchObject({
    options: {
      redundant_series_encoding: true,
      line_type: 'dashed',
      point_shape: 'square',
    },
  });
});
