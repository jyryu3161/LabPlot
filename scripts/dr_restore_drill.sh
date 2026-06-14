#!/usr/bin/env bash
set -euo pipefail

SOURCE_DB_CONTAINER="${SOURCE_DB_CONTAINER:-labplot-db}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"
RESTORE_USER="${RESTORE_USER:-labplot}"
RESTORE_DB="${RESTORE_DB:-labplot}"
RESTORE_PASSWORD="${RESTORE_PASSWORD:-restore-drill}"
KEEP_RESTORE_CONTAINER="${KEEP_RESTORE_CONTAINER:-0}"

STAMP="$(date +%Y%m%d-%H%M%S)"
RESTORE_CONTAINER="${RESTORE_CONTAINER:-labplot-restore-drill-$STAMP-$$}"
WORK_DIR="$(mktemp -d)"
DUMP_PATH="$WORK_DIR/labplot.dump"
FILES_ARCHIVE="$WORK_DIR/labplot-files.tgz"
START_TS="$(date +%s)"

cleanup() {
  if [ "$KEEP_RESTORE_CONTAINER" != "1" ]; then
    docker rm -f "$RESTORE_CONTAINER" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

wait_for_restore_db() {
  local i
  for i in $(seq 1 60); do
    if docker exec "$RESTORE_CONTAINER" pg_isready -U "$RESTORE_USER" -d "$RESTORE_DB" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

check_table() {
  local table="$1"
  local exists
  exists="$(docker exec "$RESTORE_CONTAINER" psql -U "$RESTORE_USER" -d "$RESTORE_DB" -tAc "select to_regclass('public.$table') is not null" | tr -d '[:space:]')"
  if [ "$exists" != "t" ]; then
    printf 'FAIL missing restored table: %s\n' "$table" >&2
    exit 1
  fi
}

printf 'Creating database backup from %s...\n' "$SOURCE_DB_CONTAINER"
docker exec "$SOURCE_DB_CONTAINER" pg_dump -U "$RESTORE_USER" -d "$RESTORE_DB" --format=custom --no-owner --no-privileges > "$DUMP_PATH"

printf 'Creating file asset archive...\n'
tar -czf "$FILES_ARCHIVE" backend/private backend/static/figures
tar -tzf "$FILES_ARCHIVE" >/dev/null

printf 'Starting isolated restore container %s...\n' "$RESTORE_CONTAINER"
docker run -d \
  --name "$RESTORE_CONTAINER" \
  -e POSTGRES_USER="$RESTORE_USER" \
  -e POSTGRES_PASSWORD="$RESTORE_PASSWORD" \
  -e POSTGRES_DB="$RESTORE_DB" \
  "$POSTGRES_IMAGE" >/dev/null

wait_for_restore_db

printf 'Restoring database backup into isolated container...\n'
cat "$DUMP_PATH" | docker exec -i "$RESTORE_CONTAINER" pg_restore -U "$RESTORE_USER" -d "$RESTORE_DB" --clean --if-exists --no-owner --no-privileges

for table in \
  alembic_version \
  users \
  projects \
  datasets \
  figures \
  figure_versions \
  figure_code_artifacts \
  audit_logs \
  client_error_events; do
  check_table "$table"
done

ALEMBIC_VERSION="$(docker exec "$RESTORE_CONTAINER" psql -U "$RESTORE_USER" -d "$RESTORE_DB" -tAc "select version_num from alembic_version limit 1" | tr -d '[:space:]')"
USER_COUNT="$(docker exec "$RESTORE_CONTAINER" psql -U "$RESTORE_USER" -d "$RESTORE_DB" -tAc "select count(*) from users" | tr -d '[:space:]')"
DATASET_COUNT="$(docker exec "$RESTORE_CONTAINER" psql -U "$RESTORE_USER" -d "$RESTORE_DB" -tAc "select count(*) from datasets" | tr -d '[:space:]')"
FIGURE_COUNT="$(docker exec "$RESTORE_CONTAINER" psql -U "$RESTORE_USER" -d "$RESTORE_DB" -tAc "select count(*) from figures" | tr -d '[:space:]')"
END_TS="$(date +%s)"
ELAPSED="$((END_TS - START_TS))"

if [ -z "$ALEMBIC_VERSION" ]; then
  printf 'FAIL restored database has no alembic version\n' >&2
  exit 1
fi

printf 'PASS restore drill in %ss: alembic=%s users=%s datasets=%s figures=%s\n' \
  "$ELAPSED" "$ALEMBIC_VERSION" "$USER_COUNT" "$DATASET_COUNT" "$FIGURE_COUNT"
