const { test, expect } = require('@playwright/test');
const { ENV, attachConsole, apiLogin, authedPage } = require('../helpers');

test.describe('figure editor', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a continuous-axis figure id to run editor E2E');
  let tokens, auth;
  test.beforeEach(async ({ request }) => { tokens = await apiLogin(request); auth = { Authorization: `Bearer ${tokens.access_token}` }; });

  test('new controls are present and page is error-free', async ({ page }) => {
    const errors = []; attachConsole(page, errors);
    await authedPage(page, tokens);
    await page.goto(`/figures/${ENV.FIG}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    const body = await page.evaluate(() => document.body.innerText);
    const required = ['Live preview', 'Duplicate', 'Interactive view', 'Place on figure', 'Annotations', 'Secondary Y', 'X axis type'];
    for (const label of required) expect(body, `control "${label}"`).toContain(label);
    // export formats
    for (const fmt of ['PNG', 'SVG', 'TIFF', 'PDF', 'EPS', 'R script', 'Python code', 'LaTeX']) expect(body).toContain(fmt);
    // break-axis controls
    expect(body.toLowerCase()).toMatch(/break [xy] axis/);
    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('annotation place + drag-move persists exact data coords', async ({ page, request }) => {
    // Deterministic start: clear any existing annotations via API so retries and
    // prior tests never leave stale marks (read-back would otherwise pick them up).
    {
      const cur = (await (await request.get(`${ENV.BASE}/api/figures/${ENV.FIG}`, { headers: auth })).json()).versions.slice(-1)[0];
      const opts = { ...(cur.options || {}) }; delete opts.annotations;
      await request.post(`${ENV.BASE}/api/figures/${ENV.FIG}/rerender`, { headers: auth, data: { options: opts, change_note: 'qa reset' } });
    }
    const f0 = await (await request.get(`${ENV.BASE}/api/figures/${ENV.FIG}`, { headers: auth })).json();
    const layout = f0.versions[f0.versions.length - 1].layout;
    expect(layout, 'figure has panel layout').toBeTruthy();
    const [x0, x1] = layout.x_range, [y0, y1] = layout.y_range;
    const fx = (x) => (x - x0) / (x1 - x0), fy = (y) => (y - y0) / (y1 - y0);

    await authedPage(page, tokens);
    await page.goto(`/figures/${ENV.FIG}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    const toggle = page.getByText('Place on figure', { exact: false }).first();
    await toggle.scrollIntoViewIfNeeded();
    await toggle.locator('xpath=ancestor::*[self::div][1]').getByRole('switch').first().click();
    await page.waitForTimeout(1000);
    const canvas = page.locator('canvas').first();
    const overlay = canvas.locator('xpath=ancestor::div[.//*[@aria-label="Toggle visual annotation placement"]][1]');
    const boxNow = async () => { await canvas.scrollIntoViewIfNeeded(); await page.waitForTimeout(150); return canvas.boundingBox(); };
    const at = (b, ffx, fyUp) => ({ x: b.x + b.width * ffx, y: b.y + b.height * (1 - fyUp) });
    const tool = async (n) => { await overlay.getByRole('button', { name: n, exact: true }).first().click(); await page.waitForTimeout(250); };
    const nStart = f0.versions.length;

    // PLACE a box (0.3,0.3)->(0.5,0.5)
    await tool('Box');
    let b = await boxNow(); let a = at(b, 0.3, 0.3), c = at(b, 0.5, 0.5);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move((a.x + c.x) / 2, (a.y + c.y) / 2, { steps: 4 }); await page.mouse.move(c.x, c.y, { steps: 4 }); await page.mouse.up();
    await page.waitForTimeout(300);
    // MOVE center 0.4,0.4 -> 0.6,0.6 (also selects it)
    b = await boxNow(); let from = at(b, 0.4, 0.4), to = at(b, 0.6, 0.6);
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 }); await page.mouse.move(to.x, to.y, { steps: 5 }); await page.mouse.up();
    await page.waitForTimeout(400);
    const del = overlay.getByRole('button', { name: /delete/i }).first();
    expect(await del.isEnabled(), 'Delete enabled after drag-select').toBeTruthy();

    // apply and verify MOVE
    await page.getByRole('button', { name: /apply changes/i }).click();
    await page.waitForFunction((n) => { const m = document.body.innerText.match(/Versions \((\d+)\)/); return m && Number(m[1]) > n; }, nStart, { timeout: 60000 });
    await page.waitForTimeout(1000);
    let v = (await (await request.get(`${ENV.BASE}/api/figures/${ENV.FIG}`, { headers: auth })).json()).versions.slice(-1)[0];
    const rect = (v.options.annotations || []).filter((x) => x.kind === 'rect').slice(-1)[0];
    expect(rect, 'rect persisted').toBeTruthy();
    expect(rect.coord, 'rect uses data coords on continuous plot').toBe('data');
    expect(Math.abs(fx(rect.x) - 0.5), 'rect x0 near 0.5 after move').toBeLessThan(0.08);
    expect(Math.abs(fy(rect.y) - 0.5), 'rect y0 near 0.5 after move').toBeLessThan(0.08);
    expect(Math.abs(fx(rect.x2) - 0.7), 'rect x1 near 0.7 after move').toBeLessThan(0.08);

  });

  test('annotation delete removes the mark', async ({ page, request }) => {
    // Deterministic start: clear annotations via API.
    {
      const cur = (await (await request.get(`${ENV.BASE}/api/figures/${ENV.FIG}`, { headers: auth })).json()).versions.slice(-1)[0];
      const opts = { ...(cur.options || {}) }; delete opts.annotations;
      await request.post(`${ENV.BASE}/api/figures/${ENV.FIG}/rerender`, { headers: auth, data: { options: opts, change_note: 'qa reset' } });
    }
    const f0 = await (await request.get(`${ENV.BASE}/api/figures/${ENV.FIG}`, { headers: auth })).json();
    const nStart = f0.versions.length;
    await authedPage(page, tokens);
    await page.goto(`/figures/${ENV.FIG}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    const toggle = page.getByText('Place on figure', { exact: false }).first();
    await toggle.scrollIntoViewIfNeeded();
    await toggle.locator('xpath=ancestor::*[self::div][1]').getByRole('switch').first().click();
    await page.waitForTimeout(1000);
    const canvas = page.locator('canvas').first();
    const overlay = canvas.locator('xpath=ancestor::div[.//*[@aria-label="Toggle visual annotation placement"]][1]');
    const boxNow = async () => { await canvas.scrollIntoViewIfNeeded(); await page.waitForTimeout(150); return canvas.boundingBox(); };
    const at = (b, ffx, fyUp) => ({ x: b.x + b.width * ffx, y: b.y + b.height * (1 - fyUp) });
    const tool = async (n) => { await overlay.getByRole('button', { name: n, exact: true }).first().click(); await page.waitForTimeout(250); };

    // place a box, then drag it (auto-selects) — same session, reliable
    await tool('Box');
    let b = await boxNow(); let a = at(b, 0.3, 0.3), c = at(b, 0.5, 0.5);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move((a.x + c.x) / 2, (a.y + c.y) / 2, { steps: 4 }); await page.mouse.move(c.x, c.y, { steps: 4 }); await page.mouse.up();
    await page.waitForTimeout(300);
    b = await boxNow(); const from = at(b, 0.4, 0.4), to = at(b, 0.55, 0.55);
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 }); await page.mouse.move(to.x, to.y, { steps: 5 }); await page.mouse.up();
    await page.waitForTimeout(400);
    const del = overlay.getByRole('button', { name: /delete/i }).first();
    expect(await del.isEnabled(), 'Delete enabled after drag-select').toBeTruthy();
    await del.click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: /apply changes/i }).click();
    await page.waitForFunction((n) => { const m = document.body.innerText.match(/Versions \((\d+)\)/); return m && Number(m[1]) > n; }, nStart, { timeout: 60000 });
    await page.waitForTimeout(1000);
    const v = (await (await request.get(`${ENV.BASE}/api/figures/${ENV.FIG}`, { headers: auth })).json()).versions.slice(-1)[0];
    expect((v.options.annotations || []).length, 'annotations removed after delete').toBe(0);
  });
});
