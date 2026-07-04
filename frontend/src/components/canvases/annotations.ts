// U8: geometry + validation helpers for canvas text/shape annotations. Pure
// TypeScript (no React, no Konva) so it's trivially testable and importable
// from both the editor and its sub-components.
//
// Font invariance contract (design §5, mirrored from backend _PT_TO_MM):
// font sizes are ABSOLUTE pt everywhere; pt -> mm = pt * 25.4/72.

import type { AnnotationType, CanvasAnnotation } from '@/lib/types';
import { MM_PER_INCH } from './mm';

export const FONT_PT_MIN = 4;
export const FONT_PT_MAX = 72;
export const FONT_PT_DEFAULT = 10;
export const STROKE_PT_MIN = 0.25;
export const STROKE_PT_MAX = 10;
export const STROKE_PT_DEFAULT = 1;
export const STROKE_HEX_DEFAULT = '#000000';
export const TEXT_MAX_LEN = 500;
/** Minimum drag distance (mm) for a shape/line/arrow creation gesture — a
 * shorter drag is discarded as an accidental click (contract §3). */
export const MIN_CREATE_DRAG_MM = 2;
/** Fallback box (mm) for a freshly-created text annotation before Konva has
 * measured its actual rendered width (auto-width text has no w_mm). */
export const TEXT_FALLBACK_W_MM = 40;

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function ptToMm(pt: number): number {
  return (pt * MM_PER_INCH) / 72;
}

export function clampNum(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

export function clampFontPt(pt: number): number {
  return clampNum(pt, FONT_PT_MIN, FONT_PT_MAX);
}
export function clampStrokePt(pt: number): number {
  return clampNum(pt, STROKE_PT_MIN, STROKE_PT_MAX);
}
export function isValidHex(s: string): boolean {
  return HEX_RE.test(s);
}
export function normalizeHex(s: string, fallback = STROKE_HEX_DEFAULT): string {
  return isValidHex(s) ? s.toLowerCase() : fallback;
}

export function makeAnnotationId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  // Fallback (very old browsers / non-secure-context): random v4-ish string.
  return `ann-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function nextAnnotationZ(annotations: CanvasAnnotation[]): number {
  return annotations.length ? Math.max(...annotations.map((a) => a.z)) + 1 : 0;
}

/** Factory for a freshly-created annotation of `type` anchored/sized per the
 * creation gesture. `text` types open inline editing immediately after. */
export function createAnnotation(
  type: AnnotationType,
  geom: { x_mm: number; y_mm: number; w_mm?: number; h_mm?: number; points_mm?: [number, number, number, number] },
  z: number,
): CanvasAnnotation {
  const base: CanvasAnnotation = {
    id: makeAnnotationId(),
    type,
    x_mm: geom.x_mm,
    y_mm: geom.y_mm,
    stroke_hex: STROKE_HEX_DEFAULT,
    stroke_pt: STROKE_PT_DEFAULT,
    z,
  };
  if (type === 'text') {
    // The backend REJECTS an empty/whitespace-only text string (400
    // BAD_ANNOTATIONS) — a non-empty placeholder lets the initial creation
    // commit succeed; the inline editor opens with an EMPTY draft (see
    // createTextAt) so the user types straight over it. An abandoned blank
    // edit deletes the whole annotation instead of ever re-committing "".
    return { ...base, text: 'Text', font_pt: FONT_PT_DEFAULT, align: 'left', fill_hex: STROKE_HEX_DEFAULT };
  }
  if (type === 'rect' || type === 'ellipse') {
    return { ...base, w_mm: geom.w_mm, h_mm: geom.h_mm, fill_hex: null };
  }
  // line / arrow
  return { ...base, points_mm: geom.points_mm };
}

/** Top-left anchor of an annotation's bounding box, in mm — the Konva Group
 * position for ALL annotation types (rect/ellipse/text use x_mm/y_mm
 * directly; line/arrow derive it from their two endpoints so drag/snap/group-
 * move machinery can treat every annotation uniformly, the same way panels
 * are always positioned by their top-left). */
export function originMm(a: CanvasAnnotation): { x: number; y: number } {
  if (a.type === 'line' || a.type === 'arrow') {
    const p = a.points_mm ?? [0, 0, 0, 0];
    return { x: Math.min(p[0], p[2]), y: Math.min(p[1], p[3]) };
  }
  return { x: a.x_mm, y: a.y_mm };
}

/** Bounding box size (mm). `measuredTextMm` is the actual rendered size of an
 * auto-width text annotation (reported by CanvasAnnotationNode post-layout);
 * falls back to a heuristic before the first measurement lands. */
export function sizeMm(
  a: CanvasAnnotation,
  measuredTextMm?: { w_mm: number; h_mm: number },
): { w_mm: number; h_mm: number } {
  if (a.type === 'line' || a.type === 'arrow') {
    const p = a.points_mm ?? [0, 0, 0, 0];
    return { w_mm: Math.abs(p[2] - p[0]), h_mm: Math.abs(p[3] - p[1]) };
  }
  if (a.type === 'text') {
    if (a.w_mm != null) return { w_mm: a.w_mm, h_mm: a.h_mm ?? ptToMm((a.font_pt ?? FONT_PT_DEFAULT) * 1.3) };
    if (measuredTextMm) return measuredTextMm;
    return { w_mm: TEXT_FALLBACK_W_MM, h_mm: ptToMm((a.font_pt ?? FONT_PT_DEFAULT) * 1.3) };
  }
  return { w_mm: a.w_mm ?? 0, h_mm: a.h_mm ?? 0 };
}

/** Bounding box in fit-px (canvas/un-zoomed space), same convention as panel
 * mmToPx(x_mm)/mmToPx(y_mm) — used for marquee hit-testing and as snap
 * targets alongside panels. */
export function annotationBoxPx(
  a: CanvasAnnotation,
  pxPerMm: number,
  measuredTextMm?: { w_mm: number; h_mm: number },
): { x0: number; y0: number; x1: number; y1: number } {
  const o = originMm(a);
  const s = sizeMm(a, measuredTextMm);
  return {
    x0: o.x * pxPerMm,
    y0: o.y * pxPerMm,
    x1: (o.x + s.w_mm) * pxPerMm,
    y1: (o.y + s.h_mm) * pxPerMm,
  };
}

/** Translate an annotation by (dx_mm, dy_mm) — applied uniformly regardless
 * of type: rect/ellipse/text move their anchor; line/arrow move BOTH
 * endpoints (so the segment keeps its length/angle, only its position
 * changes). Used by single-item drag commit AND group-move commit. */
export function translateAnnotation(a: CanvasAnnotation, dx_mm: number, dy_mm: number): CanvasAnnotation {
  if (a.type === 'line' || a.type === 'arrow') {
    const p = a.points_mm ?? [0, 0, 0, 0];
    return { ...a, points_mm: [p[0] + dx_mm, p[1] + dy_mm, p[2] + dx_mm, p[3] + dy_mm] };
  }
  return { ...a, x_mm: a.x_mm + dx_mm, y_mm: a.y_mm + dy_mm };
}

/** Arrowhead length in mm (design contract: max(2.5*stroke_mm, 2.0mm)) so the
 * Konva Arrow's rendered head matches the export's vector arrowhead. */
export function arrowHeadLenMm(stroke_pt: number | undefined): number {
  const strokeMm = ptToMm(clampStrokePt(stroke_pt ?? STROKE_PT_DEFAULT));
  return Math.max(2.5 * strokeMm, 2.0);
}

export function sanitizeText(raw: string): string {
  return raw.replace(/[\r\n]+/g, ' ').slice(0, TEXT_MAX_LEN);
}

export const ANNOTATION_TYPE_LABEL: Record<AnnotationType, string> = {
  text: 'Text',
  arrow: 'Arrow',
  line: 'Line',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
};
