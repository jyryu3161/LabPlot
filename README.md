# LabPlot AI

LabPlot AI is a web platform for producing publication-ready scientific figures from tabular datasets. Researchers can upload CSV, TSV, or Excel files, receive rule-based and AI-assisted chart recommendations, render reproducible ggplot2 figures, review visual quality with AI, apply structured improvement suggestions, and export figures with the underlying R code.

## Highlights

- Project-based dataset and figure organization
- FastAPI backend with PostgreSQL persistence and authenticated user isolation
- Next.js frontend optimized for production standalone deployment
- ggplot2-based rendering through fixed R templates, not arbitrary user code
- Rule-based chart suggestions for immediate feedback
- Optional Claude or Gemini AI features for recommendations, reference-image chart matching, figure review, improvements, legend writing, and prompt enhancement
- Admin controls for user approval, role management, AI provider settings, and per-user AI token/cost estimates
- Successful render code is archived as reusable figure-code artifacts for later retrieval, training-data preparation, and cross-user template reuse
- Caddy reverse proxy with HTTPS, compression, and cache headers for rendered static assets

## Architecture

```text
Browser
  -> Caddy
     -> Next.js frontend
     -> FastAPI backend
        -> PostgreSQL
        -> R renderer
        -> Anthropic Claude or Google Gemini API
```

The backend stores datasets, figure versions, rendered asset paths, reviews, improvements, AI configuration, AI usage records, and reusable figure-code artifacts. Figure rendering is deterministic: validated JSON parameters are passed into known R templates and every version keeps its generated R script for reproducibility.

## Repository Layout

```text
backend/        FastAPI app, SQLAlchemy models, rendering services, AI integration
frontend/       Next.js app, React components, API client types
Caddyfile       Public routing, TLS, compression, and static cache headers
docker-compose.yml
README.md
```

## Configuration

Create a `.env` file or provide equivalent environment variables to Docker Compose.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret used for access and refresh token signing |
| `ROOT_EMAIL` / `ROOT_PASSWORD` | Initial root admin account |
| `ANTHROPIC_API_KEY` | Optional Claude API key |
| `GEMINI_API_KEY` | Optional Gemini API key |
| `ANTHROPIC_MODEL` | Default Claude model |
| `GEMINI_MODEL` | Default Gemini model |
| `MAX_UPLOAD_SIZE_MB` | Upload size limit |
| `NEXT_PUBLIC_API_URL` | Frontend API base URL, usually empty for same-origin deployment |

Admins can also update the active AI provider, model names, and API keys from the Admin page.

## Development

Backend:

```bash
cd backend
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Production-like local stack:

```bash
docker compose build
docker compose up -d
```

## Verification

Recommended checks before deployment:

```bash
cd frontend && npm run lint && npm run build
PYTHONPYCACHEPREFIX=/tmp/labplot-pycache python -m py_compile $(find backend/app -name '*.py' -not -path '*/__pycache__/*' -print)
docker compose ps
```

For deployed routing, verify the public pages and API health:

```bash
curl -k https://labplotai.com/
curl -k https://labplotai.com/api/health
```

## AI Usage Accounting

Every successful AI call with an authenticated user is recorded in `ai_usage` with provider, model, feature name, input tokens, output tokens, total tokens, and an estimated USD cost when the model matches a known pricing profile. The Admin users table aggregates these values for all users, including admins.

Cost estimates are operational guidance, not a billing ledger. Provider invoices remain authoritative because discounts, cached-token pricing, batch pricing, regional pricing, and model-specific changes can affect final cost.

## Deployment Notes

- The production frontend image runs Next.js standalone output instead of `next dev`.
- The backend runs Uvicorn without auto-reload in Docker Compose.
- Caddy enables `zstd`/`gzip` compression and long-lived immutable caching for rendered figure assets.
- Uploaded files and rendered outputs are stored under backend-managed local static directories.

## Security Notes

- Users can only access their own datasets and figures unless viewing shared gallery output.
- Admin privileges are required for user management and AI provider configuration.
- AI output is treated as suggestions and is validated before it can affect figure parameters.
- The R renderer uses fixed templates and sanitized parameters rather than executing arbitrary user-provided R code.
