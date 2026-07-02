// Client-side, spatially-scoped SVG recolor for the canvas color editor.
//
// Frozen decisions (docs/01-plan/multipanel-canvas-design.md §1, §7, decision 9):
//  - Color editing reuses `series_styles`/`category_colors` (scale-level) so the
//    graph body AND legend keys share one hex per series — recoloring one recolors
//    both, matching what the server will produce on the committed re-render.
//  - Instant preview = inline-SVG hex replace, but SPATIALLY SCOPED to the panel
//    body (inset ~2% so axis lines/ticks at the border are untouched) plus each
//    legend key-box. An element is only recolored when its CURRENT paint equals a
//    series' current hex AND its bbox center lies inside the scope — so recoloring
//    a BLACK series never touches black axis lines/ticks outside those boxes.
//
// All boxes are in the preview SVG's OWN native px (== the SVG viewBox units,
// == `layout.img_px`), matching `panel_px` / `legend_keys[].px` from the sidecar.

export type Box = { x0: number; y0: number; x1: number; y1: number };
export type LegendKey = { series: string; px: Box };

const PAINT_SELECTOR = 'path,circle,rect,line,polyline,polygon,ellipse';

/** Normalize a color to lowercase `#rrggbb`, or null for none/transparent/unparseable. */
export function normalizeColor(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (!s || s === 'none' || s === 'transparent' || s === 'currentcolor') return null;

  const rgb = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  if (rgb) {
    const parts = [rgb[1], rgb[2], rgb[3]].map((v) => Math.max(0, Math.min(255, Math.round(parseFloat(v)))));
    return '#' + parts.map((n) => n.toString(16).padStart(2, '0')).join('');
  }

  if (s[0] !== '#') return null;
  s = s.slice(1);
  if (s.length === 3) s = s.split('').map((c) => c + c).join(''); // #rgb → #rrggbb
  if (s.length === 8) s = s.slice(0, 6); // drop alpha
  if (s.length !== 6 || /[^0-9a-f]/.test(s)) return null;
  return '#' + s;
}

// ── paint read/write (handles both presentation attrs and inline style) ──────
function styleProp(el: Element, prop: string): string | null {
  const style = el.getAttribute('style');
  if (!style) return null;
  const m = style.match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)', 'i'));
  return m ? m[1].trim() : null;
}

/** The element's effective fill|stroke as a normalized hex (or null). */
export function readPaint(el: Element, prop: 'fill' | 'stroke'): string | null {
  return normalizeColor(styleProp(el, prop) ?? el.getAttribute(prop));
}

function setPaint(el: Element, prop: 'fill' | 'stroke', value: string): void {
  const style = el.getAttribute('style');
  if (style && new RegExp('(?:^|;)\\s*' + prop + '\\s*:', 'i').test(style)) {
    el.setAttribute(
      'style',
      style.replace(new RegExp('((?:^|;)\\s*' + prop + '\\s*:\\s*)([^;]+)', 'i'), `$1${value}`),
    );
  }
  if (el.hasAttribute(prop)) el.setAttribute(prop, value);
}

// ── geometry ────────────────────────────────────────────────────────────────
function inBox(x: number, y: number, b: Box): boolean {
  return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
}

/** BBox center mapped to the SVG root (viewBox == img_px) coordinate system. */
function centerInRoot(el: SVGGraphicsElement): { x: number; y: number } | null {
  try {
    if (typeof el.getBBox !== 'function') return null;
    const b = el.getBBox();
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const m = el.getCTM();
    if (!m) return { x: cx, y: cy };
    return { x: m.a * cx + m.c * cy + m.e, y: m.b * cx + m.d * cy + m.f };
  } catch {
    return null;
  }
}

/** Scope = panel body inset by `inset` (default 2%) + every legend key-box. */
export function computeScopeBoxes(panelPx: Box, legendKeys: LegendKey[], inset = 0.02): Box[] {
  const pw = panelPx.x1 - panelPx.x0;
  const ph = panelPx.y1 - panelPx.y0;
  const panelInset: Box = {
    x0: panelPx.x0 + pw * inset,
    y0: panelPx.y0 + ph * inset,
    x1: panelPx.x1 - pw * inset,
    y1: panelPx.y1 - ph * inset,
  };
  return [panelInset, ...legendKeys.map((k) => k.px)];
}

/**
 * Recolor `root` in place. For each element matching PAINT_SELECTOR whose fill|stroke
 * equals a series' CURRENT hex AND whose bbox center is inside the scope, swap that
 * paint to the series' new hex. Both the graph body and the in-scope legend keys are
 * recolored together (they share the series hex and are both in-scope).
 */
export function recolorSvg(
  root: SVGElement,
  edits: Record<string, string>,
  seriesHex: Record<string, string>,
  scopeBoxes: Box[],
): void {
  const editList = Object.entries(edits)
    .map(([series, next]) => ({ cur: normalizeColor(seriesHex[series]), next: normalizeColor(next) ?? next }))
    .filter((e): e is { cur: string; next: string } => Boolean(e.cur));
  if (!editList.length || !scopeBoxes.length) return;

  root.querySelectorAll(PAINT_SELECTOR).forEach((node) => {
    const el = node as SVGGraphicsElement;
    const c = centerInRoot(el);
    if (!c) return;
    const inScope = scopeBoxes.some((b) => inBox(c.x, c.y, b));
    if (!inScope) return;
    (['fill', 'stroke'] as const).forEach((prop) => {
      const cur = readPaint(el, prop);
      if (!cur) return;
      const hit = editList.find((e) => e.cur === cur);
      if (hit) setPaint(el, prop, hit.next);
    });
  });
}

// ── hit-testing (click-to-select a series on the panel) ──────────────────────
/** Legend-key hit-test: which series' legend box contains the native-px point. */
export function seriesAtPoint(sx: number, sy: number, legendKeys: LegendKey[]): string | null {
  for (const k of legendKeys) if (inBox(sx, sy, k.px)) return k.series;
  return null;
}

/**
 * Graph-object hit-test: read the clicked element's (or a near ancestor's) paint and
 * match it to a series via `series_hex` (current) OR `edits` (already-recolored), so a
 * click still resolves after the instant preview has changed that series' color.
 */
export function seriesAtElement(
  target: Element | null,
  seriesHex: Record<string, string>,
  edits: Record<string, string>,
): string | null {
  let el: Element | null = target;
  for (let depth = 0; el && depth < 4; depth++, el = el.parentElement) {
    for (const prop of ['fill', 'stroke'] as const) {
      const cur = readPaint(el, prop);
      if (!cur) continue;
      for (const series of Object.keys(seriesHex)) {
        const candidates = [normalizeColor(seriesHex[series]), normalizeColor(edits[series])];
        if (candidates.includes(cur)) return series;
      }
    }
  }
  return null;
}
