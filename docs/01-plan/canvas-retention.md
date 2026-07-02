# Canvas — version & derivative retention policy (M4)

Scope: how the multi-panel Canvas feature's data and derived artifacts are retained
and reclaimed. Complements `multipanel-canvas-design.md` (§4 cache, decisions 3/5).

## What is authoritative (never auto-deleted)
- **Figures + FigureVersions** — content is figure-owned. Every color commit from a
  canvas creates a new immutable `FigureVersion` (via `rerender`, decisions 3/7).
  These follow the existing figure retention (kept until the figure/account is
  deleted). Canvas editing never deletes a figure version.
- **canvases / canvas_panels rows** — layout is canvas-owned; deleted only when the
  user deletes the canvas (FK cascade removes its panels) or the owner/account is
  removed.
- **canvas.export_snapshot** — the `{panel_id: version_id}` map from the last export,
  kept for reproducibility (decision 5). Overwritten on each export.

## Derived artifacts (safe to reclaim; regenerable)
- **Preview cache** `static/figures/canvases/preview/{hash}.svg` (+ `.layout.json`) —
  content-hash keyed (§4). Ephemeral: no DB row, no version. Regenerated on demand
  (a miss just re-renders). Safe to GC by age.
- **Panel/export composites** — produced on export; not required to persist.

### Reclamation
- Reuse the existing retention sweep (`scripts/retention_cleanup.py`) or a cron to
  delete preview/export files older than a TTL (recommend **7 days** since they are
  cheap to regenerate and keyed by content hash, so stale entries are never served
  incorrectly — a changed figure/size yields a new hash).
- Object-storage backend: same TTL via lifecycle rules on the
  `figures/canvases/preview/` and export key prefixes.
- No referential integrity depends on these files; deleting them only forces a
  re-render on next view.

## Invalidation (correctness, not space)
- A color commit advances the figure's `current_version_id`; follow-latest panels
  key their render on `effective_version_id`, so they pick up the new version and
  the old preview hash is simply no longer requested (no explicit purge needed).
- Pinned panels keep rendering their pinned version until re-pinned.

## Not retained / out of scope
- No per-canvas color forks or per-canvas figure copies (decision 7) — variants are
  full figure duplicates, retained as normal figures.
- The orphan `figure_canvases` table (pre-106daca) was dropped in migration 0019.
