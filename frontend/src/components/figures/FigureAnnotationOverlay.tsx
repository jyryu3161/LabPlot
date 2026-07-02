'use client';

import { useEffect, useRef, useState } from 'react';
import Konva from 'konva';
import { Stage, Layer, Group, Rect, Arrow, Line, Text } from 'react-konva';
import { ArrowUpRight, Minus, MapPin, Square, Trash2, Type } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { FigureAnnotation } from '@/lib/types';

type RelTool = 'text' | 'arrow' | 'rect' | 'bracket';

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const DEFAULT_COLOR = '#2563EB';

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
function shapeColor(ann: FigureAnnotation, selected: boolean): string {
  if (selected) return '#0F172A';
  return typeof ann.color === 'string' && HEX_RE.test(ann.color) ? ann.color : DEFAULT_COLOR;
}

interface DraftDrag {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface LabelPrompt {
  kind: 'text' | 'bracket';
  px: number;
  py: number;
  coords: { x: number; y: number; x2?: number };
  value: string;
}

const TOOLS: { key: RelTool; label: string; icon: typeof Type }[] = [
  { key: 'text', label: 'Text', icon: Type },
  { key: 'arrow', label: 'Arrow', icon: ArrowUpRight },
  { key: 'rect', label: 'Box', icon: Square },
  { key: 'bracket', label: 'Bracket', icon: Minus },
];

/**
 * Visual drag-to-place editor for panel-relative annotations. Renders the figure
 * image and, when "Place on figure" is on, a Konva stage sized to the displayed
 * image. Clicks/drags map to fractions of the image (x = offsetX/width,
 * y = 1 - offsetY/height so y grows upward like plot coordinates) and produce
 * annotations with `coord: 'relative'`. Data-coord annotations are left to the
 * form editor and are not shown here. `onChange` always emits the full merged
 * list (data-coord items untouched, relative items replaced).
 */
export function FigureAnnotationOverlay({
  imageUrl,
  alt,
  annotations,
  onChange,
}: {
  imageUrl: string;
  alt: string;
  annotations: FigureAnnotation[];
  onChange: (next: FigureAnnotation[]) => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [enabled, setEnabled] = useState(false);
  const [tool, setTool] = useState<RelTool>('arrow');
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [draft, setDraft] = useState<DraftDrag | null>(null);
  const [labelInput, setLabelInput] = useState<LabelPrompt | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const relatives = annotations
    .map((ann, index) => ({ ann, index }))
    .filter((entry) => entry.ann.coord === 'relative');

  const { w, h } = dims;
  const toPx = (x: number, y: number) => ({ px: x * w, py: (1 - y) * h });
  const toFrac = (px: number, py: number) => ({ x: clamp01(px / w), y: clamp01(1 - py / h) });
  const fontSize = Math.max(12, Math.round((h || 400) * 0.03));

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

  // Delete/Escape for the selected relative annotation (never steals from inputs).
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

  function shiftAnnotation(ann: FigureAnnotation, dxf: number, dyf: number): FigureAnnotation {
    switch (ann.kind) {
      case 'text':
        return { ...ann, x: clamp01(ann.x + dxf), y: clamp01(ann.y + dyf) };
      case 'arrow':
      case 'rect':
        return {
          ...ann,
          x: clamp01(ann.x + dxf), y: clamp01(ann.y + dyf),
          x2: clamp01(ann.x2 + dxf), y2: clamp01(ann.y2 + dyf),
        };
      case 'bracket':
        return { ...ann, x: clamp01(ann.x + dxf), x2: clamp01(ann.x2 + dxf), y: clamp01(ann.y + dyf) };
    }
  }

  function handleDragEnd(index: number, ann: FigureAnnotation, e: Konva.KonvaEventObject<DragEvent>) {
    const g = e.target;
    const dx = g.x();
    const dy = g.y();
    g.position({ x: 0, y: 0 });
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return; // pure click → select only
    updateAt(index, shiftAnnotation(ann, dx / w, -dy / h));
  }

  function onStageDown(e: Konva.KonvaEventObject<MouseEvent>) {
    if (labelInput) return;
    const stage = e.target.getStage();
    if (!stage || e.target !== stage) return; // clicked a shape → let drag/select handle it
    const pos = stage.getPointerPosition();
    if (!pos) return;
    setSelected(null);
    if (tool === 'text') {
      setLabelInput({ kind: 'text', px: pos.x, py: pos.y, coords: toFrac(pos.x, pos.y), value: 'Label' });
      return;
    }
    setDraft({ x0: pos.x, y0: pos.y, x1: pos.x, y1: pos.y });
  }
  function onStageMove(e: Konva.KonvaEventObject<MouseEvent>) {
    if (!draft) return;
    const pos = e.target.getStage()?.getPointerPosition();
    if (!pos) return;
    setDraft({ ...draft, x1: pos.x, y1: pos.y });
  }
  function onStageUp() {
    if (!draft) return;
    const d = draft;
    setDraft(null);
    if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) < 4) return; // too small to be intentional
    const a = toFrac(d.x0, d.y0);
    const b = toFrac(d.x1, d.y1);
    if (tool === 'arrow') {
      add({ kind: 'arrow', x: a.x, y: a.y, x2: b.x, y2: b.y, color: '#000000', coord: 'relative' });
    } else if (tool === 'rect') {
      add({ kind: 'rect', x: a.x, y: a.y, x2: b.x, y2: b.y, color: '#EE6677', coord: 'relative' });
    } else if (tool === 'bracket') {
      setLabelInput({
        kind: 'bracket',
        px: (d.x0 + d.x1) / 2,
        py: Math.min(d.y0, d.y1),
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
      add({ kind: 'text', x: c.x, y: c.y, text: value, size: 4, color: '#000000', coord: 'relative' });
    } else {
      add({ kind: 'bracket', x: c.x, x2: c.x2 ?? c.x, y: c.y, label: value, color: '#000000', coord: 'relative' });
    }
    setLabelInput(null);
  }

  function renderShape(ann: FigureAnnotation, selected: boolean) {
    const color = shapeColor(ann, selected);
    const sw = selected ? 3 : 2;
    if (ann.kind === 'text') {
      const { px, py } = toPx(ann.x, ann.y);
      return <Text x={px} y={py} text={ann.text || 'Label'} fontSize={fontSize} fill={color} />;
    }
    if (ann.kind === 'arrow') {
      const p1 = toPx(ann.x, ann.y);
      const p2 = toPx(ann.x2, ann.y2);
      return <Arrow points={[p1.px, p1.py, p2.px, p2.py]} stroke={color} fill={color} strokeWidth={sw} pointerLength={10} pointerWidth={10} />;
    }
    if (ann.kind === 'rect') {
      const p1 = toPx(ann.x, ann.y);
      const p2 = toPx(ann.x2, ann.y2);
      return (
        <Rect
          x={Math.min(p1.px, p2.px)}
          y={Math.min(p1.py, p2.py)}
          width={Math.abs(p2.px - p1.px)}
          height={Math.abs(p2.py - p1.py)}
          stroke={color}
          strokeWidth={sw}
          dash={[6, 4]}
          fill={selected ? 'rgba(15,23,42,0.06)' : 'rgba(37,99,235,0.06)'}
        />
      );
    }
    // bracket — horizontal span at y with downward end ticks and a label above
    const p1 = toPx(ann.x, ann.y);
    const p2 = toPx(ann.x2, ann.y);
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

  const relCount = relatives.length;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <MapPin className={`h-4 w-4 ${enabled ? 'text-primary' : 'text-muted-foreground'}`} />
          <Label htmlFor="place-on-figure" className="cursor-pointer text-sm">Place on figure</Label>
          <Switch id="place-on-figure" checked={enabled} onCheckedChange={setEnabled} aria-label="Toggle visual annotation placement" />
        </div>
        {relCount > 0 && <Badge variant="secondary" className="text-[10px]">{relCount} placed</Badge>}
        {enabled && (
          <>
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
          Placement is relative to the plotting panel (approximate for figures with wide margins). Drag to place an arrow, box, or bracket; click to drop a text label. Drag an existing mark to reposition it, click to select, then Delete to remove. Applied on the next re-render.
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
        {enabled && w > 0 && h > 0 && (
          <div className="absolute inset-0" style={{ cursor: labelInput ? 'text' : 'crosshair' }}>
            <Stage width={w} height={h} onMouseDown={onStageDown} onMouseMove={onStageMove} onMouseUp={onStageUp}>
              <Layer>
                {relatives.map(({ ann, index }) => (
                  <Group
                    key={index}
                    draggable
                    onClick={() => setSelected(index)}
                    onTap={() => setSelected(index)}
                    onDragStart={() => setSelected(index)}
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
        {enabled && labelInput && (
          <input
            autoFocus
            className="absolute z-10 h-7 w-40 -translate-y-1/2 rounded border bg-background px-2 text-xs shadow"
            style={{ left: Math.min(labelInput.px, Math.max(0, w - 160)), top: Math.max(12, labelInput.py) }}
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
