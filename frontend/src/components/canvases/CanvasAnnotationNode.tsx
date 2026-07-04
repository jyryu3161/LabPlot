'use client';

import { useEffect, useRef } from 'react';
import Konva from 'konva';
import { Group, Rect, Ellipse, Text, Line, Arrow } from 'react-konva';
import type { CanvasAnnotation } from '@/lib/types';
import { mmToPx, pxToMm } from './mm';
import {
  originMm, sizeMm, arrowHeadLenMm, ptToMm, FONT_PT_DEFAULT, STROKE_PT_DEFAULT, STROKE_HEX_DEFAULT,
} from './annotations';

/**
 * One annotation object on the Konva layer. Mirrors CanvasPanelNode's Group
 * convention: the Group is positioned at the item's top-left bounding-box
 * ORIGIN (mm -> fit-px, same space as panels) and all shape geometry is drawn
 * relative to (0,0) inside it. For line/arrow the origin is the min(x)/min(y)
 * of the two endpoints (see annotations.ts `originMm`) -- dragging the group
 * therefore translates both endpoints together, uniformly with how rect/
 * ellipse/text dragging works, so the shared group-move/snap machinery in
 * CanvasEditor never needs to special-case annotation type.
 */
export function CanvasAnnotationNode({
  annotation,
  pxPerMm,
  selected,
  listening,
  draggableEnabled,
  measuredTextMm,
  registerNode,
  onMeasured,
  onMouseDown,
  onClick,
  onDblClick,
  onDragStart,
  onDragMove,
  onDragEnd,
  onTransformEnd,
}: {
  annotation: CanvasAnnotation;
  pxPerMm: number;
  selected: boolean;
  /** false while a creation tool is active -- lets mousedown pass through to
   * the Stage so shape drawing can start on top of an existing object. */
  listening: boolean;
  /** false while Space is held -- the Stage pans instead of the item dragging. */
  draggableEnabled: boolean;
  /** Actual rendered size (mm) of auto-width text, reported post-layout. */
  measuredTextMm?: { w_mm: number; h_mm: number };
  registerNode: (id: string, node: Konva.Group | null) => void;
  onMeasured: (id: string, size: { w_mm: number; h_mm: number }) => void;
  onMouseDown: (a: CanvasAnnotation, e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => void;
  onClick: (a: CanvasAnnotation, e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => void;
  onDblClick: (a: CanvasAnnotation) => void;
  onDragStart: (a: CanvasAnnotation, e: Konva.KonvaEventObject<DragEvent>) => void;
  onDragMove: (a: CanvasAnnotation, e: Konva.KonvaEventObject<DragEvent>) => void;
  onDragEnd: (a: CanvasAnnotation, e: Konva.KonvaEventObject<DragEvent>) => void;
  onTransformEnd: (a: CanvasAnnotation, e: Konva.KonvaEventObject<Event>) => void;
}) {
  const groupRef = useRef<Konva.Group>(null);
  const textRef = useRef<Konva.Text>(null);

  useEffect(() => {
    registerNode(annotation.id, groupRef.current);
    return () => registerNode(annotation.id, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotation.id]);

  const origin = originMm(annotation);
  const size = sizeMm(annotation, measuredTextMm);
  const originPx = { x: mmToPx(origin.x, pxPerMm), y: mmToPx(origin.y, pxPerMm) };
  const wPx = mmToPx(size.w_mm, pxPerMm);
  const hPx = mmToPx(size.h_mm, pxPerMm);
  const strokePx = mmToPx(ptToMm(annotation.stroke_pt ?? STROKE_PT_DEFAULT), pxPerMm);
  const strokeHex = annotation.stroke_hex ?? STROKE_HEX_DEFAULT;
  const isLineLike = annotation.type === 'line' || annotation.type === 'arrow';
  const linePoints = isLineLike
    ? (() => {
        const p = annotation.points_mm ?? [0, 0, 0, 0];
        return [
          mmToPx(p[0] - origin.x, pxPerMm), mmToPx(p[1] - origin.y, pxPerMm),
          mmToPx(p[2] - origin.x, pxPerMm), mmToPx(p[3] - origin.y, pxPerMm),
        ];
      })()
    : null;

  // Text measurement: the actual laid-out Konva.Text box (fontSize/family/
  // content driven), reported upward after each render. Auto-width text uses
  // it for marquee/snap/transformer bounding boxes; boxed text uses it only
  // for align-anchor emulation below (sizeMm ignores measuredTextMm when
  // w_mm != null, so boxed bbox/snap behavior is unaffected).
  useEffect(() => {
    if (annotation.type !== 'text') return;
    const node = textRef.current;
    if (!node) return;
    const w = pxToMm(node.width(), pxPerMm);
    const h = pxToMm(node.height(), pxPerMm);
    if (!measuredTextMm || Math.abs(measuredTextMm.w_mm - w) > 0.1 || Math.abs(measuredTextMm.h_mm - h) > 0.1) {
      onMeasured(annotation.id, { w_mm: w, h_mm: h });
    }
  });

  return (
    <Group
      ref={groupRef}
      x={originPx.x}
      y={originPx.y}
      width={wPx}
      height={hPx}
      listening={listening}
      draggable={draggableEnabled && listening}
      dragDistance={3}
      onMouseDown={(e) => onMouseDown(annotation, e)}
      onTouchStart={(e) => onMouseDown(annotation, e)}
      onClick={(e) => onClick(annotation, e)}
      onTap={(e) => onClick(annotation, e)}
      onDblClick={() => onDblClick(annotation)}
      onDblTap={() => onDblClick(annotation)}
      onDragStart={(e) => onDragStart(annotation, e)}
      onDragMove={(e) => onDragMove(annotation, e)}
      onDragEnd={(e) => onDragEnd(annotation, e)}
      onTransformEnd={(e) => onTransformEnd(annotation, e)}
    >
      {annotation.type === 'text' && (() => {
        // Export parity: the backend emits ONE SVG <text> line anchored via
        // text-anchor start/middle/end at x, x+w/2, x+w — it never wraps. A
        // width-constrained Konva Text would wrap (or, with wrap="none",
        // TRUNCATE at the box). So render unbounded single-line text and
        // emulate the SVG anchor with x/offsetX from the measured natural
        // width; a too-long line overflows the box exactly like the export.
        const align = annotation.align ?? 'left';
        const boxed = annotation.w_mm != null;
        const naturalWpx = measuredTextMm ? mmToPx(measuredTextMm.w_mm, pxPerMm) : 0;
        const anchorX = !boxed || align === 'left' ? 0 : align === 'center' ? wPx / 2 : wPx;
        const anchorOffsetX = !boxed || align === 'left' ? 0 : naturalWpx * (align === 'center' ? 0.5 : 1);
        return (
          <>
            {/* A blank annotation would otherwise be a zero-size, invisible,
                unclickable hole -- a single-space placeholder keeps the Konva
                Text auto-measured at a sane non-zero size, and the dashed box
                keeps it discoverable/selectable until real text is typed. */}
            <Text
              ref={textRef}
              x={anchorX}
              y={0}
              offsetX={anchorOffsetX}
              wrap="none"
              text={annotation.text || ' '}
              fontSize={ptToMm(annotation.font_pt ?? FONT_PT_DEFAULT) * pxPerMm}
              fontFamily="Helvetica, Arial, sans-serif"
              fill={annotation.fill_hex ?? STROKE_HEX_DEFAULT}
              listening={false}
            />
            {!annotation.text && (
              <Rect width={Math.max(wPx, 16)} height={Math.max(hPx, 12)} stroke="#94a3b8" dash={[3, 3]} strokeWidth={1} listening={false} />
            )}
          </>
        );
      })()}
      {annotation.type === 'rect' && (
        <Rect
          width={wPx}
          height={hPx}
          stroke={strokeHex}
          strokeWidth={strokePx}
          fill={annotation.fill_hex ?? 'rgba(0,0,0,0.0001)'}
        />
      )}
      {annotation.type === 'ellipse' && (
        <Ellipse
          x={wPx / 2}
          y={hPx / 2}
          radiusX={wPx / 2}
          radiusY={hPx / 2}
          stroke={strokeHex}
          strokeWidth={strokePx}
          fill={annotation.fill_hex ?? 'rgba(0,0,0,0.0001)'}
        />
      )}
      {isLineLike && linePoints && (() => {
        // A perfectly horizontal/vertical line has a zero-width/height bbox --
        // widen the invisible hit area with hitStrokeWidth so it stays
        // clickable at any zoom, without affecting the visible stroke.
        const hitWidth = Math.max(strokePx, 10);
        if (annotation.type === 'line') {
          return <Line points={linePoints} stroke={strokeHex} strokeWidth={strokePx} hitStrokeWidth={hitWidth} />;
        }
        const headPx = mmToPx(arrowHeadLenMm(annotation.stroke_pt), pxPerMm);
        return (
          <Arrow
            points={linePoints}
            stroke={strokeHex}
            fill={strokeHex}
            strokeWidth={strokePx}
            pointerLength={headPx}
            // Matches the export's polygon exactly (backend _annotation_svg:
            // half_w = 0.6 * head_len, so full width = 1.2 * head_len).
            pointerWidth={headPx * 1.2}
            hitStrokeWidth={hitWidth}
          />
        );
      })()}
      {/* selection affordance for line/arrow (excluded from the shared
          Transformer -- CanvasEditor renders draggable endpoint handles for
          these instead when solely selected). A thin highlight here keeps
          multi-selection legible. */}
      {selected && isLineLike && linePoints && (
        <Line points={linePoints} stroke="#2563EB" strokeWidth={strokePx + 4} opacity={0.18} listening={false} />
      )}
    </Group>
  );
}
