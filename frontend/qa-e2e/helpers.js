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
async function runAxe(page) {
  await page.addScriptTag({ path: require.resolve('axe-core') });
  return page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const res = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'] });
    return res.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, help: v.help }));
  });
}
module.exports = { ENV, attachConsole, apiLogin, authedPage, runAxe };
