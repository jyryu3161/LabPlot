"""Deterministic grounding and colour-accessibility checks for figure AI.

The language model is allowed to phrase grounded facts, but it is not the
authority for numeric values or accessibility verdicts.  This module builds a
small factual contract from the stored dataset/render options, removes numeric
sentences that cannot be traced to that contract, and calculates colour checks
from the resolved colours used by the plot.
"""
from __future__ import annotations

from decimal import Decimal, InvalidOperation
from functools import lru_cache
import itertools
import math
import os
import re
import subprocess
import tempfile
from typing import Any, Literal

import pandas as pd
from pydantic import BaseModel, ConfigDict

from app.config import settings
from app.r_engine.presets import NAMED_PALETTES, NAMED_PALETTE_STROKES, PALETTES


GROUNDING_SCHEMA_VERSION = "1.0"
ACCESSIBILITY_SCHEMA_VERSION = "1.0"
_HEX_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
_NUMBER_RE = re.compile(
    r"(?<![A-Za-z0-9_])[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?%?(?![A-Za-z0-9_])"
)
_UNGROUNDED_SAMPLE_SIZE_RE = re.compile(
    r"(?:\b(?:n\s*=|samples?|subjects?|participants?|patients?|donors?|animals?|mice|biological\s+replicates?)\b|"
    r"표본\s*(?:수|크기)?|피험자\s*수)",
    re.IGNORECASE,
)
_UNGROUNDED_INFERENCE_RE = re.compile(
    r"(?:\bp\s*[<=>]|\bp\s*[- ]?value|confidence\s+interval|effect\s+size|유의|p\s*값)",
    re.IGNORECASE,
)
_ROW_CLAIM_RE = re.compile(r"([-+]?\d+(?:\.\d+)?)\s+(?:source[- ]data\s+)?rows?\b", re.IGNORECASE)
_GROUP_COUNT_CLAIM_RE = re.compile(r"([-+]?\d+(?:\.\d+)?)\s+(?:groups?|series|levels?)\b", re.IGNORECASE)
_RANGE_CLAIM_RE = re.compile(
    r"ranges?\s+from\s+([-+]?\d+(?:\.\d+)?)\s+to\s+([-+]?\d+(?:\.\d+)?)",
    re.IGNORECASE,
)
_PACKAGE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9.]*$")
_PAIRWISE_THRESHOLD = 10.0
_CONTRAST_THRESHOLD = 3.0


class _StrictContract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AccessibilityPaletteContract(_StrictContract):
    status: Literal["evaluated", "not_evaluable"]
    source: str | None
    colors: list[str]
    series_count: int | None
    reason: str | None


class CVDSimulationContract(_StrictContract):
    mode: Literal["protanopia", "deuteranopia", "tritanopia"]
    status: Literal["pass", "needs_review", "not_evaluable"]
    min_delta_e: float | None
    closest_pair: list[str] | None


class CVDContract(_StrictContract):
    status: Literal["pass", "needs_review", "not_evaluable"]
    method: Literal["deterministic_srgb_matrix_delta_e76_v1"]
    threshold_delta_e: float
    simulations: list[CVDSimulationContract]
    reason: str | None


class GrayscaleContract(_StrictContract):
    status: Literal["pass", "needs_review", "not_evaluable"]
    method: Literal["cie_lab_lightness_delta_v1"]
    threshold_delta_l: float
    min_delta_l: float | None
    closest_pair: list[str] | None
    reason: str | None


class ContrastContract(_StrictContract):
    status: Literal["pass", "needs_review", "not_evaluable"]
    method: Literal["wcag_relative_luminance"]
    threshold_ratio: float
    ratio: float | None
    foreground: str | None
    background: str
    reason: str | None


class AccessibilityChecksContract(_StrictContract):
    schema_version: Literal["1.0"]
    palette: AccessibilityPaletteContract
    cvd: CVDContract
    grayscale: GrayscaleContract
    minimum_contrast: ContrastContract


def _json_number(value: Any) -> int | float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    if number.is_integer():
        return int(number)
    return float(f"{number:.8g}")


def _display_number(value: Any) -> str:
    number = _json_number(value)
    if number is None:
        return str(value)
    return str(number)


def _profile_lookup(column_profile: list[dict] | None) -> dict[str, dict]:
    return {
        str(item.get("name")): item
        for item in (column_profile or [])
        if isinstance(item, dict) and item.get("name") not in (None, "")
    }


def _level_sort_key(value: Any) -> tuple[int, Any]:
    number = _json_number(value)
    return (0, float(number)) if number is not None else (1, str(value).casefold())


def _exact_levels(profile: dict, series: pd.Series | None, *, sort_levels: bool = False) -> tuple[list[str], bool]:
    if series is not None:
        raw_values = list(pd.unique(series.dropna()))
        if sort_levels:
            raw_values = sorted(raw_values, key=_level_sort_key)
        values = [str(value) for value in raw_values]
        if len(values) <= 50:
            return values, True
        return values[:50], False
    sample = [str(value) for value in (profile.get("sample_values") or []) if value is not None]
    try:
        unique_count = int(profile.get("n_unique"))
    except (TypeError, ValueError):
        unique_count = -1
    if sort_levels:
        sample = sorted(sample, key=_level_sort_key)
    return sample, unique_count >= 0 and unique_count == len(sample)


def _mapped_column_fact(profile: dict, n_rows: int, series: pd.Series | None,
                        *, force_levels: bool = False, sort_levels: bool = False) -> dict:
    result: dict[str, Any] = {
        "name": str(profile.get("name") or ""),
        "role": str(profile.get("role") or ""),
        "dtype": str(profile.get("dtype") or ""),
    }
    if profile.get("n_missing") is not None:
        try:
            missing = max(0, int(profile.get("n_missing")))
            result["non_missing_rows"] = max(0, int(n_rows) - missing)
        except (TypeError, ValueError):
            pass
    try:
        result["unique_values"] = max(0, int(profile.get("n_unique")))
    except (TypeError, ValueError):
        pass

    if series is not None:
        numeric = pd.to_numeric(series, errors="coerce").dropna()
        if len(numeric):
            result["range"] = {
                "min": _json_number(numeric.min()),
                "max": _json_number(numeric.max()),
            }
    if "range" not in result and isinstance(profile.get("stats"), dict):
        minimum = _json_number(profile["stats"].get("min"))
        maximum = _json_number(profile["stats"].get("max"))
        if minimum is not None and maximum is not None:
            result["range"] = {"min": minimum, "max": maximum}

    dtype = str(profile.get("dtype") or "")
    role = str(profile.get("role") or "")
    if force_levels or dtype in {"categorical", "text"} or role in {"group", "category", "status", "id", "replicate"}:
        levels, complete = _exact_levels(profile, series, sort_levels=sort_levels)
        result["levels"] = levels
        result["levels_complete"] = complete
    return result


def _representation(plot_type: str, mapping: dict, options: dict) -> dict:
    options = options or {}
    summary: str | None = None
    error_bars = bool(options.get("error_bars", False))
    if plot_type == "bar":
        summary = str(options.get("stat") or mapping.get("stat") or ("mean" if mapping.get("y") else "count"))
        if summary == "mean" and "error_bars" not in options:
            error_bars = True
    elif plot_type == "grouped_bar":
        summary = str(options.get("stat") or "mean")

    individual_default = plot_type in {"box", "scatter"}
    individual = bool(options.get("show_points", individual_default))
    error_type = str(options.get("error_type") or "sd") if error_bars else None
    return {
        "summary": summary,
        "individual_observations": individual,
        "error_bars": error_bars,
        "error_type": error_type,
    }


def _descriptive_trends(dataframe: pd.DataFrame | None, mapping: dict) -> list[dict]:
    if dataframe is None or not isinstance(dataframe, pd.DataFrame):
        return []
    x_name, y_name = mapping.get("x"), mapping.get("y")
    if not isinstance(x_name, str) or not isinstance(y_name, str):
        return []
    if x_name not in dataframe.columns or y_name not in dataframe.columns:
        return []
    work = dataframe[[x_name, y_name]].copy()
    work[".x"] = pd.to_numeric(work[x_name], errors="coerce")
    work[".y"] = pd.to_numeric(work[y_name], errors="coerce")
    group_name = next(
        (mapping.get(key) for key in ("group", "color", "fill", "series") if isinstance(mapping.get(key), str)),
        None,
    )
    if group_name and group_name in dataframe.columns:
        work[".series"] = dataframe[group_name].astype("string")
    else:
        work[".series"] = "all"
    work = work.dropna(subset=[".x", ".y", ".series"])
    if work[".x"].nunique() < 2:
        return []
    results: list[dict] = []
    for series_value, subset in work.groupby(".series", sort=False, dropna=True):
        means = subset.groupby(".x", sort=True)[".y"].mean().dropna()
        if len(means) < 2:
            continue
        first_x, last_x = means.index[0], means.index[-1]
        first_mean, last_mean = float(means.iloc[0]), float(means.iloc[-1])
        tolerance = max(abs(first_mean), abs(last_mean), 1.0) * 1e-12
        if last_mean > first_mean + tolerance:
            direction = "increased"
        elif last_mean < first_mean - tolerance:
            direction = "decreased"
        else:
            direction = "unchanged"
        results.append({
            "series": str(series_value),
            "first_x": _json_number(first_x),
            "last_x": _json_number(last_x),
            "first_mean": _json_number(first_mean),
            "last_mean": _json_number(last_mean),
            "direction": direction,
            "basis": "arithmetic_mean_of_available_rows_at_each_x",
        })
        if len(results) >= 12:
            break
    return results


def build_dataset_grounding(*, n_rows: int, column_profile: list[dict] | None,
                            mapping: dict | None, options: dict | None,
                            plot_type: str, dataframe: pd.DataFrame | None = None) -> dict:
    """Build the only numeric/data context figure-writing AI may assert."""
    mapping = mapping or {}
    options = options or {}
    lookup = _profile_lookup(column_profile)
    mapped: dict[str, dict] = {}
    for mapping_key, column_name in mapping.items():
        if not isinstance(column_name, str) or column_name not in lookup:
            continue
        series = dataframe[column_name] if dataframe is not None and column_name in dataframe.columns else None
        force_levels = mapping_key in {"group", "color", "fill", "series"}
        mapped[mapping_key] = _mapped_column_fact(
            lookup[column_name], n_rows, series,
            force_levels=force_levels,
            # R's factor() determines the colour-scale level order for these
            # mappings.  Sorting here mirrors that render contract instead of
            # assuming first-row order.
            sort_levels=force_levels,
        )

    series_key = next((key for key in ("group", "color", "fill", "series") if key in mapped), None)
    if series_key is None and plot_type in {"box", "violin"} and "x" in mapped:
        series_key = "x"
    if series_key is None and plot_type == "bar" and options.get("color_bars") and "x" in mapped:
        series_key = "x"
    series_fact: dict[str, Any] | None = None
    if series_key:
        source = mapped[series_key]
        series_fact = {
            "mapping_key": series_key,
            "column": source.get("name"),
            "levels": list(source.get("levels") or []),
            "levels_complete": bool(source.get("levels_complete", False)),
        }

    return {
        "schema_version": GROUNDING_SCHEMA_VERSION,
        "total_rows": max(0, int(n_rows or 0)),
        "row_count_semantics": "source_data_rows_not_independent_sample_size",
        "mapped_columns": mapped,
        "series": series_fact,
        "representation": _representation(plot_type, mapping, options),
        "descriptive_trends": _descriptive_trends(dataframe, mapping),
    }


def _numeric_atoms(value: Any) -> set[Decimal]:
    atoms: set[Decimal] = set()
    if isinstance(value, bool) or value is None:
        return atoms
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return atoms
        try:
            atoms.add(Decimal(str(value)).normalize())
        except InvalidOperation:
            pass
        return atoms
    if isinstance(value, str):
        for match in _NUMBER_RE.finditer(value):
            raw = match.group(0).rstrip("%")
            try:
                atoms.add(Decimal(raw).normalize())
            except InvalidOperation:
                continue
        return atoms
    if isinstance(value, dict):
        for child in value.values():
            atoms.update(_numeric_atoms(child))
    elif isinstance(value, (list, tuple, set)):
        for child in value:
            atoms.update(_numeric_atoms(child))
    return atoms


def _decimal(value: str) -> Decimal | None:
    try:
        return Decimal(value).normalize()
    except InvalidOperation:
        return None


def _numeric_semantics_supported(sentence: str, grounding: dict) -> bool:
    row_match = _ROW_CLAIM_RE.search(sentence)
    if row_match:
        claimed = _decimal(row_match.group(1))
        expected = _decimal(str(grounding.get("total_rows")))
        if claimed is None or expected is None or claimed != expected:
            return False

    count_match = _GROUP_COUNT_CLAIM_RE.search(sentence)
    if count_match:
        series = grounding.get("series")
        levels = series.get("levels") if isinstance(series, dict) and series.get("levels_complete") else None
        claimed = _decimal(count_match.group(1))
        if not isinstance(levels, list) or claimed != Decimal(len(levels)):
            return False

    for range_match in _RANGE_CLAIM_RE.finditer(sentence):
        claimed = (_decimal(range_match.group(1)), _decimal(range_match.group(2)))
        supported_ranges = set()
        for fact in (grounding.get("mapped_columns") or {}).values():
            value_range = fact.get("range") if isinstance(fact, dict) else None
            if isinstance(value_range, dict):
                minimum = _decimal(str(value_range.get("min")))
                maximum = _decimal(str(value_range.get("max")))
                if minimum is not None and maximum is not None:
                    supported_ranges.add((minimum, maximum))
        if claimed not in supported_ranges:
            return False
    return True


def ground_generated_text(text: str, grounding: dict | None) -> str:
    """Drop complete sentences containing a numeric claim absent from grounding."""
    if not isinstance(text, str) or not text.strip():
        return ""
    allowed = _numeric_atoms(grounding or {})
    representation = (grounding or {}).get("representation") if isinstance(grounding, dict) else None
    if isinstance(representation, dict) and representation.get("error_type") == "ci95":
        allowed.add(Decimal("95"))
    kept: list[str] = []
    for sentence in re.split(r"(?<=[.!?])\s+|\n+", text.strip()):
        sentence = sentence.strip()
        if not sentence:
            continue
        claims = _numeric_atoms(sentence)
        unsupported_semantics = bool(
            claims
            and (
                _UNGROUNDED_SAMPLE_SIZE_RE.search(sentence)
                or (
                    _UNGROUNDED_INFERENCE_RE.search(sentence)
                    and not (
                        isinstance(representation, dict)
                        and representation.get("error_type") == "ci95"
                        and "confidence interval" in sentence.lower()
                    )
                )
            )
        )
        if (
            claims.issubset(allowed)
            and not unsupported_semantics
            and _numeric_semantics_supported(sentence, grounding or {})
        ):
            kept.append(sentence)
    return " ".join(kept).strip()


def _joined_labels(values: list[str]) -> str:
    if not values:
        return ""
    if len(values) == 1:
        return values[0]
    if len(values) == 2:
        return f"{values[0]} and {values[1]}"
    return ", ".join(values[:-1]) + f", and {values[-1]}"


def _upper_first(value: str) -> str:
    return value[:1].upper() + value[1:] if value else value


def ensure_grounded_facts(text: str, grounding: dict | None, *, kind: str,
                          plot_type: str | None = None) -> str:
    """Append compact, deterministic facts so quantitative context is never optional."""
    grounding = grounding or {}
    base = (text or "").strip()
    if not base and plot_type:
        base = plot_type.replace("_", " ").capitalize() + " chart."
    facts: list[str] = []
    rows = grounding.get("total_rows")
    if isinstance(rows, int) and rows >= 0 and "source-data row" not in base.lower():
        facts.append(f"The figure is based on {rows} source-data rows")
    series = grounding.get("series")
    if isinstance(series, dict) and series.get("levels_complete"):
        levels = [str(value) for value in (series.get("levels") or [])]
        if levels and not all(level.lower() in base.lower() for level in levels):
            facts.append(f"the {series.get('column') or 'series'} levels are {_joined_labels(levels)}")
    y_fact = (grounding.get("mapped_columns") or {}).get("y")
    if isinstance(y_fact, dict) and isinstance(y_fact.get("range"), dict):
        value_range = y_fact["range"]
        minimum, maximum = value_range.get("min"), value_range.get("max")
        if minimum is not None and maximum is not None:
            facts.append(
                f"observed {y_fact.get('name') or 'y'} values range from "
                f"{_display_number(minimum)} to {_display_number(maximum)}"
            )
    if facts:
        base += (" " if base else "") + _upper_first("; ".join(facts)) + "."

    representation = grounding.get("representation")
    if isinstance(representation, dict):
        rep_bits: list[str] = []
        if representation.get("summary"):
            rep_bits.append(str(representation["summary"]))
        if representation.get("error_bars") and representation.get("error_type"):
            rep_bits.append(f"{str(representation['error_type']).upper()} error bars")
        if representation.get("individual_observations"):
            rep_bits.append("individual observations")
        if rep_bits:
            base += " The rendering includes " + _joined_labels(rep_bits) + "."

    trends = grounding.get("descriptive_trends")
    if isinstance(trends, list) and trends:
        pieces = []
        for item in trends[:4]:
            if not isinstance(item, dict):
                continue
            pieces.append(
                f"{item.get('series')} {item.get('direction')} from a descriptive mean of "
                f"{_display_number(item.get('first_mean'))} to {_display_number(item.get('last_mean'))}"
            )
        if pieces:
            base += " Across the displayed x values, " + _joined_labels(pieces) + "."
    return base.strip()


def _hex(value: Any) -> str | None:
    return value.upper() if isinstance(value, str) and _HEX_RE.fullmatch(value) else None


def _base_palette(options: dict, style_preset: str, *, stroke: bool) -> tuple[list[str], str]:
    if options.get("color_mode") == "grayscale":
        return ["#1A1A1A", "#666666", "#999999", "#CCCCCC", "#4D4D4D", "#808080", "#B3B3B3", "#000000"], "grayscale"
    name = options.get("palette_name")
    custom = options.get("custom_palette_values")
    if isinstance(name, str) and (name == "custom" or name.startswith("custom:")) and isinstance(custom, list):
        colors = [color for value in custom if (color := _hex(value))]
        return colors, str(name)
    if isinstance(name, str) and name in NAMED_PALETTES:
        raw = NAMED_PALETTE_STROKES.get(name, NAMED_PALETTES[name]) if stroke else NAMED_PALETTES[name]
        return [color for value in raw if (color := _hex(value))], name
    raw = PALETTES.get(style_preset, PALETTES["nature"])
    return [color for value in raw if (color := _hex(value))], f"preset:{style_preset}"


def _resolved_colors(*, plot_type: str, options: dict, dataset_grounding: dict | None,
                     style_preset: str) -> tuple[list[str], list[str], str, str | None]:
    series = (dataset_grounding or {}).get("series")
    if not isinstance(series, dict) or not series.get("levels_complete"):
        explicit_line = _hex(options.get("line_color")) if plot_type == "line" else None
        if explicit_line:
            return [explicit_line], ["line"], "options.line_color", None
        return [], [], str(options.get("palette_name") or f"preset:{style_preset}"), "Exact rendered series levels are unavailable."
    levels = [str(value) for value in (series.get("levels") or [])]
    if not levels:
        return [], [], str(options.get("palette_name") or f"preset:{style_preset}"), "No rendered series levels were found."
    palette, source = _base_palette(options, style_preset, stroke=plot_type in {"line", "scatter"})
    if not palette:
        return [], levels, source, "No valid resolved palette colours are available."
    category_colors = options.get("category_colors") if isinstance(options.get("category_colors"), dict) else {}
    series_styles = options.get("series_styles") if isinstance(options.get("series_styles"), dict) else {}
    resolved: list[str] = []
    for index, level in enumerate(levels):
        color = _hex(category_colors.get(level))
        style = series_styles.get(level) if isinstance(series_styles.get(level), dict) else {}
        style_color = _hex(style.get("color") or style.get("colour") or style.get("fill"))
        resolved.append(style_color or color or palette[index % len(palette)])
    element_overrides = options.get("element_overrides")
    has_element_override_color = False
    if isinstance(element_overrides, dict):
        for override in element_overrides.values():
            if not isinstance(override, dict):
                continue
            override_color = _hex(override.get("fill") or override.get("stroke"))
            if override_color and override_color not in resolved:
                resolved.append(override_color)
                has_element_override_color = True
    if has_element_override_color:
        source += "+element_overrides"
    return resolved, levels, source, None


def _srgb_channels(hex_color: str) -> tuple[float, float, float]:
    return tuple(int(hex_color[index:index + 2], 16) / 255.0 for index in (1, 3, 5))  # type: ignore[return-value]


def _linear(channel: float) -> float:
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4


def _lab(channels: tuple[float, float, float]) -> tuple[float, float, float]:
    r, g, b = (_linear(value) for value in channels)
    x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047
    y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750
    z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883

    def f(value: float) -> float:
        return value ** (1 / 3) if value > 0.008856 else 7.787 * value + 16 / 116

    fx, fy, fz = f(x), f(y), f(z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


_CVD_MATRICES = {
    "protanopia": ((0.56667, 0.43333, 0.0), (0.55833, 0.44167, 0.0), (0.0, 0.24167, 0.75833)),
    "deuteranopia": ((0.625, 0.375, 0.0), (0.7, 0.3, 0.0), (0.0, 0.3, 0.7)),
    "tritanopia": ((0.95, 0.05, 0.0), (0.0, 0.43333, 0.56667), (0.0, 0.475, 0.525)),
}


def _simulate(channels: tuple[float, float, float], mode: str) -> tuple[float, float, float]:
    matrix = _CVD_MATRICES[mode]
    return tuple(max(0.0, min(1.0, sum(row[index] * channels[index] for index in range(3)))) for row in matrix)  # type: ignore[return-value]


def _delta_e(first: tuple[float, float, float], second: tuple[float, float, float]) -> float:
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(_lab(first), _lab(second))))


def _pairwise_min(colors: list[str], transform) -> tuple[float, list[str]]:
    best = math.inf
    pair: list[str] = []
    for first, second in itertools.combinations(colors, 2):
        value = float(transform(_srgb_channels(first), _srgb_channels(second)))
        if value < best:
            best, pair = value, [first, second]
    return best, pair


def _relative_luminance(color: str) -> float:
    r, g, b = (_linear(value) for value in _srgb_channels(color))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _contrast(first: str, second: str) -> float:
    high, low = sorted((_relative_luminance(first), _relative_luminance(second)), reverse=True)
    return (high + 0.05) / (low + 0.05)


def _not_evaluable(reason: str, **fields) -> dict:
    return {"status": "not_evaluable", **fields, "reason": reason}


def accessibility_checks(*, plot_type: str, mapping: dict | None, options: dict | None,
                         dataset_grounding: dict | None, style_preset: str = "nature") -> dict:
    """Calculate machine-readable accessibility checks from server-owned colours."""
    del mapping  # The grounded series contract already records the resolved mapping.
    options = options or {}
    colors, levels, source, reason = _resolved_colors(
        plot_type=plot_type,
        options=options,
        dataset_grounding=dataset_grounding,
        style_preset=style_preset,
    )
    palette = {
        "status": "evaluated" if colors else "not_evaluable",
        "source": source or None,
        "colors": colors,
        "series_count": len(levels) if levels else None,
        "reason": reason,
    }
    if not colors:
        cvd = _not_evaluable(
            reason or "Resolved colours are unavailable.",
            method="deterministic_srgb_matrix_delta_e76_v1",
            threshold_delta_e=_PAIRWISE_THRESHOLD,
            simulations=[],
        )
        grayscale = _not_evaluable(
            reason or "Resolved colours are unavailable.",
            method="cie_lab_lightness_delta_v1",
            threshold_delta_l=_PAIRWISE_THRESHOLD,
            min_delta_l=None,
            closest_pair=None,
        )
        contrast = _not_evaluable(
            reason or "Resolved colours are unavailable.",
            method="wcag_relative_luminance",
            threshold_ratio=_CONTRAST_THRESHOLD,
            ratio=None,
            foreground=None,
            background="#FFFFFF",
        )
    else:
        background = _hex(options.get("background_color")) or "#FFFFFF"
        ratios = [(_contrast(color, background), color) for color in colors]
        ratio, foreground = min(ratios, key=lambda item: item[0])
        contrast = {
            "status": "pass" if ratio >= _CONTRAST_THRESHOLD else "needs_review",
            "method": "wcag_relative_luminance",
            "threshold_ratio": _CONTRAST_THRESHOLD,
            "ratio": round(ratio, 2),
            "foreground": foreground,
            "background": background,
            "reason": None,
        }
        if len(colors) < 2:
            pair_reason = "At least two resolved series colours are required for pairwise distinguishability."
            cvd = _not_evaluable(
                pair_reason,
                method="deterministic_srgb_matrix_delta_e76_v1",
                threshold_delta_e=_PAIRWISE_THRESHOLD,
                simulations=[],
            )
            grayscale = _not_evaluable(
                pair_reason,
                method="cie_lab_lightness_delta_v1",
                threshold_delta_l=_PAIRWISE_THRESHOLD,
                min_delta_l=None,
                closest_pair=None,
            )
        else:
            simulations = []
            for mode in _CVD_MATRICES:
                minimum, pair = _pairwise_min(
                    colors,
                    lambda first, second, mode=mode: _delta_e(_simulate(first, mode), _simulate(second, mode)),
                )
                simulations.append({
                    "mode": mode,
                    "status": "pass" if minimum >= _PAIRWISE_THRESHOLD else "needs_review",
                    "min_delta_e": round(minimum, 2),
                    "closest_pair": pair,
                })
            cvd = {
                "status": "pass" if all(item["status"] == "pass" for item in simulations) else "needs_review",
                "method": "deterministic_srgb_matrix_delta_e76_v1",
                "threshold_delta_e": _PAIRWISE_THRESHOLD,
                "simulations": simulations,
                "reason": None,
            }
            minimum_l, pair_l = _pairwise_min(colors, lambda first, second: abs(_lab(first)[0] - _lab(second)[0]))
            grayscale = {
                "status": "pass" if minimum_l >= _PAIRWISE_THRESHOLD else "needs_review",
                "method": "cie_lab_lightness_delta_v1",
                "threshold_delta_l": _PAIRWISE_THRESHOLD,
                "min_delta_l": round(minimum_l, 2),
                "closest_pair": pair_l,
                "reason": None,
            }
    payload = {
        "schema_version": ACCESSIBILITY_SCHEMA_VERSION,
        "palette": palette,
        "cvd": cvd,
        "grayscale": grayscale,
        "minimum_contrast": contrast,
    }
    return AccessibilityChecksContract.model_validate(payload).model_dump(mode="json")


@lru_cache(maxsize=32)
def _cached_r_versions(packages: tuple[str, ...]) -> tuple[tuple[str, str], ...]:
    rscript = settings.RSCRIPT_PATH
    if not rscript or not os.path.isfile(rscript):
        return ()
    quoted = ",".join(f'"{name}"' for name in packages)
    expression = (
        'cat("R=", as.character(getRversion()), "\\n", sep=""); '
        f'for (p in c({quoted})) {{ if (requireNamespace(p, quietly=TRUE)) '
        'cat(p, "=", as.character(packageVersion(p)), "\\n", sep="") }'
    )
    with tempfile.TemporaryDirectory(prefix="labplot-r-versions-") as work:
        env = {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "HOME": work, "TMPDIR": work,
               "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
        for name in ("R_HOME", "R_LIBS", "R_LIBS_USER", "R_LIBS_SITE"):
            if os.environ.get(name):
                env[name] = os.environ[name]
        try:
            result = subprocess.run(
                [rscript, "-e", expression], capture_output=True, text=True,
                timeout=10, check=False, env=env,
            )
        except (OSError, subprocess.SubprocessError):
            return ()
    if result.returncode != 0:
        return ()
    versions: list[tuple[str, str]] = []
    for line in result.stdout.splitlines():
        name, separator, version = line.partition("=")
        if separator and (name == "R" or name in packages) and version.strip():
            versions.append((name, version.strip()))
    return tuple(versions)


def collect_r_package_versions(packages: list[str] | tuple[str, ...]) -> dict[str, str]:
    safe = tuple(dict.fromkeys(name for name in packages if isinstance(name, str) and _PACKAGE_RE.fullmatch(name)))
    return dict(_cached_r_versions(safe))
