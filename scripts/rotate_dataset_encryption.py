#!/usr/bin/env python3
"""Re-encrypt dataset files with the current DATA_ENCRYPTION_KEY.

Run inside the backend container:
  docker cp scripts/rotate_dataset_encryption.py labplot-backend:/tmp/rotate_dataset_encryption.py
  docker exec labplot-backend sh -lc "cd /app/backend && /app/.pixi/envs/default/bin/python /tmp/rotate_dataset_encryption.py --dry-run"
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.getcwd())

from app.ai import models as _ai_models  # noqa: F401
from app.audit import models as _audit_models  # noqa: F401
from app.auth import models as _auth_models  # noqa: F401
from app.projects import models as _project_models  # noqa: F401
from app.common import storage
from app.common.encryption import decrypt_private_bytes, encrypted_with_primary_key, encrypt_private_bytes
from app.database import SessionLocal
from app.datasets.models import Dataset
from app.figures import models as _figure_models  # noqa: F401


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    checked = 0
    changed = 0
    missing = 0
    with SessionLocal() as db:
        for (path,) in db.query(Dataset.file_path).all():
            checked += 1
            if not path or not storage.exists(path):
                missing += 1
                continue
            raw = storage.read_bytes(path)
            if encrypted_with_primary_key(raw):
                continue
            plain = decrypt_private_bytes(raw)
            encoded = encrypt_private_bytes(plain)
            changed += 1
            if not args.dry_run:
                storage.write_bytes(path, encoded, content_type="application/octet-stream")
    mode = "DRY-RUN" if args.dry_run else "UPDATED"
    print(f"{mode} dataset encryption rotation: checked={checked} changed={changed} missing={missing}")


if __name__ == "__main__":
    main()
