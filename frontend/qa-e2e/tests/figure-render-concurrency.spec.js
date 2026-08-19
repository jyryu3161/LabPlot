const { test, expect } = require('@playwright/test');
const { ENV, apiLogin } = require('../helpers');

test.describe('figure render concurrency', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to a rendered figure id');

  test('two renders from one base cannot both become the next version', async ({ request }) => {
    test.setTimeout(120_000);
    const tokens = await apiLogin(request);
    const headers = { Authorization: `Bearer ${tokens.access_token}` };
    let figureId = null;

    try {
      const duplicateResponse = await request.post(`${ENV.BASE}/api/figures/${ENV.FIG}/duplicate`, { headers });
      expect(duplicateResponse.status()).toBe(201);
      const figure = await duplicateResponse.json();
      figureId = figure.id;
      const baseVersion = figure.versions.find((version) => version.id === figure.current_version_id)
        ?? figure.versions[figure.versions.length - 1];

      const render = (title) => request.post(`${ENV.BASE}/api/figures/${figureId}/rerender`, {
        headers,
        data: {
          options: { ...baseVersion.options, title },
          change_note: `Concurrent render QA: ${title}`,
          base_version_id: baseVersion.id,
        },
        timeout: 90_000,
      });
      const [first, second] = await Promise.all([
        render(`First ${Date.now()}`),
        render(`Second ${Date.now()}`),
      ]);
      expect([first.status(), second.status()].sort((a, b) => a - b)).toEqual([200, 409]);

      const latestResponse = await request.get(`${ENV.BASE}/api/figures/${figureId}`, { headers });
      expect(latestResponse.ok()).toBeTruthy();
      const latest = await latestResponse.json();
      const numbers = latest.versions.map((version) => version.version_number);
      expect(new Set(numbers).size).toBe(numbers.length);
      expect(latest.versions).toHaveLength(figure.versions.length + 1);
    } finally {
      if (figureId) await request.delete(`${ENV.BASE}/api/figures/${figureId}`, { headers }).catch(() => {});
    }
  });

  test('an SVG save and an R rerender cannot overwrite each other', async ({ request }) => {
    test.setTimeout(120_000);
    const tokens = await apiLogin(request);
    const headers = { Authorization: `Bearer ${tokens.access_token}` };
    let figureId = null;

    try {
      const duplicateResponse = await request.post(`${ENV.BASE}/api/figures/${ENV.FIG}/duplicate`, { headers });
      expect(duplicateResponse.status()).toBe(201);
      const figure = await duplicateResponse.json();
      figureId = figure.id;
      const baseVersion = figure.versions.find((version) => version.id === figure.current_version_id)
        ?? figure.versions[figure.versions.length - 1];
      const svgResponse = await request.get(
        `${ENV.BASE}/api/figures/${figureId}/versions/${baseVersion.id}/export?format=svg`,
        { headers },
      );
      expect(svgResponse.ok()).toBeTruthy();
      const svg = await svgResponse.text();

      const [svgSave, rerender] = await Promise.all([
        request.post(`${ENV.BASE}/api/figures/${figureId}/versions/${baseVersion.id}/svg-edit`, {
          headers,
          data: { svg, change_note: 'Concurrent SVG save QA' },
          timeout: 90_000,
        }),
        request.post(`${ENV.BASE}/api/figures/${figureId}/rerender`, {
          headers,
          data: {
            options: { ...baseVersion.options, title: `Concurrent R ${Date.now()}` },
            change_note: 'Concurrent SVG/R render QA',
            base_version_id: baseVersion.id,
          },
          timeout: 90_000,
        }),
      ]);
      expect([svgSave.status(), rerender.status()].sort((a, b) => a - b)).toEqual([200, 409]);

      const latest = await (await request.get(`${ENV.BASE}/api/figures/${figureId}`, { headers })).json();
      const numbers = latest.versions.map((version) => version.version_number);
      expect(new Set(numbers).size).toBe(numbers.length);
      expect(latest.versions).toHaveLength(figure.versions.length + 1);
    } finally {
      if (figureId) await request.delete(`${ENV.BASE}/api/figures/${figureId}`, { headers }).catch(() => {});
    }
  });
});
