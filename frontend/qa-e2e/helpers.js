const path = require('path');

// Config from environment (no secrets committed). See qa-e2e/README.md.
const ENV = {
  BASE: process.env.QA_BASE || 'https://labplotai.com',
  EMAIL: process.env.QA_EMAIL,
  PW: process.env.QA_PW,
  FIG: process.env.QA_FIG, // a continuous-axis figure id (scatter/line) owned by QA_EMAIL
};

// console errors we intentionally ignore (third-party noise, not app defects)
const IGNORE = [
  /cloudflareinsights|beacon\.min\.js/i,
  /googletagmanager|google-analytics|gtag/i,
  /Failed to load resource: the server responded with a status of 4\d\d.*(favicon|beacon)/i,
];
function attachConsole(page, sink) {
  page.on('console', (m) => { if (m.type() === 'error' && !IGNORE.some((r) => r.test(m.text()))) sink.push(m.text()); });
  page.on('pageerror', (e) => sink.push('PAGEERROR: ' + e.message));
}
// Cache the login token across tests: logging in per-test trips the auth
// rate limit (which is itself correct app behavior). Token TTL keeps it fresh.
let _tok = null, _tokAt = 0;
async function apiLogin(request) {
  if (!ENV.EMAIL || !ENV.PW) throw new Error('Set QA_EMAIL and QA_PW env vars (see qa-e2e/README.md)');
  if (_tok && Date.now() - _tokAt < 10 * 60_000) return _tok;
  const r = await request.post(`${ENV.BASE}/api/auth/login`, { data: { email: ENV.EMAIL, password: ENV.PW } });
  if (!r.ok()) throw new Error('login failed ' + r.status());
  _tok = await r.json(); _tokAt = Date.now();
  return _tok;
}
async function authedPage(page, tokens) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.evaluate(([a, r]) => { localStorage.setItem('access_token', a); localStorage.setItem('refresh_token', r); }, [tokens.access_token, tokens.refresh_token]);
}
async function responseJson(response, action) {
  if (!response.ok()) {
    const body = await response.text().catch(() => '');
    throw new Error(`${action} failed (${response.status()}): ${body.slice(0, 500)}`);
  }
  return response.json();
}
async function getFigure(request, auth, figureId) {
  const response = await request.get(`${ENV.BASE}/api/figures/${figureId}`, { headers: auth });
  return responseJson(response, `get figure ${figureId}`);
}
async function duplicateFigure(request, auth, sourceFigureId) {
  const response = await request.post(`${ENV.BASE}/api/figures/${sourceFigureId}/duplicate`, { headers: auth });
  return responseJson(response, `duplicate figure ${sourceFigureId}`);
}
function figureVersionState(figure) {
  return {
    currentVersionId: figure.current_version_id ?? null,
    versionCount: Array.isArray(figure.versions) ? figure.versions.length : 0,
  };
}
async function cleanupApiResources(request, auth, resources) {
  const allowedCollections = new Set(['canvases', 'figures', 'projects']);
  const failures = [];
  for (const { collection, id } of resources) {
    if (!id) continue;
    if (!allowedCollections.has(collection)) {
      failures.push(`refused unknown cleanup collection ${collection}`);
      continue;
    }
    try {
      const response = await request.delete(`${ENV.BASE}/api/${collection}/${id}`, { headers: auth });
      if (!response.ok() && response.status() !== 404) {
        const body = await response.text().catch(() => '');
        failures.push(`${collection}/${id}: ${response.status()} ${body.slice(0, 300)}`);
      }
    } catch (error) {
      failures.push(`${collection}/${id}: ${error?.message || error}`);
    }
  }
  if (failures.length) throw new Error(`QA cleanup failed:\n${failures.join('\n')}`);
}
async function cleanupAndVerifySourceFigure(request, auth, resources, sourceFigureId, sourceState) {
  const failures = [];
  try {
    await cleanupApiResources(request, auth, resources);
  } catch (error) {
    failures.push(error?.message || String(error));
  }
  if (sourceFigureId && sourceState) {
    try {
      const after = figureVersionState(await getFigure(request, auth, sourceFigureId));
      if (after.currentVersionId !== sourceState.currentVersionId || after.versionCount !== sourceState.versionCount) {
        failures.push(
          `source figure ${sourceFigureId} changed: before=${JSON.stringify(sourceState)} after=${JSON.stringify(after)}`,
        );
      }
    } catch (error) {
      failures.push(`source figure verification failed: ${error?.message || error}`);
    }
  }
  if (failures.length) throw new Error(`QA fixture isolation failed:\n${failures.join('\n')}`);
}
async function runAxe(page) {
  await page.addScriptTag({ path: require.resolve('axe-core') });
  return page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const res = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'] });
    return res.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, help: v.help }));
  });
}
module.exports = {
  ENV,
  attachConsole,
  apiLogin,
  authedPage,
  cleanupAndVerifySourceFigure,
  cleanupApiResources,
  duplicateFigure,
  figureVersionState,
  getFigure,
  runAxe,
};
