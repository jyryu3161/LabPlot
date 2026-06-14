#!/usr/bin/env python3
"""Apply a conservative lifecycle policy to the configured object-storage bucket."""
from __future__ import annotations

import argparse
import json
import os
import sys


def _prefix() -> str:
    return (os.environ.get("OBJECT_STORAGE_PREFIX", "labplot") or "").strip("/")


def _rule(prefix: str) -> dict:
    abort_days = int(os.environ.get("OBJECT_STORAGE_ABORT_MULTIPART_DAYS", "7"))
    rule = {
        "ID": f"labplot-{prefix.replace('/', '-')}-multipart-cleanup",
        "Status": "Enabled",
        "Filter": {"Prefix": prefix.rstrip("/") + "/"},
        "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": abort_days},
    }
    transition_days = int(os.environ.get("OBJECT_STORAGE_TRANSITION_DAYS", "0"))
    transition_class = os.environ.get("OBJECT_STORAGE_TRANSITION_CLASS", "").strip()
    if transition_days > 0 and transition_class:
        rule["Transitions"] = [{"Days": transition_days, "StorageClass": transition_class}]
    return rule


def lifecycle_config() -> dict:
    prefix = _prefix()
    base = f"{prefix}/" if prefix else ""
    return {"Rules": [_rule(base + "uploads"), _rule(base + "figures")]}


def _s3_client():
    import boto3

    kwargs = {
        "region_name": os.environ.get("OBJECT_STORAGE_REGION") or None,
        "endpoint_url": os.environ.get("OBJECT_STORAGE_ENDPOINT_URL") or None,
    }
    access_key = os.environ.get("OBJECT_STORAGE_ACCESS_KEY_ID")
    secret_key = os.environ.get("OBJECT_STORAGE_SECRET_ACCESS_KEY")
    if access_key or secret_key:
        kwargs["aws_access_key_id"] = access_key
        kwargs["aws_secret_access_key"] = secret_key
    return boto3.client("s3", **{k: v for k, v in kwargs.items() if v})


def main() -> None:
    parser = argparse.ArgumentParser(description="Apply LabPlot object-storage lifecycle rules.")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    config = lifecycle_config()
    if args.dry_run:
        print(json.dumps(config, indent=2))
        return

    bucket = os.environ.get("OBJECT_STORAGE_BUCKET", "").strip()
    if not bucket:
        raise RuntimeError("OBJECT_STORAGE_BUCKET must be set")
    _s3_client().put_bucket_lifecycle_configuration(Bucket=bucket, LifecycleConfiguration=config)
    print(f"PASS applied object lifecycle policy to bucket {bucket}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"FAIL object lifecycle: {exc}", file=sys.stderr)
        raise
