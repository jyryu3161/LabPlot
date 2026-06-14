#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

docker exec labplot-db pg_dump -U labplot -d labplot --format=custom > "$BACKUP_DIR/labplot-$STAMP.dump"
tar -czf "$BACKUP_DIR/labplot-files-$STAMP.tgz" backend/private backend/static/figures

printf 'Wrote %s/labplot-%s.dump\n' "$BACKUP_DIR" "$STAMP"
printf 'Wrote %s/labplot-files-%s.tgz\n' "$BACKUP_DIR" "$STAMP"
