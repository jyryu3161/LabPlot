# qa-e2e — Playwright E2E + accessibility suite

Professional QA suite covering:
- **smoke.spec.js** — every public and authenticated route loads with HTTP < 400 and no
  real console errors (third-party analytics/beacon noise is filtered).
- **a11y.spec.js** — axe-core WCAG 2.1 A/AA scan on key pages; fails on any `critical`
  violation.
- **editor.spec.js** — figure editor: new controls present, and the annotation
  place → drag-move (exact data coordinates) and select → delete flows.

## Run

```bash
cd frontend
QA_EMAIL=you@example.com QA_PW='...' \
QA_FIG=<scatter-or-line-figure-id> \
QA_BASE=https://labplotai.com \
  npx playwright test -c qa-e2e/playwright.config.js
```

- `QA_EMAIL` / `QA_PW` — an account to authenticate with (never commit these).
- `QA_FIG` — a continuous-axis figure (scatter/line) owned by that account; the editor
  specs skip if unset.
- `QA_BASE` — target origin (defaults to the production URL).

No secrets are stored in this directory; all config comes from environment variables.
