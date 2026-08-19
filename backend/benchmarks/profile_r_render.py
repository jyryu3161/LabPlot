#!/usr/bin/env python3
"""Profile LabPlot's R renderer without changing application behavior.

The benchmark uses the real generated R program and a deterministic 192-row,
16-column data frame.  It injects timing markers around package loading, data
loading, plot setup, every static output device, and the semantic-layout pass.
Run it inside the backend image so package/device availability matches runtime::

    python benchmarks/profile_r_render.py --repeats 3

Results are emitted as JSON, making the artifact suitable for retaining as a
baseline or feeding into a separate performance-budget check.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import statistics
import subprocess
import tempfile
import time

import numpy as np
import pandas as pd
from PIL import Image

from app.r_engine import renderer


BASE_OPTIONS = {
    "title": "Isolated render benchmark",
    "x_label": "Experimental condition",
    "y_label": "Response",
    "size": "wide",
    "dpi": 300,
    "base_size": 7,
    "font_family": "dejavu_sans",
    "axis_line_width_pt": 0.5,
    "data_line_width_pt": 0.8,
    "linewidth_scale": 1.0,
    "palette_name": "publication_muted_v2",
    "legend_position": "bottom",
}


def synthetic_frame() -> pd.DataFrame:
    rng = np.random.default_rng(20260818)
    rows = 192
    genotype = np.resize(np.array(["Control", "Knockout", "Mutant"]), rows)
    time_h = np.resize(np.array([0, 24, 48, 72]), rows)
    replicate = np.tile(np.arange(1, 17), 12)
    condition_index = pd.Categorical(genotype).codes
    response = 2.5 + condition_index * 0.55 + time_h * 0.018 + rng.normal(0, 0.35, rows)
    data: dict[str, object] = {
        "Genotype": genotype,
        "Time_h": time_h,
        "Replicate": replicate,
        "Expression": response,
    }
    # Twelve numeric features plus the four design/value columns = 16 columns.
    for index in range(1, 13):
        data[f"Feature_{index:02d}"] = (
            response * (0.45 + index * 0.04)
            + rng.normal(0, 0.25 + index * 0.015, rows)
        )
    frame = pd.DataFrame(data)
    assert frame.shape == (192, 16)
    return frame


CASES = {
    "grouped_bar": {
        "mapping": {"x": "Genotype", "y": "Expression", "group": "Time_h"},
        "options": {"show_points": True, "error_bars": True, "error_type": "sd"},
    },
    "line": {
        "mapping": {"x": "Time_h", "y": "Expression", "group": "Genotype"},
        "options": {"redundant_series_encoding": True},
    },
    "scatter": {
        "mapping": {"x": "Feature_01", "y": "Expression", "color": "Genotype"},
        "options": {"add_smooth": True},
    },
    "correlation_heatmap": {
        "mapping": {"columns": [f"Feature_{index:02d}" for index in range(1, 13)]},
        "options": {"show_values": True, "corr_method": "pearson"},
    },
}


_TIMER = r'''
.labplot_started <- proc.time()[["elapsed"]]
.labplot_last <- .labplot_started
.labplot_mark <- function(.name) {
  .now <- proc.time()[["elapsed"]]
  cat(sprintf("LABPLOT_PHASE|%s|%.6f|%.6f\n",
              .name, .now - .labplot_last, .now - .labplot_started))
  .labplot_last <<- .now
}
'''.lstrip()


def instrument(script: str) -> str:
    """Add elapsed-time markers while preserving the generated render logic."""
    result = _TIMER + script
    if renderer._HEADER not in result:
        raise RuntimeError("renderer package header changed; update benchmark marker")
    result = result.replace(
        renderer._HEADER,
        renderer._HEADER + '.labplot_mark("package_load")\n',
        1,
    )
    data_anchor = "df <- as.data.frame(df)\n"
    if data_anchor not in result:
        raise RuntimeError("renderer data-load anchor changed")
    result = result.replace(data_anchor, data_anchor + '.labplot_mark("data_load")\n', 1)

    export_anchor = ".pdf_device <- if (isTRUE(capabilities(\"cairo\"))"
    if export_anchor not in result:
        raise RuntimeError("renderer export anchor changed")
    result = result.replace(export_anchor, '.labplot_mark("plot_setup")\n' + export_anchor, 1)

    for extension in ("png", "svg", "tiff", "pdf"):
        pattern = re.compile(rf'(^ggsave\("figure\.{extension}"[^\n]*\)\n)', re.MULTILINE)
        result, count = pattern.subn(
            rf'\1.labplot_mark("export_{extension}")\n', result, count=1
        )
        if count != 1:
            raise RuntimeError(f"renderer {extension} export anchor changed")

    layout_anchor = "\ntryCatch({\n  .w <- "
    if layout_anchor not in result:
        raise RuntimeError("renderer layout start anchor changed")
    result = result.replace(layout_anchor, '\n.labplot_mark("export_eps")' + layout_anchor, 1)
    layout_end = '}, error = function(e) message("layout skip: ", conditionMessage(e)))\n'
    if layout_end not in result:
        raise RuntimeError("renderer layout end anchor changed")
    result = result.replace(layout_end, layout_end + '.labplot_mark("semantic_layout")\n', 1)
    result += '.labplot_mark("process_tail")\n'
    return result


def reuse_built_gtable(script: str) -> str:
    """Experimental optimization: build once, draw the same gtable everywhere."""
    export_anchor = '.pdf_device <- if (isTRUE(capabilities("cairo"))'
    if export_anchor not in script:
        raise RuntimeError("renderer export anchor changed")
    script = script.replace(
        export_anchor,
        ".labplot_built <- ggplot2::ggplot_build(p)\n"
        ".labplot_gtable <- ggplot2::ggplot_gtable(.labplot_built)\n"
        + export_anchor,
        1,
    )
    for extension in ("png", "svg", "tiff", "pdf", "eps"):
        script, count = re.subn(
            rf'(ggsave\("figure\.{extension}",\s+)p,',
            rf'\1.labplot_gtable,',
            script,
            count=1,
        )
        if count != 1:
            raise RuntimeError(f"renderer {extension} ggsave anchor changed")
    layout_build = (
        "  .gb <- ggplot2::ggplot_build(p)\n"
        "  .gt <- ggplot2::ggplot_gtable(.gb)\n"
    )
    if layout_build not in script:
        raise RuntimeError("renderer layout build anchor changed")
    return script.replace(
        layout_build,
        "  .gb <- .labplot_built\n  .gt <- .labplot_gtable\n",
        1,
    )


def phase_run(frame: pd.DataFrame, plot_type: str, case: dict, *, reuse_gtable: bool = False) -> dict:
    options = {**BASE_OPTIONS, **case["options"]}
    t0 = time.perf_counter()
    script = renderer.build_script(plot_type, case["mapping"], options, "nature")
    build_ms = (time.perf_counter() - t0) * 1000
    if reuse_gtable:
        script = reuse_built_gtable(script)
    script = instrument(script)

    with tempfile.TemporaryDirectory(prefix=f"labplot_perf_{plot_type}_") as work:
        csv_path = Path(work, "data.csv")
        t0 = time.perf_counter()
        frame.to_csv(csv_path, index=False)
        csv_ms = (time.perf_counter() - t0) * 1000
        Path(work, "figure.R").write_text(script, encoding="utf-8")
        t0 = time.perf_counter()
        proc = subprocess.run(
            [renderer._rscript_bin(), "figure.R"],
            cwd=work,
            capture_output=True,
            text=True,
            timeout=180,
            env=renderer._scrubbed_env(work),
            preexec_fn=renderer._resource_limit_preexec(),
        )
        process_ms = (time.perf_counter() - t0) * 1000
        if proc.returncode:
            raise RuntimeError(f"{plot_type} render failed:\n{proc.stdout}\n{proc.stderr}")
        phases: dict[str, float] = {}
        cumulative_ms = 0.0
        for line in proc.stdout.splitlines():
            match = re.fullmatch(r"LABPLOT_PHASE\|([^|]+)\|([0-9.]+)\|([0-9.]+)", line)
            if match:
                phases[match.group(1)] = float(match.group(2)) * 1000
                cumulative_ms = float(match.group(3)) * 1000
        expected = {
            "package_load", "data_load", "plot_setup", "export_png", "export_svg",
            "export_tiff", "export_pdf", "export_eps", "semantic_layout", "process_tail",
        }
        missing = expected.difference(phases)
        if missing:
            raise RuntimeError(f"missing timing phases for {plot_type}: {sorted(missing)}")
        output_sizes = {
            ext: Path(work, f"figure.{ext}").stat().st_size
            for ext in ("png", "svg", "tiff", "pdf", "eps")
            if Path(work, f"figure.{ext}").exists()
        }
        output_sha256 = {
            ext: hashlib.sha256(Path(work, f"figure.{ext}").read_bytes()).hexdigest()
            for ext in ("png", "svg")
            if Path(work, f"figure.{ext}").exists()
        }
        t0 = time.perf_counter()
        with tempfile.TemporaryDirectory(prefix="labplot_perf_copy_") as copy_dir:
            for ext in output_sizes:
                shutil.copyfile(Path(work, f"figure.{ext}"), Path(copy_dir, f"figure.{ext}"))
            if Path(work, "figure_layout.json").exists():
                shutil.copyfile(
                    Path(work, "figure_layout.json"), Path(copy_dir, "figure_layout.json")
                )
        copy_ms = (time.perf_counter() - t0) * 1000
    return {
        "build_script_ms": build_ms,
        "csv_write_ms": csv_ms,
        "r_process_wall_ms": process_ms,
        "r_measured_ms": cumulative_ms,
        "process_spawn_exit_ms": max(0.0, process_ms - cumulative_ms),
        "artifact_copy_ms": copy_ms,
        "phases_ms": phases,
        "output_bytes": output_sizes,
        "output_sha256": output_sha256,
    }


def summarize(samples: list[dict]) -> dict:
    scalar_keys = (
        "build_script_ms", "csv_write_ms", "r_process_wall_ms", "r_measured_ms",
        "process_spawn_exit_ms", "artifact_copy_ms",
    )
    summary: dict[str, object] = {"samples": samples}
    summary["median_ms"] = {
        key: statistics.median(sample[key] for sample in samples) for key in scalar_keys
    }
    phase_names = samples[0]["phases_ms"].keys()
    summary["phase_median_ms"] = {
        key: statistics.median(sample["phases_ms"][key] for sample in samples)
        for key in phase_names
    }
    summary["output_bytes"] = samples[-1]["output_bytes"]
    summary["output_sha256"] = samples[-1]["output_sha256"]
    return summary


def _render_png_for_visual_check(frame: pd.DataFrame, plot_type: str, case: dict,
                                 *, reuse_gtable: bool) -> np.ndarray:
    options = {**BASE_OPTIONS, **case["options"]}
    script = renderer.build_script(plot_type, case["mapping"], options, "nature")
    if reuse_gtable:
        script = reuse_built_gtable(script)
    with tempfile.TemporaryDirectory(prefix=f"labplot_perf_visual_{plot_type}_") as work:
        frame.to_csv(Path(work, "data.csv"), index=False)
        Path(work, "figure.R").write_text(script, encoding="utf-8")
        proc = subprocess.run(
            [renderer._rscript_bin(), "figure.R"], cwd=work, capture_output=True,
            text=True, timeout=180, env=renderer._scrubbed_env(work),
            preexec_fn=renderer._resource_limit_preexec(),
        )
        if proc.returncode:
            raise RuntimeError(f"visual-check render failed:\n{proc.stdout}\n{proc.stderr}")
        with Image.open(Path(work, "figure.png")) as image:
            return np.asarray(image.convert("RGB"), dtype=np.int16)


def compare_gtable_visual(frame: pd.DataFrame, plot_type: str, case: dict) -> dict:
    baseline = _render_png_for_visual_check(frame, plot_type, case, reuse_gtable=False)
    candidate = _render_png_for_visual_check(frame, plot_type, case, reuse_gtable=True)
    if baseline.shape != candidate.shape:
        return {"same_dimensions": False, "baseline_shape": baseline.shape,
                "candidate_shape": candidate.shape}
    delta = np.abs(baseline - candidate)
    pixel_delta = np.max(delta, axis=2)
    return {
        "same_dimensions": True,
        "shape": list(baseline.shape),
        "changed_pixel_fraction": float(np.mean(pixel_delta > 0)),
        "changed_pixel_fraction_gt_8": float(np.mean(pixel_delta > 8)),
        "mean_abs_channel_delta": float(np.mean(delta)),
        "p99_pixel_delta": float(np.percentile(pixel_delta, 99)),
        "max_pixel_delta": int(np.max(pixel_delta)),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--cases", nargs="*", choices=CASES, default=list(CASES))
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--summary-only",
        action="store_true",
        help="omit raw samples from stdout/output while retaining medians",
    )
    parser.add_argument(
        "--visual-check-gtable",
        action="store_true",
        help="compare current and gtable-reuse PNG pixels (expensive)",
    )
    parser.add_argument(
        "--visual-only",
        action="store_true",
        help="skip timing samples and run only the gtable pixel comparison",
    )
    parser.add_argument(
        "--reuse-gtable",
        action="store_true",
        help="measure an experimental build-once/gtable-reuse transformation",
    )
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error("--repeats must be at least 1")
    frame = synthetic_frame()
    report = {
        "environment": {
            "rscript": renderer._rscript_bin(),
            "rows": frame.shape[0],
            "columns": frame.shape[1],
            "dpi": BASE_OPTIONS["dpi"],
            "size": BASE_OPTIONS["size"],
            "repeats": args.repeats,
        },
        "cases": {},
    }
    for plot_type in args.cases:
        if args.visual_only:
            report["cases"][plot_type] = {}
        else:
            samples = [
                phase_run(frame, plot_type, CASES[plot_type], reuse_gtable=args.reuse_gtable)
                for _ in range(args.repeats)
            ]
            report["cases"][plot_type] = summarize(samples)
        if args.visual_check_gtable or args.visual_only:
            report["cases"][plot_type]["gtable_visual_diff"] = compare_gtable_visual(
                frame, plot_type, CASES[plot_type]
            )
    if args.summary_only:
        for result in report["cases"].values():
            result.pop("samples", None)
    rendered = json.dumps(report, indent=2, sort_keys=True)
    if args.output:
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
