import { expect, test } from '@playwright/test';

const FIGURE_ID = '10000000-0000-4000-8000-000000000001';
const VERSION_ID = '20000000-0000-4000-8000-000000000001';
const APPLIED_VERSION_ID = '20000000-0000-4000-8000-000000000002';
const MARK_A_ID = 'mark-region-title';
const MARK_B_ID = 'mark-arrow-x-label';
const MARK_C_ID = 'mark-note-y-label';
const EXACT_ORIGINAL_REQUEST = [
  'Replace this text with After title',
  'Mark B: Make this one bar blue',
  'Mark C: Rename the y-axis label to Normalized expression',
].join('\n');

const figure = {
  id: FIGURE_ID,
  name: 'Deterministic marked edit fixture',
  plot_type: 'scatter',
  style_preset: 'publication',
  status: 'ready',
  dataset_id: '30000000-0000-4000-8000-000000000001',
  dataset_name: 'Marked edit data',
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
    mapping: { x: 'Time_h', y: 'Expression' },
    options: { title: 'Before title', subtitle: 'Before subtitle', x_label: 'Time', y_label: 'Expression' },
    style_preset: 'publication',
    created_at: '2026-08-18T00:00:00Z',
    png_url: '/marked-edit-fixture.svg',
    svg_url: '/marked-edit-fixture.svg',
    layout: {
      panel_px: { x0: 140, y0: 110, x1: 920, y1: 650 },
      img_px: { w: 1000, h: 800 },
      x_range: [0, 24],
      y_range: [0, 10],
      x_discrete: false,
      y_discrete: false,
      title_px: { x0: 140, y0: 20, x1: 920, y1: 90 },
      subtitle_px: { x0: 140, y0: 70, x1: 920, y1: 110 },
      xlab_px: { x0: 300, y0: 730, x1: 760, y1: 785 },
      ylab_px: { x0: 20, y0: 180, x1: 80, y1: 620 },
      x_axis_px: { x0: 140, y0: 650, x1: 920, y1: 720 },
      y_axis_px: { x0: 80, y0: 110, x1: 140, y1: 650 },
      scene_elements: [
        { id: 'element:title', kind: 'text', role: 'title', bbox_px: { x0: 140, y0: 20, x1: 920, y1: 90 }, editable: true, setting_path: 'options.title' },
        { id: 'element:subtitle', kind: 'text', role: 'subtitle', bbox_px: { x0: 140, y0: 70, x1: 920, y1: 110 }, editable: true, setting_path: 'options.subtitle' },
        { id: 'element:axis:x:label', kind: 'text', role: 'x_label', bbox_px: { x0: 300, y0: 730, x1: 760, y1: 785 }, editable: true, setting_path: 'options.x_label' },
        { id: 'element:axis:y:label', kind: 'text', role: 'y_label', bbox_px: { x0: 20, y0: 180, x1: 80, y1: 620 }, editable: true, setting_path: 'options.y_label' },
        { id: 'mark:bar:Knockout:24h', kind: 'mark', role: 'bar', bbox_px: { x0: 450, y0: 300, x1: 550, y1: 500 }, category: 'Knockout', series: '24h', editable: false, setting_path: null, unsupported_reason: 'Per-bar styling is not supported yet; use per-series styling.' },
      ],
    },
  }],
};

const improvements: Array<Record<string, unknown>> = [
  {
    id: '40000000-0000-4000-8000-000000000001',
    figure_version_id: VERSION_ID,
    suggestion_type: 'Marked title edit',
    current_state: 'The title is Before title.',
    recommended: 'Set the title requested at Mark A.',
    param_patch: { options: { title: 'After title' } },
    priority: 'high',
    applied: false,
    skipped: ['options.injected_script'],
    unsupported: [
      { mark_id: MARK_A_ID, request: 'Apply this marked change', reason: 'This scoped change was not applied.' },
      { mark_id: MARK_A_ID, request: 'Mark A: change only this title', reason: 'The title target needs a supported text patch.' },
      { mark_id: MARK_B_ID, request: 'Apply this marked change', reason: 'This scoped change was not applied.' },
      { mark_id: MARK_B_ID, request: 'Mark B: make this one bar blue', reason: 'Per-bar styling is not supported yet; use per-series styling.' },
      { mark_id: MARK_C_ID, request: 'Apply this marked change', reason: 'This scoped change was not applied.' },
    ],
    edit_scope: {
      scope_id: 'mark:A', mark_id: MARK_A_ID, mark_label: 'A', mark_type: 'region',
      request: 'Replace this text with After title', status: 'supported', confidence: 0.97,
      resolved_target: { type: 'title', label: 'Title', setting_path: 'options.title', element_id: 'element:title', editable: true },
      allowed_patch_keys: ['options.title'],
    },
    created_at: '2026-08-18T00:01:00Z',
  },
  {
    id: '40000000-0000-4000-8000-000000000002',
    figure_version_id: VERSION_ID,
    suggestion_type: 'Unsupported marked x-label edit',
    current_state: 'The arrow points to one rendered Knockout bar.',
    recommended: 'A single rendered bar cannot be restyled independently.',
    param_patch: {},
    priority: 'medium',
    applied: false,
    unsupported: [{ mark_id: MARK_B_ID, request: 'Mark B: make this one bar blue', reason: 'Per-bar styling is not supported yet; use per-series styling.' }],
    edit_scope: {
      scope_id: 'mark:B', mark_id: MARK_B_ID, mark_label: 'B', mark_type: 'arrow',
      request: 'Make this one bar blue', status: 'unsupported', confidence: 0.94,
      resolved_target: { type: 'bar', label: 'Bar · Knockout · 24h', setting_path: null, element_id: 'mark:bar:Knockout:24h', role: 'bar', category: 'Knockout', series: '24h', editable: false, unsupported_reason: 'Per-bar styling is not supported yet; use per-series styling.' },
      allowed_patch_keys: [], reason: 'Per-bar styling is not supported yet; use per-series styling.',
    },
    created_at: '2026-08-18T00:01:01Z',
  },
  {
    id: '40000000-0000-4000-8000-000000000003',
    figure_version_id: VERSION_ID,
    suggestion_type: 'Marked y-label edit',
    current_state: 'The y-axis label is Expression.',
    recommended: 'Rename the y-axis label requested at Mark C.',
    param_patch: { options: { y_label: 'Normalized expression' } },
    priority: 'high',
    applied: false,
    unsupported: [{ request: 'Mark B: make this one bar blue', reason: 'Per-bar styling is not supported yet; use per-series styling.' }],
    edit_scope: {
      scope_id: 'mark:C', mark_id: MARK_C_ID, mark_label: 'C', mark_type: 'region',
      request: 'Rename the y-axis label to Normalized expression', status: 'supported', confidence: 0.88,
      resolved_target: { type: 'y_label', label: 'Y-axis label', setting_path: 'options.y_label', element_id: 'element:axis:y:label', editable: true },
      allowed_patch_keys: ['options.y_label'],
    },
    created_at: '2026-08-18T00:01:02Z',
  },
  {
    id: '40000000-0000-4000-8000-000000000004',
    figure_version_id: VERSION_ID,
    suggestion_type: 'Unrequested font edit',
    current_state: 'The font is sans.',
    recommended: 'Change the font even though no mark requested it.',
    param_patch: { options: { font_family: 'serif' } },
    priority: 'low',
    applied: false,
    requested: false,
    unrequested_changes: ['options.font_family'],
    edit_scope: {
      scope_id: 'unlinked', request: 'Change the font', status: 'blocked',
      allowed_patch_keys: [], reason: 'No submitted request scope authorizes this patch.',
    },
    created_at: '2026-08-18T00:01:03Z',
  },
  {
    id: '40000000-0000-4000-8000-000000000005',
    figure_version_id: VERSION_ID,
    suggestion_type: 'Series color',
    current_state: 'The 24h series uses its current palette color.',
    recommended: 'Use the approved blue override for the 24h series.',
    param_patch: { options: { category_colors: { '24h': '#2563EB' } } },
    priority: 'medium',
    applied: false,
    edit_scope: {
      scope_id: 'request', request: 'Set the 24h series to blue', status: 'supported',
      allowed_patch_keys: ['options.category_colors.24h'],
    },
    created_at: '2026-08-18T00:01:04Z',
  },
];

test('marked AI plan keeps A/B/C traceability and blocks unsupported or unrequested patches', async ({ page }) => {
  test.setTimeout(60_000);
  let improveBody: Record<string, unknown> | null = null;
  const improveBodies: Record<string, unknown>[] = [];
  let applyBody: Record<string, unknown> | null = null;
  let improveResponse = improvements;
  let holdNextImprove = false;
  let releaseImprove: (() => void) | null = null;

  await page.addInitScript(({ versionId, annotations }) => {
    window.localStorage.setItem('access_token', 'deterministic-access-token');
    window.localStorage.setItem('refresh_token', 'deterministic-refresh-token');
    window.localStorage.setItem(`labplot.ai-editor.annotations.${versionId}`, JSON.stringify(annotations));
  }, {
    versionId: VERSION_ID,
    annotations: [
      // A blank mark memo is valid when the global request supplies its intent.
      { id: MARK_A_ID, displayNumber: 1, type: 'region', x: 14, y: 2.5, w: 78, h: 9, text: '' },
      { id: MARK_B_ID, displayNumber: 2, type: 'arrow', x: 80, y: 70, x2: 50, y2: 50, text: 'Make this one bar blue' },
      // This broad region begins one rendered pixel outside the y-label box
      // while overlapping the whole y-axis band. Label tolerance and semantic
      // specificity must still resolve it to the editable y-axis label.
      { id: MARK_C_ID, displayNumber: 3, type: 'region', x: 8.1, y: 15, w: 6.9, h: 67, text: 'Rename the y-axis label to Normalized expression' },
    ],
  });

  await page.route('**/marked-edit-fixture.svg', (route) => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800"><rect width="1000" height="800" fill="white"/><text x="500" y="60">Before title</text></svg>',
  }));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/auth/me') {
      return route.fulfill({ json: {
        id: '50000000-0000-4000-8000-000000000001',
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
      improveBodies.push(improveBody!);
      if (holdNextImprove) {
        holdNextImprove = false;
        await new Promise<void>((resolve) => { releaseImprove = resolve; });
      }
      return route.fulfill({ json: improveResponse });
    }
    if (pathname === `/api/figures/${FIGURE_ID}/improvements/apply` && request.method() === 'POST') {
      applyBody = request.postDataJSON();
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Deterministic test stops before mutation.' }),
      });
    }
    if (pathname === '/api/plot-types') {
      return route.fulfill({ json: { plot_types: [{ type: 'scatter', label: 'Scatter', required: [], optional: [], options: [] }] } });
    }
    if (pathname === '/api/styles') return route.fulfill({ json: { styles: [{ key: 'publication', label: 'Publication' }] } });
    if (pathname === '/api/palettes') return route.fulfill({ json: { palettes: [] } });
    if (pathname === `/api/datasets/${figure.dataset_id}`) {
      return route.fulfill({ json: {
        id: figure.dataset_id,
        name: figure.dataset_name,
        original_filename: 'fixture.csv',
        format: 'csv',
        n_rows: 2,
        n_cols: 2,
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
  const previewImage = page.getByRole('img', { name: 'Figure for AI editing' });
  await expect.poll(async () => {
    const box = await previewImage.boundingBox();
    const natural = await previewImage.evaluate((image) => ({
      width: (image as HTMLImageElement).naturalWidth,
      height: (image as HTMLImageElement).naturalHeight,
    }));
    return box && natural.width && natural.height
      ? box.width / box.height - natural.width / natural.height
      : Number.POSITIVE_INFINITY;
  }).toBeCloseTo(0, 2);
  await page.getByRole('textbox', { name: 'Additional edit request (optional)' }).fill('Replace this text with After title');
  await page.getByRole('button', { name: 'Review change plan' }).click();

  await expect.poll(() => improveBody).not.toBeNull();
  expect(improveBody).toHaveProperty('original_request', EXACT_ORIGINAL_REQUEST);
  expect(improveBody).toMatchObject({
    marks: [
      { id: MARK_A_ID, label: 'A', display_number: 1, type: 'region', memo: '', bbox_normalized: { x: 0.14, y: 0.025, width: 0.78, height: 0.09 }, resolved_target: { type: 'title', setting_path: 'options.title', element_id: 'element:title', role: 'title' } },
      { id: MARK_B_ID, label: 'B', display_number: 2, type: 'arrow', point_normalized: { x: 0.5, y: 0.5 }, resolved_target: { type: 'bar', setting_path: null, element_id: 'mark:bar:Knockout:24h', role: 'bar', category: 'Knockout', series: '24h', editable: false } },
      { id: MARK_C_ID, label: 'C', display_number: 3, type: 'region', bbox_normalized: { x: 0.081, y: 0.15, width: 0.069, height: 0.67 }, resolved_target: { type: 'y_label', setting_path: 'options.y_label', element_id: 'element:axis:y:label' } },
    ],
  });

  const plan = page.getByRole('region', { name: 'AI interpretation and settings plan' });
  const markA = plan.getByRole('article', { name: 'Mark A · Region' });
  const markB = plan.getByRole('article', { name: 'Mark B · Arrow' });
  const markC = plan.getByRole('article', { name: 'Mark C · Region' });

  await expect(markA).toContainText('Supported');
  await expect(markA).toContainText('Confidence 97%');
  await expect(markA).toContainText('Resolved target: Title');
  await expect(markA).toContainText('options.title');
  const markATable = markA.getByRole('table', { name: 'Before and after values for Mark A' });
  await expect(markATable.getByRole('columnheader', { name: 'Before' })).toBeVisible();
  await expect(markATable.getByRole('columnheader', { name: 'After' })).toBeVisible();
  await expect(markATable.getByRole('row', { name: /Title.*Before title.*After title/ })).toBeVisible();

  await expect(markB).toContainText('Unsupported');
  await expect(markB).toContainText('Confidence 94%');
  await expect(markB).toContainText('Bar · Knockout · 24h');
  await expect(markB).toContainText('Per-bar styling is not supported yet; use per-series styling.');
  await expect(markB.getByRole('checkbox', { name: 'Select Mark B changes' })).toBeDisabled();

  await expect(markC).toContainText('Supported');
  await expect(markC).toContainText('Confidence 88%');
  await expect(markC).toContainText('Resolved target: Y-axis label');

  const requestCoverage = page.getByRole('region', { name: 'Request coverage' });
  await expect(requestCoverage.getByText('3 not applied', { exact: true })).toBeVisible();
  await expect(requestCoverage.getByRole('listitem').filter({ hasText: 'Apply this marked change — This scoped change was not applied.' })).toHaveCount(3);

  await markA.getByRole('checkbox', { name: 'Select Mark A changes' }).click();
  await page.getByRole('textbox', { name: 'Additional edit request (optional)' }).fill('Replace this text with After title and change nothing else');
  await expect(page.getByRole('status', { name: 'Change plan status' })).toContainText('Marks changed. Refresh plan.');
  await expect(plan).toBeHidden();
  await page.getByRole('textbox', { name: 'Instructions for Mark C' }).fill('Rename only this y-axis label to Normalized expression');
  await expect(page.getByRole('status', { name: 'Change plan status' })).toContainText('Marks changed. Refresh plan.');
  await expect(plan).toBeHidden();
  await expect(requestCoverage).toBeHidden();
  await expect(page.getByText('Submitted request', { exact: true })).toBeHidden();
  holdNextImprove = true;
  await page.getByRole('button', { name: 'Refresh change plan' }).click();
  await expect(plan).toBeHidden();
  await expect(page.getByRole('button', { name: 'Refresh change plan' })).toBeDisabled();
  await expect.poll(() => releaseImprove).not.toBeNull();
  releaseImprove!();
  await expect(plan).toBeVisible();
  await expect(markA.getByRole('checkbox', { name: 'Select Mark A changes' })).not.toBeChecked();

  improveResponse = improvements.map((improvement) => {
    if (improvement.id !== '40000000-0000-4000-8000-000000000001') return { ...improvement, unsupported: [] };
    return {
      ...improvement,
      current_state: 'The automatic hit favored the title in an overlapping text region.',
      recommended: 'Use the nearby subtitle target explicitly selected by the user.',
      param_patch: { options: { subtitle: 'After title' } },
      unsupported: [],
      edit_scope: {
        ...improvement.edit_scope as Record<string, unknown>,
        status: 'supported',
        reason: undefined,
        resolved_target: { type: 'subtitle', label: 'Subtitle', setting_path: 'options.subtitle', element_id: 'element:subtitle', role: 'subtitle', editable: true },
        requested_target_override: { type: 'subtitle', label: 'Subtitle', setting_path: 'options.subtitle', element_id: 'element:subtitle', role: 'subtitle' },
        accepted_target_override: { type: 'subtitle', label: 'Subtitle', setting_path: 'options.subtitle', element_id: 'element:subtitle', role: 'subtitle', editable: true },
        target_override_status: 'accepted',
        allowed_patch_keys: ['options.subtitle'],
      },
    };
  });
  const markATarget = page.getByRole('combobox', { name: 'Target for Mark A' });
  await expect(markATarget.getByRole('option')).toHaveText(['Auto-detect · Title', 'Title', 'Subtitle']);
  await expect(markATarget.getByRole('option', { name: 'X-axis label' })).toHaveCount(0);
  await expect(markATarget.getByRole('option', { name: 'Y-axis label' })).toHaveCount(0);
  await markATarget.selectOption({ label: 'Subtitle' });
  await expect(page.getByRole('status', { name: 'Change plan status' })).toContainText('Marks changed. Refresh plan.');
  await expect(plan).toBeHidden();
  await page.getByRole('button', { name: 'Refresh change plan' }).click();
  await expect(plan).toBeVisible();
  expect(improveBodies.at(-1)).toMatchObject({
    marks: [{
      id: MARK_A_ID,
      resolved_target: { type: 'title', setting_path: 'options.title', element_id: 'element:title' },
      target_override: { type: 'subtitle', setting_path: 'options.subtitle', element_id: 'element:subtitle' },
    }, {}, {}],
  });
  await expect(markA).toContainText('Supported');
  await expect(markA).toContainText('Resolved target: Subtitle');
  await expect(markA).toContainText('Requested target correction: Subtitle · Accepted');
  await expect(markA.getByRole('checkbox', { name: 'Select Mark A changes' })).toBeEnabled();

  improveResponse = improvements;
  await page.getByRole('button', { name: 'Select Mark B arrow' }).click();
  await page.keyboard.press('Delete');
  await expect(page.getByRole('status', { name: 'Change plan status' })).toContainText('Marks changed. Refresh plan.');
  await expect(plan).toBeHidden();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'AI editor (v1)' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Additional edit request (optional)' }).fill('Replace this text with After title');
  await page.getByRole('button', { name: 'Review change plan' }).click();
  await expect(plan).toBeVisible();

  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Change plan status' })).toContainText('Marks changed. Refresh plan.');
  await expect(plan).toBeHidden();
  await expect(requestCoverage).toBeHidden();

  // Reloading re-seeds the deterministic marks through addInitScript so the
  // original apply-selection safety assertions can continue independently.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'AI editor (v1)' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Additional edit request (optional)' }).fill('Replace this text with After title');
  await page.getByRole('button', { name: 'Review change plan' }).click();
  await expect(plan).toBeVisible();

  const nestedGeneral = plan.getByRole('article', { name: 'Series color' });
  await expect(nestedGeneral.getByRole('checkbox', { name: 'Select general request change: Series color' })).toBeEnabled();

  const unrequested = plan.getByRole('region', { name: 'Unrequested changes' });
  await expect(unrequested).toContainText('Blocked for safety');
  await expect(unrequested).toContainText('Font Family');
  await expect(unrequested).toContainText('Injected Script');
  await expect(unrequested.getByRole('checkbox')).toHaveCount(0);

  // A subsequent server plan with no unlinked or validation-dropped patch has
  // an explicit empty safety review rather than hiding the category.
  improveResponse = improvements.slice(0, 3).map((improvement) => ({ ...improvement, skipped: [] }));
  await page.getByRole('button', { name: 'Refresh change plan' }).click();
  await expect(unrequested).toContainText('None');
  await expect(unrequested).not.toContainText('Blocked for safety');

  await markA.getByRole('checkbox', { name: 'Select Mark A changes' }).click();
  await markC.getByRole('checkbox', { name: 'Select Mark C changes' }).click();
  await plan.getByRole('button', { name: 'Apply selected (2)' }).click();
  await expect.poll(() => applyBody).not.toBeNull();
  expect(applyBody).toMatchObject({
    improvement_ids: [
      '40000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000003',
    ],
  });

});

test('drawing around the visible vertical y-axis label keeps image-relative coordinates', async ({ page }) => {
  let improveBody: Record<string, unknown> | null = null;
  const sourceVersion = figure.versions[0];
  const verticalLabelFigure = {
    ...figure,
    versions: [{
      ...sourceVersion,
      layout: {
        ...sourceVersion.layout,
        scene_elements: sourceVersion.layout.scene_elements.map((element) => (
          element.role === 'bar'
            ? {
              ...element,
              id: 'mark:grouped_bar:category=Control&series=0',
              bbox_px: { x0: 180, y0: 300, x1: 260, y1: 650 },
              category: 'Control',
              series: '0',
            }
            : element
        )),
      },
    }],
  };

  await page.addInitScript(() => {
    window.localStorage.setItem('access_token', 'deterministic-access-token');
    window.localStorage.setItem('refresh_token', 'deterministic-refresh-token');
  });
  await page.route('**/marked-edit-fixture.svg', (route) => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: [
      '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800">',
      '<rect width="1000" height="800" fill="white"/>',
      '<text x="50" y="400" text-anchor="middle" transform="rotate(-90 50 400)">Expression</text>',
      '<rect x="180" y="300" width="80" height="350" fill="#dc2626"/>',
      '</svg>',
    ].join(''),
  }));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/auth/me') {
      return route.fulfill({ json: {
        id: '50000000-0000-4000-8000-000000000001',
        email: 'qa@example.test',
        display_name: 'QA',
        is_active: true,
        is_approved: true,
        is_admin: false,
        created_at: '2026-08-18T00:00:00Z',
      } });
    }
    if (pathname === `/api/figures/${FIGURE_ID}` && request.method() === 'GET') {
      return route.fulfill({ json: verticalLabelFigure });
    }
    if (pathname === `/api/figures/${FIGURE_ID}/versions/${VERSION_ID}/improve` && request.method() === 'POST') {
      improveBody = request.postDataJSON();
      return route.fulfill({ json: [] });
    }
    if (pathname === '/api/plot-types') {
      return route.fulfill({ json: { plot_types: [{ type: 'scatter', label: 'Scatter', required: [], optional: [], options: [] }] } });
    }
    if (pathname === '/api/styles') return route.fulfill({ json: { styles: [{ key: 'publication', label: 'Publication' }] } });
    if (pathname === '/api/palettes') return route.fulfill({ json: { palettes: [] } });
    if (pathname === `/api/datasets/${figure.dataset_id}`) {
      return route.fulfill({ json: {
        id: figure.dataset_id,
        name: figure.dataset_name,
        original_filename: 'fixture.csv',
        format: 'csv',
        n_rows: 2,
        n_cols: 2,
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
  const previewImage = page.getByRole('img', { name: 'Figure for AI editing' });
  await previewImage.scrollIntoViewIfNeeded();
  await expect.poll(() => previewImage.evaluate((image) => (
    (image as HTMLImageElement).naturalWidth
  ))).toBe(1000);
  const imageBox = await previewImage.boundingBox();
  const natural = await previewImage.evaluate((image) => ({
    width: (image as HTMLImageElement).naturalWidth,
    height: (image as HTMLImageElement).naturalHeight,
  }));
  expect(imageBox).not.toBeNull();
  expect(natural).toEqual({ width: 1000, height: 800 });
  const scale = Math.min(imageBox!.width / natural.width, imageBox!.height / natural.height);
  const contentLeft = imageBox!.x + (imageBox!.width - natural.width * scale) / 2;
  const contentTop = imageBox!.y + (imageBox!.height - natural.height * scale) / 2;

  await page.getByRole('button', { name: 'Region', exact: true }).click();
  await page.mouse.move(contentLeft + 12 * scale, contentTop + 160 * scale);
  await page.mouse.down();
  await page.mouse.move(contentLeft + 88 * scale, contentTop + 640 * scale);
  await page.mouse.up();

  const targetSelect = page.getByRole('combobox', { name: 'Target for Mark A' });
  await expect(targetSelect.getByRole('option').first()).toHaveText('Auto-detect · Y-axis label');
  await page.getByRole('textbox', { name: 'Instructions for Mark A' }).fill('Change only this text to Normalized expression');
  await page.getByRole('button', { name: 'Review change plan' }).click();
  await expect.poll(() => improveBody).not.toBeNull();
  expect(improveBody).toMatchObject({
    marks: [{
      label: 'A',
      type: 'region',
      resolved_target: {
        type: 'y_label',
        role: 'y_label',
        setting_path: 'options.y_label',
        element_id: 'element:axis:y:label',
      },
    }],
  });
  const mark = (improveBody!.marks as Array<Record<string, unknown>>)[0];
  const bbox = mark.bbox_normalized as { x: number; y: number; width: number; height: number };
  expect(bbox.x).toBeCloseTo(0.012, 2);
  expect(bbox.width).toBeCloseTo(0.076, 2);
  expect(bbox.y).toBeCloseTo(0.2, 2);
  expect(bbox.height).toBeCloseTo(0.6, 2);
});

test('successful AI receipt and Undo survive a new draft, plan review, and a late stale response', async ({ page }) => {
  const sourceVersion = figure.versions[0];
  const appliedVersion = {
    ...sourceVersion,
    id: APPLIED_VERSION_ID,
    version_number: 2,
    options: { ...sourceVersion.options, title: 'Applied receipt title' },
    created_at: '2026-08-18T00:10:00Z',
  };
  let servedFigure = figure;
  let holdNextImprove = false;
  let releaseImprove: (() => void) | null = null;
  let improveCallCount = 0;

  const sourcePlan = [{
    id: '41000000-0000-4000-8000-000000000001',
    figure_version_id: VERSION_ID,
    suggestion_type: 'Marked title edit',
    current_state: 'The title is Before title.',
    recommended: 'Set the marked title to Applied receipt title.',
    param_patch: { options: { title: 'Applied receipt title' } },
    priority: 'high',
    applied: false,
    unsupported: [{
      mark_id: MARK_A_ID,
      request: 'Old request detail',
      reason: 'Old unsupported detail that belongs only to the applied request.',
    }],
    edit_scope: {
      scope_id: 'mark:A', mark_id: MARK_A_ID, mark_label: 'A', mark_type: 'region',
      request: 'Replace this text with Applied receipt title', status: 'supported', confidence: 0.99,
      resolved_target: { type: 'title', label: 'Title', setting_path: 'options.title', element_id: 'element:title', role: 'title', editable: true },
      allowed_patch_keys: ['options.title'],
    },
    created_at: '2026-08-18T00:09:00Z',
  }];
  const nextPlan = [{
    ...sourcePlan[0],
    id: '41000000-0000-4000-8000-000000000002',
    figure_version_id: APPLIED_VERSION_ID,
    recommended: 'Set the marked title to Next draft title.',
    param_patch: { options: { title: 'Next draft title' } },
    unsupported: [],
    edit_scope: {
      ...sourcePlan[0].edit_scope,
      request: 'Replace this text with Next draft title',
    },
    created_at: '2026-08-18T00:11:00Z',
  }];
  let improveResponse = sourcePlan;

  const annotations = [
    { id: MARK_A_ID, displayNumber: 1, type: 'region', x: 14, y: 2.5, w: 78, h: 9, text: '' },
  ];
  await page.addInitScript(({ sourceId, appliedId, storedAnnotations }) => {
    window.localStorage.setItem('access_token', 'deterministic-access-token');
    window.localStorage.setItem('refresh_token', 'deterministic-refresh-token');
    window.localStorage.setItem(`labplot.ai-editor.annotations.${sourceId}`, JSON.stringify(storedAnnotations));
    window.localStorage.setItem(`labplot.ai-editor.annotations.${appliedId}`, JSON.stringify(storedAnnotations));
  }, { sourceId: VERSION_ID, appliedId: APPLIED_VERSION_ID, storedAnnotations: annotations });

  await page.route('**/marked-edit-fixture.svg', (route) => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800"><rect width="1000" height="800" fill="white"/><text x="500" y="60">Receipt fixture</text></svg>',
  }));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/auth/me') {
      return route.fulfill({ json: {
        id: '50000000-0000-4000-8000-000000000001', email: 'qa@example.test', display_name: 'QA',
        is_active: true, is_approved: true, is_admin: false, created_at: '2026-08-18T00:00:00Z',
      } });
    }
    if (pathname === `/api/figures/${FIGURE_ID}` && request.method() === 'GET') {
      return route.fulfill({ json: servedFigure });
    }
    if (pathname.endsWith('/improve') && request.method() === 'POST') {
      improveCallCount += 1;
      if (holdNextImprove) {
        holdNextImprove = false;
        await new Promise<void>((resolve) => { releaseImprove = resolve; });
      }
      return route.fulfill({ json: improveResponse });
    }
    if (pathname === `/api/figures/${FIGURE_ID}/improvements/apply` && request.method() === 'POST') {
      servedFigure = {
        ...figure,
        current_version_id: APPLIED_VERSION_ID,
        versions: [...figure.versions, appliedVersion],
      };
      return route.fulfill({ json: {
        version: appliedVersion,
        applied_changes: [{ key: 'options.title', from: 'Before title', to: 'Applied receipt title' }],
        dropped_keys: ['options.old_dropped'],
        verification: { attempts: 1, satisfied: true, feedback: 'Applied receipt verification passed.' },
      } });
    }
    if (pathname === `/api/figures/${FIGURE_ID}/versions/${VERSION_ID}` && request.method() === 'DELETE') {
      servedFigure = {
        ...servedFigure,
        current_version_id: APPLIED_VERSION_ID,
        versions: [appliedVersion],
      };
      return route.fulfill({ json: servedFigure });
    }
    if (pathname === '/api/plot-types') {
      return route.fulfill({ json: { plot_types: [{ type: 'scatter', label: 'Scatter', required: [], optional: [], options: [] }] } });
    }
    if (pathname === '/api/styles') return route.fulfill({ json: { styles: [{ key: 'publication', label: 'Publication' }] } });
    if (pathname === '/api/palettes') return route.fulfill({ json: { palettes: [] } });
    if (pathname === `/api/datasets/${figure.dataset_id}`) {
      return route.fulfill({ json: {
        id: figure.dataset_id, name: figure.dataset_name, original_filename: 'fixture.csv', format: 'csv',
        n_rows: 2, n_cols: 2, created_at: '2026-08-18T00:00:00Z', column_profile: [], preview: [],
      } });
    }
    if (pathname === '/api/projects/invitations' || pathname.endsWith('/comments')) return route.fulfill({ json: [] });
    if (request.method() === 'GET') return route.fulfill({ json: [] });
    return route.fulfill({ status: 204 });
  });

  await page.goto(`/figures/${FIGURE_ID}`);
  await expect(page.getByRole('heading', { name: 'AI editor (v1)' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Additional edit request (optional)' }).fill('Replace this text with Applied receipt title');
  await page.getByRole('button', { name: 'Review change plan' }).click();
  const sourcePlanRegion = page.getByRole('region', { name: 'AI interpretation and settings plan' });
  await sourcePlanRegion.getByRole('checkbox', { name: 'Select Mark A changes' }).click();
  await sourcePlanRegion.getByRole('button', { name: 'Apply selected (1)' }).click();

  await expect(page.getByRole('heading', { name: 'AI editor (v2)' })).toBeVisible();
  const receipt = page.getByRole('region', { name: 'AI edit result · v2' });
  await expect(receipt.getByRole('table', { name: 'Settings changed by the most recent AI edit' })).toContainText('Applied receipt title');
  await expect(receipt).toContainText('Applied receipt verification passed.');
  await expect(receipt).toContainText('Old unsupported detail that belongs only to the applied request.');
  await expect(receipt).toContainText('Old Dropped');
  await expect(page.getByRole('button', { name: 'Undo AI edit' })).toBeVisible();

  await page.getByRole('textbox', { name: 'Additional edit request (optional)' }).fill('Replace this text with Next draft title');
  await expect(receipt).toBeVisible();
  await expect(receipt).toContainText('Applied receipt verification passed.');
  await expect(receipt).not.toContainText('Old unsupported detail that belongs only to the applied request.');
  await expect(receipt).not.toContainText('Old Dropped');
  await expect(page.getByRole('button', { name: 'Undo AI edit' })).toBeVisible();

  improveResponse = nextPlan;
  await page.getByRole('button', { name: 'Review change plan' }).click();
  const nextPlanRegion = page.getByRole('region', { name: 'AI interpretation and settings plan' });
  await expect(nextPlanRegion).toBeVisible();
  await expect(receipt).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo AI edit' })).toBeVisible();

  releaseImprove = null;
  holdNextImprove = true;
  const callsBeforeRace = improveCallCount;
  await page.getByRole('button', { name: 'Refresh change plan' }).click();
  await expect.poll(() => improveCallCount).toBe(callsBeforeRace + 1);
  await expect.poll(() => releaseImprove).not.toBeNull();
  await page.getByRole('textbox', { name: 'Instructions for Mark A' }).fill('Replace only this text with a late draft title');
  await expect(nextPlanRegion).toBeHidden();
  await expect(page.getByRole('status', { name: 'Change plan status' })).toContainText('Marks changed. Refresh plan.');
  releaseImprove!();
  // The enabled button proves the held response actually settled; its late
  // payload must still not revive the plan invalidated by the memo edit.
  await expect(page.getByRole('button', { name: 'Refresh change plan' })).toBeEnabled();
  await expect(nextPlanRegion).toBeHidden();
  await expect(receipt).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo AI edit' })).toBeVisible();

  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(nextPlanRegion).toBeHidden();
  await expect(receipt).toBeVisible();
  await expect(receipt).toContainText('Applied receipt verification passed.');
  await expect(page.getByRole('button', { name: 'Undo AI edit' })).toBeVisible();

  // A plan response is version-scoped as well as draft-scoped. Hold a v2
  // request, switch to v1, then release it: the late v2 payload must not be
  // installed into the newly mounted v1 editor even though no memo changes.
  releaseImprove = null;
  holdNextImprove = true;
  const callsBeforeVersionSwitch = improveCallCount;
  await page.getByRole('button', { name: 'Refresh change plan' }).click();
  await expect.poll(() => improveCallCount).toBe(callsBeforeVersionSwitch + 1);
  await expect.poll(() => releaseImprove).not.toBeNull();
  await page.getByRole('button', { name: /^v1 ·/ }).click();
  await expect(page.getByRole('heading', { name: 'AI editor (v1)' })).toBeVisible();
  releaseImprove!();
  await expect(page.getByRole('button', { name: 'Review change plan' })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'AI interpretation and settings plan' })).toBeHidden();
  await expect(page.getByRole('region', { name: 'Request coverage' })).toBeHidden();
  await expect(page.getByRole('button', { name: /Apply selected/ })).toHaveCount(0);

  // Deleting the version that owns a held request is another version
  // transition. Its callback must invalidate the request synchronously,
  // before React's next render updates the selected-version ref.
  releaseImprove = null;
  holdNextImprove = true;
  const callsBeforeDelete = improveCallCount;
  await page.getByRole('button', { name: 'Review change plan' }).click();
  await expect.poll(() => improveCallCount).toBe(callsBeforeDelete + 1);
  await expect.poll(() => releaseImprove).not.toBeNull();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTitle('Delete v1').click();
  await expect(page.getByRole('heading', { name: 'AI editor (v2)' })).toBeVisible();
  releaseImprove!();
  await expect(page.getByRole('button', { name: 'Review change plan' })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'AI interpretation and settings plan' })).toBeHidden();
  await expect(page.getByRole('region', { name: 'Request coverage' })).toBeHidden();
  await expect(page.getByRole('button', { name: /Apply selected/ })).toHaveCount(0);
});
