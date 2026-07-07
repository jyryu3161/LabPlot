"""canvas image panels: figure_id nullable + imported-image reference columns

A canvas panel is now EITHER a figure panel (figure_id set) or an imported
external image (image_key set, pointing at a sanitized/validated blob under
figures/canvases/imports/). Exactly one of the two must be present — enforced
by a CHECK constraint so a degenerate row (both or neither) can never exist.

Revision ID: 20260707_0022
Revises: 20260704_0021
Create Date: 2026-07-07
"""

from __future__ import annotations

from alembic import op
from sqlalchemy import text

revision = "20260707_0022"
down_revision = "20260704_0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("ALTER TABLE canvas_panels ALTER COLUMN figure_id DROP NOT NULL"))
    # Relative storage key ("canvases/imports/<hex32>.<ext>") — never a raw
    # filesystem path or s3:// URI, so the stored value is backend-agnostic.
    bind.execute(text(
        "ALTER TABLE canvas_panels ADD COLUMN IF NOT EXISTS image_key VARCHAR(160)"
    ))
    # Native physical size (mm) computed once at upload from the image's own
    # dimensions/DPI — feeds the editor's original-size placement/reset.
    bind.execute(text(
        "ALTER TABLE canvas_panels ADD COLUMN IF NOT EXISTS image_native_width_mm DOUBLE PRECISION"
    ))
    bind.execute(text(
        "ALTER TABLE canvas_panels ADD COLUMN IF NOT EXISTS image_native_height_mm DOUBLE PRECISION"
    ))
    bind.execute(text(
        "ALTER TABLE canvas_panels ADD CONSTRAINT ck_canvas_panels_figure_xor_image "
        "CHECK ((figure_id IS NULL) <> (image_key IS NULL))"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text(
        "ALTER TABLE canvas_panels DROP CONSTRAINT IF EXISTS ck_canvas_panels_figure_xor_image"
    ))
    # Image panels have no figure to fall back to — they must be removed before
    # figure_id can be NOT NULL again.
    bind.execute(text("DELETE FROM canvas_panels WHERE figure_id IS NULL"))
    bind.execute(text("ALTER TABLE canvas_panels DROP COLUMN IF EXISTS image_native_height_mm"))
    bind.execute(text("ALTER TABLE canvas_panels DROP COLUMN IF EXISTS image_native_width_mm"))
    bind.execute(text("ALTER TABLE canvas_panels DROP COLUMN IF EXISTS image_key"))
    bind.execute(text("ALTER TABLE canvas_panels ALTER COLUMN figure_id SET NOT NULL"))
