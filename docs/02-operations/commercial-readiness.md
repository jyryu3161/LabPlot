# LabPlot Commercial-Readiness Runbook

This project is not intended as a regulated commercial product yet, but it should be operated with production-grade defaults. This runbook lists the controls that must be configured and the checks to run before and after deployment.

## Required Environment

Set these values in `.env` before public deployment:

```bash
POSTGRES_PASSWORD=$(openssl rand -hex 32)
JWT_SECRET=$(openssl rand -hex 64)
DATA_ENCRYPTION_KEY=$(openssl rand -base64 32)
ROOT_EMAIL=admin@your-domain.example
ROOT_PASSWORD=<long one-time bootstrap password>
APP_BASE_URL=https://your-domain.example
ALLOWED_ORIGINS=https://your-domain.example,https://www.your-domain.example
```

Optional but recommended:

```bash
SMTP_HOST=smtp.example.com
SMTP_USERNAME=<smtp user>
SMTP_PASSWORD=<smtp password>
SMTP_FROM=no-reply@your-domain.example
NEXT_PUBLIC_GA_ID=G-XXXXXXXXXX
ANTHROPIC_API_KEY=<only if AI features are enabled>
GEMINI_API_KEY=<only if Gemini is enabled>
```

`DATA_ENCRYPTION_KEY` protects newly uploaded private datasets at rest. Existing plaintext uploads remain readable for backward compatibility; re-uploading or running a future migration can convert old files.

## Deployment

Build and start the production-like Docker stack:

```bash
docker compose build
docker compose up -d
docker compose ps
```

Use service-scoped rebuilds for routine backend/frontend releases:

```bash
docker compose build labplot-backend labplot-frontend
docker compose up -d labplot-backend labplot-frontend labplot-caddy
```

Rollback to a previous Git commit and rebuild the affected images. Database rollbacks are not automatic; take a backup before schema-affecting releases.

## Preflight Checks

Run these before pushing or deploying:

```bash
PYTHONPYCACHEPREFIX=/tmp/labplot-pycache python -m py_compile $(find backend/app -name '*.py' -not -path '*/__pycache__/*' -print)
cd frontend && npm run lint && npm run build
cd ..
docker compose config --quiet
git diff --check
```

After deployment, run:

```bash
python scripts/smoke_security.py
docker cp scripts/smoke_api.py labplot-backend:/tmp/smoke_api.py
docker cp scripts/smoke_services.py labplot-backend:/tmp/smoke_services.py
docker exec labplot-backend sh -lc "cd /app/backend && /app/.pixi/envs/default/bin/python /tmp/smoke_api.py"
docker exec labplot-backend sh -lc "cd /app/backend && /app/.pixi/envs/default/bin/python /tmp/smoke_services.py"
curl -k --resolve labplotai.com:443:127.0.0.1 -I https://labplotai.com/
```

The security smoke script checks API health, CORS origin restriction, private upload exposure, and login rate limiting. The API smoke script checks admin login, test-user provisioning, encrypted dataset upload, AI/render/storage quota blocking, figure rendering, audit logs, and delete cleanup. The service smoke script checks password reset, AI quota enforcement, prompt-injection neutralization, and SVG sanitization. The curl command checks edge security headers through Caddy.

## Backup And Restore

Database backup:

```bash
mkdir -p backups
docker exec labplot-db pg_dump -U labplot -d labplot --format=custom > backups/labplot-$(date +%Y%m%d-%H%M%S).dump
```

Private uploads and rendered figures:

```bash
tar -czf backups/labplot-files-$(date +%Y%m%d-%H%M%S).tgz backend/private backend/static/figures
```

Restore database:

```bash
cat backups/labplot.dump | docker exec -i labplot-db pg_restore -U labplot -d labplot --clean --if-exists
```

Restore file assets only from trusted backups. Keep `DATA_ENCRYPTION_KEY` with the backup metadata; encrypted datasets cannot be recovered without it.

## Security Controls

- Authentication: access and refresh JWTs include `token_version`; password reset and admin reset invalidate old tokens.
- Password reset: configure SMTP before production. Without SMTP, reset links are not emailed.
- Authorization: users are scoped to their own projects, datasets, and figures. Admin endpoints require admin privileges.
- Upload storage: datasets are stored under `backend/private`, not public static routes. New private dataset files are encrypted at rest.
- Render safety: R code is generated from fixed templates and validated JSON parameters. Users cannot submit arbitrary R code for execution.
- AI prompt safety: user-provided project and dataset context is wrapped as untrusted context. AI outputs are parsed as structured suggestions and sanitized before use.
- SVG edit safety: saved SVG edits reject script-like tags, event handlers, embedded file/data links, and oversized payloads.
- Edge hardening: Caddy owns public security headers and blocks `/static/uploads/*`.
- Auditability: account, dataset, figure, SVG-edit, and admin configuration events are written to `audit_logs`.
- Abuse control: rate limits are applied to auth, uploads, renders, SVG edits, and AI-heavy endpoints.
- Cost control: admin users can set per-user monthly AI request limits, render limits, and storage limits.

## Admin Operations

Review these areas from the Admin page:

- Pending users: approve only known accounts.
- AI provider settings: keep only the active provider key configured.
- AI usage and estimated cost: monitor monthly usage by user.
- User quotas: set AI, render, and storage limits for heavy users.
- Audit log: review recent account, admin, dataset, and figure events.

## Remaining Production Roadmap

These are not blockers for the current single-server deployment, but they are the next hardening steps for a larger service:

- Replace startup SQL snippets with Alembic migrations.
- Move private uploads and rendered assets to object storage with server-side encryption and lifecycle policies.
- Add CI that runs backend compile checks, frontend lint/build, Docker build, and smoke tests.
- Add Sentry or equivalent error monitoring for backend and frontend.
- Add uptime checks and log retention.
- Add per-tenant data retention and deletion policies.
- Add key rotation support for `DATA_ENCRYPTION_KEY`.
- Add disaster recovery drills with timed restore validation.
