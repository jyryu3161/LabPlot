// Panel layout helpers shared with M-C2. Pure TypeScript (no React, no I/O).
import type { CanvasPanel } from '@/lib/types';

/**
 * Reading order for "Relabel A→Z" (M-C1 contract §5): cluster panels into
 * rows by y_mm — a panel joins a row if
 * `|y - rowTopY| <= 0.5 * min(panel heights in row ∪ panel)` — rows are
 * ordered top-to-bottom (by their first panel's y_mm), and panels within a
 * row are ordered left-to-right by x_mm. Image panels are included; a
 * panel's label-visibility does not affect its place in the order.
 */
export function readingOrder(panels: CanvasPanel[]): CanvasPanel[] {
  const rows: CanvasPanel[][] = [];
  const sorted = [...panels].sort((a, b) => a.y_mm - b.y_mm);
  for (const panel of sorted) {
    let placedRow: CanvasPanel[] | null = null;
    for (const row of rows) {
      const rowTopY = row[0].y_mm;
      const heights = [...row.map((p) => p.height_mm), panel.height_mm];
      const threshold = 0.5 * Math.min(...heights);
      if (Math.abs(panel.y_mm - rowTopY) <= threshold) {
        placedRow = row;
        break;
      }
    }
    if (placedRow) placedRow.push(panel);
    else rows.push([panel]);
  }
  rows.sort((a, b) => a[0].y_mm - b[0].y_mm);
  const out: CanvasPanel[] = [];
  for (const row of rows) {
    out.push(...[...row].sort((a, b) => a.x_mm - b.x_mm));
  }
  return out;
}
