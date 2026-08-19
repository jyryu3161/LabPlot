import { expect, test } from '@playwright/test';

const FIGURE_ID = '71000000-0000-4000-8000-000000000001';
const VERSION_ID = '72000000-0000-4000-8000-000000000001';
const DATASET_ID = '73000000-0000-4000-8000-000000000001';
const IMPROVEMENT_ID = '74000000-0000-4000-8000-000000000001';
const POINT_IMPROVEMENT_ID = '74000000-0000-4000-8000-000000000002';
const CELL_IMPROVEMENT_ID = '74000000-0000-4000-8000-000000000003';
const MARK_ID = 'marked-control-24h-bar';
const POINT_MARK_ID = 'marked-scatter-row-17';
const CELL_MARK_ID = 'marked-correlation-cell';
const ELEMENT_ID = 'mark:grouped_bar:category=Control&series=24h';
const POINT_ELEMENT_ID = 'mark:scatter:row=17';
const CELL_ELEMENT_ID = 'mark:correlation_heatmap:x=GeneA&y=GeneB';
const ELEMENT_SETTING_PATH = `options.element_overrides.${ELEMENT_ID}`;
const POINT_SETTING_PATH = `options.element_overrides.${POINT_ELEMENT_ID}`;
const CELL_SETTING_PATH = `options.element_overrides.${CELL_ELEMENT_ID}`;

const figure = {
  id: FIGURE_ID,
  name: 'Deterministic element override fixture',
  plot_type: 'grouped_bar',
  style_preset: 'clean',
  status: 'ready',
  dataset_id: DATASET_ID,
  dataset_name: 'Element override data',
  description: '',
  legend: '',
  current_version_id: VERSION_ID,
  created_at: '2026-08-18T00:00:00Z',
  updated_at: '2026-08-18T00:00:00Z',
  is_favorite: false,
  is_public: false,
  share_token: null,
  versions: [{
    id: VERSION_ID,
    version_number: 1,
    mapping: { x: 'Genotype', y: 'Expression', group: 'Time_h' },
    options: {
      title: 'Expression',
      element_overrides: { [ELEMENT_ID]: { fill: '#62B9C5' } },
    },
    style_preset: 'clean',
    created_at: '2026-08-18T00:00:00Z',
    png_url: '/element-override-fixture.svg',
    svg_url: '/element-override-fixture.svg',
    layout: {
      panel_px: { x0: 100, y0: 80, x1: 900, y1: 680 },
      img_px: { w: 1000, h: 800 },
      x_range: [0, 2],
      y_range: [0, 10],
      x_discrete: true,
      y_discrete: false,
      scene_elements: [
        {
          id: ELEMENT_ID,
          kind: 'mark',
          role: 'bar',
          bbox_px: { x0: 420, y0: 280, x1: 520, y1: 650 },
          category: 'Control',
          series: '24h',
          editable: true,
          setting_path: ELEMENT_SETTING_PATH,
        },
        {
          id: POINT_ELEMENT_ID,
          kind: 'mark',
          role: 'point',
          bbox_px: { x0: 640, y0: 290, x1: 680, y1: 330 },
          category: 'row 17',
          series: 'Control',
          editable: true,
          setting_path: POINT_SETTING_PATH,
        },
        {
          id: CELL_ELEMENT_ID,
          kind: 'mark',
          role: 'cell',
          bbox_px: { x0: 700, y0: 400, x1: 780, y1: 480 },
          category: 'GeneA',
          series: 'GeneB',
          editable: true,
          setting_path: CELL_SETTING_PATH,
        },
      ],
    },
  }],
};

test('marked bar, point, and cell targets apply only their stable element overrides', async ({ page }) => {
  let improveBody: Record<string, unknown> | null = null;
  let applyBody: Record<string, unknown> | null = null;

  await page.addInitScript(({ versionId, markId, pointMarkId, cellMarkId }) => {
    window.localStorage.setItem('access_token', 'deterministic-access-token');
    window.localStorage.setItem('refresh_token', 'deterministic-refresh-token');
    window.localStorage.setItem(`labplot.ai-editor.annotations.${versionId}`, JSON.stringify([
      {
        id: markId,
        displayNumber: 1,
        type: 'region',
        x: 42,
        y: 35,
        w: 10,
        h: 46,
        text: 'Change only this bar fill to #7E22CE',
      },
      {
        id: pointMarkId,
        displayNumber: 2,
        type: 'region',
        x: 64,
        y: 36,
        w: 4,
        h: 6,
        text: 'Change only this point fill to #2563EB',
      },
      {
        id: cellMarkId,
        displayNumber: 3,
        type: 'region',
        x: 70,
        y: 50,
        w: 8,
        h: 10,
        text: 'Change only this cell fill to #16A34A',
      },
    ]));
  }, {
    versionId: VERSION_ID,
    markId: MARK_ID,
    pointMarkId: POINT_MARK_ID,
    cellMarkId: CELL_MARK_ID,
  });

  await page.route('**/element-override-fixture.svg', (route) => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: [
      '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800">',
      '<rect width="1000" height="800" fill="white"/>',
      '<rect x="420" y="280" width="100" height="370" fill="#62B9C5"/>',
      '</svg>',
    ].join(''),
  }));

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/auth/me') {
      return route.fulfill({ json: {
        id: '75000000-0000-4000-8000-000000000001',
        email: 'qa@example.test',
        display_name: 'QA',
        is_active: true,
        is_approved: true,
        is_admin: false,
        created_at: '2026-08-18T00:00:00Z',
      } });
    }
    if (pathname === `/api/figures/${FIGURE_ID}` && request.method() === 'GET') {
      return route.fulfill({ json: figure });
    }
    if (pathname === `/api/figures/${FIGURE_ID}/versions/${VERSION_ID}/improve` && request.method() === 'POST') {
      improveBody = request.postDataJSON();
      return route.fulfill({ json: [{
        id: IMPROVEMENT_ID,
        figure_version_id: VERSION_ID,
        suggestion_type: 'Marked bar fill',
        current_state: 'The selected Control / 24h bar uses #62B9C5.',
        recommended: 'Set only the selected bar fill to #7E22CE.',
        param_patch: { options: { element_overrides: { [ELEMENT_ID]: { fill: '#7E22CE' } } } },
        priority: 'high',
        applied: false,
        skipped: [],
        unsupported: [],
        edit_scope: {
          scope_id: 'mark:A',
          mark_id: MARK_ID,
          mark_label: 'A',
          mark_type: 'region',
          request: 'Change only this bar fill to #7E22CE',
          status: 'supported',
          confidence: 0.99,
          resolved_target: {
            type: 'bar',
            label: 'Bar · Control · 24h',
            setting_path: ELEMENT_SETTING_PATH,
            element_id: ELEMENT_ID,
            role: 'bar',
            category: 'Control',
            series: '24h',
            editable: true,
          },
          allowed_patch_keys: [`${ELEMENT_SETTING_PATH}.fill`],
        },
        created_at: '2026-08-18T00:01:00Z',
      }, {
        id: POINT_IMPROVEMENT_ID,
        figure_version_id: VERSION_ID,
        suggestion_type: 'Marked point fill',
        current_state: 'The selected scatter point uses its series color.',
        recommended: 'Set only the selected point fill to #2563EB.',
        param_patch: { options: { element_overrides: { [POINT_ELEMENT_ID]: { fill: '#2563EB' } } } },
        priority: 'high',
        applied: false,
        skipped: [],
        unsupported: [],
        edit_scope: {
          scope_id: 'mark:B',
          mark_id: POINT_MARK_ID,
          mark_label: 'B',
          mark_type: 'region',
          request: 'Change only this point fill to #2563EB',
          status: 'supported',
          confidence: 0.99,
          resolved_target: {
            type: 'point',
            label: 'Point · row 17 · Control',
            setting_path: POINT_SETTING_PATH,
            element_id: POINT_ELEMENT_ID,
            role: 'point',
            category: 'row 17',
            series: 'Control',
            editable: true,
          },
          allowed_patch_keys: [`${POINT_SETTING_PATH}.fill`],
        },
        created_at: '2026-08-18T00:01:01Z',
      }, {
        id: CELL_IMPROVEMENT_ID,
        figure_version_id: VERSION_ID,
        suggestion_type: 'Marked cell fill',
        current_state: 'The selected GeneA / GeneB cell uses the continuous scale.',
        recommended: 'Set only the selected cell fill to #16A34A.',
        param_patch: { options: { element_overrides: { [CELL_ELEMENT_ID]: { fill: '#16A34A' } } } },
        priority: 'high',
        applied: false,
        skipped: [],
        unsupported: [],
        edit_scope: {
          scope_id: 'mark:C',
          mark_id: CELL_MARK_ID,
          mark_label: 'C',
          mark_type: 'region',
          request: 'Change only this cell fill to #16A34A',
          status: 'supported',
          confidence: 0.99,
          resolved_target: {
            type: 'cell',
            label: 'Cell · GeneA · GeneB',
            setting_path: CELL_SETTING_PATH,
            element_id: CELL_ELEMENT_ID,
            role: 'cell',
            category: 'GeneA',
            series: 'GeneB',
            editable: true,
          },
          allowed_patch_keys: [`${CELL_SETTING_PATH}.fill`],
        },
        created_at: '2026-08-18T00:01:02Z',
      }] });
    }
    if (pathname === `/api/figures/${FIGURE_ID}/improvements/apply` && request.method() === 'POST') {
      applyBody = request.postDataJSON();
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Deterministic test stops before mutation.' }),
      });
    }
    if (pathname === `/api/figures/${FIGURE_ID}/versions/${VERSION_ID}/review` && request.method() === 'POST') {
      return route.fulfill({ json: {
        id: '76000000-0000-4000-8000-000000000001',
        figure_version_id: VERSION_ID,
        publication_score: 86,
        payload: {
          publication_score: 86,
          summary: 'Grounded deterministic review.',
          accessibility_checks: {
            schema_version: '1.0',
            palette: {
              status: 'evaluated', source: 'publication_muted_v2',
              colors: ['#62B9C5', '#E4776B'], series_count: 2, reason: null,
            },
            cvd: {
              status: 'needs_review', method: 'deterministic_srgb_matrix_delta_e76_v1', threshold_delta_e: 10,
              simulations: [
                { mode: 'protanopia', status: 'pass', min_delta_e: 18.4, closest_pair: ['#62B9C5', '#E4776B'] },
                { mode: 'deuteranopia', status: 'pass', min_delta_e: 16.2, closest_pair: ['#62B9C5', '#E4776B'] },
                { mode: 'tritanopia', status: 'needs_review', min_delta_e: 8.7, closest_pair: ['#62B9C5', '#E4776B'] },
              ],
              reason: null,
            },
            grayscale: {
              status: 'pass', method: 'cie_lab_lightness_delta_v1', threshold_delta_l: 10,
              min_delta_l: 12.3, closest_pair: ['#62B9C5', '#E4776B'], reason: null,
            },
            minimum_contrast: {
              status: 'pass', method: 'wcag_relative_luminance', threshold_ratio: 3,
              ratio: 3.6, foreground: '#E4776B', background: '#FFFFFF', reason: null,
            },
          },
        },
        created_at: '2026-08-18T00:02:00Z',
      } });
    }
    if (pathname === '/api/plot-types') {
      return route.fulfill({ json: { plot_types: [{ type: 'grouped_bar', label: 'Grouped bar', required: [], optional: [], options: [] }] } });
    }
    if (pathname === '/api/styles') return route.fulfill({ json: { styles: [{ key: 'clean', label: 'Clean' }] } });
    if (pathname === '/api/palettes') return route.fulfill({ json: { palettes: [] } });
    if (pathname === `/api/datasets/${DATASET_ID}`) {
      return route.fulfill({ json: {
        id: DATASET_ID,
        name: figure.dataset_name,
        original_filename: 'fixture.csv',
        format: 'csv',
        n_rows: 4,
        n_cols: 3,
        created_at: '2026-08-18T00:00:00Z',
        column_profile: [],
        preview: [],
      } });
    }
    if (pathname === '/api/projects/invitations' || pathname.endsWith('/comments')) return route.fulfill({ json: [] });
    if (request.method() === 'GET') return route.fulfill({ json: [] });
    return route.fulfill({ status: 204 });
  });

  await page.goto(`/figures/${FIGURE_ID}`);
  await expect(page.getByRole('heading', { name: 'AI editor (v1)' })).toBeVisible();
  const targetSelect = page.getByRole('combobox', { name: 'Target for Mark A' });
  await expect(targetSelect.getByRole('option').first()).toHaveText('Auto-detect · Bar · Control · 24h');
  await expect(targetSelect.getByRole('option', { name: 'Bar · Control · 24h', exact: true })).toHaveCount(1);
  const pointTargetSelect = page.getByRole('combobox', { name: 'Target for Mark B' });
  await expect(pointTargetSelect.getByRole('option').first()).toHaveText('Auto-detect · Point · row 17 · Control');
  await expect(pointTargetSelect.getByRole('option', { name: 'Point · row 17 · Control', exact: true })).toHaveCount(1);
  const cellTargetSelect = page.getByRole('combobox', { name: 'Target for Mark C' });
  await expect(cellTargetSelect.getByRole('option').first()).toHaveText('Auto-detect · Cell · GeneA · GeneB');
  await expect(cellTargetSelect.getByRole('option', { name: 'Cell · GeneA · GeneB', exact: true })).toHaveCount(1);

  await page.getByRole('button', { name: 'Review change plan' }).click();
  await expect.poll(() => improveBody).not.toBeNull();
  expect(improveBody).toMatchObject({
    marks: [
      {
        id: MARK_ID,
        resolved_target: {
          type: 'bar',
          element_id: ELEMENT_ID,
          setting_path: ELEMENT_SETTING_PATH,
          category: 'Control',
          series: '24h',
          editable: true,
        },
      },
      {
        id: POINT_MARK_ID,
        resolved_target: {
          type: 'point',
          element_id: POINT_ELEMENT_ID,
          setting_path: POINT_SETTING_PATH,
          category: 'row 17',
          series: 'Control',
          editable: true,
        },
      },
      {
        id: CELL_MARK_ID,
        resolved_target: {
          type: 'cell',
          element_id: CELL_ELEMENT_ID,
          setting_path: CELL_SETTING_PATH,
          category: 'GeneA',
          series: 'GeneB',
          editable: true,
        },
      },
    ],
  });

  const plan = page.getByRole('region', { name: 'AI interpretation and settings plan' });
  const markA = plan.getByRole('article', { name: 'Mark A · Region' });
  const markB = plan.getByRole('article', { name: 'Mark B · Region' });
  const markC = plan.getByRole('article', { name: 'Mark C · Region' });
  await expect(markA).toContainText('Supported');
  await expect(markA).toContainText('Resolved target: Bar · Control · 24h');
  await expect(markA).toContainText(`${ELEMENT_SETTING_PATH}.fill`);
  await expect(markA.getByRole('cell', { name: '#62B9C5', exact: true })).toBeVisible();
  await expect(markB).toContainText('Supported');
  await expect(markB).toContainText('Resolved target: Point · row 17 · Control');
  await expect(markB).toContainText(`${POINT_SETTING_PATH}.fill`);
  await expect(markC).toContainText('Supported');
  await expect(markC).toContainText('Resolved target: Cell · GeneA · GeneB');
  await expect(markC).toContainText(`${CELL_SETTING_PATH}.fill`);
  await expect(plan.getByRole('region', { name: 'Unrequested changes' })).toContainText('None');

  await markA.getByRole('checkbox', { name: 'Select Mark A changes' }).click();
  await markB.getByRole('checkbox', { name: 'Select Mark B changes' }).click();
  await markC.getByRole('checkbox', { name: 'Select Mark C changes' }).click();
  await plan.getByRole('button', { name: 'Apply selected (3)' }).click();
  await expect.poll(() => applyBody).not.toBeNull();
  expect(applyBody).toMatchObject({
    improvement_ids: [IMPROVEMENT_ID, POINT_IMPROVEMENT_ID, CELL_IMPROVEMENT_ID],
  });

  await page.getByRole('button', { name: 'Review this figure' }).click();
  const checks = page.getByRole('region', { name: 'Deterministic color accessibility checks' });
  await expect(checks).toBeVisible();
  await expect(checks).toContainText('these results are not an AI opinion');
  await expect(checks).toContainText('protanopia');
  await expect(checks).toContainText('ΔE 18.4');
  await expect(checks).toContainText('Minimum ΔL 12.3');
  await expect(checks).toContainText('Minimum ratio 3.6:1');
});
