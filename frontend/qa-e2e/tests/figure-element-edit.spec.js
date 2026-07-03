const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

// U6: Prism-style element editing on the FIGURE page — clicking the axis-label
// hit target edits the DRAFT options (no render), and the page's normal Apply
// commits it. Server truth = current version options after Apply.
test.describe('figure page element editing (U6)', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a figure id');

  const currentOptions = async (request, auth) => {
    const fig = await (await request.get(`${ENV.BASE}/api/figures/${ENV.FIG}`, { headers: auth })).json();
    const v = fig.versions.find((x) => x.id === fig.current_version_id) ?? fig.versions[0];
    return v?.options ?? {};
  };

  test('inline x-label draft edit -> Apply commits a version with the new label', async ({ page, request }) => {
    test.setTimeout(180000); // Apply + restore = two R renders
    const tokens = await apiLogin(request);
    const auth = { Authorization: `Bearer ${tokens.access_token}` };
    const before = await currentOptions(request, auth);

    await authedPage(page, tokens);
    await page.goto(`/figures/${ENV.FIG}`, { waitUntil: 'networkidle' });

    // Element hit target renders over the preview (annotation mode off).
    const target = page.getByRole('button', { name: 'Edit x axis label', exact: true });
    await expect(target).toBeVisible({ timeout: 20000 });
    await target.click();
    const input = page.getByRole('textbox', { name: 'x axis label text' });
    await expect(input).toBeVisible();
    await input.fill('U6 Draft Label');
    await input.press('Enter');

    // Draft only — server unchanged until Apply.
    expect((await currentOptions(request, auth)).x_label ?? '').toBe(before.x_label ?? '');

    await page.getByRole('button', { name: 'Apply changes (new version)' }).click();
    await expect.poll(async () => (await currentOptions(request, auth)).x_label, { timeout: 45000 })
      .toBe('U6 Draft Label');

    // restore for other tests (unset if it was unset before)
    const now = await currentOptions(request, auth);
    const restored = { ...now };
    if (before.x_label === undefined) delete restored.x_label; else restored.x_label = before.x_label;
    await request.post(`${ENV.BASE}/api/figures/${ENV.FIG}/rerender`, {
      headers: auth, data: { options: restored, change_note: 'QA: restore x label' },
    });
    await expect.poll(async () => (await currentOptions(request, auth)).x_label ?? '', { timeout: 45000 })
      .toBe(before.x_label ?? '');
  });
});
