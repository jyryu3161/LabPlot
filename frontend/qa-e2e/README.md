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
QA_DATASET=<group-time-dataset-id> \
QA_BASE=https://labplotai.com \
  npx playwright test -c qa-e2e/playwright.config.js
```

- `QA_EMAIL` / `QA_PW` — an account to authenticate with (never commit these).
- `QA_FIG` — a continuous-axis figure (scatter/line) owned by that account; the editor
  specs skip if unset.
- `QA_DATASET` — a group + time dataset used by recommendation and statistics safety
  regressions; those specs skip if unset.
- `QA_BASE` — target origin (defaults to the production URL).
- `QA_PAGE_BASE` — optional browser-page origin. Set this to a local frontend while
  keeping `QA_BASE` on the real QA API to test local UI changes against safe fixtures.
- `QA_LOCAL_CROSS_ORIGIN=1` — local-only opt-in when that frontend calls a QA API on a
  different origin. Do not set it for deployed-site runs.

No secrets are stored in this directory; all config comes from environment variables.
