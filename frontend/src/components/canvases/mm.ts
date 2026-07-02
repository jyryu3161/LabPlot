// mm ↔ px conversion for the multi-panel canvas editor.
//
// Frozen decisions (docs/01-plan/multipanel-canvas-design.md §1, §5):
//  - Canvas & panel geometry live in mm (physical units).
//  - The editor picks a single fit scale `pxPerMm` so the whole canvas
//    (width_mm × height_mm) fits the viewport with a margin.
//  - Zoom multiplies the Konva Stage scale UNIFORMLY (scaleX === scaleY) and pan
//    offsets the Stage position — text is never scaled non-uniformly. All panel
//    geometry is therefore computed once in "fit px" (mm * pxPerMm); the Stage
//    scale then applies zoom on top, keeping every transform uniform.

export const MM_PER_INCH = 25.4;

// Physical clamps (design §5): canvas 20–500 mm/side, panel 10–500 mm/side.
export const CANVAS_MM_MIN = 20;
export const CANVAS_MM_MAX = 500;
export const PANEL_MM_MIN = 10;
export const PANEL_MM_MAX = 500;

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function clampCanvasMm(mm: number): number {
  return clamp(mm, CANVAS_MM_MIN, CANVAS_MM_MAX);
}
export function clampPanelMm(mm: number): number {
  return clamp(mm, PANEL_MM_MIN, PANEL_MM_MAX);
}

/**
 * Fit scale (px per mm) so the full canvas fits inside the viewport with a
 * uniform margin. Uniform: the same factor applies to both axes, preserving
 * physical aspect ratio.
 */
export function fitPxPerMm(
  canvasWmm: number,
  canvasHmm: number,
  viewportW: number,
  viewportH: number,
  marginPx = 48,
): number {
  const availW = Math.max(1, viewportW - marginPx * 2);
  const availH = Math.max(1, viewportH - marginPx * 2);
  const w = canvasWmm > 0 ? availW / canvasWmm : 1;
  const h = canvasHmm > 0 ? availH / canvasHmm : 1;
  const s = Math.min(w, h);
  return Number.isFinite(s) && s > 0 ? s : 1;
}

export function mmToPx(mm: number, pxPerMm: number): number {
  return mm * pxPerMm;
}
export function pxToMm(px: number, pxPerMm: number): number {
  return pxPerMm > 0 ? px / pxPerMm : 0;
}

/** Round mm to 2 decimals — matches the backend derived-cache key granularity. */
export function roundMm(mm: number): number {
  return Math.round(mm * 100) / 100;
}
