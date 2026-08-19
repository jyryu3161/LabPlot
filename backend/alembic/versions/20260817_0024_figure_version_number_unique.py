"""serialize figure version numbers per figure

Revision ID: 20260817_0024
Revises: 20260817_0023
Create Date: 2026-08-17
"""

from __future__ import annotations

from alembic import op


revision = "20260817_0024"
down_revision = "20260817_0023"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Historical concurrent renders could assign the same visible number.
    # Preserve every version and every existing number except the second and
    # later member of a duplicate group; move those to fresh numbers above the
    # figure's current maximum before installing the invariant.
    op.execute(
        """
        WITH ranked AS (
            SELECT
                id,
                figure_id,
                version_number,
                ROW_NUMBER() OVER (
                    PARTITION BY figure_id, version_number
                    ORDER BY created_at, id
                ) AS duplicate_rank
            FROM figure_versions
        ), to_move AS (
            SELECT
                id,
                figure_id,
                ROW_NUMBER() OVER (
                    PARTITION BY figure_id
                    ORDER BY version_number, id
                ) AS move_offset
            FROM ranked
            WHERE duplicate_rank > 1
        ), maxima AS (
            SELECT figure_id, MAX(version_number) AS max_number
            FROM figure_versions
            GROUP BY figure_id
        )
        UPDATE figure_versions AS version
        SET version_number = maxima.max_number + to_move.move_offset
        FROM to_move
        JOIN maxima ON maxima.figure_id = to_move.figure_id
        WHERE version.id = to_move.id
        """
    )
    op.create_unique_constraint(
        "uq_figure_versions_figure_number",
        "figure_versions",
        ["figure_id", "version_number"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_figure_versions_figure_number",
        "figure_versions",
        type_="unique",
    )
