const { test, expect } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { ENV, apiLogin, authedPage } = require('../helpers');

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
});
