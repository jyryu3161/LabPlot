'use client';

import { useEffect, useRef, useState } from 'react';
import Konva from 'konva';
import { Stage, Layer, Group, Rect, Arrow, Line, Text } from 'react-konva';
import { ArrowUpRight, Minus, MapPin, Square, Trash2, Type } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { FigureAnnotation, FigureLayout, AnnotationCoord } from '@/lib/types';

type RelTool = 'text' | 'arrow' | 'rect' | 'bracket';

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const DEFAULT_COLOR = '#2563EB';

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
function identity(n: number): number {
  return n;
}
function shapeColor(ann: FigureAnnotation, selected: boolean): string {
  if (selected) return '#0F172A';
  return typeof ann.color === 'string' && HEX_RE.test(ann.color) ? ann.color : DEFAULT_COLOR;
}
function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return String(Number(n.toPrecision(4)));
}
function fmtCoords(mode: AnnotationCoord, x: number, y: number): string {
  if (mode === 'data') return `x ${fmtNum(x)} · y ${fmtNum(y)}`;
  return `x ${Math.round(clamp01(x) * 100)}% · y ${Math.round(clamp01(y) * 100)}%`;
}

/**
 * Panel geometry mapped into DISPLAYED pixels. panel_px in the layout are pixels
 * on the ORIGINAL rendered PNG (img_px.w×img_px.h) with y measured from the image
 * TOP (y0 = top of plotting panel, y1 = bottom). We scale by sx/sy to the on-screen
 * image size, giving pL/pR/pT/pB and the panel width/height.
 *
 * Worked example (scatter, 2100×1260 png, layout panel_px={x0:131.68,x1:2050.19,
 * y0:41.51,y1:1141.51}, x_range=[2.44,16.96]). Suppose the image is displayed at
 * half size (1050×630) ⇒ sx=sy=0.5. Then pL=65.84, pR=1025.10, pT=20.76,
 * pB=570.76, W=959.26, H=550.00.
 *   • dataX=2.44 (x_range[0]) ⇒ fx=0 ⇒ stage px=0 ⇒ image px=pL=65.84 = x0*sx. ✓
 *   • dataX=16.96 (x_range[1]) ⇒ fx=1 ⇒ stage px=W ⇒ image px=pR = x1*sx. ✓
 *   • dataY=y_range[0] ⇒ fy=0 ⇒ stage py=H (bottom, pB) — y grows upward. ✓
 *   • pointer at panel-bottom-left (px=0,py=H) ⇒ fx=0,fy=0 ⇒ data (xmin,ymin). ✓
 * Reverse (data→px) and forward (px→data) are exact inverses of the linear map.
 */
interface Panel {
  pL: number;
  pR: number;
  pT: number;
  pB: number;
  W: number;
  H: number;
}

interface DraftDrag {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface LabelPrompt {
  kind: 'text' | 'bracket';
  coord: AnnotationCoord;
  ix: number; // image-container px (for input positioning)
  iy: number;
  coords: { x: number; y: number; x2?: number };
  value: string;
}
interface Readout {
  mode: AnnotationCoord;
  x: number;
  y: number;
}

const TOOLS: { key: RelTool; label: string; icon: typeof Type }[] = [
  { key: 'text', label: 'Text', icon: Type },
  { key: 'arrow', label: 'Arrow', icon: ArrowUpRight },
  { key: 'rect', label: 'Box', icon: Square },
  { key: 'bracket', label: 'Bracket', icon: Minus },
];

/**
 * Visual drag-to-place editor for figure annotations. Renders the figure image and,
 * when "Place on figure" is on, a Konva stage clipped to the plotting PANEL (when a
 * `layout` is available) so the interactive area matches the real data area.
 *
 * Coordinate modes:
 *  - Data (default when layout present and neither axis is discrete): clicks map to
 *    data-space values via x_range/y_range so marks pin to the data and survive
 *    re-render/rescale. Produces `coord: 'data'`.
 *  - Relative: 0..1 fraction of the panel (y up). Produces `coord: 'relative'`.
 *  - No layout (older versions / 3D / heatmap): graceful fallback — stage covers the
 *    whole image and only relative, whole-image annotations are handled here.
 *
 * All annotations this overlay owns are rendered AND draggable at their exact panel
 * pixel positions; dragging updates each mark in its OWN coordinate space (data drag →
 * new data x/y; relative drag → new fraction), delivering WYSIWYG placement. `onChange`
 * always emits the full merged list (unowned items untouched).
 */
export function FigureAnnotationOverlay({
  imageUrl,
  alt,
  annotations,
  onChange,
  layout,
}: {
  imageUrl: string;
  alt: string;
  annotations: FigureAnnotation[];
  onChange: (next: FigureAnnotation[]) => void;
  layout?: FigureLayout | null;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [enabled, setEnabled] = useState(false);
  const [tool, setTool] = useState<RelTool>('arrow');
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [draft, setDraft] = useState<DraftDrag | null>(null);
  const [labelInput, setLabelInput] = useState<LabelPrompt | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [readout, setReadout] = useState<Readout | null>(null);

  // Data placement is only sensible when a panel exists and neither axis is discrete
  // (linear data mapping). Otherwise we fall back to relative placement.
  const dataCapable = Boolean(layout) && !layout!.x_discrete && !layout!.y_discrete;
  const [coordMode, setCoordMode] = useState<AnnotationCoord>(() => (dataCapable ? 'data' : 'relative'));

  const { w, h } = dims;

  // Panel rectangle in DISPLAYED pixels (only when layout + measured image).
  let panel: Panel | null = null;
  if (layout && w > 0 && h > 0 && layout.img_px.w > 0 && layout.img_px.h > 0) {
    const sx = w / layout.img_px.w;
    const sy = h / layout.img_px.h;
    const pL = layout.panel_px.x0 * sx;
    const pR = layout.panel_px.x1 * sx;
    const pT = layout.panel_px.y0 * sy;
    const pB = layout.panel_px.y1 * sy;
    panel = { pL, pR, pT, pB, W: pR - pL, H: pB - pT };
  }

  // Stage geometry: clipped to the panel when available, else the whole image.
  const stageW = panel ? panel.W : w;
  const stageH = panel ? panel.H : h;
  const containerStyle: React.CSSProperties = panel
    ? { position: 'absolute', left: panel.pL, top: panel.pT, width: panel.W, height: panel.H }
    : { position: 'absolute', inset: 0 };

  // Active placement coord for NEW marks.
  const placeMode: AnnotationCoord = dataCapable && coordMode === 'data' ? 'data' : 'relative';

  const fontSize = Math.max(12, Math.round((stageH || 400) * 0.03));

  // --- Coordinate mapping ---------------------------------------------------
  // annotation coord-space value → stage px (relative to stage/panel origin).
  function coordToStage(coord: AnnotationCoord, x: number, y: number): { px: number; py: number } {
    if (panel) {
      if (coord === 'data' && layout) {
        const [x0, x1] = layout.x_range;
        const [y0v, y1v] = layout.y_range;
        const fx = (x - x0) / (x1 - x0);
        const fy = (y - y0v) / (y1v - y0v);
        return { px: fx * panel.W, py: panel.H - fy * panel.H };
      }
      // relative = panel fraction (y up)
      return { px: x * panel.W, py: panel.H - y * panel.H };
    }
    // fallback: whole-image relative fraction (y up)
    return { px: x * stageW, py: (1 - y) * stageH };
  }
  // stage px → coord-space value in the requested mode (clamped into the panel).
  function stageToCoords(px: number, py: number, mode: AnnotationCoord): { x: number; y: number } {
    if (panel) {
      const fx = clamp01(px / panel.W);
      const fy = clamp01((panel.H - py) / panel.H);
      if (mode === 'data' && layout) {
        const [x0, x1] = layout.x_range;
        const [y0v, y1v] = layout.y_range;
        return { x: x0 + fx * (x1 - x0), y: y0v + fy * (y1v - y0v) };
      }
      return { x: fx, y: fy };
    }
    return { x: clamp01(px / stageW), y: clamp01(1 - py / stageH) };
  }
  // pixel drag delta → delta in the annotation's own coord space.
  function pxDeltaToCoord(coord: AnnotationCoord, dxPx: number, dyPx: number): { dx: number; dy: number } {
    if (panel) {
      if (coord === 'data' && layout) {
        const [x0, x1] = layout.x_range;
        const [y0v, y1v] = layout.y_range;
        return { dx: (dxPx / panel.W) * (x1 - x0), dy: -(dyPx / panel.H) * (y1v - y0v) };
      }
      return { dx: dxPx / panel.W, dy: -dyPx / panel.H };
    }
    return { dx: dxPx / stageW, dy: -dyPx / stageH };
  }
  // stage px → image-container px (for absolutely-positioned label input).
  function stageToImagePx(px: number, py: number): { ix: number; iy: number } {
    return panel ? { ix: panel.pL + px, iy: panel.pT + py } : { ix: px, iy: py };
  }

  // Owned annotations: with a panel we render both data + relative; without a panel
  // only whole-image relative marks are handled here (data marks left to the form).
  const owned = annotations
    .map((ann, index) => ({ ann, index }))
    .filter(({ ann }) => (panel ? ann.coord === 'data' || ann.coord === 'relative' : ann.coord === 'relative'));

  // Keep the stage sized to the rendered image (responsive + after load).
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const measure = () => setDims({ w: img.clientWidth, h: img.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(img);
    return () => ro.disconnect();
  }, [imageUrl]);

  // Delete/Escape for the selected annotation (never steals from inputs).
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (selected === null) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        removeAt(selected);
      } else if (e.key === 'Escape') {
        setSelected(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, selected, annotations]);

  function add(ann: FigureAnnotation) {
    onChange([...annotations, ann]);
  }
  function updateAt(index: number, ann: FigureAnnotation) {
    onChange(annotations.map((a, i) => (i === index ? ann : a)));
  }
  function removeAt(index: number) {
    onChange(annotations.filter((_, i) => i !== index));
    setSelected(null);
  }

  // Shift an annotation by (dx, dy) in its OWN coord units. Relative marks clamp to
  // [0,1]; data marks are free (values live in data space, not a fraction).
  function shiftAnnotation(ann: FigureAnnotation, dx: number, dy: number, doClamp: boolean): FigureAnnotation {
    const c = doClamp ? clamp01 : identity;
    switch (ann.kind) {
      case 'text':
        return { ...ann, x: c(ann.x + dx), y: c(ann.y + dy) };
      case 'arrow':
      case 'rect':
        return { ...ann, x: c(ann.x + dx), y: c(ann.y + dy), x2: c(ann.x2 + dx), y2: c(ann.y2 + dy) };
      case 'bracket':
        return { ...ann, x: c(ann.x + dx), x2: c(ann.x2 + dx), y: c(ann.y + dy) };
    }
  }

  function primaryCoord(ann: FigureAnnotation): { x: number; y: number } {
    return { x: ann.x, y: ann.y };
  }

  function handleDragMove(ann: FigureAnnotation, e: Konva.KonvaEventObject<DragEvent>) {
    const g = e.target;
    const coord = (ann.coord ?? 'relative') as AnnotationCoord;
    const { dx, dy } = pxDeltaToCoord(coord, g.x(), g.y());
    const base = primaryCoord(ann);
    const doClamp = coord === 'relative';
    const nx = doClamp ? clamp01(base.x + dx) : base.x + dx;
    const ny = doClamp ? clamp01(base.y + dy) : base.y + dy;
    setReadout({ mode: coord, x: nx, y: ny });
  }

  function handleDragEnd(index: number, ann: FigureAnnotation, e: Konva.KonvaEventObject<DragEvent>) {
    const g = e.target;
    const dxPx = g.x();
    const dyPx = g.y();
    g.position({ x: 0, y: 0 });
    setReadout(null);
    if (Math.abs(dxPx) < 0.5 && Math.abs(dyPx) < 0.5) return; // pure click → select only
    const coord = (ann.coord ?? 'relative') as AnnotationCoord;
    const { dx, dy } = pxDeltaToCoord(coord, dxPx, dyPx);
    updateAt(index, shiftAnnotation(ann, dx, dy, coord === 'relative'));
  }

  function onStageDown(e: Konva.KonvaEventObject<MouseEvent>) {
    if (labelInput) return;
    const stage = e.target.getStage();
    if (!stage || e.target !== stage) return; // clicked a shape → let drag/select handle it
    const pos = stage.getPointerPosition();
    if (!pos) return;
    setSelected(null);
    if (tool === 'text') {
      const coords = stageToCoords(pos.x, pos.y, placeMode);
      const { ix, iy } = stageToImagePx(pos.x, pos.y);
      setLabelInput({ kind: 'text', coord: placeMode, ix, iy, coords, value: 'Label' });
      return;
    }
    setDraft({ x0: pos.x, y0: pos.y, x1: pos.x, y1: pos.y });
  }
  function onStageMove(e: Konva.KonvaEventObject<MouseEvent>) {
    const pos = e.target.getStage()?.getPointerPosition();
    if (!pos) return;
    setReadout({ mode: placeMode, ...stageToCoords(pos.x, pos.y, placeMode) });
    if (draft) setDraft({ ...draft, x1: pos.x, y1: pos.y });
  }
  function onStageUp() {
    if (!draft) return;
    const d = draft;
    setDraft(null);
    if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) < 4) return; // too small to be intentional
    const a = stageToCoords(d.x0, d.y0, placeMode);
    const b = stageToCoords(d.x1, d.y1, placeMode);
    if (tool === 'arrow') {
      add({ kind: 'arrow', x: a.x, y: a.y, x2: b.x, y2: b.y, color: '#000000', coord: placeMode });
    } else if (tool === 'rect') {
      add({ kind: 'rect', x: a.x, y: a.y, x2: b.x, y2: b.y, color: '#EE6677', coord: placeMode });
    } else if (tool === 'bracket') {
      const mid = stageToImagePx((d.x0 + d.x1) / 2, Math.min(d.y0, d.y1));
      setLabelInput({
        kind: 'bracket',
        coord: placeMode,
        ix: mid.ix,
        iy: mid.iy,
        coords: { x: a.x, x2: b.x, y: a.y },
        value: '*',
      });
    }
  }

  function confirmLabel() {
    if (!labelInput) return;
    const value = labelInput.value.trim() || (labelInput.kind === 'text' ? 'Label' : '*');
    const c = labelInput.coords;
    if (labelInput.kind === 'text') {
      add({ kind: 'text', x: c.x, y: c.y, text: value, size: 4, color: '#000000', coord: labelInput.coord });
    } else {
      add({ kind: 'bracket', x: c.x, x2: c.x2 ?? c.x, y: c.y, label: value, color: '#000000', coord: labelInput.coord });
    }
    setLabelInput(null);
  }

  function renderShape(ann: FigureAnnotation, isSel: boolean) {
    const color = shapeColor(ann, isSel);
    const sw = isSel ? 3 : 2;
    const coord = (ann.coord ?? 'relative') as AnnotationCoord;
    const map = (x: number, y: number) => coordToStage(coord, x, y);
    if (ann.kind === 'text') {
      const { px, py } = map(ann.x, ann.y);
      return <Text x={px} y={py} text={ann.text || 'Label'} fontSize={fontSize} fill={color} />;
    }
    if (ann.kind === 'arrow') {
      const p1 = map(ann.x, ann.y);
      const p2 = map(ann.x2, ann.y2);
      return <Arrow points={[p1.px, p1.py, p2.px, p2.py]} stroke={color} fill={color} strokeWidth={sw} pointerLength={10} pointerWidth={10} />;
    }
    if (ann.kind === 'rect') {
      const p1 = map(ann.x, ann.y);
      const p2 = map(ann.x2, ann.y2);
      return (
        <Rect
          x={Math.min(p1.px, p2.px)}
          y={Math.min(p1.py, p2.py)}
          width={Math.abs(p2.px - p1.px)}
          height={Math.abs(p2.py - p1.py)}
          stroke={color}
          strokeWidth={sw}
          dash={[6, 4]}
          fill={isSel ? 'rgba(15,23,42,0.06)' : 'rgba(37,99,235,0.06)'}
        />
      );
    }
    // bracket — horizontal span at y with downward end ticks and a label above
    const p1 = map(ann.x, ann.y);
    const p2 = map(ann.x2, ann.y);
    const left = Math.min(p1.px, p2.px);
    const right = Math.max(p1.px, p2.px);
    const y = p1.py;
    const tick = 8;
    return (
      <>
        <Line points={[left, y + tick, left, y, right, y, right, y + tick]} stroke={color} strokeWidth={sw} />
        <Text x={(left + right) / 2 - fontSize} y={y - fontSize - 4} text={ann.label || '*'} fontSize={fontSize} fill={color} />
      </>
    );
  }

  function renderDraft() {
    if (!draft) return null;
    if (tool === 'arrow') {
      return <Arrow points={[draft.x0, draft.y0, draft.x1, draft.y1]} stroke={DEFAULT_COLOR} fill={DEFAULT_COLOR} strokeWidth={2} dash={[4, 4]} pointerLength={10} pointerWidth={10} />;
    }
    if (tool === 'rect') {
      return (
        <Rect
          x={Math.min(draft.x0, draft.x1)}
          y={Math.min(draft.y0, draft.y1)}
          width={Math.abs(draft.x1 - draft.x0)}
          height={Math.abs(draft.y1 - draft.y0)}
          stroke={DEFAULT_COLOR}
          strokeWidth={2}
          dash={[4, 4]}
          fill="rgba(37,99,235,0.06)"
        />
      );
    }
    if (tool === 'bracket') {
      const left = Math.min(draft.x0, draft.x1);
      const right = Math.max(draft.x0, draft.x1);
      return <Line points={[left, draft.y0 + 8, left, draft.y0, right, draft.y0, right, draft.y0 + 8]} stroke={DEFAULT_COLOR} strokeWidth={2} dash={[4, 4]} />;
    }
    return null;
  }

  const ownedCount = owned.length;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <MapPin className={`h-4 w-4 ${enabled ? 'text-primary' : 'text-muted-foreground'}`} />
          <Label htmlFor="place-on-figure" className="cursor-pointer text-sm">Place on figure</Label>
          <Switch id="place-on-figure" checked={enabled} onCheckedChange={setEnabled} aria-label="Toggle visual annotation placement" />
        </div>
        {ownedCount > 0 && <Badge variant="secondary" className="text-[10px]">{ownedCount} placed</Badge>}
        {enabled && (
          <>
            {dataCapable && (
              <div className="flex items-center gap-1" role="group" aria-label="Placement coordinate mode">
                <Button type="button" size="xs" variant={coordMode === 'data' ? 'default' : 'outline'} onClick={() => setCoordMode('data')}>
                  Data coords
                </Button>
                <Button type="button" size="xs" variant={coordMode === 'relative' ? 'default' : 'outline'} onClick={() => setCoordMode('relative')}>
                  Relative
                </Button>
              </div>
            )}
            <div className="flex flex-wrap gap-1">
              {TOOLS.map(({ key, label, icon: Icon }) => (
                <Button key={key} type="button" size="xs" variant={tool === key ? 'default' : 'outline'} onClick={() => setTool(key)}>
                  <Icon className="mr-1 h-3.5 w-3.5" /> {label}
                </Button>
              ))}
            </div>
            <Button type="button" size="xs" variant="ghost" disabled={selected === null} onClick={() => selected !== null && removeAt(selected)}>
              <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
            </Button>
          </>
        )}
      </div>
      {enabled && (
        <p className="text-[11px] text-muted-foreground">
          {panel
            ? placeMode === 'data'
              ? 'Marks pin to data coordinates and stay correct when the figure is re-rendered or rescaled. Drag to place an arrow, box, or bracket; click to drop a text label. Drag an existing mark to reposition it, click to select, then Delete to remove.'
              : 'Marks are placed relative to the plotting panel (0–100%). Drag to place an arrow, box, or bracket; click to drop a text label. Drag an existing mark to reposition it, click to select, then Delete to remove.'
            : 'Placement is relative to the whole image (approximate). Precise, data-pinned placement is available after re-render. Drag to place an arrow, box, or bracket; click to drop a text label.'}
        </p>
      )}
      <div className="relative mx-auto w-fit">
        <img
          ref={imgRef}
          src={imageUrl}
          alt={alt}
          decoding="async"
          draggable={false}
          className="mx-auto block max-h-[58vh] w-auto rounded bg-white object-contain"
          onLoad={() => { const img = imgRef.current; if (img) setDims({ w: img.clientWidth, h: img.clientHeight }); }}
        />
        {enabled && stageW > 0 && stageH > 0 && (
          <div
            style={{ ...containerStyle, cursor: labelInput ? 'text' : 'crosshair' }}
            onMouseLeave={() => setReadout(null)}
          >
            <Stage width={stageW} height={stageH} onMouseDown={onStageDown} onMouseMove={onStageMove} onMouseUp={onStageUp}>
              <Layer>
                {owned.map(({ ann, index }) => (
                  <Group
                    key={index}
                    draggable
                    onClick={() => setSelected(index)}
                    onTap={() => setSelected(index)}
                    onDragStart={() => setSelected(index)}
                    onDragMove={(e) => handleDragMove(ann, e)}
                    onDragEnd={(e) => handleDragEnd(index, ann, e)}
                  >
                    {renderShape(ann, selected === index)}
                  </Group>
                ))}
                {renderDraft()}
              </Layer>
            </Stage>
          </div>
        )}
        {enabled && readout && (
          <div className="pointer-events-none absolute left-2 top-2 z-10 rounded bg-slate-900/80 px-2 py-0.5 font-mono text-[10px] text-white shadow">
            {readout.mode === 'data' ? 'data ' : 'panel '}{fmtCoords(readout.mode, readout.x, readout.y)}
          </div>
        )}
        {enabled && labelInput && (
          <input
            autoFocus
            className="absolute z-10 h-7 w-40 -translate-y-1/2 rounded border bg-background px-2 text-xs shadow"
            style={{ left: Math.min(labelInput.ix, Math.max(0, w - 160)), top: Math.max(12, labelInput.iy) }}
            value={labelInput.value}
            onChange={(e) => setLabelInput({ ...labelInput, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); confirmLabel(); }
              else if (e.key === 'Escape') { e.preventDefault(); setLabelInput(null); }
            }}
            onBlur={confirmLabel}
            aria-label={labelInput.kind === 'text' ? 'Annotation text' : 'Bracket label'}
            placeholder={labelInput.kind === 'text' ? 'Label text' : 'Bracket label'}
          />
        )}
      </div>
    </div>
  );
}
