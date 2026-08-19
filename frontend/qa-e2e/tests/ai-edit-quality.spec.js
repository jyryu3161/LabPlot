const { test, expect } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  ENV,
  apiLogin,
  authedPage,
  cleanupAndVerifySourceFigure,
  figureVersionState,
} = require('../helpers');

// U10: AI edit quality — schema auto-gen from renderer metadata (U10a),
// transparency chips for unsupported/dropped changes (U10b), and a self-verify
// + single-retry loop on apply (U10c). See AiFigureEditor.tsx, figures/schemas.py
// (ImprovementApplyResponse/AppliedChangeItem/VerificationResult) and
// ai/options_schema.py (build_options_patch_schema) for the implementation.
//
// DETERMINISTIC ONLY. Everything U10 does that depends on what a live model
// actually says — which suggestions /improve returns, what it reports as
// `unsupported`, whether verify_edit judges a render "satisfied" — is
// deliberately OUT of scope here: asserting on model output would make this
// suite flaky on provider/prompt drift, and the active provider is a
// quota-limited Gemini free tier, so a live call can fail for reasons that
// have nothing to do with the code under test. This file only covers the
// parts that are deterministic given the CODE:
//
//   1) (U10a) The AI options-patch JSON schema is generated from the real
//      renderer metadata (figures/option_metadata.py + r_engine/templates.py),
//      not a hand-maintained list, so newly-supported option keys are
//      reachable by the AI without a second edit to keep a list in sync.
//      There is no HTTP endpoint exposing this schema (it's only consumed
//      server-side when building the AI request), and the only end-to-end way
//      to exercise it is a real /improve call, which hits live AI. Instead we
//      run the same import the implementer verified with (property count
//      60 -> 95), inside the backend's own container image, against the
//      CURRENT checked-out source — a deterministic backend-source assertion,
//      not a live-model one. Skips cleanly if docker isn't reachable.
//   2) (U10b/U10c) The apply endpoints' applied_changes/dropped_keys/
//      verification fields are only reachable via an Improvement id, which is
//      only minted by /improve (AI) — so there is no way to hit them without
//      a live AI call. Rather than fake or skip that entirely, we do a UI-only
//      smoke check of the one piece of U10c wiring that has NO AI dependency:
//      the "Verify result (AI)" toggle defaults on (loadVerifyPreference) and
//      its preference persists across a reload via localStorage. This proves
//      the `verify` flag the apply mutations send is wired correctly without
//      ever calling /improve or /apply.
// Read the AI options-patch JSON schema keys from the CURRENT backend source,
// run inside the backend container image (reuses its pixi Python env). Returns
// null with a skip-reason when docker / the source / the container is
// unavailable, so callers skip cleanly rather than fail on infra.
function readOptionSchemaKeys() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const appDir = path.join(repoRoot, 'backend', 'app');
  if (!fs.existsSync(appDir)) return { keys: null, skip: `backend source not found at ${appDir}` };
  try { execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 }); }
  catch { return { keys: null, skip: 'docker not reachable from this test runner' }; }
  let image = null;
  try {
    image = execFileSync('docker', ['inspect', 'labplot-backend', '--format', '{{.Config.Image}}'],
      { encoding: 'utf8', timeout: 10_000 }).trim();
  } catch { image = null; }
  if (!image) return { keys: null, skip: 'labplot-backend container not found' };
  const script = [
    'from app.ai.options_schema import build_options_patch_schema',
    'import json',
    'print(json.dumps(sorted(build_options_patch_schema()["properties"].keys())))',
  ].join('\n');
  const out = execFileSync('docker', [
    'run', '--rm', '-i', '-v', `${appDir}:/app/backend/app:ro`, '-w', '/app/backend',
    image, '/app/.pixi/envs/default/bin/python', '-',
  ], { input: script, encoding: 'utf8', timeout: 30_000 });
  return { keys: JSON.parse(out.trim().split('\n').pop()), skip: null };
}

// U10 regression (plan2.md open item): the user's original pain was "AI 기반으로
// 그림 수정하려는데 잘 반영이 안되는 느낌" — edits that don't take. The ROOT cause
// of a silent no-op is a requested change whose option key is absent from the
// AI's patch vocabulary: the model then can't emit it and it's dropped without
// a trace. U10a autogenerates that vocabulary from renderer metadata; this test
// pins that the vocabulary actually COVERS the common natural-language edit
// intents users ask for, so a future metadata/template refactor that drops a
// key (reintroducing the silent-drop bug) fails here instead of in the field.
// Each row is a realistic request -> the supported option key(s) that express
// it (verified against r_engine/templates.py + option_metadata.py semantics).
const COMMON_EDIT_COVERAGE = [
  { ask: 'move the legend to the bottom', keys: ['legend_position'] },
  { ask: 'hide the legend', keys: ['hide_legend'] },
  { ask: 'give the legend a title / more columns / bigger keys', keys: ['legend_title', 'legend_ncol', 'legend_key_size'] },
  { ask: 'rotate the x-axis tick labels', keys: ['x_text_angle'] },
  { ask: 'put the y axis on a log scale', keys: ['log_y'] },
  { ask: 'log-scale the x axis', keys: ['log_x'] },
  { ask: 'add a plot title and subtitle', keys: ['title', 'subtitle'] },
  { ask: 'rename the x and y axis labels', keys: ['x_label', 'y_label'] },
  { ask: 'set the y-axis range/limits', keys: ['y_min', 'y_max'] },
  { ask: 'set the x-axis range/limits', keys: ['x_min', 'x_max'] },
  { ask: 'use a colorblind-safe palette', keys: ['palette_name'] },
  { ask: 'switch to grayscale', keys: ['color_mode'] },
  { ask: 'recolor specific categories', keys: ['category_colors'] },
  { ask: 'make the fonts larger', keys: ['base_size', 'font_scale'] },
  { ask: 'change the font family', keys: ['font_family'] },
  { ask: 'show data labels/values with a number format', keys: ['show_data_labels', 'show_values', 'data_label_format'] },
  { ask: 'flip the bars to horizontal', keys: ['flip_coords'] },
  { ask: 'add a trend/regression line with fit stats', keys: ['add_smooth', 'fit_model', 'show_fit_stats'] },
  { ask: 'add a horizontal/vertical reference line', keys: ['hline_at', 'vline_at'] },
  { ask: 'facet/panel by a column', keys: ['facet_by', 'facet_scales'] },
  { ask: 'sort the bars descending', keys: ['sort_desc'] },
  { ask: 'change the point shape and size', keys: ['point_shape', 'size'] },
  { ask: 'set the bar width and make bars semi-transparent', keys: ['bar_width', 'bar_alpha'] },
  { ask: 'add error bars (SE/CI/SD)', keys: ['error_bars', 'error_type'] },
  { ask: 'change the number of histogram bins', keys: ['bins'] },
  { ask: 'reverse the x/y axis direction', keys: ['reverse_x', 'reverse_y'] },
  { ask: 'format x ticks as percent/comma/scientific', keys: ['x_tick_format'] },
  { ask: 'treat the x axis as dates', keys: ['x_axis_type', 'date_format'] },
  { ask: 'export at 600 DPI / a specific size', keys: ['dpi', 'size', 'width_in', 'height_in'] },
  { ask: 'stack vs fill the bars', keys: ['stack_mode'] },
  { ask: 'connect the points with a line', keys: ['connect_points'] },
  { ask: 'reorder the categories', keys: ['level_order'] },
  { ask: 'add a second y-axis series', keys: ['y2_column', 'y2_label'] },
];

test.describe('AI edit quality (U10)', () => {
  // The review-workflow test uses QA_FIG read-only and mocks every write.
  // This guard proves no rerender/apply escaped those routes, even on failure.
  let sourceGuard = null;
  test.beforeEach(() => { sourceGuard = null; });
  test.afterEach(async ({ request }) => {
    if (!sourceGuard) return;
    await cleanupAndVerifySourceFigure(
      request,
      sourceGuard.auth,
      [],
      sourceGuard.figureId,
      sourceGuard.state,
    );
  });

  test('U10 regression: the AI patch vocabulary covers common figure-edit intents (no silent-drop)', () => {
    const { keys, skip } = readOptionSchemaKeys();
    test.skip(!keys, skip || 'schema unavailable');
    const present = new Set(keys);
    const missing = [];
    for (const row of COMMON_EDIT_COVERAGE) {
      for (const key of row.keys) {
        if (!present.has(key)) missing.push(`"${row.ask}" needs option "${key}"`);
      }
    }
    // Every common edit intent must be expressible by at least the option key(s)
    // that render it — a missing key is exactly the silent no-op U10 exists to
    // prevent. The message lists every gap so a coverage regression is obvious.
    expect(missing, `AI patch vocabulary lost coverage for:\n  ${missing.join('\n  ')}`).toEqual([]);
    // Sanity: the map really is checking a broad surface, not a token few.
    expect(COMMON_EDIT_COVERAGE.length).toBeGreaterThanOrEqual(25);
  });

  test('U10a: options patch schema is generated from real renderer metadata (not hand-maintained)', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const appDir = path.join(repoRoot, 'backend', 'app');
    test.skip(!fs.existsSync(appDir), `backend source not found at ${appDir} — this checkout has no backend/ next to frontend/`);

    let dockerOk = true;
    try {
      execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 });
    } catch {
      dockerOk = false;
    }
    test.skip(!dockerOk, 'docker not reachable from this test runner');

    let image = null;
    try {
      image = execFileSync(
        'docker',
        ['inspect', 'labplot-backend', '--format', '{{.Config.Image}}'],
        { encoding: 'utf8', timeout: 10_000 },
      ).trim();
    } catch {
      image = null;
    }
    test.skip(!image, 'labplot-backend container not found — nothing to reuse the pixi Python env from');

    // Same call the implementer used to verify the property count (60 -> 95).
    // Mount the CURRENT source over the image's baked-in copy, read-only, so
    // this checks the working tree, not whatever was last deployed. Piped via
    // stdin (`python -`) rather than `-c` (argv/shell quoting) or a mounted
    // script file (that sets sys.path[0] to the script's dir, not cwd, so the
    // `app` package wouldn't resolve).
    const script = [
      'from app.ai.options_schema import build_options_patch_schema',
      'import json',
      's = build_options_patch_schema()',
      'props = s["properties"]',
      'print(json.dumps({"count": len(props), "keys": sorted(props.keys())}))',
    ].join('\n');

    let out;
    try {
      out = execFileSync('docker', [
        'run', '--rm', '-i',
        '-v', `${appDir}:/app/backend/app:ro`,
        '-w', '/app/backend',
        image,
        '/app/.pixi/envs/default/bin/python', '-',
      ], { input: script, encoding: 'utf8', timeout: 30_000 });
    } catch (e) {
      throw new Error(`docker run import smoke failed: ${e.stderr || e.message || e}`);
    }

    const lastLine = out.trim().split('\n').pop();
    const result = JSON.parse(lastLine);
    expect(result.count).toBeGreaterThanOrEqual(60);
    for (const key of ['base_size', 'x_breaks', 'x_tick_format', 'reverse_x', 'show_data_labels']) {
      expect(result.keys).toContain(key);
    }
  });

  test('U10c: "Verify result (AI)" toggle defaults on and persists across reload', async ({ page, request }) => {
    test.skip(!ENV.FIG, 'set QA_FIG to a figure id');
    const tokens = await apiLogin(request);
    await authedPage(page, tokens);
    await page.goto(`/figures/${ENV.FIG}`, { waitUntil: 'networkidle' });

    // The Switch's accessible name is computed from its associated <Label>
    // (htmlFor) text, which wins over the element's aria-label here.
    const verifyName = /Verify result \(AI\)/;
    const verifyToggle = page.getByRole('switch', { name: verifyName });
    await expect(verifyToggle).toBeVisible({ timeout: 20000 });
    // Default ON when no stored preference exists yet (AiFigureEditor's
    // loadVerifyPreference: raw === null ? true : raw === '1').
    await expect(verifyToggle).toBeChecked();

    await verifyToggle.click();
    await expect(verifyToggle).not.toBeChecked();
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem('labplot.ai-editor.verify-enabled')))
      .toBe('0');

    await page.reload({ waitUntil: 'networkidle' });
    const verifyToggleAfterReload = page.getByRole('switch', { name: verifyName });
    await expect(verifyToggleAfterReload).toBeVisible({ timeout: 20000 });
    await expect(verifyToggleAfterReload).not.toBeChecked();
  });

  test('AI editor exposes a review-first, keyboard-accessible settings workflow', async ({ page, request }) => {
    test.skip(!ENV.FIG, 'set QA_FIG to a figure id');
    const tokens = await apiLogin(request);
    const auth = { Authorization: `Bearer ${tokens.access_token}` };
    const figureResponse = await request.get(`${ENV.BASE}/api/figures/${ENV.FIG}`, {
      headers: auth,
    });
    expect(figureResponse.ok()).toBeTruthy();
    const sourceFigure = await figureResponse.json();
    const sourceVersion = sourceFigure.versions.find((item) => item.id === sourceFigure.current_version_id)
      || sourceFigure.versions[sourceFigure.versions.length - 1];
    expect(sourceVersion?.id).toBeTruthy();
    const sourceState = figureVersionState(sourceFigure);
    sourceGuard = { auth, figureId: ENV.FIG, state: sourceState };
    await authedPage(page, tokens);
    await page.goto(`/figures/${ENV.FIG}`, { waitUntil: 'networkidle' });

    const editorHeading = page.getByRole('heading', { name: /AI editor/ });
    await expect(editorHeading).toBeVisible({ timeout: 20_000 });
    const editor = editorHeading.locator('xpath=ancestor::*[@data-slot="card"][1]');

    let livePreviewBody = null;
    await page.route('**/api/figures/*/rerender', async (route) => {
      livePreviewBody = route.request().postDataJSON();
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Version conflict', error_code: 'VERSION_CONFLICT' }),
      });
    });
    const livePreviewToggle = page.getByRole('switch', { name: /Live preview|Auto re-render/ });
    await livePreviewToggle.click();
    const manualTitle = page.getByLabel('In-plot title (usually blank)');
    await manualTitle.fill('Unsaved conflict-safe draft');
    await expect.poll(() => livePreviewBody, { timeout: 10_000 }).not.toBeNull();
    expect(livePreviewBody.base_version_id).toBe(sourceVersion.id);
    await expect(manualTitle).toHaveValue('Unsaved conflict-safe draft');
    await expect(page.getByText(/Live preview was not applied because this figure changed elsewhere/)).toBeVisible();
    await livePreviewToggle.click();

    const workflow = editor.getByRole('region', { name: 'AI editing workflow' });
    await expect(workflow).toContainText('Review the change plan before applying');
    await expect(workflow).toContainText('settings-only plan, not a rendered image preview');
    await expect(workflow.getByRole('button', { name: 'Review change plan' })).toBeEnabled();
    await expect(workflow.getByRole('button', { name: 'Apply now (skip plan)' })).toBeDisabled();

    const prompt = editor.getByRole('textbox', { name: 'Edit request' });
    await prompt.fill('Change the title and make Knockout blue; add a secondary legend.');
    await expect(workflow.getByRole('button', { name: 'Apply now (skip plan)' })).toBeEnabled();

    // Mock only the model-dependent planning response. This exercises the
    // production component state without spending quota or making assertions
    // about a nondeterministic provider response.
    await page.route('**/api/figures/*/versions/*/improve', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: '11111111-1111-4111-8111-111111111111',
          figure_version_id: sourceVersion.id,
          suggestion_type: 'Labels and color',
          current_state: 'The current title and Knockout color do not match the request.',
          recommended: 'Update the title and use blue for the Knockout category.',
          param_patch: { options: { title: 'Requested title', category_colors: { Knockout: '#2563EB' } } },
          priority: 'high',
          applied: false,
          skipped: ['options.secondary_legend'],
          unsupported: [{ request: 'add a secondary legend', reason: 'Only one legend is supported.' }],
          created_at: '2026-08-17T00:00:00Z',
        }]),
      });
    });
    await workflow.getByRole('button', { name: 'Review change plan' }).click();

    const changePlan = editor.getByRole('region', { name: 'AI interpretation and settings plan' });
    await expect(changePlan).toContainText('Submitted request');
    await expect(changePlan).toContainText('Change the title and make Knockout blue; add a secondary legend.');
    await expect(changePlan).toContainText('Current assessment');
    await expect(changePlan).toContainText('Proposed change');
    await expect(changePlan).toContainText('Category Colors');
    await expect(changePlan).toContainText('{"Knockout":"#2563EB"}');
    await expect(changePlan).toContainText('1 applicable');
    await expect(changePlan).toContainText('1 unsupported');
    await expect(changePlan).toContainText('1 excluded by validation');
    await expect(editor.getByRole('heading', { name: 'Request coverage' })).toBeVisible();
    await expect(editor).toContainText('Only one legend is supported.');
    const settingsTable = changePlan.getByRole('table', { name: 'Current and proposed setting values for Labels and color' });
    await expect(settingsTable.getByRole('columnheader', { name: 'Before' })).toBeVisible();
    await expect(settingsTable.getByRole('columnheader', { name: 'Proposed value' })).toBeVisible();
    const titleRow = settingsTable.getByRole('row', { name: /Title.*Requested title/ });
    await expect(titleRow.getByRole('cell')).toHaveCount(2);
    await expect(titleRow.getByRole('cell').last()).toHaveText('Requested title');
    await expect(workflow).toContainText('Apply now may retry once; reviewed-plan applies report a mismatch');

    const proposedChange = changePlan.getByRole('checkbox', { name: 'Select proposed change: Labels and color' });
    await proposedChange.click();
    await expect(changePlan.getByRole('button', { name: 'Apply selected (1)' })).toBeEnabled();

    const markingTools = editor.getByRole('toolbar', { name: 'Figure marking tools' });
    const selectTool = markingTools.getByRole('button', { name: 'Select', exact: true });
    const regionTool = markingTools.getByRole('button', { name: 'Region', exact: true });
    await expect(selectTool).toHaveAttribute('aria-pressed', 'true');
    await regionTool.focus();
    await page.keyboard.press('Enter');
    await expect(regionTool).toHaveAttribute('aria-pressed', 'true');
    await expect(selectTool).toHaveAttribute('aria-pressed', 'false');

    // Scan the complete AI editor card after exercising its pressed state. The
    // keyboard assertion above covers operability that axe cannot detect.
    await page.addScriptTag({ path: require.resolve('axe-core') });
    const accessibilityViolations = await editor.evaluate(async (root) => {
      // eslint-disable-next-line no-undef
      const result = await window.axe.run(root, { runOnly: ['wcag2a', 'wcag2aa'] });
      return result.violations
        .map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          nodes: violation.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
        }));
    });
    expect(accessibilityViolations).toEqual([]);

    // Apply the reviewed plan against mocked HTTP responses so we can assert
    // provenance/concurrency payloads and the one-click restore without a
    // model call, render quota, or production write.
    const appliedVersionId = '33333333-3333-4333-8333-333333333333';
    const restoredVersionId = '44444444-4444-4444-8444-444444444444';
    const appliedOptions = {
      ...(sourceVersion.options || {}),
      title: 'Requested title',
      category_colors: { Knockout: '#2563EB' },
    };
    const appliedVersion = {
      ...sourceVersion,
      id: appliedVersionId,
      version_number: sourceVersion.version_number + 1,
      options: appliedOptions,
      change_note: 'Applied checked AI suggestion',
      created_at: '2026-08-17T00:01:00Z',
    };
    let servedFigure = {
      ...sourceFigure,
      current_version_id: appliedVersionId,
      style_preset: appliedVersion.style_preset,
      versions: [...sourceFigure.versions, appliedVersion],
    };
    const exactFigureUrl = new RegExp(`/api/figures/${ENV.FIG}(?:\\?.*)?$`);
    await page.route(exactFigureUrl, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(servedFigure) });
    });

    let applyBody = null;
    await page.route('**/api/figures/*/improvements/apply', async (route) => {
      applyBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          version: appliedVersion,
          applied_changes: [
            { key: 'options.title', from: sourceVersion.options?.title ?? null, to: 'Requested title' },
            { key: 'options.category_colors', from: sourceVersion.options?.category_colors ?? null, to: { Knockout: '#2563EB' } },
          ],
          dropped_keys: [],
          verification: { attempts: 1, satisfied: true, feedback: 'Selected settings match the rendered result.' },
        }),
      });
    });
    await changePlan.getByRole('button', { name: 'Apply selected (1)' }).click();
    await expect.poll(() => applyBody).not.toBeNull();
    expect(applyBody).toMatchObject({
      improvement_ids: ['11111111-1111-4111-8111-111111111111'],
      verify: true,
      original_request: 'Change the title and make Knockout blue; add a secondary legend.',
      verification_request: 'Update the title and use blue for the Knockout category.',
      expected_base_version_id: sourceVersion.id,
      retry: false,
    });

    const undoButton = editor.getByRole('button', { name: 'Undo AI edit' });
    await expect(undoButton).toBeVisible();
    await expect(editor.getByRole('table', { name: 'Settings changed by the most recent AI edit' })).toContainText('Requested title');

    let undoBody = null;
    const restoredVersion = {
      ...sourceVersion,
      id: restoredVersionId,
      version_number: sourceVersion.version_number + 2,
      change_note: `Restored pre-AI settings from v${sourceVersion.version_number}`,
      created_at: '2026-08-17T00:02:00Z',
    };
    await page.route('**/api/figures/*/rerender', async (route) => {
      undoBody = route.request().postDataJSON();
      servedFigure = {
        ...sourceFigure,
        current_version_id: restoredVersionId,
        style_preset: restoredVersion.style_preset,
        versions: [...sourceFigure.versions, appliedVersion, restoredVersion],
      };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(restoredVersion) });
    });
    await undoButton.click();
    await expect.poll(() => undoBody).not.toBeNull();
    expect(undoBody).toMatchObject({
      mapping: sourceVersion.mapping,
      options: sourceVersion.options,
      style_preset: sourceVersion.style_preset,
      base_version_id: appliedVersionId,
    });
    await expect(editor.getByRole('button', { name: 'Undo AI edit' })).toHaveCount(0);

    // Evidence disclosure is also model-independent: mock a completed review
    // and prove the UI identifies every grounding input without data rows.
    await page.route('**/api/figures/*/versions/*/review', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: '55555555-5555-4555-8555-555555555555',
          figure_version_id: restoredVersionId,
          publication_score: 88,
          payload: {
            publication_score: 88,
            summary: 'Grounded review summary.',
            accessibility_checks: {
              schema_version: '1.0',
              palette: {
                status: 'evaluated',
                source: 'Muted publication',
                colors: ['#62B9C5', '#E4776B'],
                series_count: 2,
                reason: null,
              },
              cvd: {
                status: 'pass',
                method: 'deterministic_srgb_matrix_delta_e76_v1',
                threshold_delta_e: 10,
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
            evidence: {
              render: { version_id: restoredVersionId, version_number: restoredVersion.version_number, image_available: true },
              plot_type: sourceFigure.plot_type,
              style_preset: sourceVersion.style_preset,
              mapping: { group: 'Time_h', y: 'Expression' },
              options: { title: 'Original title' },
              last_ai_request: 'Make Knockout blue',
              dataset: {
                name: 'UX Audit dataset',
                column_count: 2,
                columns: [
                  { name: 'Time_h', role: 'time', dtype: 'integer' },
                  { name: 'Expression', role: 'value', dtype: 'float' },
                ],
                columns_truncated: false,
              },
            },
          },
          created_at: '2026-08-17T00:03:00Z',
        }),
      });
    });
    const reviewButton = page.getByRole('button', { name: 'Review this figure' });
    await reviewButton.click();
    const accessibilityChecks = page.getByRole('region', { name: 'Deterministic color accessibility checks' });
    await expect(accessibilityChecks).toBeVisible();
    await expect(accessibilityChecks).toContainText('these results are not an AI opinion');
    await expect(accessibilityChecks).toContainText('protanopia');
    await expect(accessibilityChecks).toContainText('ΔE 18.4');
    await expect(accessibilityChecks).toContainText('Minimum ΔL 12.3');
    await expect(accessibilityChecks).toContainText('Minimum ratio 3.6:1');
    await expect(accessibilityChecks).toContainText('Muted publication · 2 series');
    const evidenceDetails = page.locator('details').filter({ hasText: 'Evidence used for this review' });
    await expect(evidenceDetails).toBeVisible();
    await evidenceDetails.locator('summary').click();
    await expect(evidenceDetails).toContainText(`Render v${restoredVersion.version_number}`);
    await expect(evidenceDetails).toContainText('Make Knockout blue');
    await expect(evidenceDetails).toContainText('Time_h');
    await expect(evidenceDetails).toContainText('time');
    await expect(evidenceDetails).toContainText('integer');
    await expect(evidenceDetails).toContainText('No dataset rows or sample values are included.');
    const evidenceAccessibilityViolations = await evidenceDetails.evaluate(async (root) => {
      // eslint-disable-next-line no-undef
      const result = await window.axe.run(root, { runOnly: ['wcag2a', 'wcag2aa'] });
      return result.violations
        .map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          nodes: violation.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
        }));
    });
    expect(evidenceAccessibilityViolations).toEqual([]);
  });
});
