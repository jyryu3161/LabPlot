const { test, expect } = require('@playwright/test');
const { ENV, attachConsole, apiLogin, authedPage } = require('../helpers');

// M2 completion criteria: multiple canvases create/switch; panel resize does NOT
// bump the figure version; resize re-render keeps text pt (M1 property tied to a
// panel); no regression to the figures page. Uses the API for the invariants and
// a light UI smoke for page loads (Konva editor drag/resize isn't automated here).
test.describe('canvas (M2)', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a continuous-axis figure id');
  let tokens, auth, base;
  test.beforeEach(async ({ request }) => {
    tokens = await apiLogin(request);
    auth = { Authorization: `Bearer ${tokens.access_token}` };
    base = ENV.BASE;
  });

  test('canvas CRUD + panel resize keeps figure version, pt-invariant preview', async ({ request }) => {
    // create two canvases (multiple-canvas requirement)
    const mk = (name, w, h) => request.post(`${base}/api/canvases`, { headers: auth, data: { name, width_mm: w, height_mm: h } });
    const c1 = await (await mk('QA canvas 1', 180, 120)).json();
    const c2 = await (await mk('QA canvas 2', 90, 60)).json();
    expect(c1.id).toBeTruthy(); expect(c2.id).toBeTruthy();
    const list = await (await request.get(`${base}/api/canvases`, { headers: auth })).json();
    const ids = list.map((c) => c.id);
    expect(ids).toContain(c1.id); expect(ids).toContain(c2.id);

    // figure version count before
    const fig0 = await (await request.get(`${base}/api/figures/${ENV.FIG}`, { headers: auth })).json();
    const vBefore = fig0.versions.length;

    // add a panel to c1 referencing the figure
    const panel = await (await request.post(`${base}/api/canvases/${c1.id}/panels`, {
      headers: auth, data: { figure_id: ENV.FIG, x_mm: 5, y_mm: 5, width_mm: 90, height_mm: 60 },
    })).json();
    expect(panel.id).toBeTruthy();
    expect(panel.effective_version_id, 'panel resolves effective version').toBeTruthy();

    // preview render at the panel's current size, capture text pt
    const fontSizes = async (w, h) => {
      const r = await (await request.post(`${base}/api/canvases/preview`, {
        headers: auth, data: { figure_id: ENV.FIG, width_mm: w, height_mm: h, options_overlay: { base_size: 8 } },
      })).json();
      const svgResp = await request.get(base + r.svg_url, { headers: auth });
      const text = await svgResp.text();
      const fs = [...new Set([...text.matchAll(/font-size:\s*([\d.]+)/g)].map((m) => m[1]).concat(
        [...text.matchAll(/font-size="([\d.]+)"/g)].map((m) => m[1])))].sort();
      return { cached: r.cached, fs };
    };
    const small = await fontSizes(90, 60);
    const large = await fontSizes(180, 120);
    expect(small.fs.length, 'preview svg has text').toBeGreaterThan(0);
    expect(large.fs, 'font pt identical across panel sizes (resize = re-layout)').toEqual(small.fs);

    // resize the panel (90x60 -> 60x45) via PATCH — must NOT bump the figure version
    await request.patch(`${base}/api/canvases/${c1.id}/panels/${panel.id}`, { headers: auth, data: { width_mm: 60, height_mm: 45 } });
    const fig1 = await (await request.get(`${base}/api/figures/${ENV.FIG}`, { headers: auth })).json();
    expect(fig1.versions.length, 'panel resize did not create a figure version').toBe(vBefore);

    // cleanup
    await request.delete(`${base}/api/canvases/${c1.id}/panels/${panel.id}`, { headers: auth });
    await request.delete(`${base}/api/canvases/${c1.id}`, { headers: auth });
    await request.delete(`${base}/api/canvases/${c2.id}`, { headers: auth });
  });

  test('canvas list + editor pages load without console errors', async ({ page, request }) => {
    const errors = []; attachConsole(page, errors);
    const c = await (await request.post(`${base}/api/canvases`, { headers: auth, data: { name: 'QA smoke canvas', width_mm: 120, height_mm: 90 } })).json();
    await authedPage(page, tokens);
    // list page
    let resp = await page.goto('/canvases', { waitUntil: 'networkidle' });
    expect(resp.status()).toBeLessThan(400);
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => document.body.innerText)).toMatch(/canvas/i);
    // editor page
    resp = await page.goto(`/canvases/${c.id}`, { waitUntil: 'networkidle' });
    expect(resp.status()).toBeLessThan(400);
    await page.waitForTimeout(1500);
    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
    await request.delete(`${base}/api/canvases/${c.id}`, { headers: auth });
  });
});
