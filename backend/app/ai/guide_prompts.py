"""Load local guide prompts for AI workflows."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
GUIDE_DIR = ROOT / "guide"


@lru_cache(maxsize=4)
def _read_guide(filename: str) -> str:
    try:
        return (GUIDE_DIR / filename).read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def r_code_generator_guide() -> str:
    return _read_guide("system_prompt_r_code_generator_en.md")


def figure_quality_checker_guide() -> str:
    return _read_guide("system_prompt_figure_quality_checker_en.md")


def with_guide(base_system: str, guide_text: str, label: str) -> str:
    if not guide_text:
        return base_system
    return (
        base_system.rstrip()
        + "\n\nAUTHORITATIVE LABPLOT GUIDE: "
        + label
        + "\nThe following local Markdown guide is part of the system instructions for this LabPlot workflow. "
        + "Apply it where it is stricter than the shorter task prompt while still obeying the JSON output schema.\n\n"
        + guide_text
    )
