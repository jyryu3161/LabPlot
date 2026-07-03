// Text-element hit regions for Prism-style click-to-edit (U4 P1).
//
// The render sidecar (figure_layout.json) carries device-px boxes for the
// title / x-label / y-label gtable cells (title_px, xlab_px, ylab_px — added
// additively in renderer.py). This module converts them into overlay-relative
// CSS rects; the overlay renders them as transparent click targets, so no
// manual point-in-box math is needed on the click path.
import type { Box } from './recolor';

export type TextRegion = 'title' | 'xlab' | 'ylab';

/** Sidecar key per region. */
const LAYOUT_KEY: Record<TextRegion, string> = {
  title: 'title_px',
  xlab: 'xlab_px',
  ylab: 'ylab_px',
};

/** Figure-option key each region edits (all pass the backend allow-list). */
export const REGION_OPTION_KEY: Record<TextRegion, 'title' | 'x_label' | 'y_label'> = {
  title: 'title',
  xlab: 'x_label',
  ylab: 'y_label',
};

export const REGION_LABEL: Record<TextRegion, string> = {
  title: 'title',
  xlab: 'x axis label',
  ylab: 'y axis label',
};

function asBox(v: unknown): Box | null {
  if (!v || typeof v !== 'object') return null;
  const b = v as Record<string, unknown>;
  const nums = [b.x0, b.y0, b.x1, b.y1];
  return nums.every((n) => typeof n === 'number' && Number.isFinite(n)) ? (b as unknown as Box) : null;
}

/** The regions present in a layout (absent for DEVICE_TYPES / old renders). */
export function textRegionBoxes(layout: Record<string, unknown> | null | undefined): Partial<Record<TextRegion, Box>> {
  const out: Partial<Record<TextRegion, Box>> = {};
  if (!layout) return out;
  for (const region of Object.keys(LAYOUT_KEY) as TextRegion[]) {
    const box = asBox(layout[LAYOUT_KEY[region]]);
    if (box) out[region] = box;
  }
  return out;
}

/**
 * Overlay-relative CSS rect (percent) for a region box. A zero-height box
 * (e.g. no title set — the sidecar still marks WHERE it would render) is
 * given a minimum clickable band via minHeightPx.
 */
export function regionCssRect(box: Box, imgPx: { w: number; h: number }): {
  left: string; top: string; width: string; height: string; minHeight: number; minWidth: number;
} {
  return {
    left: `${(box.x0 / imgPx.w) * 100}%`,
    top: `${(box.y0 / imgPx.h) * 100}%`,
    width: `${(Math.max(1, box.x1 - box.x0) / imgPx.w) * 100}%`,
    height: `${(Math.max(1, box.y1 - box.y0) / imgPx.h) * 100}%`,
    // Degenerate boxes stay clickable: zero-height title band / thin ylab strip.
    minHeight: 14,
    minWidth: 14,
  };
}
