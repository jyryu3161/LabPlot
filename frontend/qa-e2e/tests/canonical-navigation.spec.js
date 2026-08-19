const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

const authHeaders = (tokens) => ({ Authorization: `Bearer ${tokens.access_token}` });

async function allowCrossOriginQaApi(page) {
  const pageBase = process.env.QA_PAGE_BASE;
  if (!pageBase || new URL(pageBase).origin === new URL(ENV.BASE).origin) return;
  await page.route(`${new URL(ENV.BASE).origin}/api/**`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        'access-control-allow-origin': new URL(pageBase).origin,
        'access-control-allow-headers': 'authorization,content-type',
        'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
      },
    });
  });
}

async function watchTextRoute(page, selector, text, expectedPath) {
  await page.evaluate(({ selector, text, expectedPath }) => {
    window.__labplotRouteViolations = [];
    const inspect = () => {
      const target = [...document.querySelectorAll(selector)].find((node) => node.textContent?.trim() === text);
      if (target && window.location.pathname !== expectedPath) {
        window.__labplotRouteViolations.push({
          expectedPath,
          actualPath: window.location.pathname,
          text,
        });
      }
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    window.__labplotStopRouteWatch = () => observer.disconnect();
    inspect();
  }, { selector, text, expectedPath });
}

async function expectNoRouteViolation(page) {
  await expect.poll(() => page.evaluate(() => window.__labplotRouteViolations ?? [])).toEqual([]);
  await page.evaluate(() => window.__labplotStopRouteWatch?.());
}

async function delayNextHistoryCommit(page, expectedPath) {
  await page.evaluate(({ expectedPath }) => {
    const pushState = window.history.pushState.bind(window.history);
    let delayed = false;
    window.history.pushState = (state, unused, url) => {
      const destination = url == null ? null : new URL(String(url), window.location.href);
      if (!delayed && destination?.pathname === expectedPath) {
        delayed = true;
        window.setTimeout(() => pushState(state, unused, url), 250);
        return;
      }
      pushState(state, unused, url);
    };
  }, { expectedPath });
}

test.describe('canonical navigation ordering', () => {
  test.skip(!ENV.FIG, 'set QA_FIG to an owned figure id');

  test('the canonical URL is committed before Return to canvas and global target screens render', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    const headers = authHeaders(tokens);
    let canvasId = null;

    try {
      const canvasResponse = await request.post(`${ENV.BASE}/api/canvases`, {
        headers,
        data: { name: `Canonical route QA ${Date.now()}`, width_mm: 180, height_mm: 120 },
      });
      expect(canvasResponse.status()).toBe(201);
      const canvas = await canvasResponse.json();
      canvasId = canvas.id;

      await allowCrossOriginQaApi(page);
      await authedPage(page, tokens);
      await page.goto(`/figures/${ENV.FIG}?returnCanvas=${canvasId}`, { waitUntil: 'domcontentloaded' });

      await watchTextRoute(page, 'button', canvas.name, `/canvases/${canvasId}`);
      const returnLink = page.getByRole('link', { name: 'Return to canvas' });
      await expect(returnLink).toHaveAttribute('href', `/canvases/${canvasId}`);
      await returnLink.click();
      await expect(page).toHaveURL(`/canvases/${canvasId}`);
      await expect(page.getByRole('button', { name: canvas.name, exact: true })).toBeVisible();
      await expectNoRouteViolation(page);

      for (const destination of [
        { link: 'Gallery', heading: 'Gallery', path: '/gallery' },
        { link: 'Projects', heading: 'Projects', path: '/projects' },
        { link: 'Canvases', heading: 'Canvases', path: '/canvases' },
      ]) {
        // Deterministically exercise the scheduling window reported in the
        // audit: the target React tree is ready before the History API commit.
        if (destination.path === '/gallery') await delayNextHistoryCommit(page, destination.path);
        await watchTextRoute(page, 'h1', destination.heading, destination.path);
        await page.getByRole('navigation').getByRole('link', { name: destination.link, exact: true }).click();
        await expect(page).toHaveURL(destination.path);
        await expect(page.getByRole('heading', { name: destination.heading, exact: true })).toBeVisible();
        await expectNoRouteViolation(page);
      }
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
      if (canvasId) {
        await request.delete(`${ENV.BASE}/api/canvases/${canvasId}`, { headers }).catch(() => {});
      }
    }
  });

  test('URL-backed tabs do not expose the next panel before its canonical query is committed', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    const headers = authHeaders(tokens);
    const projectsResponse = await request.get(`${ENV.BASE}/api/projects`, { headers });
    expect(projectsResponse.ok()).toBeTruthy();
    const projects = await projectsResponse.json();
    expect(projects.length).toBeGreaterThan(0);
    const projectPath = `/projects/${projects[0].id}`;

    await allowCrossOriginQaApi(page);
    await authedPage(page, tokens);
    await page.goto(projectPath, { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ projectPath }) => {
      window.__labplotRouteViolations = [];
      const inspect = () => {
        const figuresTab = [...document.querySelectorAll('[role="tab"]')]
          .find((node) => node.textContent?.trim().startsWith('Figures'));
        if (figuresTab?.getAttribute('aria-selected') === 'true') {
          const actual = window.location.pathname + window.location.search;
          if (actual !== `${projectPath}?tab=figures`) {
            window.__labplotRouteViolations.push({
              expectedPath: `${projectPath}?tab=figures`,
              actualPath: actual,
              tab: 'Figures',
            });
          }
        }
      };
      const observer = new MutationObserver(inspect);
      observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
      window.__labplotStopRouteWatch = () => observer.disconnect();
      inspect();
    }, { projectPath });

    await page.getByRole('tab', { name: /^Figures/ }).click();
    await expect(page).toHaveURL(`${projectPath}?tab=figures`);
    await expect(page.getByRole('tab', { name: /^Figures/ })).toHaveAttribute('aria-selected', 'true');
    await expectNoRouteViolation(page);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });
});
