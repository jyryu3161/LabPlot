const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

// M-C1 §10: figure-page journal compliance checklist + submission bundle
// download. Read-only against QA_FIG (never mutated) — mirrors the
// read-only style of figure-conveniences.spec.js.
test.describe('figure compliance panel (M-C1 §10)', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a figure id');

  test('GET compliance report: shape matches the contract and the checklist renders', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    const auth = { Authorization: `Bearer ${tokens.access_token}` };
    const fig = await (await request.get(`${ENV.BASE}/api/figures/${ENV.FIG}`, { headers: auth })).json();
    const versionId = fig.current_version_id ?? fig.versions[fig.versions.length - 1]?.id;
    test.skip(!versionId, 'QA_FIG has no rendered version');

    const res = await request.get(`${ENV.BASE}/api/figures/${ENV.FIG}/versions/${versionId}/compliance`, { headers: auth });
    expect(res.status()).toBe(200);
    const report = await res.json();
    expect(report.figure_id).toBe(ENV.FIG);
    expect(report.version_id).toBe(versionId);
    expect(typeof report.passed).toBe('boolean');
    expect(typeof report.width_in).toBe('number');
    expect(typeof report.height_in).toBe('number');
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);
    for (const c of report.checks) {
      expect(typeof c.name).toBe('string');
      expect(typeof c.ok).toBe('boolean');
      expect(typeof c.actual).toBe('string');
      expect(typeof c.expected).toBe('string');
    }

    await authedPage(page, tokens);
    await page.goto(`/figures/${ENV.FIG}`, { waitUntil: 'networkidle' });

    const panel = page.getByRole('region', { name: 'Journal compliance' });
    await expect(panel).toBeVisible();
    await panel.scrollIntoViewIfNeeded();
    // checks[0] is always "Column width"; a failing width check renders a
    // hint containing "double-column width", whose case-insensitive
    // substring match would otherwise also match this getByText — exact:
    // true resolves to only the check-name span (see finding [4]).
    await expect(panel.getByText(report.checks[0].name, { exact: true })).toBeVisible();
    await expect(panel.getByRole('status').first()).toHaveText(report.passed ? /Meets requirements/ : /Needs attention/);

    // Per-check pass/fail icons must match the API report exactly.
    const passCount = report.checks.filter((c) => c.ok).length;
    const failCount = report.checks.filter((c) => !c.ok).length;
    await expect(panel.getByLabel('Pass')).toHaveCount(passCount);
    await expect(panel.getByLabel('Fail')).toHaveCount(failCount);
  });

  test('Submission bundle download: single/double column buttons trigger a zip download named from Content-Disposition', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    const auth = { Authorization: `Bearer ${tokens.access_token}` };
    const fig = await (await request.get(`${ENV.BASE}/api/figures/${ENV.FIG}`, { headers: auth })).json();
    const versionId = fig.current_version_id ?? fig.versions[fig.versions.length - 1]?.id;
    test.skip(!versionId, 'QA_FIG has no rendered version');

    // API-level: the endpoint 200s with a zip and a Content-Disposition filename.
    const res = await request.get(
      `${ENV.BASE}/api/figures/${ENV.FIG}/versions/${versionId}/submission-bundle?column=single`,
      { headers: auth },
    );
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('zip');
    expect(res.headers()['content-disposition']).toMatch(/filename/i);

    // UI: the download button starts a real browser download.
    await authedPage(page, tokens);
    await page.goto(`/figures/${ENV.FIG}`, { waitUntil: 'networkidle' });

    const panel = page.getByRole('region', { name: 'Journal compliance' });
    await expect(panel).toBeVisible();
    await panel.scrollIntoViewIfNeeded();
    const singleBtn = panel.getByRole('button', { name: 'Download submission bundle, single column' });
    await expect(singleBtn).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      singleBtn.click(),
    ]);
    expect(download.suggestedFilename().length).toBeGreaterThan(0);
  });
});
