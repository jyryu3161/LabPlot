'use client';

import { useEffect, useRef } from 'react';
import { useTheme } from 'next-themes';

// U9: top/left mm rulers pinned to the viewport edges. Editor-only chrome —
// composed server-side, the export never sees these — so they're plain HTML
// <canvas> overlays (not Konva) drawn imperatively with the 2D context. Kept
// deliberately separate from the Konva Stage: `pointer-events: none` on every
// wrapper means a click anywhere in the ruler band passes straight through to
// whatever's underneath (the Stage), so the rulers can never steal a
// mousedown/drag from the editor — no dead zones despite visually overlapping
// the annotation toolbar's corner (see CanvasAnnotationToolbar's inset, which
// leaves room so it doesn't sit UNDER the ruler ink).
export const RULER_PX = 22;

type ViewT = { zoom: number; x: number; y: number };

// Label pitch (mm) never denser than 10mm (at zoom>=fit that's the
// steady-state step); steps up through this ladder as the view zooms out so
// labels never crowd each other.
const STEP_CANDIDATES_MM = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
const MIN_LABEL_SPACING_PX = 46;
const MIN_MINOR_SPACING_PX = 6;
const MAX_TICKS_PER_AXIS = 800; // defensive cap — never spam draws at pathological zoom

function pickStepMm(pxPerMmZoomed: number): number {
  for (const step of STEP_CANDIDATES_MM) {
    if (step * pxPerMmZoomed >= MIN_LABEL_SPACING_PX) return step;
  }
  return STEP_CANDIDATES_MM[STEP_CANDIDATES_MM.length - 1];
}

function drawRuler(
  canvas: HTMLCanvasElement,
  orientation: 'x' | 'y',
  lengthPx: number,
  view: ViewT,
  pxPerMm: number,
  colors: { bg: string; ink: string },
) {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const thickness = RULER_PX;
  const wCss = orientation === 'x' ? lengthPx : thickness;
  const hCss = orientation === 'x' ? thickness : lengthPx;
  canvas.width = Math.max(1, Math.round(wCss * dpr));
  canvas.height = Math.max(1, Math.round(hCss * dpr));
  canvas.style.width = `${wCss}px`;
  canvas.style.height = `${hCss}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, wCss, hCss);
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, wCss, hCss);
  if (lengthPx <= 0) return;

  const pxPerMmZoomed = pxPerMm * view.zoom;
  if (!(pxPerMmZoomed > 0) || !Number.isFinite(pxPerMmZoomed)) return;
  // The ruler <canvas> lives in a wrapper inset by RULER_PX from the container
  // origin (left: RULER_PX for the top ruler, top: RULER_PX for the left one),
  // while view.x/view.y are Stage offsets in CONTAINER coordinates (the Stage
  // fills the container from (0,0)). Subtract the inset so ruler-local mm=0
  // lines up with the sheet origin instead of sitting exactly RULER_PX off.
  const offset = (orientation === 'x' ? view.x : view.y) - RULER_PX;
  const mmMin = -offset / pxPerMmZoomed;
  const mmMax = (lengthPx - offset) / pxPerMmZoomed;

  const step = pickStepMm(pxPerMmZoomed);
  const minorStep = step / 5;
  const showMinor = minorStep * pxPerMmZoomed >= MIN_MINOR_SPACING_PX;
  const tickUnit = showMinor ? minorStep : step;
  // Integer tick index (not repeated float addition) so "is this a major
  // line" is an exact modulo check instead of float-drift-prone comparison.
  const majorEvery = Math.max(1, Math.round(step / tickUnit));
  const firstIdx = Math.floor(mmMin / tickUnit) - 1;
  const lastMm = mmMax;

  ctx.strokeStyle = colors.ink;
  ctx.fillStyle = colors.ink;
  ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
  ctx.lineWidth = 1;

  let count = 0;
  for (let idx = firstIdx; count < MAX_TICKS_PER_AXIS; idx++, count++) {
    const mm = idx * tickUnit;
    if (mm > lastMm + tickUnit) break;
    if (mm < mmMin - tickUnit) continue;
    const isMajor = idx % majorEvery === 0;
    const posPx = offset + mm * pxPerMmZoomed;
    const tickLen = isMajor ? 9 : 4;
    if (orientation === 'x') {
      ctx.beginPath();
      ctx.moveTo(posPx + 0.5, thickness);
      ctx.lineTo(posPx + 0.5, thickness - tickLen);
      ctx.stroke();
      if (isMajor) {
        ctx.textBaseline = 'top';
        ctx.fillText(String(Math.round(mm)), posPx + 2, 2);
      }
    } else {
      ctx.beginPath();
      ctx.moveTo(thickness, posPx + 0.5);
      ctx.lineTo(thickness - tickLen, posPx + 0.5);
      ctx.stroke();
      if (isMajor) {
        ctx.save();
        ctx.translate(9, posPx - 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textBaseline = 'bottom';
        ctx.fillText(String(Math.round(mm)), 0, 0);
        ctx.restore();
      }
    }
  }
}

/**
 * mm rulers along the top and left edges of the canvas viewport — always on
 * (no toggle), zoom/pan-synced, `pointer-events: none` throughout so they
 * never intercept a drag meant for the Konva Stage underneath.
 */
export function CanvasRulers({
  viewport, view, pxPerMm,
}: {
  viewport: { w: number; h: number };
  view: ViewT;
  pxPerMm: number;
}) {
  const topRef = useRef<HTMLCanvasElement>(null);
  const leftRef = useRef<HTMLCanvasElement>(null);
  const swatchRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    // Theme flips swap the CSS variables behind bg-background/95 and
    // text-muted-foreground — re-read getComputedStyle and repaint the raster
    // when next-themes resolves a new theme (the class lands on <html> before
    // this re-runs, so the swatch already carries the new colors).
    void resolvedTheme;
    const topCanvas = topRef.current;
    const leftCanvas = leftRef.current;
    const swatch = swatchRef.current;
    if (!topCanvas || !leftCanvas || !swatch || viewport.w <= 0 || viewport.h <= 0) return;
    // A hidden themed element resolves Tailwind's CSS-variable colors
    // (bg-background/95, text-muted-foreground) into concrete rgb()/oklch()
    // strings the canvas 2D context can use directly as fillStyle/strokeStyle
    // — canvas can't read Tailwind classes, but getComputedStyle can.
    const cs = getComputedStyle(swatch);
    const colors = { bg: cs.backgroundColor, ink: cs.color };
    drawRuler(topCanvas, 'x', Math.max(0, viewport.w - RULER_PX), view, pxPerMm, colors);
    drawRuler(leftCanvas, 'y', Math.max(0, viewport.h - RULER_PX), view, pxPerMm, colors);
    // `view` itself (not just its numeric fields) is passed into drawRuler,
    // so it — not the individual x/y/zoom fields — is the exhaustive-deps-
    // correct dependency; CanvasEditor replaces it wholesale on every pan/
    // zoom/wheel update, so this re-runs exactly when it needs to.
  }, [viewport.w, viewport.h, view, pxPerMm, resolvedTheme]);

  if (viewport.w <= 0 || viewport.h <= 0) return null;

  return (
    <>
      <div
        ref={swatchRef}
        className="pointer-events-none absolute -z-10 h-0 w-0 overflow-hidden bg-background/95 text-muted-foreground"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute left-0 top-0 z-20 overflow-hidden border-b border-border"
        style={{ left: RULER_PX, width: Math.max(0, viewport.w - RULER_PX), height: RULER_PX }}
        data-testid="canvas-ruler-top"
        aria-hidden
      >
        <canvas ref={topRef} />
      </div>
      <div
        className="pointer-events-none absolute left-0 top-0 z-20 overflow-hidden border-r border-border"
        style={{ top: RULER_PX, width: RULER_PX, height: Math.max(0, viewport.h - RULER_PX) }}
        data-testid="canvas-ruler-left"
        aria-hidden
      >
        <canvas ref={leftRef} />
      </div>
      <div
        className="pointer-events-none absolute left-0 top-0 z-20 border-b border-r border-border bg-background/95"
        style={{ width: RULER_PX, height: RULER_PX }}
        data-testid="canvas-ruler-corner"
        aria-hidden
      />
    </>
  );
}
