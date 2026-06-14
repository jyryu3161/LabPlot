#!/usr/bin/env python3
"""End-to-end LabPlot verification with the real root/root account.

The script creates two verification projects, uploads deterministic datasets,
renders figures covering all supported plot types, validates exported images,
and runs live AI recommendation/review/legend/improvement calls.

Run:
  python3 test_data/run_analysis.py [BASE_URL]
  python3 test_data/run_analysis.py [BASE_URL] --skip-ai
"""
from __future__ import annotations

import argparse
import subprocess
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from typing import Any

from PIL import Image, ImageStat

HERE = os.path.dirname(os.path.abspath(__file__))
PLOT_TYPES = {
    "box", "violin", "scatter", "bar", "line", "error_bar", "ribbon", "contour", "radar",
    "histogram", "density", "correlation_heatmap", "heatmap", "volcano", "pca", "kaplan_meier",
    "annotated_heatmap", "network", "enrichment_dot", "enrichment_bar", "manhattan", "chemical_space",
}
VERIFY_PREFIX = "LabPlot Verification:"
SAMPLES = "Ctrl_1 Ctrl_2 Ctrl_3 Trt_1 Trt_2 Trt_3".split()
FEATS = [f"Feature{i}" for i in range(1, 13)]

DATASETS = {
    "gene_expression": "gene_expression.csv",
    "dose_response": "dose_response.csv",
    "time_course": "time_course.csv",
    "deg_results": "deg_results.csv",
    "expression_matrix": "expression_matrix.csv",
    "pca_samples": "pca_samples.csv",
    "survival": "survival.csv",
    "cancer_cohort": "cancer_cohort.csv",
    "ppi_network": "ppi_network.csv",
    "enrichment": "enrichment.csv",
    "gwas": "gwas.csv",
    "compounds": "compounds.csv",
    "response_surface": "response_surface.csv",
    "tensile_test": "tensile_test.csv",
    "sensor_timeseries": "sensor_timeseries.csv",
    "material_profile": "material_profile.csv",
}

PROJECTS = {
    "omics": {
        "name": f"{VERIFY_PREFIX} Omics",
        "description": "RNA-seq style verification project with treatment groups, differential expression, expression matrices, and PCA-ready sample features.",
        "datasets": ["gene_expression", "deg_results", "expression_matrix", "pca_samples", "dose_response"],
    },
    "clinical": {
        "name": f"{VERIFY_PREFIX} Clinical",
        "description": "Clinical verification project with time-to-event data, treatment arms, and longitudinal response measurements.",
        "datasets": ["survival", "time_course", "gene_expression", "dose_response", "cancer_cohort"],
    },
    "domain": {
        "name": f"{VERIFY_PREFIX} Domain gallery",
        "description": "Domain-specific gallery examples covering networks, enrichment, GWAS, and cheminformatics.",
        "datasets": ["ppi_network", "enrichment", "gwas", "compounds"],
    },
    "engineering": {
        "name": f"{VERIFY_PREFIX} Engineering",
        "description": "Engineering and physical-science verification project with response surfaces, uncertainty intervals, and material profiles.",
        "datasets": ["response_surface", "tensile_test", "sensor_timeseries", "material_profile"],
    },
}

SCENARIOS = [
    ("omics", "gene_expression", "Expression by group (Box)", "box",
     {"x": "Group", "y": "Expression", "color": "Group"},
     {"show_points": True}, "nature"),
    ("omics", "gene_expression", "Mean expression (Bar mean)", "bar",
     {"x": "Group", "y": "Expression"},
     {"stat": "mean", "error_bars": True}, "cell"),
    ("omics", "gene_expression", "Group counts (Bar count)", "bar",
     {"x": "Group", "y": "Expression"},
     {"stat": "count", "error_bars": True}, "minimal"),
    ("omics", "gene_expression", "Expression vs viability (Scatter)", "scatter",
     {"x": "Expression", "y": "Viability", "color": "Group"},
     {"add_smooth": True}, "minimal"),
    ("omics", "gene_expression", "Expression histogram", "histogram",
     {"value": "Expression", "group": "Group"},
     {"bins": 18}, "minimal"),
    ("omics", "gene_expression", "Expression density", "density",
     {"value": "Expression", "group": "Group"},
     {"show_rug": True}, "science"),
    ("omics", "expression_matrix", "Expression heatmap (z-scored)", "heatmap",
     {"columns": SAMPLES, "row_label": "Gene"},
     {"scale_rows": True, "palette": "viridis"}, "nature"),
    ("omics", "deg_results", "Differential expression (Volcano)", "volcano",
     {"log2fc": "log2FC", "pvalue": "padj", "gene_label": "Gene"},
     {"fc_threshold": 1, "p_threshold": 0.05, "label_top": 15}, "science"),
    ("omics", "pca_samples", "PCA of samples", "pca",
     {"columns": FEATS, "color": "Group"},
     {}, "colorblind"),
    ("omics", "pca_samples", "Feature correlation heatmap", "correlation_heatmap",
     {"columns": FEATS[:8]},
     {"corr_method": "pearson", "show_values": True}, "minimal"),
    ("clinical", "gene_expression", "Viability distribution (Violin)", "violin",
     {"x": "Group", "y": "Viability", "color": "Group"},
     {"show_box": True, "show_points": True}, "science"),
    ("clinical", "time_course", "Time-course expression (Line)", "line",
     {"x": "Time", "y": "Expression", "group": "Treatment"},
     {}, "nature"),
    ("clinical", "survival", "Overall survival (Kaplan-Meier)", "kaplan_meier",
     {"time": "time", "status": "status", "group": "arm"},
     {}, "colorblind"),
    ("clinical", "dose_response", "Dose-response (Scatter)", "scatter",
     {"x": "Dose", "y": "Response", "color": "Compound"},
     {"add_smooth": True}, "cell"),
    ("clinical", "cancer_cohort", "Cohort annotated heatmap", "annotated_heatmap",
     {"columns": [f"GENE_{i}" for i in range(1, 16)], "annotations": ["Group", "Stage"], "row_label": "PatientID"},
     {"cluster_rows": True, "cluster_cols": True, "show_row_names": False}, "nature"),
    ("domain", "ppi_network", "Protein interaction network", "network",
     {"source": "source", "target": "target", "weight": "weight"},
     {"layout": "fr", "show_labels": True}, "nature"),
    ("domain", "enrichment", "Enrichment dot plot", "enrichment_dot",
     {"term": "Description", "value": "GeneRatio", "size": "Count", "color": "p.adjust"},
     {}, "cell"),
    ("domain", "enrichment", "Enrichment bar plot", "enrichment_bar",
     {"term": "Description", "value": "neg_log10_padj"},
     {}, "science"),
    ("domain", "gwas", "GWAS Manhattan plot", "manhattan",
     {"chrom": "CHR", "pos": "BP", "pvalue": "P"},
     {"sig_threshold": 5e-8}, "nature"),
    ("domain", "compounds", "Chemical descriptor space", "chemical_space",
     {"x": "MW", "y": "LogP", "color": "Activity", "size": "TPSA"},
     {}, "colorblind"),
    ("engineering", "response_surface", "Process response contour", "contour",
     {"x": "Temperature", "y": "Pressure", "z": "Yield"},
     {"bins": 12, "show_contour_lines": True, "palette": "viridis"}, "minimal"),
    ("engineering", "tensile_test", "Tensile strength uncertainty", "error_bar",
     {"x": "StrainRate", "y": "StrengthMean", "group": "Material", "error": "StrengthSD"},
     {"connect_points": True, "x_label": "Strain rate", "y_label": "Strength"}, "science"),
    ("engineering", "sensor_timeseries", "Sensor signal interval", "ribbon",
     {"x": "Time", "y": "SignalMean", "group": "Sensor", "ymin": "Lower", "ymax": "Upper"},
     {"x_label": "Time", "y_label": "Signal"}, "nature"),
    ("engineering", "material_profile", "Material profile radar", "radar",
     {"axis": "Metric", "value": "Score", "group": "Material"},
     {"y_label": "Score"}, "colorblind"),
]


class CheckFailed(RuntimeError):
    pass


def log(message: str) -> None:
    print(message, flush=True)


def ensure_example_data() -> None:
    missing = [name for name in DATASETS.values() if not os.path.exists(os.path.join(HERE, name))]
    if not missing:
        return
    log("example CSVs missing; regenerating deterministic test data")
    subprocess.run([sys.executable, os.path.join(HERE, "generate.py")], check=True)
    subprocess.run([sys.executable, os.path.join(HERE, "generate_domains.py")], check=True)


def _headers(token: str | None = None, extra: dict[str, str] | None = None) -> dict[str, str]:
    headers = dict(extra or {})
    if token:
        headers["Authorization"] = "Bearer " + token
    return headers


def _json_request(base: str, method: str, path: str, body: Any = None,
                  token: str | None = None, headers: dict[str, str] | None = None,
                  timeout: int = 180) -> tuple[int, Any]:
    data = None
    req_headers = _headers(token, headers)
    if body is not None and not isinstance(body, bytes):
        data = json.dumps(body).encode("utf-8")
        req_headers["Content-Type"] = "application/json"
    elif isinstance(body, bytes):
        data = body
    req = urllib.request.Request(base + path, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            if not raw:
                return resp.status, None
            return resp.status, json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "ignore")
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {"detail": raw}
        return exc.code, payload


def _raw_request(base: str, method: str, path: str, token: str | None = None,
                 timeout: int = 180) -> tuple[int, bytes, str]:
    req = urllib.request.Request(base + path, headers=_headers(token), method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), exc.headers.get("Content-Type", "")


def expect(status: int, payload: Any, wanted: int, label: str) -> Any:
    if status != wanted:
        raise CheckFailed(f"{label} failed: HTTP {status} {payload}")
    return payload


def retry_ai(label: str, call, attempts: int = 2) -> Any:
    last: tuple[int, Any] | None = None
    for attempt in range(1, attempts + 1):
        status, payload = call()
        if status == 200:
            return payload
        last = (status, payload)
        log(f"  [retry {attempt}/{attempts}] {label}: HTTP {status} {payload}")
        time.sleep(2)
    raise CheckFailed(f"{label} failed after {attempts} attempts: {last}")


def login(base: str) -> str:
    email = os.environ.get("ROOT_EMAIL", "root")
    password = os.environ.get("ROOT_PASSWORD", "root")
    status, payload = _json_request(base, "POST", "/api/auth/login", {"email": email, "password": password})
    return expect(status, payload, 200, "root login")["access_token"]


def upload_dataset(base: str, token: str, project_id: str, key: str) -> dict[str, Any]:
    filename = DATASETS[key]
    with open(os.path.join(HERE, filename), "rb") as f:
        file_bytes = f.read()
    boundary = "----LabPlot" + uuid.uuid4().hex
    parts = [
        (
            f"--{boundary}\r\n"
            f"Content-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
            "Content-Type: text/csv\r\n\r\n"
        ).encode("utf-8") + file_bytes,
        (
            f"\r\n--{boundary}\r\n"
            f"Content-Disposition: form-data; name=\"name\"\r\n\r\n{key}"
        ).encode("utf-8"),
        (
            f"\r\n--{boundary}\r\n"
            f"Content-Disposition: form-data; name=\"project_id\"\r\n\r\n{project_id}"
        ).encode("utf-8"),
        f"\r\n--{boundary}--\r\n".encode("utf-8"),
    ]
    status, payload = _json_request(
        base, "POST", "/api/datasets", b"".join(parts), token,
        {"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    return expect(status, payload, 201, f"upload {key}")


def create_clean_projects(base: str, token: str) -> dict[str, dict[str, Any]]:
    status, existing = _json_request(base, "GET", "/api/projects", token=token)
    expect(status, existing, 200, "list projects")
    for project in existing:
        if project["name"].startswith(VERIFY_PREFIX):
            status, payload = _json_request(base, "DELETE", f"/api/projects/{project['id']}", token=token)
            expect(status, payload, 204, f"delete previous project {project['name']}")

    created = {}
    for key, spec in PROJECTS.items():
        status, payload = _json_request(
            base, "POST", "/api/projects",
            {"name": spec["name"], "description": spec["description"]},
            token=token,
        )
        created[key] = expect(status, payload, 201, f"create project {key}")
        log(f"  [OK] project {created[key]['name']}")
    return created


def validate_png(label: str, data: bytes) -> tuple[int, int, float]:
    if len(data) < 5000:
        raise CheckFailed(f"{label} PNG is unexpectedly small ({len(data)} bytes)")
    img = Image.open(io.BytesIO(data)).convert("RGB")
    width, height = img.size
    if width < 600 or height < 400:
        raise CheckFailed(f"{label} PNG dimensions are too small: {width}x{height}")
    thumb = img.copy()
    thumb.thumbnail((160, 160))
    gray = thumb.convert("L")
    stddev = ImageStat.Stat(gray).stddev[0]
    if stddev < 2.0:
        raise CheckFailed(f"{label} PNG appears blank or nearly blank (stddev={stddev:.2f})")
    return width, height, stddev


def validate_exports(base: str, token: str, figure: dict[str, Any]) -> None:
    version_id = figure["current_version_id"]
    status, png, ctype = _raw_request(base, "GET", f"/api/figures/{figure['id']}/versions/{version_id}/export?format=png", token)
    if status != 200 or "image/png" not in ctype:
        raise CheckFailed(f"PNG export failed for {figure['name']}: HTTP {status} {ctype}")
    width, height, stddev = validate_png(figure["name"], png)

    for fmt, marker in [("svg", b"<svg"), ("pdf", b"%PDF"), ("r", b"# LabPlot AI")]:
        status, data, _ = _raw_request(base, "GET", f"/api/figures/{figure['id']}/versions/{version_id}/export?format={fmt}", token)
        if status != 200 or marker not in data[:500]:
            raise CheckFailed(f"{fmt.upper()} export failed for {figure['name']}: HTTP {status}")

    status, r_code, _ = _raw_request(base, "GET", f"/api/figures/{figure['id']}/versions/{version_id}/export?format=r", token)
    if figure["name"].endswith("(Bar count)") and b"geom_bar()" not in r_code:
        raise CheckFailed("bar count scenario did not use geom_bar(); options.stat was not honored")
    log(f"  [OK] image {figure['plot_type']:13s} {figure['name']} ({width}x{height}, sd={stddev:.1f})")


def validate_project_pack(base: str, token: str, project: dict[str, Any]) -> None:
    status, data, ctype = _raw_request(base, "GET", f"/api/projects/{project['id']}/export", token)
    if status != 200 or "zip" not in ctype.lower():
        raise CheckFailed(f"project pack failed for {project['name']}: HTTP {status} {ctype}")
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
    if not any(name.endswith(".png") for name in names) or not any(name.endswith(".R") for name in names):
        raise CheckFailed(f"project pack missing expected figure assets for {project['name']}")
    log(f"  [OK] project pack {project['name']} ({len(names)} files)")


def validate_version_delete(base: str, token: str, figure: dict[str, Any]) -> dict[str, Any]:
    original_version_id = figure["current_version_id"]
    status, version = _json_request(
        base,
        "POST",
        f"/api/figures/{figure['id']}/rerender",
        {
            "plot_type": figure["plot_type"],
            "mapping": figure["versions"][0]["mapping"],
            "options": {**figure["versions"][0]["options"], "font_scale": 1.05},
            "style_preset": figure["style_preset"],
            "change_note": "Version delete verification",
        },
        token=token,
        timeout=240,
    )
    version = expect(status, version, 200, "create second version for delete test")

    status, updated = _json_request(base, "GET", f"/api/figures/{figure['id']}", token=token)
    updated = expect(status, updated, 200, "reload versioned figure")
    if len(updated["versions"]) != 2:
        raise CheckFailed(f"expected 2 versions before delete, found {len(updated['versions'])}")

    status, after = _json_request(base, "DELETE", f"/api/figures/{figure['id']}/versions/{original_version_id}", token=token)
    after = expect(status, after, 200, "delete old figure version")
    if len(after["versions"]) != 1 or after["current_version_id"] != version["id"]:
        raise CheckFailed(f"version delete did not promote remaining version correctly: {after}")
    validate_exports(base, token, after)

    status, blocked = _json_request(base, "DELETE", f"/api/figures/{figure['id']}/versions/{version['id']}", token=token)
    if status != 400:
        raise CheckFailed(f"last-version delete was not blocked: HTTP {status} {blocked}")
    log(f"  [OK] version delete kept v{version['version_number']} and blocked deleting the last version")
    return after


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("base_url", nargs="?", default="http://localhost:8071")
    parser.add_argument("--skip-ai", action="store_true", help="skip live provider calls")
    args = parser.parse_args()
    base = args.base_url.rstrip("/")

    log(f"== LabPlot verification against {base} ==")
    ensure_example_data()
    token = login(base)
    log(f"logged in as {os.environ.get('ROOT_EMAIL', 'root')}")

    status, cfg = _json_request(base, "GET", "/api/admin/ai-config", token=token)
    expect(status, cfg, 200, "AI config")
    active_model = cfg["gemini_model"] if cfg["provider"] == "gemini" else cfg["claude_model"]
    log(f"AI provider: {cfg['provider']} / {active_model} (enabled={cfg['enabled']})")

    log("\n-- projects --")
    projects = create_clean_projects(base, token)

    log("\n-- uploading datasets --")
    dataset_ids: dict[tuple[str, str], str] = {}
    for project_key, spec in PROJECTS.items():
        for dataset_key in spec["datasets"]:
            ds = upload_dataset(base, token, projects[project_key]["id"], dataset_key)
            dataset_ids[(project_key, dataset_key)] = ds["id"]
            roles = ",".join(sorted({c["role"] for c in ds["column_profile"]}))
            log(f"  [OK] {project_key:8s} {dataset_key:18s} rows={ds['n_rows']:3d} roles=[{roles}]")

    log("\n-- rendering and validating figures --")
    figures: list[dict[str, Any]] = []
    for project_key, dataset_key, title, plot_type, mapping, options, style in SCENARIOS:
        status, fig = _json_request(
            base, "POST", "/api/figures",
            {
                "dataset_id": dataset_ids[(project_key, dataset_key)],
                "name": title,
                "plot_type": plot_type,
                "mapping": mapping,
                "options": options,
                "style_preset": style,
            },
            token=token,
            timeout=240,
        )
        fig = expect(status, fig, 201, f"create figure {title}")
        figures.append(fig)
        validate_exports(base, token, fig)

    covered = {fig["plot_type"] for fig in figures}
    if covered != PLOT_TYPES:
        raise CheckFailed(f"plot type coverage mismatch: missing {sorted(PLOT_TYPES - covered)}")

    log("\n-- figure version deletion --")
    delete_target_index = next(i for i, f in enumerate(figures) if f["plot_type"] == "box")
    figures[delete_target_index] = validate_version_delete(base, token, figures[delete_target_index])

    for project_key, project in projects.items():
        status, project_figs = _json_request(base, "GET", f"/api/figures?project_id={project['id']}", token=token)
        expect(status, project_figs, 200, f"list project figures {project_key}")
        if len(project_figs) < 3:
            raise CheckFailed(f"{project_key} has too few figures: {len(project_figs)}")
        validate_project_pack(base, token, project)

    if not args.skip_ai:
        if not cfg["enabled"]:
            raise CheckFailed("AI config is disabled")
        log("\n-- live AI recommendations --")
        for project_key, dataset_key in [("omics", "deg_results"), ("clinical", "survival")]:
            recs = retry_ai(
                f"recommend {project_key}/{dataset_key}",
                lambda pk=project_key, dk=dataset_key: _json_request(
                    base, "POST", f"/api/datasets/{dataset_ids[(pk, dk)]}/recommend", token=token, timeout=180
                ),
            )
            if not isinstance(recs, list) or not recs or not recs[0].get("suggested_mapping"):
                raise CheckFailed(f"AI recommendation missing suggested_mapping for {project_key}/{dataset_key}: {recs}")
            log(f"  [OK] {project_key}/{dataset_key}: " + ", ".join(f"{r['plot_type']}({r.get('score')})" for r in recs[:3]))

        log("\n-- live AI image review and legends --")
        review_targets = [fig for fig in figures if fig["plot_type"] in {"box", "heatmap", "volcano", "pca", "kaplan_meier"}]
        for fig in review_targets:
            review = retry_ai(
                f"review {fig['name']}",
                lambda f=fig: _json_request(
                    base, "POST", f"/api/figures/{f['id']}/versions/{f['current_version_id']}/review",
                    token=token, timeout=180
                ),
            )
            payload = review.get("payload", {})
            if not payload.get("summary") or not payload.get("visual_quality") or not payload.get("issues"):
                raise CheckFailed(f"review payload incomplete for {fig['name']}: {payload}")
            log(f"  [OK] review {fig['plot_type']:13s} score={review.get('publication_score')} {payload['summary'][:80]}")

        for fig in [figures[0], next(f for f in figures if f["plot_type"] == "kaplan_meier")]:
            legend = retry_ai(
                f"legend {fig['name']}",
                lambda f=fig: _json_request(
                    base, "POST", f"/api/figures/{f['id']}/versions/{f['current_version_id']}/legend",
                    token=token, timeout=180
                ),
            )
            if len((legend.get("legend") or "").strip()) < 40:
                raise CheckFailed(f"legend too short for {fig['name']}: {legend}")
            log(f"  [OK] legend {fig['plot_type']:13s} {legend['legend'][:80]}")

        log("\n-- live AI improve and apply --")
        target = next(fig for fig in figures if fig["plot_type"] == "bar" and "mean" in fig["name"].lower())
        improvements = retry_ai(
            f"improve {target['name']}",
            lambda: _json_request(
                base, "POST", f"/api/figures/{target['id']}/versions/{target['current_version_id']}/improve",
                token=token, timeout=180
            ),
        )
        if not improvements:
            raise CheckFailed("AI improve returned no suggestions")
        status, version = _json_request(base, "POST", f"/api/figures/{target['id']}/improvements/{improvements[0]['id']}/apply", token=token, timeout=240)
        version = expect(status, version, 200, "apply first improvement")
        status, updated = _json_request(base, "GET", f"/api/figures/{target['id']}", token=token)
        updated = expect(status, updated, 200, "reload improved figure")
        validate_exports(base, token, updated)
        log(f"  [OK] applied improvement -> v{version['version_number']}")

    status, all_figs = _json_request(base, "GET", "/api/figures", token=token)
    expect(status, all_figs, 200, "list all figures")
    verification_figs = [f for f in all_figs if f["project_id"] in {p["id"] for p in projects.values()}]
    log(f"\n== PASS: {len(projects)} projects, {len(verification_figs)} figures, {len(covered)} plot types verified ==")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CheckFailed as exc:
        print(f"\n== FAIL: {exc} ==", file=sys.stderr, flush=True)
        raise SystemExit(1)
