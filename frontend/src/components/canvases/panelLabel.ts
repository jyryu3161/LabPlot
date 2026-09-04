// Panel label layout — ONE formula shared with the backend's
// `_label_layout_mm` (see the M-C1 contract §4). Any change here must be
// mirrored server-side (SVG export `<text>`, PPTX textbox, `_content_bbox_mm`)
// or the Konva label in the editor will disagree with the exported file.
import type { CanvasLabelStyle } from '@/lib/types';

export const PT_TO_MM = 25.4 / 72;
export const LABEL_BASELINE_RATIO = 0.8;

export const DEFAULT_LABEL_STYLE: CanvasLabelStyle = {
  format: 'A',
  bold: true,
  pt: 12,
  placement: 'inside',
  offset_mm: 1.0,
};

export type LabelFormat = CanvasLabelStyle['format'];
export const LABEL_FORMATS: LabelFormat[] = ['A', 'a', '(A)', 'A.'];
export const LABEL_PT_MIN = 6;
export const LABEL_PT_MAX = 18;
export const LABEL_OFFSET_MM_MIN = 0;
export const LABEL_OFFSET_MM_MAX = 10;

/**
 * Canonical stored label (uppercase A-Z, e.g. "B") -> display text per format.
 * Mirrors the backend's `_format_label` exactly: trim, then lowercase only
 * for format 'a'. Non-canonical labels (anything other than uppercase A-Z,
 * e.g. free text typed by a user) are never uppercased here, since the
 * backend never uppercases them either — the two must render identical text.
 */
export function formatLabel(raw: string, format: LabelFormat): string {
  const letter = (raw ?? '').trim();
  if (!letter) return letter;
  switch (format) {
    case 'a': return letter.toLowerCase();
    case '(A)': return `(${letter})`;
    case 'A.': return `${letter}.`;
    case 'A':
    default: return letter;
  }
}

export interface LabelLayoutMm {
  text: string;
  left: number;
  top: number;
  baseline_y: number;
  font_mm: number;
  box_w: number;
  box_h: number;
}

/**
 * Compute the mm-space box/position for a panel's label. Mirrors backend
 * `_label_layout_mm` exactly — used by the SVG export `<text>`, the PPTX
 * textbox, `_content_bbox_mm`, and the editor's Konva label.
 *
 * Pass `panel` as the panel's own {x_mm, y_mm} for absolute canvas-mm
 * coordinates, or as {x_mm: 0, y_mm: 0} to get coordinates relative to the
 * panel's own top-left corner (what the Konva node needs, since it is
 * already translated to the panel's position).
 */
export function labelLayoutMm(
  raw: string,
  panel: { x_mm: number; y_mm: number },
  style: CanvasLabelStyle,
): LabelLayoutMm {
  const text = formatLabel(raw, style.format);
  const font_mm = style.pt * PT_TO_MM;
  const left = style.placement === 'inside' ? panel.x_mm + style.offset_mm : panel.x_mm;
  const top = style.placement === 'inside'
    ? panel.y_mm + style.offset_mm
    : panel.y_mm - style.offset_mm - font_mm;
  const baseline_y = top + LABEL_BASELINE_RATIO * font_mm;
  const box_w = 0.62 * font_mm * text.length + 0.4 * font_mm;
  const box_h = font_mm;
  return { text, left, top, baseline_y, font_mm, box_w, box_h };
}

/** Merge a (possibly partial/absent) canvas style.label with the defaults. */
export function resolveLabelStyle(label?: Partial<CanvasLabelStyle> | null): CanvasLabelStyle {
  return { ...DEFAULT_LABEL_STYLE, ...(label ?? {}) };
}
