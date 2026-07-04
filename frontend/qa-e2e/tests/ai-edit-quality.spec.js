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
test.describe('AI edit quality (U10)', () => {
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
