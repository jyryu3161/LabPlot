import { expect, test } from '@playwright/test';

const PROJECT_ID = '81000000-0000-4000-8000-000000000001';
const PROJECT_NAME = 'Canonical navigation fixture';
const FIGURE_ID = '81000000-0000-4000-8000-000000000003';
const VERSION_ID = '81000000-0000-4000-8000-000000000004';
const DATASET_ID = '81000000-0000-4000-8000-000000000005';
const CANVAS_ID = '81000000-0000-4000-8000-000000000006';
const CANVAS_NAME = 'Canonical return canvas';

const user = {
  id: '81000000-0000-4000-8000-000000000002',
  email: 'canonical@example.test',
  display_name: 'Canonical QA',
  is_active: true,
  is_approved: true,
  is_admin: false,
  created_at: '2026-08-18T00:00:00Z',
};

const project = {
  id: PROJECT_ID,
  owner_id: user.id,
  name: PROJECT_NAME,
  description: 'Deterministic route-ordering fixture.',
  created_at: '2026-08-18T00:00:00Z',
  updated_at: '2026-08-18T00:00:00Z',
  role: 'owner',
  collaborators: [],
};

async function mockProjectWorkspace(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('access_token', 'deterministic-access-token');
    window.localStorage.setItem('refresh_token', 'deterministic-refresh-token');
  });

  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/auth/me') return route.fulfill({ json: user });
    if (pathname === '/api/projects/invitations') return route.fulfill({ json: [] });
    if (pathname === `/api/projects/${PROJECT_ID}`) return route.fulfill({ json: project });
    if (pathname === '/api/projects') {
      return route.fulfill({ json: [{
        ...project,
        dataset_count: 0,
        figure_count: 0,
        collaborator_count: 0,
      }] });
    }
    if (pathname === '/api/datasets' || pathname === '/api/figures' || pathname === '/api/canvases') {
      return route.fulfill({ json: [] });
    }
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    return route.fulfill({ status: 204 });
  });
}

async function delayHistoryCommit(page: import('@playwright/test').Page, destinationPath: string) {
  await page.evaluate((destination) => {
    const originalPushState = window.history.pushState.bind(window.history);
    let delayed = false;
    window.history.pushState = (state, unused, url) => {
      const next = url == null ? null : new URL(String(url), window.location.href);
      if (!delayed && next?.pathname === destination) {
        delayed = true;
        window.setTimeout(() => originalPushState(state, unused, url), 350);
        return;
      }
      originalPushState(state, unused, url);
    };
  }, destinationPath);
}

async function watchHeadingPath(
  page: import('@playwright/test').Page,
  heading: string,
  expectedPath: string,
) {
  await page.evaluate(({ heading, expectedPath }) => {
    window.__canonicalPathViolations = [];
    const inspect = () => {
      const rendered = [...document.querySelectorAll('h1')]
        .some((node) => node.textContent?.trim() === heading);
      if (rendered && window.location.pathname !== expectedPath) {
        (window.__canonicalPathViolations ??= []).push({
          expectedPath,
          actualPath: window.location.pathname,
          heading,
        });
      }
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    window.__stopCanonicalPathWatch = () => observer.disconnect();
    inspect();
  }, { heading, expectedPath });
}

async function mockFigureAndCanvas(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('access_token', 'deterministic-access-token');
    window.localStorage.setItem('refresh_token', 'deterministic-refresh-token');
  });

  const figure = {
    id: FIGURE_ID,
    name: 'Canonical return figure',
    plot_type: 'scatter',
    style_preset: 'nature',
    status: 'ready',
    dataset_id: DATASET_ID,
    dataset_name: 'Canonical data',
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
      mapping: { x: 'x', y: 'y' },
      options: { x_label: 'X', y_label: 'Y' },
      style_preset: 'nature',
      change_note: 'Fixture',
      created_at: '2026-08-18T00:00:00Z',
      png_url: '/canonical-route-figure.svg',
      svg_url: '/canonical-route-figure.svg',
      layout: null,
    }],
  };
  const canvas = {
    id: CANVAS_ID,
    owner_id: user.id,
    name: CANVAS_NAME,
    description: null,
    project_id: null,
    width_mm: 182.88,
    height_mm: 131.67,
    preset: 'nature_double',
    background: '#FFFFFF',
    export_snapshot: null,
    annotations: [],
    annotations_rev: 0,
    panels: [],
    created_at: '2026-08-18T00:00:00Z',
    updated_at: '2026-08-18T00:00:00Z',
  };

  await page.route('**/canonical-route-figure.svg', (route) => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="white"/></svg>',
  }));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/auth/me') return route.fulfill({ json: user });
    if (pathname === '/api/projects/invitations') return route.fulfill({ json: [] });
    if (pathname === `/api/figures/${FIGURE_ID}`) return route.fulfill({ json: figure });
    if (pathname === `/api/canvases/${CANVAS_ID}`) return route.fulfill({ json: canvas });
    if (pathname === `/api/datasets/${DATASET_ID}`) {
      return route.fulfill({ json: {
        id: DATASET_ID,
        name: 'Canonical data',
        original_filename: 'canonical.csv',
        format: 'csv',
        n_rows: 2,
        n_cols: 2,
        created_at: '2026-08-18T00:00:00Z',
        column_profile: [],
        preview: [],
      } });
    }
    if (pathname === '/api/plot-types') {
      return route.fulfill({ json: { plot_types: [{
        type: 'scatter', label: 'Scatter', required: [], optional: [], options: [], color_editable: true,
      }] } });
    }
    if (pathname === '/api/styles') return route.fulfill({ json: { styles: [{ key: 'nature', label: 'Clean Classic' }] } });
    if (pathname === '/api/palettes') return route.fulfill({ json: { palettes: [] } });
    if (pathname === '/api/projects' || pathname.endsWith('/comments')) return route.fulfill({ json: [] });
    if (request.method() === 'GET') return route.fulfill({ json: [] });
    return route.fulfill({ status: 204 });
  });
}

test('project detail never renders under the projects-list URL and survives history plus refresh', async ({ page }) => {
  await mockProjectWorkspace(page);
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();

  const projectPath = `/projects/${PROJECT_ID}`;
  await delayHistoryCommit(page, projectPath);
  await watchHeadingPath(page, PROJECT_NAME, projectPath);

  await page.getByRole('link', { name: 'Open project' }).click();
  await expect(page).toHaveURL(projectPath);
  await expect(page.getByRole('heading', { name: PROJECT_NAME, exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__canonicalPathViolations ?? [])).toEqual([]);
  await page.evaluate(() => window.__stopCanonicalPathWatch?.());

  await page.reload();
  await expect(page).toHaveURL(projectPath);
  await expect(page.getByRole('heading', { name: PROJECT_NAME, exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL('/projects');
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
});

test('route boundary uses the rendered route identity when pathname metadata is stale', async ({ page }) => {
  await mockProjectWorkspace(page);
  const projectPath = `/projects/${PROJECT_ID}`;
  await page.goto(projectPath);
  await expect(page.getByRole('heading', { name: PROJECT_NAME, exact: true })).toBeVisible();

  // Model the reported App Router scheduling state: the browser pathname and
  // usePathname metadata both identify the list while the streamed child tree
  // is still the project detail. Comparing those two values alone cannot spot
  // that the visible screen belongs to another resource.
  await page.evaluate(() => window.history.replaceState(null, '', '/projects'));
  await expect(page.getByTestId('canonical-route-pending')).toBeVisible();
  await expect(page.getByRole('heading', { name: PROJECT_NAME, exact: true })).toBeHidden();

  await page.evaluate((destination) => window.history.replaceState(null, '', destination), projectPath);
  await expect(page).toHaveURL(projectPath);
  await expect(page.getByRole('heading', { name: PROJECT_NAME, exact: true })).toBeVisible();
});

test('Return to canvas commits its canonical URL before the canvas screen renders', async ({ page }) => {
  await mockFigureAndCanvas(page);
  const figurePath = `/figures/${FIGURE_ID}?returnCanvas=${CANVAS_ID}`;
  const canvasPath = `/canvases/${CANVAS_ID}`;
  await page.goto(figurePath);
  await expect(page.getByRole('heading', { name: 'Canonical return figure', exact: true })).toBeVisible();

  await delayHistoryCommit(page, canvasPath);
  await page.evaluate(({ canvasName, canvasPath }) => {
    window.__canonicalPathViolations = [];
    const inspect = () => {
      const canvasButton = [...document.querySelectorAll('button')]
        .some((node) => node.textContent?.trim() === canvasName);
      if (canvasButton && window.location.pathname !== canvasPath) {
        (window.__canonicalPathViolations ??= []).push({
          expectedPath: canvasPath,
          actualPath: window.location.pathname,
          heading: canvasName,
        });
      }
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    window.__stopCanonicalPathWatch = () => observer.disconnect();
    inspect();
  }, { canvasName: CANVAS_NAME, canvasPath });

  await page.getByRole('link', { name: 'Return to canvas' }).click();
  await expect(page).toHaveURL(canvasPath);
  await expect(page.getByRole('button', { name: CANVAS_NAME, exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__canonicalPathViolations ?? [])).toEqual([]);
  await page.evaluate(() => window.__stopCanonicalPathWatch?.());
});

test('Return to canvas keeps the canonical resource across refresh and browser back', async ({ page }) => {
  await mockFigureAndCanvas(page);
  const figurePath = `/figures/${FIGURE_ID}?returnCanvas=${CANVAS_ID}`;
  const canvasPath = `/canvases/${CANVAS_ID}`;
  await page.goto(figurePath);
  await expect(page.getByRole('heading', { name: 'Canonical return figure', exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Return to canvas' }).click();
  await expect(page).toHaveURL(canvasPath);
  await expect(page.getByRole('button', { name: CANVAS_NAME, exact: true })).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(canvasPath);
  await expect(page.getByRole('button', { name: CANVAS_NAME, exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(figurePath);
  await expect(page.getByRole('heading', { name: 'Canonical return figure', exact: true })).toBeVisible();
});

declare global {
  interface Window {
    __canonicalPathViolations?: Array<Record<string, string>>;
    __stopCanonicalPathWatch?: () => void;
  }
}
