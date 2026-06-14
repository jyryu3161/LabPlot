# LabPlot Commercial-Readiness Runbook

This project is not intended as a regulated commercial product yet, but it should be operated with production-grade defaults. This runbook lists the controls that must be configured and the checks to run before and after deployment.

## Required Environment

Set these values in `.env` before public deployment:

```bash
POSTGRES_PASSWORD=$(openssl rand -hex 32)
JWT_SECRET=$(openssl rand -hex 64)
DATA_ENCRYPTION_KEY=$(openssl rand -base64 32)
DATA_ENCRYPTION_PREVIOUS_KEYS=
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
SENTRY_DSN=<optional backend error monitoring DSN>
SENTRY_ENVIRONMENT=production
SENTRY_RELEASE=<git sha or release version>
AUDIT_LOG_RETENTION_DAYS=365
PASSWORD_RESET_TOKEN_RETENTION_DAYS=30
CLIENT_ERROR_RETENTION_DAYS=90
```

`DATA_ENCRYPTION_KEY` protects newly uploaded private datasets at rest. Existing plaintext uploads remain readable for backward compatibility. During key rotation, put the old key in `DATA_ENCRYPTION_PREVIOUS_KEYS`, deploy, run the rotation script below, then remove the old key after a verified backup.

Object storage for new uploads and rendered assets:

```bash
STORAGE_BACKEND=s3
OBJECT_STORAGE_BUCKET=labplot-prod
OBJECT_STORAGE_PREFIX=labplot
OBJECT_STORAGE_REGION=us-east-1
OBJECT_STORAGE_ENDPOINT_URL=<optional S3-compatible endpoint>
OBJECT_STORAGE_ACCESS_KEY_ID=<object storage access key>
OBJECT_STORAGE_SECRET_ACCESS_KEY=<object storage secret key>
OBJECT_STORAGE_SSE=AES256
OBJECT_STORAGE_KMS_KEY_ID=<optional KMS key id>
OBJECT_STORAGE_PUBLIC_BASE_URL=<optional CDN/public base URL for rendered assets>
```

When `STORAGE_BACKEND=s3`, new private dataset uploads and new rendered figure assets are written to `s3://...` object URIs. Dataset objects remain encrypted by LabPlot before upload; the object-storage client also sets server-side encryption headers. If `OBJECT_STORAGE_PUBLIC_BASE_URL` is not set, rendered assets are streamed by LabPlot through `/api/assets/...`.

Migrate existing local uploads and rendered assets after the bucket is ready:

```bash
docker cp scripts/migrate_assets_to_object_storage.py labplot-backend:/tmp/migrate_assets_to_object_storage.py
docker exec \
  -e STORAGE_BACKEND=s3 \
  -e OBJECT_STORAGE_BUCKET=labplot-prod \
  -e OBJECT_STORAGE_PREFIX=labplot \
  -e OBJECT_STORAGE_REGION=us-east-1 \
  -e OBJECT_STORAGE_ACCESS_KEY_ID="$OBJECT_STORAGE_ACCESS_KEY_ID" \
  -e OBJECT_STORAGE_SECRET_ACCESS_KEY="$OBJECT_STORAGE_SECRET_ACCESS_KEY" \
  labplot-backend sh -lc "cd /app/backend && /app/.pixi/envs/default/bin/python /tmp/migrate_assets_to_object_storage.py --dry-run"
docker exec \
  -e STORAGE_BACKEND=s3 \
  -e OBJECT_STORAGE_BUCKET=labplot-prod \
  -e OBJECT_STORAGE_PREFIX=labplot \
  -e OBJECT_STORAGE_REGION=us-east-1 \
  -e OBJECT_STORAGE_ACCESS_KEY_ID="$OBJECT_STORAGE_ACCESS_KEY_ID" \
  -e OBJECT_STORAGE_SECRET_ACCESS_KEY="$OBJECT_STORAGE_SECRET_ACCESS_KEY" \
  labplot-backend sh -lc "cd /app/backend && /app/.pixi/envs/default/bin/python /tmp/migrate_assets_to_object_storage.py --apply --delete-local"
```

Validate object-storage code paths with the local filesystem object backend:

```bash
docker cp scripts/smoke_object_storage.py labplot-backend:/tmp/smoke_object_storage.py
docker exec \
  -e STORAGE_BACKEND=filesystem_object \
  -e OBJECT_STORAGE_BUCKET=labplot-smoke \
  -e OBJECT_STORAGE_LOCAL_DIR=/tmp/labplot-object-smoke/store \
  -e OBJECT_STORAGE_CACHE_DIR=/tmp/labplot-object-smoke/cache \
  labplot-backend sh -lc "cd /app/backend && /app/.pixi/envs/default/bin/python /tmp/smoke_object_storage.py"
```

Apply a conservative object-storage lifecycle policy after bucket creation:

```bash
OBJECT_STORAGE_BUCKET=labplot-prod python scripts/apply_object_lifecycle.py --dry-run
docker cp scripts/apply_object_lifecycle.py labplot-backend:/tmp/apply_object_lifecycle.py
docker exec \
  -e OBJECT_STORAGE_BUCKET=labplot-prod \
  -e OBJECT_STORAGE_PREFIX=labplot \
  -e OBJECT_STORAGE_REGION=us-east-1 \
  -e OBJECT_STORAGE_ACCESS_KEY_ID="$OBJECT_STORAGE_ACCESS_KEY_ID" \
  -e OBJECT_STORAGE_SECRET_ACCESS_KEY="$OBJECT_STORAGE_SECRET_ACCESS_KEY" \
  labplot-backend sh -lc "cd /app/backend && /app/.pixi/envs/default/bin/python /tmp/apply_object_lifecycle.py"
```

The default lifecycle rules abort incomplete multipart uploads under the `uploads/` and `figures/` prefixes after seven days. Set `OBJECT_STORAGE_TRANSITION_DAYS` and `OBJECT_STORAGE_TRANSITION_CLASS` if your provider should transition older objects to another storage class.

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
scripts/run_production_smoke_suite.sh
```

The production smoke suite checks Python compilation, Docker Compose config, running service health, Alembic state, public uptime, API security controls, password reset, AI quota enforcement, prompt-injection neutralization, SVG sanitization, encrypted dataset upload, figure rendering, account export/delete, quotas, audit logs, object-storage asset paths, object migration, retention dry-run, key-rotation dry-run, client-error alert dry-run, object lifecycle dry-run, restore drill, and git whitespace hygiene.

## Backup And Restore

Database backup:

```bash
scripts/backup_labplot.sh
```

Manual equivalent:

```bash
mkdir -p backups
docker exec labplot-db pg_dump -U labplot -d labplot --format=custom > backups/labplot-$(date +%Y%m%d-%H%M%S).dump
tar -czf backups/labplot-files-$(date +%Y%m%d-%H%M%S).tgz backend/private backend/static/figures
```

Restore database:

```bash
cat backups/labplot.dump | docker exec -i labplot-db pg_restore -U labplot -d labplot --clean --if-exists
```

Restore file assets only from trusted backups. Keep `DATA_ENCRYPTION_KEY` with the backup metadata; encrypted datasets cannot be recovered without it.

Disaster recovery drill:

```bash
scripts/dr_restore_drill.sh
```

The drill creates a fresh database dump, validates the file asset archive, restores the dump into an isolated temporary Postgres container, checks the Alembic revision and core tables, reports elapsed restore time, and removes the temporary container unless `KEEP_RESTORE_CONTAINER=1` is set.

## Dataset Key Rotation

Use this when changing `DATA_ENCRYPTION_KEY`:

```bash
scripts/backup_labplot.sh
docker cp scripts/rotate_dataset_encryption.py labplot-backend:/tmp/rotate_dataset_encryption.py
docker exec labplot-backend sh -lc "cd /app/backend && /app/.pixi/envs/default/bin/python /tmp/rotate_dataset_encryption.py --dry-run"
docker exec labplot-backend sh -lc "cd /app/backend && /app/.pixi/envs/default/bin/python /tmp/rotate_dataset_encryption.py"
```

Keep the old key in `DATA_ENCRYPTION_PREVIOUS_KEYS` until the non-dry-run script reports success and newly uploaded plus old datasets have been opened successfully.

## Retention Cleanup

Run this on a scheduled maintenance interval:

```bash
docker cp scripts/retention_cleanup.py labplot-backend:/tmp/retention_cleanup.py
docker exec labplot-backend sh -lc "cd /app/backend && /app/.pixi/envs/default/bin/python /tmp/retention_cleanup.py --dry-run --orphan-files"
docker exec labplot-backend sh -lc "cd /app/backend && /app/.pixi/envs/default/bin/python /tmp/retention_cleanup.py --orphan-files"
```

The cleanup removes audit logs older than `AUDIT_LOG_RETENTION_DAYS`, expired or used password reset tokens older than `PASSWORD_RESET_TOKEN_RETENTION_DAYS`, client errors older than `CLIENT_ERROR_RETENTION_DAYS`, and optionally orphaned upload/render files.

## Uptime Checks

GitHub Actions runs `.github/workflows/uptime.yml` every 15 minutes against the public home page and health endpoint. Override `UPTIME_HEALTH_URL` and `UPTIME_HOME_URL` with repository variables if the production domain changes.

For external uptime alerts, set repository secret `UPTIME_ALERT_WEBHOOK_URL`. Set repository variable `UPTIME_ALERT_WEBHOOK_FORMAT` to `slack`, `discord`, or `generic` depending on the webhook receiver.

Manual check:

```bash
python scripts/uptime_check.py
ALERT_TITLE="LabPlot test" ALERT_MESSAGE="Webhook dry run" python scripts/send_alert.py --dry-run
```

## Client Error Alerts

Browser errors are stored in `client_error_events` and visible on the Admin page. Run this from cron or a systemd timer to alert when recent frontend errors exceed a threshold:

```bash
docker cp scripts/check_client_error_alerts.py labplot-backend:/tmp/check_client_error_alerts.py
docker exec \
  -e CLIENT_ERROR_ALERT_WINDOW_MINUTES=15 \
  -e CLIENT_ERROR_ALERT_THRESHOLD=25 \
  -e CLIENT_ERROR_ALERT_WEBHOOK_URL="$CLIENT_ERROR_ALERT_WEBHOOK_URL" \
  -e CLIENT_ERROR_ALERT_WEBHOOK_FORMAT=slack \
  labplot-backend sh -lc "cd /app/backend && /app/.pixi/envs/default/bin/python /tmp/check_client_error_alerts.py"
```

Use `CLIENT_ERROR_ALERT_WEBHOOK_FORMAT=slack`, `discord`, or `generic`. For a non-sending verification:

```bash
docker exec \
  -e CLIENT_ERROR_ALERT_THRESHOLD=1 \
  labplot-backend sh -lc "cd /app/backend && /app/.pixi/envs/default/bin/python /tmp/check_client_error_alerts.py --dry-run"
```

## Security Controls

- Authentication: access and refresh JWTs include `token_version`; password reset and admin reset invalidate old tokens.
- Password reset: configure SMTP before production. Without SMTP, reset links are not emailed.
- Authorization: users are scoped to their own projects, datasets, and figures. Admin endpoints require admin privileges.
- Upload storage: datasets are stored under `backend/private`, not public static routes. New private dataset files are encrypted at rest.
- Account data rights: authenticated users can export their account data as a ZIP and delete their own account after password confirmation.
- Render safety: R code is generated from fixed templates and validated JSON parameters. Users cannot submit arbitrary R code for execution.
- AI prompt safety: user-provided project and dataset context is wrapped as untrusted context. AI outputs are parsed as structured suggestions and sanitized before use.
- SVG edit safety: saved SVG edits reject script-like tags, event handlers, embedded file/data links, and oversized payloads.
- Edge hardening: Caddy owns public security headers and blocks `/static/uploads/*`.
- Auditability: account, dataset, figure, SVG-edit, and admin configuration events are written to `audit_logs`.
- Abuse control: rate limits are applied to auth, uploads, renders, SVG edits, and AI-heavy endpoints.
- Cost control: admin users can set per-user monthly AI request limits, render limits, and storage limits.
- Error monitoring: configure `SENTRY_DSN` to capture backend exceptions.
- Client monitoring: browser errors are posted to `/api/client-errors`, visible to admins, and can trigger threshold-based webhook alerts.
- Database migrations: startup runs Alembic `upgrade head`; `alembic_version` tracks applied schema revisions.
- Uptime monitoring: scheduled GitHub Actions checks validate the public home page and health endpoint, with optional webhook alerts on failure.
- Log retention: Docker services use capped json-file logs to prevent unbounded disk growth.

## Admin Operations

Review these areas from the Admin page:

- Pending users: approve only known accounts.
- AI provider settings: keep only the active provider key configured.
- AI usage and estimated cost: monitor monthly usage by user.
- User quotas: set AI, render, and storage limits for heavy users.
- Audit log: review recent account, admin, dataset, and figure events.

## Hosting Account Checklist

These are external account settings to apply when enabling S3/R2/MinIO-backed storage or a CDN. The application code paths and local filesystem-object smoke tests are included in this repository.

- Configure a production object-storage bucket, lifecycle policy, and optional CDN in the hosting account.
