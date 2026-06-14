#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BACKEND_CONTAINER="${BACKEND_CONTAINER:-labplot-backend}"
API_BASE="${API_BASE:-http://127.0.0.1:8000}"
SMOKE_ADMIN_EMAIL="smoke-admin-$(date +%s)-$RANDOM@example.com"
SMOKE_ADMIN_PASSWORD="SmokeAdminPass12345"

log() {
  printf '\n==> %s\n' "$*"
}

backend_py() {
  docker exec "$BACKEND_CONTAINER" sh -lc "cd /app/backend && /app/.pixi/envs/default/bin/python $*"
}

cleanup_admin() {
  docker exec -e SMOKE_ADMIN_EMAIL="$SMOKE_ADMIN_EMAIL" "$BACKEND_CONTAINER" sh -lc 'cd /app/backend && /app/.pixi/envs/default/bin/python - <<'"'"'PY'"'"'
import os
from app.ai import models as _ai_models  # noqa
from app.audit import models as _audit_models  # noqa
from app.client_errors import models as _client_error_models  # noqa
from app.datasets import models as _dataset_models  # noqa
from app.figures import models as _figure_models  # noqa
from app.projects import models as _project_models  # noqa
from app.database import SessionLocal
from app.auth.models import User
with SessionLocal() as db:
    db.query(User).filter(User.email == os.environ["SMOKE_ADMIN_EMAIL"]).delete(synchronize_session=False)
    db.commit()
PY' >/dev/null 2>&1 || true
}
trap cleanup_admin EXIT

log "Python compile"
PYTHONPYCACHEPREFIX=/tmp/labplot-pycache python -m py_compile $(find backend/app backend/alembic scripts -name '*.py' -not -path '*/__pycache__/*' -print)

log "Docker compose config"
docker compose config --quiet
docker compose ps

log "Database migration state"
docker exec "$BACKEND_CONTAINER" sh -lc 'cd /app/backend && /app/.pixi/envs/default/bin/alembic current'

log "Public uptime"
python scripts/uptime_check.py

log "Security smoke"
python scripts/smoke_security.py

log "Service smoke"
docker cp scripts/smoke_services.py "$BACKEND_CONTAINER":/tmp/smoke_services.py
backend_py /tmp/smoke_services.py

log "API smoke with temporary admin"
docker cp scripts/smoke_api.py "$BACKEND_CONTAINER":/tmp/smoke_api.py
docker exec \
  -e SMOKE_ADMIN_EMAIL="$SMOKE_ADMIN_EMAIL" \
  -e SMOKE_ADMIN_PASSWORD="$SMOKE_ADMIN_PASSWORD" \
  "$BACKEND_CONTAINER" sh -lc 'cd /app/backend && /app/.pixi/envs/default/bin/python - <<'"'"'PY'"'"'
import os
from app.ai import models as _ai_models  # noqa
from app.audit import models as _audit_models  # noqa
from app.client_errors import models as _client_error_models  # noqa
from app.datasets import models as _dataset_models  # noqa
from app.figures import models as _figure_models  # noqa
from app.projects import models as _project_models  # noqa
from app.database import SessionLocal
from app.auth.models import User
from app.auth.service import _hash_password
with SessionLocal() as db:
    db.add(User(
        email=os.environ["SMOKE_ADMIN_EMAIL"],
        hashed_password=_hash_password(os.environ["SMOKE_ADMIN_PASSWORD"]),
        display_name="Smoke Admin",
        is_active=True,
        is_approved=True,
        is_admin=True,
    ))
    db.commit()
PY'
docker exec \
  -e ROOT_EMAIL="$SMOKE_ADMIN_EMAIL" \
  -e ROOT_PASSWORD="$SMOKE_ADMIN_PASSWORD" \
  -e API_BASE="$API_BASE" \
  "$BACKEND_CONTAINER" sh -lc 'cd /app/backend && /app/.pixi/envs/default/bin/python /tmp/smoke_api.py'
cleanup_admin

log "Object storage smoke"
docker cp scripts/smoke_object_storage.py "$BACKEND_CONTAINER":/tmp/smoke_object_storage.py
docker exec \
  -e STORAGE_BACKEND=filesystem_object \
  -e OBJECT_STORAGE_BUCKET=labplot-smoke \
  -e OBJECT_STORAGE_LOCAL_DIR=/tmp/labplot-object-smoke/store \
  -e OBJECT_STORAGE_CACHE_DIR=/tmp/labplot-object-smoke/cache \
  "$BACKEND_CONTAINER" sh -lc 'cd /app/backend && /app/.pixi/envs/default/bin/python /tmp/smoke_object_storage.py'

log "Object migration smoke"
docker cp scripts/migrate_assets_to_object_storage.py "$BACKEND_CONTAINER":/tmp/migrate_assets_to_object_storage.py
docker cp scripts/smoke_object_migration.py "$BACKEND_CONTAINER":/tmp/smoke_object_migration.py
docker exec \
  -e MIGRATION_SCRIPT_PATH=/tmp/migrate_assets_to_object_storage.py \
  "$BACKEND_CONTAINER" sh -lc 'cd /app/backend && /app/.pixi/envs/default/bin/python /tmp/smoke_object_migration.py'

log "Operational scripts"
docker cp scripts/rotate_dataset_encryption.py "$BACKEND_CONTAINER":/tmp/rotate_dataset_encryption.py
backend_py '/tmp/rotate_dataset_encryption.py --dry-run'
docker cp scripts/retention_cleanup.py "$BACKEND_CONTAINER":/tmp/retention_cleanup.py
backend_py '/tmp/retention_cleanup.py --dry-run --orphan-files'
docker cp scripts/check_client_error_alerts.py "$BACKEND_CONTAINER":/tmp/check_client_error_alerts.py
docker exec -e CLIENT_ERROR_ALERT_THRESHOLD=25 "$BACKEND_CONTAINER" sh -lc 'cd /app/backend && /app/.pixi/envs/default/bin/python /tmp/check_client_error_alerts.py --dry-run'
docker cp scripts/apply_object_lifecycle.py "$BACKEND_CONTAINER":/tmp/apply_object_lifecycle.py
docker exec -e OBJECT_STORAGE_BUCKET=labplot-prod "$BACKEND_CONTAINER" sh -lc 'cd /app/backend && /app/.pixi/envs/default/bin/python /tmp/apply_object_lifecycle.py --dry-run >/tmp/object_lifecycle.json && test -s /tmp/object_lifecycle.json'

log "Disaster recovery drill"
scripts/dr_restore_drill.sh

log "Git hygiene"
git diff --check

printf '\nPASS production smoke suite\n'
