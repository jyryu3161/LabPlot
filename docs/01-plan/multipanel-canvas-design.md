# Multi-panel Canvas + object color editing + version linkage — Design (M0)

Status: **M0 (schema & contract)**. Scope this session: M0, M1. Later: M2–M4.

This document is the frozen contract that M1–M4 implement against. It encodes the
11 design decisions from the task brief plus the resolutions found during the M0
repo-fact verification. Where implementation would conflict with a frozen
decision, stop and report — do not change it here unilaterally.

## 0. Repo-fact verification result (M0 gate)

All brief "repo facts" were verified against the code and hold, **except one**,
now resolved with the owner's approval:

- **base_size was not literally fixed at 7.** `presets.py:239` computes
  `size = max(7, round(cfg["size"] * font_scale))` with `cfg["size"] == 7` for
  every preset, and a pre-existing `font_scale` option (in `_UNIVERSAL_OPTION_KEYS`
  / `_NUMBER_OPTIONS`, **not** surfaced in the editor UI or plot-type metadata)
  modulates it. The device path (`renderer.py`) hard-codes `pointsize = 7`.
- The core premise ("font is absolute pt; re-render at a new (w,h) re-lays out and
  keeps pt") is **verified and sound** — only the base_size↔font_scale relationship
  was underspecified.
- **Approved resolution:** `base_size` becomes the single absolute-pt source of
  truth (default 7, clamp 5–14). `font_scale` is demoted to a legacy multiplier used
  **only when `base_size` is unset** (backward-compat for existing figures). See §6.

Everything else verified: inch sizes (`_SIZES`, `width_in`/`height_in`); sidecar via
`ggplotGrob`+`grid::deviceLoc`+`ggplot_build` recording **`panel_params[[1]]` (first
panel only)** into `FigureVersion.layout` (JSONB); `series_styles` + `category_colors`
+ `_series_styles_layer` merging at `scale_*_manual` (scale) level; `rerender()`
creating a version on success only (`version_number = max+1`, advances
`current_version_id`, `change_note` ≤512, rate limit `figure_rerender` 60/h);
removed canvas code (commit 106daca); **orphan `figure_canvases` table** (migration
20260614_0002) still in the DB; `DEVICE_TYPES = {annotated_heatmap, upset,
surface_3d, scatter_3d, contour_3d, chord_diagram, tri_surface, wireframe_3d}`;
orphan `frontend/e2e/svg-editor.spec.ts`; current alembic head `20260702_0018`.

## 1. Frozen design decisions (reference)

Units mm (physical) for canvas/panel geometry, absolute pt for fonts, uniform
viewport transform for zoom/pan only. Resize = re-layout (re-render the panel at
its new physical size; never bitmap-stretch — the old `rasterGrob` approach is
banned). Ownership boundary: **content** (colors/series styles/mapping/annotations/
theme) belongs to the figure → new version; **placement** (position/z-order/label)
**and panel size** belong to the canvas → no version bump. Panel render is a derived
cache artifact keyed `(figure_version_id, w_mm, h_mm, format)`. Preview renders are
ephemeral (single SVG, no `FigureVersion`, separate rate limit); commit uses the
existing `rerender()` path. Panels reference `figure_id` and follow-latest by
default with an optional per-panel version pin; export snapshots the used
`version_id` list. Color editing reuses `series_styles`/`category_colors` →
sanitize → `rerender` (scale-level ⇒ legend sync is automatic); no per-canvas color
fork. hit-testing solved by sidecar extension (no ggiraph / device swap). Immediate
preview recolor by hex-matching within panel + legend-key boxes only. Capability:
only discrete-scale ggplot plot types are color-editable. Security model unchanged
(fixed R templates + option allow-list + `rq()` + `_scrubbed_env` /
`_resource_limit_preexec`).

## 2. Data model

New normalized tables (drop the orphan `figure_canvases` in the same migration —
it is dead code, no references, replaced by `canvases`/`canvas_panels`).

### `canvases`
| column | type | notes |
|---|---|---|
| id | UUID PK | uuid4 |
| owner_id | UUID FK users(id) ON DELETE CASCADE, indexed | figures pattern |
| project_id | UUID FK projects(id) ON DELETE CASCADE, nullable, indexed | project scope |
| name | VARCHAR(255) NOT NULL | |
| description | TEXT NULL | |
| width_mm | DOUBLE PRECISION NOT NULL | physical canvas size |
| height_mm | DOUBLE PRECISION NOT NULL | |
| preset | VARCHAR(40) NULL | journal preset key (e.g. `nature_single`) |
| background | VARCHAR(20) NOT NULL DEFAULT 'white' | `white` \| `transparent` |
| export_snapshot | JSONB NULL | `{panel_id: version_id}` from last export |
| created_at / updated_at | TIMESTAMPTZ | `_now` / onupdate |

Index: `ix_canvases_owner_id`, `ix_canvases_project_id`.

### `canvas_panels`
| column | type | notes |
|---|---|---|
| id | UUID PK | uuid4 |
| canvas_id | UUID FK canvases(id) ON DELETE CASCADE, indexed | |
| figure_id | UUID FK figures(id) ON DELETE CASCADE, indexed | **reverse lookup** "canvases using this figure" |
| pinned_version_id | UUID NULL | null ⇒ follow-latest (`figure.current_version_id`); else pinned |
| x_mm / y_mm | DOUBLE PRECISION NOT NULL | top-left position on canvas |
| width_mm / height_mm | DOUBLE PRECISION NOT NULL | panel physical size → drives re-render |
| z_order | INTEGER NOT NULL DEFAULT 0 | paint order |
| label | VARCHAR(8) NULL | A/B/C… (rendered at export in pt) |
| label_visible | BOOLEAN NOT NULL DEFAULT true | |
| created_at / updated_at | TIMESTAMPTZ | |

Index: `ix_canvas_panels_canvas_id`, `ix_canvas_panels_figure_id`.
No unique constraint on `(canvas_id, z_order)` (ties broken by id for stable paint).

FK `figure_id` gives the required reverse query: a color commit on a figure must
invalidate the derived cache of every panel that follows-latest that figure.

## 3. API contract (pydantic in `backend/app/canvases/schemas.py`)

All endpoints auth + owner/project-scoped exactly like figures (`get_figure`
pattern: owner OR project-access; writes call `require_project_write`).

- `GET /api/canvases?project_id=` → `CanvasListItem[]` (`{id, name, project_id, width_mm, height_mm, panel_count, updated_at}`).
- `POST /api/canvases` → `CanvasDetail`. Body `CanvasCreate {name, description?, project_id?, preset?, width_mm, height_mm, background?}` (mm clamped, see §5).
- `GET /api/canvases/{id}` → `CanvasDetail` (`{...canvas fields, panels: CanvasPanel[]}`).
- `PATCH /api/canvases/{id}` → `CanvasDetail`. Body `CanvasUpdate` (partial: name/description/width_mm/height_mm/background/preset).
- `DELETE /api/canvases/{id}` → 204.
- `POST /api/canvases/{id}/panels` → `CanvasPanel`. Body `PanelCreate {figure_id, x_mm, y_mm, width_mm, height_mm, z_order?, label?, pinned_version_id?}`.
- `PATCH /api/canvases/{id}/panels/{panel_id}` → `CanvasPanel`. Body `PanelUpdate` (partial: x/y/width/height_mm, z_order, label, label_visible, pinned_version_id). **Placement/size changes here never touch figure versions.**
- `DELETE /api/canvases/{id}/panels/{panel_id}` → 204.
- **Preview render (M1, ephemeral):** `POST /api/canvases/preview` → `{svg_url | svg}`. Body `PreviewRenderRequest {figure_id, version_id?, options_overlay?: {series_styles?, category_colors?, base_size?}, width_mm, height_mm}`. Produces a **single SVG**, **no `FigureVersion`**, content-hash cached (§4), separate rate limit `canvas_preview` (e.g. 240/h). Used for resize re-layout and live color preview base.
- **Commit (M3, reuses `rerender`):** no new endpoint — the canvas color-apply calls the existing `POST /api/figures/{figure_id}/rerender` with merged `series_styles`/`category_colors` + a `change_note` recording provenance (e.g. `Canvas '<name>': series 'KO' color #E64B35`). Optional `base_version_id` for conflict detection (409 on mismatch) is an M4 addition to that request schema.

`CanvasPanel` response includes a resolved `effective_version_id` (pin or
`figure.current_version_id`) and a `render_url` (derived cache artifact, §4) so the
editor can display without an extra round-trip.

## 4. Derived render cache

Two distinct caches, both under a `canvases/` namespace mirroring existing storage.

1. **Committed panel render** — key `sha256(figure_version_id, round(w_mm,2),
   round(h_mm,2), format)`. A version is immutable, so this is stable and safe to
   keep. Path: local `static/figures/canvases/panel/{figure_version_id}/{hash}.{ext}`;
   object storage `object_key("figures","canvases","panel", figure_version_id, f"{hash}.{ext}")`.
2. **Preview render** — key `sha256(dataset_content_hash, plot_type, mapping_json,
   options_json, preset, round(w_mm,2), round(h_mm,2))` (options include the
   `series_styles`/`category_colors`/`base_size` overlay). Ephemeral: LRU/TTL
   directory `static/figures/canvases/preview/{hash}.svg` (+ object-storage mirror),
   no DB row, no version. `dataset_content_hash` reuses the dataset's stored content
   hash if present, else `sha256` of decrypted content.

Invalidation: a figure color commit (new version) makes all follow-latest panels'
committed-render keys change automatically (new `figure_version_id`), so no explicit
purge is required for correctness; a background sweep may GC old preview/panel files.

Both backends resolved through the existing `storage` module
(`object_storage_enabled`, `object_key`, `upload_file`, `read_bytes`).

## 5. base_size option spec

- Key `base_size`, integer. Add to `_UNIVERSAL_OPTION_KEYS` and `_NUMBER_OPTIONS`;
  sanitize = `int(round(x))` then clamp **[5, 14]**; non-numeric ⇒ drop (unset).
- Resolution (implemented in M1): `resolved_pt = clamp(base_size, 5, 14)` when
  `base_size` is set; else **legacy** `max(7, round(7 * font_scale))` (unchanged).
- Wiring (M1): ggplot theme path uses `resolved_pt` for `theme_*(base_size=)`; the
  device path replaces literal `pointsize = 7` with `resolved_pt`. Canvas physical
  sizing (`width_mm`/`height_mm`) converts to inches (`mm/25.4`) for the R device;
  base_size stays absolute pt regardless of (w,h) — this is the re-layout guarantee.
- `font_scale` retained only as the fallback when `base_size` unset; no UI for it.
- mm clamps: canvas 20–500 mm per side; panel 10–500 mm per side (guard against
  degenerate/huge R devices; final numbers may tighten in M2).

## 6. Color-edit capability matrix

Color-editable ⇔ the plot type renders a **discrete** colour/fill scale that
`series_styles`/`category_colors` (scale-level manual) can target.

- **Editable** (discrete ggplot): scatter, line, bar, grouped_bar, error_bar, box,
  violin, area, lollipop, dot_plot, sina, forest, histogram (grouped), density
  (grouped), ecdf (grouped), volcano (discrete significance classes), pca,
  enrichment_bar, enrichment_dot, manhattan, kaplan_meier, ridge.
- **NOT editable** — disable the color UI (mirror the existing per-type option
  allow-list / `isContinuousFill` gating):
  - `DEVICE_TYPES` = {annotated_heatmap, upset, surface_3d, scatter_3d, contour_3d,
    chord_diagram, tri_surface, wireframe_3d} — non-ggplot device path.
  - Continuous/gradient fills: heatmap, correlation_heatmap, contour, embedding,
    calibration_curve, roc_pr_curve, confusion_matrix, chemical_space,
    parallel_coordinates, radar, sankey, network — no discrete series scale to edit
    (network colors are node/edge attributes, out of scope).

Source of truth: a backend `COLOR_EDITABLE_TYPES` set derived as
`{ggplot discrete types} = all_types − DEVICE_TYPES − CONTINUOUS_FILL_TYPES`,
exposed in the plot-type metadata as a `color_editable: bool` flag so the frontend
gates the editor without hard-coding.

## 7. Sidecar extension (spec here; implemented M1)

`figure_layout.json` gains keys **additively** (existing keys — `panel_px`,
`img_px`, `x_range`, `y_range`, `x_discrete`, `y_discrete` — keep their exact shape
so `FigureAnnotationOverlay` is unaffected). New keys (design decision 8):

- `series_hex`: `{series_name: "#RRGGBB"}` — the resolved scale mapping, computed in
  R with the **same logic** as `_series_styles_layer` (limits + `labplot_palette` +
  override) so it matches the actual render.
- `legend_keys`: `[{series, px:{x0,y0,x1,y1}}]` — per-series legend key-box pixel
  boxes (y from image top, matching `panel_px`).
- `layer_geom`: compact `ggplot_build(p)$data` geometry per layer for object
  hit-testing (bounded fields; no unbounded dumps).
- `panels`: `[{panel_px, x_range, y_range, x_discrete, y_discrete}]` — **all** facet
  panels (superset of the legacy single `panel_px`, which stays for compat).

## 8. Milestone completion criteria

- **M0 (this doc):** design doc in `docs/01-plan/` ✓; alembic migration for
  `canvases`/`canvas_panels` + orphan `figure_canvases` drop that **applies and
  rolls back on an empty DB**; pydantic schema stubs compile and import.
- **M1:** two-size preview SVGs have identical text `font-size` (pt); sidecar
  contains `series_hex` + `legend_keys`; preview cache-hit test.

## 9. Non-goals (do not touch)

webR, client chart engines (Vega/Plotly twins), ggiraph, continuous-scale color
editor, direct color editing of `DEVICE_TYPES`, revival of the SVG-DOM editor.
