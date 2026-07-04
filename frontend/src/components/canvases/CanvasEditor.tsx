'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import Konva from 'konva';
import { Stage, Layer, Rect, Group, Image as KonvaImage, Text, Transformer, Line, Circle, Shape } from 'react-konva';
import {
  getCanvas, updateCanvas, addCanvasPanel, updateCanvasPanel, deleteCanvasPanel, renderCanvasPreview,
  downloadCanvasExport, duplicateFigure, duplicateCanvas, listProjects, ApiError,
} from '@/lib/api';
import type { CanvasDetail, CanvasPanel, CanvasAnnotation, FigureListItem } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import {
  Loader2, Plus, Trash2, ArrowUp, ArrowDown, Maximize2, ZoomIn, ZoomOut, Lock, Unlock, Tag, Pencil, Check,
  Download, Undo2, Redo2, ExternalLink, FlaskConical, CopyPlus, Grid3x3, Magnet,
  AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal,
  AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter,
} from 'lucide-react';
import {
  mmToPx, pxToMm, roundMm, fitPxPerMm, clampCanvasMm, clampPanelMm, PANEL_MM_MIN,
} from './mm';
import { CanvasHistory, type PanelFields, type PanelSnapshot, type CanvasSize } from './canvasHistory';
import { FigurePickerDialog } from './FigurePickerDialog';
import { CanvasColorEditor } from './CanvasColorEditor';
import { CanvasApplyStyle } from './CanvasApplyStyle';
import { CanvasHelpPopover, CanvasHintsBar } from './CanvasHints';
import { CanvasRulers } from './CanvasRulers';
import { useAuthContext } from '@/components/auth/AuthProvider';
import { CanvasAnnotationNode } from './CanvasAnnotationNode';
import { CanvasAnnotationInspector } from './CanvasAnnotationInspector';
import { CanvasAnnotationToolbar, TOOL_KEY_MAP, type ToolId } from './CanvasAnnotationToolbar';
import {
  originMm, sizeMm, translateAnnotation, createAnnotation, nextAnnotationZ, clampNum, annotationBoxPx,
  MIN_CREATE_DRAG_MM, sanitizeText, ptToMm as annPtToMm, FONT_PT_DEFAULT as ANN_FONT_PT_DEFAULT,
} from './annotations';

// U9: grid + grid-snap toggle persistence keys (localStorage) and the grid's
// fixed pitch (mm) — 5mm minor lines, every 2nd (10mm) drawn as an accent.
const GRID_SHOW_KEY = 'labplot.canvas.grid';
const GRID_SNAP_KEY = 'labplot.canvas.grid-snap';
const GRID_MINOR_MM = 5;
const GRID_MAJOR_EVERY = 2; // 2 * 5mm = 10mm accent lines
const GRID_MAX_LINES_PER_AXIS = 400; // defensive cap, never hit in practice (canvas <= 500mm / 5mm = 100)

function readBoolPref(key: string): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function writeBoolPref(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* storage unavailable — the toggle still works for this session */
  }
}

// U9: grid line positions (fit-px, un-zoomed "canvas" space) for the CURRENTLY
// VISIBLE portion of the sheet — keeps the Shape's per-frame draw work
// bounded during a deep zoom-in instead of always walking the whole sheet.
function computeGridLines(
  canvasWmm: number,
  canvasHmm: number,
  pxPerMm: number,
  view: { zoom: number; x: number; y: number },
  viewport: { w: number; h: number },
): { minorV: number[]; majorV: number[]; minorH: number[]; majorH: number[] } {
  const empty = { minorV: [], majorV: [], minorH: [], majorH: [] };
  if (!(pxPerMm > 0) || !(view.zoom > 0) || canvasWmm <= 0 || canvasHmm <= 0) return empty;
  const visX0 = clampNum((0 - view.x) / view.zoom / pxPerMm, 0, canvasWmm);
  const visX1 = clampNum((viewport.w - view.x) / view.zoom / pxPerMm, 0, canvasWmm);
  const visY0 = clampNum((0 - view.y) / view.zoom / pxPerMm, 0, canvasHmm);
  const visY1 = clampNum((viewport.h - view.y) / view.zoom / pxPerMm, 0, canvasHmm);

  const minorV: number[] = [];
  const majorV: number[] = [];
  const kStartX = Math.max(0, Math.floor(visX0 / GRID_MINOR_MM));
  for (let i = kStartX; i * GRID_MINOR_MM <= visX1 + 1e-6 && minorV.length + majorV.length < GRID_MAX_LINES_PER_AXIS; i++) {
    const px = mmToPx(i * GRID_MINOR_MM, pxPerMm);
    if (i % GRID_MAJOR_EVERY === 0) majorV.push(px);
    else minorV.push(px);
  }
  const minorH: number[] = [];
  const majorH: number[] = [];
  const kStartY = Math.max(0, Math.floor(visY0 / GRID_MINOR_MM));
  for (let i = kStartY; i * GRID_MINOR_MM <= visY1 + 1e-6 && minorH.length + majorH.length < GRID_MAX_LINES_PER_AXIS; i++) {
    const py = mmToPx(i * GRID_MINOR_MM, pxPerMm);
    if (i % GRID_MAJOR_EVERY === 0) majorH.push(py);
    else minorH.push(py);
  }
  return { minorV, majorV, minorH, majorH };
}

// U9: grid-snap targets (fit-px) at the fixed 5mm pitch, bounded to [0, sizeMm]
// — joins the existing panel/annotation/canvas-edge target arrays so "nearest
// wins" picks whichever is closest, grid included, with no special-casing.
function gridSnapTargetsPx(sizeMm: number, pxPerMm: number): number[] {
  if (!(sizeMm > 0) || !(pxPerMm > 0)) return [];
  const out: number[] = [];
  const n = Math.floor(sizeMm / GRID_MINOR_MM + 1e-6);
  for (let i = 0; i <= n; i++) out.push(mmToPx(i * GRID_MINOR_MM, pxPerMm));
  return out;
}

// ── panel figure image cache ────────────────────────────────────────────────
// Keyed by (figure_id, version_id, round(w_mm), round(h_mm)) per design §3/§4:
// a re-render is only needed when the physical panel SIZE changes. Moving a
// panel (position only) reuses the cached image.
const imageCache = new Map<string, HTMLImageElement>();
function panelKey(panel: Pick<CanvasPanel, 'figure_id' | 'effective_version_id' | 'width_mm' | 'height_mm'>): string {
  return `${panel.figure_id}|${panel.effective_version_id ?? 'latest'}|${Math.round(panel.width_mm)}|${Math.round(panel.height_mm)}`;
}

/**
 * Loads (and caches) the rendered figure SVG for a panel at its CURRENT physical
 * size. When a resize commits new width_mm/height_mm, the key changes and this
 * hook calls `renderCanvasPreview` at the NEW mm size and swaps the image — this
 * is the M2 re-layout (the backend preserves absolute-pt fonts at the new size).
 */
function usePanelImage(panel: CanvasPanel): { img: HTMLImageElement | null; loading: boolean } {
  const key = panelKey(panel);
  const [img, setImg] = useState<HTMLImageElement | null>(() => imageCache.get(key) ?? null);
  const [loading, setLoading] = useState<boolean>(() => !imageCache.has(key));

  useEffect(() => {
    let cancelled = false;
    const cached = imageCache.get(key);
    if (cached) {
      setImg(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    (async () => {
      try {
        // Re-layout render at the panel's CURRENT physical size (mm).
        const { svg_url } = await renderCanvasPreview({
          figure_id: panel.figure_id,
          version_id: panel.effective_version_id ?? undefined,
          width_mm: roundMm(panel.width_mm),
          height_mm: roundMm(panel.height_mm),
        });
        const image = new window.Image();
        image.onload = () => {
          if (cancelled) return;
          imageCache.set(key, image);
          setImg(image);
          setLoading(false);
        };
        image.onerror = () => { if (!cancelled) setLoading(false); };
        image.src = svg_url; // SVG loads fine as an <img> src
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [key, panel.figure_id, panel.effective_version_id, panel.width_mm, panel.height_mm]);

  return { img, loading };
}

// ── one panel node ──────────────────────────────────────────────────────────
function CanvasPanelNode({
  panel,
  pxPerMm,
  selected,
  transparent,
  draggableEnabled,
  listening = true,
  registerNode,
  onPanelMouseDown,
  onPanelClick,
  onDragStart,
  onDragMove,
  onDragEnd,
  onTransformEnd,
}: {
  panel: CanvasPanel;
  pxPerMm: number;
  selected: boolean;
  transparent: boolean;
  /** false while Space is held — the Stage pans instead of the panel dragging. */
  draggableEnabled: boolean;
  /** U8: false while a creation tool is active, so a shape/text drag can
   * start on top of an existing panel instead of the panel intercepting it. */
  listening?: boolean;
  registerNode: (id: string, node: Konva.Group | null) => void;
  onPanelMouseDown: (panel: CanvasPanel, e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => void;
  // onTap (touch) shares this handler and carries a TouchEvent, not a MouseEvent.
  onPanelClick: (panel: CanvasPanel, e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => void;
  onDragStart: (panel: CanvasPanel, e: Konva.KonvaEventObject<DragEvent>) => void;
  onDragMove: (panel: CanvasPanel, e: Konva.KonvaEventObject<DragEvent>) => void;
  onDragEnd: (panel: CanvasPanel, e: Konva.KonvaEventObject<DragEvent>) => void;
  onTransformEnd: (panel: CanvasPanel, e: Konva.KonvaEventObject<Event>) => void;
}) {
  const groupRef = useRef<Konva.Group>(null);
  const { img, loading } = usePanelImage(panel);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    registerNode(panel.id, groupRef.current);
    return () => registerNode(panel.id, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.id]);

  const w = mmToPx(panel.width_mm, pxPerMm);
  const h = mmToPx(panel.height_mm, pxPerMm);

  // Letterbox the image to its own aspect ratio. In steady state the render
  // matches the panel box exactly (it was rendered at these mm), so this is a
  // no-op; while a resize re-render is in flight it stops the stale image from
  // being drawn stretched into the new box.
  let imgX = 0, imgY = 0, imgW = w, imgH = h;
  if (img && img.width > 0 && img.height > 0) {
    const s = Math.min(w / img.width, h / img.height);
    imgW = img.width * s;
    imgH = img.height * s;
    imgX = (w - imgW) / 2;
    imgY = (h - imgH) / 2;
  }

  return (
    <Group
      ref={groupRef}
      x={mmToPx(panel.x_mm, pxPerMm)}
      y={mmToPx(panel.y_mm, pxPerMm)}
      width={w}
      height={h}
      listening={listening}
      draggable={draggableEnabled}
      dragDistance={3}
      onMouseDown={(e) => onPanelMouseDown(panel, e)}
      onTouchStart={(e) => onPanelMouseDown(panel, e)}
      onClick={(e) => onPanelClick(panel, e)}
      onTap={(e) => onPanelClick(panel, e)}
      onDragStart={(e) => onDragStart(panel, e)}
      onDragMove={(e) => onDragMove(panel, e)}
      onDragEnd={(e) => onDragEnd(panel, e)}
      onTransformEnd={(e) => onTransformEnd(panel, e)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Rect
        width={w}
        height={h}
        // A fully-transparent fill (not undefined) keeps Konva hit-detection
        // alive in transparent mode — the image below is listening={false}.
        fill={transparent ? 'rgba(0,0,0,0)' : 'white'}
        stroke="#94a3b8"
        strokeWidth={1}
        // Border only on hover; selection is indicated by the Transformer.
        // Exception: a failed render (no image, not loading) keeps a dashed
        // border so the panel stays discoverable instead of invisible.
        strokeEnabled={(hovered && !selected) || (!img && !loading)}
        dash={!img && !loading ? [4, 4] : undefined}
      />
      {img && <KonvaImage image={img} x={imgX} y={imgY} width={imgW} height={imgH} listening={false} />}
      {!img && !loading && (
        <Text
          text="render failed"
          x={0}
          y={h / 2 - 6}
          width={w}
          align="center"
          fontSize={11}
          fill="#dc2626"
          listening={false}
        />
      )}
      {loading && (
        <Text
          text="rendering…"
          x={0}
          y={h / 2 - 6}
          width={w}
          align="center"
          fontSize={11}
          fill="#94a3b8"
          listening={false}
        />
      )}
      {panel.label_visible && panel.label ? (
        <Text
          text={panel.label}
          x={4}
          y={3}
          fontSize={16}
          fontStyle="bold"
          fill="#0f172a"
          listening={false}
        />
      ) : null}
    </Group>
  );
}

// ── editor ──────────────────────────────────────────────────────────────────
const SNAP_PX = 6; // screen-space snap threshold
const EPS_MM = 0.05; // ignore sub-tenth-mm drift (pure-click dragend, no-op transforms)

function snapshotOf(panel: CanvasPanel): PanelSnapshot {
  return {
    panelId: panel.id,
    figure_id: panel.figure_id,
    x_mm: panel.x_mm,
    y_mm: panel.y_mm,
    width_mm: panel.width_mm,
    height_mm: panel.height_mm,
    z_order: panel.z_order,
    label: panel.label ?? null,
    label_visible: panel.label_visible,
    pinned_version_id: panel.pinned_version_id ?? null,
  };
}

// Paint-order tie-break must match the backend's codepoint sort in
// _compose_canvas_svg (sorted by (z, str(id))) — localeCompare uses ICU
// collation and orders e.g. 'a0' before 'A1', the opposite of Python, which
// would flip which of two same-z overlapping objects paints on top in the
// export vs the editor.
function byCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function nextLabel(panels: CanvasPanel[]): string {
  const used = new Set(panels.map((p) => (p.label ?? '').toUpperCase()).filter(Boolean));
  for (let i = 0; i < 26; i++) {
    const c = String.fromCharCode(65 + i);
    if (!used.has(c)) return c;
  }
  return '';
}

export function CanvasEditor({ canvasId }: { canvasId: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const queryKey = useMemo(() => ['canvas', canvasId], [canvasId]);
  const { data: canvas, isLoading, isError } = useQuery({ queryKey, queryFn: () => getCanvas(canvasId) });
  // Owner gate for the Move control (backend enforces too; hiding avoids
  // showing project editors a button that can only ever 403).
  const { user } = useAuthContext();
  const isOwner = Boolean(user && canvas && user.id === canvas.owner_id);

  // Figures can gain versions in another tab (the "Edit figure" button opens
  // one). Window-focus refetch is globally disabled (app-providers), so refetch
  // on tab return here — the new effective_version_id rotates each panelKey and
  // usePanelImage swaps in the fresh render. Without this, the editor would
  // keep showing the old figure while export uses the new version.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      // A fresh text annotation exists ONLY in the local query cache until
      // its first commit (see freshTextIdRef) — a refetch resolving now would
      // wipe it and the text being typed (user tabs away to copy a caption,
      // tabs back). Mark stale without refetching; the commit's own PATCH
      // round-trip returns fresh canvas data anyway.
      if (freshTextIdRef.current) {
        qc.invalidateQueries({ queryKey, refetchType: 'none' });
        return;
      }
      qc.invalidateQueries({ queryKey });
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [qc, queryKey]);

  // Project names for the breadcrumb badge and the move dialog (U3).
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: listProjects });

  const containerRef = useRef<HTMLDivElement>(null);
  // Mirror the container element into state so the color editor can portal its
  // instant-preview overlay into it (a plain ref won't re-render the consumer).
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const setContainerRef = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
    setContainerEl(el);
  }, []);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  // U7: ordered multi-selection. A single id behaves exactly like the old
  // selectedId (single-panel toolbar / color+text editors); 2+ ids switch the
  // toolbar to the align/distribute controls (see `selectedPanel` below).
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // U7: rubber-band marquee, in CANVAS ("fit px", un-zoomed) coordinates — same
  // space as panel x/y so hit-testing is a plain AABB overlap check.
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // TRUE from a panel/annotation mousedown until the window-level mouseup.
  // Selection-dependent chrome (selected-panel toolbar row, align toolbar,
  // mixed strip, color editor / annotation inspector sidebars) must NOT mount
  // while a pointer gesture is active: mounting them resizes the stage
  // container mid-gesture, the view re-fits (pxPerMm changes), and Konva's
  // drag offsets — captured against the OLD geometry at mousedown — teleport
  // the dragged node by tens of mm. Pure clicks still get their chrome at
  // mouseup, which is imperceptible.
  const [pointerGestureActive, setPointerGestureActive] = useState(false);
  const marqueeShiftRef = useRef(false);
  // Mirror of the marquee state for window-level listeners (a closure captured
  // at listener registration would go stale mid-drag).
  const marqueeRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const finalizeMarqueeRef = useRef<() => void>(() => {});
  // Space+drag pan (U7 Q1): Stage becomes draggable only while held, restoring
  // rubber-band select on release. Needs to be React state (not a ref) because
  // it drives the Stage's `draggable` prop and the container cursor.
  const [spaceHeld, setSpaceHeld] = useState(false);
  // Alt bypasses resize snapping (item 6). Transformer's boundBoxFunc gets no
  // event object (unlike drag, which reads e.evt.altKey directly), so this has
  // to be tracked out-of-band. A ref (not state) — it's only read inside an
  // imperative Konva callback, never rendered, so it doesn't need to trigger a
  // re-render on every Alt keydown/keyup.
  const altHeldRef = useRef(false);

  // Safari desktop reports trackpad pinch as proprietary GestureEvents (never
  // ctrlKey wheel), and without preventDefault it zooms the whole PAGE. Drive
  // the same damped pointer-anchored zoom from them; other browsers lack
  // GestureEvent and skip this entirely.
  useEffect(() => {
    if (!containerEl || typeof window === 'undefined' || !('GestureEvent' in window)) return;
    let prevScale = 1;
    const onStart = (e: Event) => {
      e.preventDefault();
      prevScale = (e as unknown as { scale?: number }).scale ?? 1;
    };
    const onChange = (e: Event) => {
      e.preventDefault();
      const ge = e as unknown as { scale?: number; clientX: number; clientY: number };
      const scale = ge.scale ?? 1;
      const factor = Math.min(1.25, Math.max(0.8, scale / (prevScale || 1)));
      prevScale = scale;
      const r = containerEl.getBoundingClientRect();
      const pointer = { x: ge.clientX - r.left, y: ge.clientY - r.top };
      setView((v) => {
        const newScale = Math.min(8, Math.max(0.15, v.zoom * factor));
        const pointTo = { x: (pointer.x - v.x) / v.zoom, y: (pointer.y - v.y) / v.zoom };
        return { zoom: newScale, x: pointer.x - pointTo.x * newScale, y: pointer.y - pointTo.y * newScale };
      });
    };
    const onEnd = (e: Event) => e.preventDefault();
    containerEl.addEventListener('gesturestart', onStart);
    containerEl.addEventListener('gesturechange', onChange);
    containerEl.addEventListener('gestureend', onEnd);
    return () => {
      containerEl.removeEventListener('gesturestart', onStart);
      containerEl.removeEventListener('gesturechange', onChange);
      containerEl.removeEventListener('gestureend', onEnd);
    };
  }, [containerEl]);
  // Aspect-locked resize by default: a free-form resize re-layouts the figure
  // at a different aspect than its native render, which reads as "distorted".
  const [lockAspect, setLockAspect] = useState(true);
  // U9: grid visibility + grid-snap, each independently toggleable and
  // persisted — this component is only ever mounted client-side (dynamic
  // import with ssr:false, see canvases/[id]/page.tsx), so reading
  // localStorage straight in the lazy initializer is safe (no hydration
  // mismatch to guard against, unlike CanvasHintsBar which IS SSR'd).
  const [showGrid, setShowGrid] = useState<boolean>(() => readBoolPref(GRID_SHOW_KEY));
  const [gridSnapEnabled, setGridSnapEnabled] = useState<boolean>(() => readBoolPref(GRID_SNAP_KEY));
  const toggleShowGrid = useCallback(() => {
    setShowGrid((v) => {
      const next = !v;
      writeBoolPref(GRID_SHOW_KEY, next);
      return next;
    });
  }, []);
  const toggleGridSnap = useCallback(() => {
    setGridSnapEnabled((v) => {
      const next = !v;
      writeBoolPref(GRID_SNAP_KEY, next);
      return next;
    });
  }, []);
  const [pickerOpen, setPickerOpen] = useState(false);
  // U3: project affiliation — breadcrumb link + owner-only move dialog.
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<string>('personal');
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const [renamingCanvas, setRenamingCanvas] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [sizeDraft, setSizeDraft] = useState<{ w: string; h: string }>({ w: '', h: '' });

  // ── undo/redo history (inverse ops; edits are already persisted server-side) ──
  const [, bumpHistory] = useState(0); // re-render when canUndo/canRedo change
  const historyRef = useRef<CanvasHistory | null>(null);
  if (historyRef.current === null) historyRef.current = new CanvasHistory(() => bumpHistory((v) => v + 1));
  const history = historyRef.current;
  const [applyingHistory, setApplyingHistory] = useState(false);
  // Original label captured on focus: keystrokes patch the local cache, so by
  // blur time the cache already holds the draft — the true "before" lives here.
  const labelEditStart = useRef<string | null>(null);
  // Stable indirection so the keydown effect doesn't need applyHistory in deps.
  const applyHistoryRef = useRef<(direction: 'undo' | 'redo') => void>(() => {});
  // Same indirection for the arrow-key nudge handler (defined later, after the
  // mutations it batches through) — the keydown effect only re-subscribes on
  // selectedIds changes, so it can't close over a fresh nudgeSelected directly.
  const nudgeSelectedRef = useRef<(key: string, shift: boolean) => void>(() => {});
  // U9: same indirection for the '1' / Shift+1 / Shift+2 zoom shortcuts —
  // all three close over view/viewport/selection state that changes far more
  // often than the keydown effect (deps: [selectedIds]) re-subscribes.
  const fitViewRef = useRef<() => void>(() => {});
  const zoomTo100Ref = useRef<() => void>(() => {});
  const zoomToSelectionRef = useRef<() => void>(() => {});

  const trRef = useRef<Konva.Transformer>(null);
  const nodeRefs = useRef<Map<string, Konva.Group>>(new Map());
  const registerNode = useCallback((id: string, node: Konva.Group | null) => {
    if (node) nodeRefs.current.set(id, node);
    else nodeRefs.current.delete(id);
  }, []);

  // U7 5a: group move. Set on dragstart of a panel that's part of a multi
  // selection; consumed by handleDragMove (apply delta to siblings) and
  // handleDragEnd (batch-commit + one history entry).
  const groupMoveRef = useRef<{
    leaderId: string;
    startPx: Map<string, { x: number; y: number }>;
    beforeMm: Map<string, { x_mm: number; y_mm: number }>;
  } | null>(null);
  // Distinguishes a genuine drag (dragstart fired) from a plain click on an
  // already-selected panel, so mousedown-time selection doesn't collapse a
  // multi-selection the user is about to drag as a group (item 4/5a).
  const dragMovedRef = useRef(false);
  // F5: shift+mousedown on a selected member defers its removal to the click
  // (so shift+drag keeps it grouped); cleared by dragstart / consumed by click.
  const shiftDeferredRef = useRef<string | null>(null);

  // U7 8: multi-node Transformer resize. `transformend` fires once PER attached
  // node (Konva.Transformer forwards it to each `target`), so a group resize is
  // batched by counting arrivals against the selection size and committing once
  // the last one lands.
  const groupResizeActiveRef = useRef(false);
  const groupResizeItemsRef = useRef<{ panelId: string; before: PanelFields; after: PanelFields }[]>([]);
  const groupResizeSeenRef = useRef(0);
  // U8: parallel accumulator for annotations caught in a group resize (only
  // needs "after" per item — commitAnnotations snapshots "before" itself from
  // the live array at commit time), plus the count of TRANSFORMER-ELIGIBLE
  // selected ids (excludes line/arrow, which never attach to the Transformer
  // and so never fire transformend) — the real threshold for "last one in".
  const groupResizeAnnotationItemsRef = useRef<{ id: string; after: CanvasAnnotation }[]>([]);
  const groupResizeEligibleCountRef = useRef(0);

  // U7 5d: keyboard nudge — optimistic local move + debounced batched commit.
  const nudgeAccumRef = useRef<Map<string, { before: { x_mm: number; y_mm: number }; after: { x_mm: number; y_mm: number } }>>(new Map());
  const nudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // U8: parallel accumulator for nudged ANNOTATIONS — one whole-array commit
  // per gesture instead of per-item PATCHes, so this only needs each touched
  // annotation's pre-nudge-session snapshot (see commitAnnotationNudge).
  const nudgeAnnotationAccumRef = useRef<Map<string, CanvasAnnotation>>(new Map());
  // F4: per-gesture union min box (mm) so a group resize can't squeeze its
  // smallest member below PANEL_MM_MIN. Null for single-node transforms.
  const groupMinBoxRef = useRef<{ w: number; h: number } | null>(null);

  // ── U8: annotation tool state ──
  const [activeTool, setActiveTool] = useState<ToolId>('select');
  // In-progress shape/line/arrow creation drag, in CANVAS ("fit px") coords —
  // same space + window-mouseup-fallback convention as the U7 marquee.
  const [drawing, setDrawing] = useState<{ type: Exclude<ToolId, 'select' | 'text'>; x0: number; y0: number; x1: number; y1: number } | null>(null);
  const drawingRef = useRef<typeof drawing>(null);
  const finalizeDrawingRef = useRef<() => void>(() => {});
  // Inline text editor overlay (opened immediately on text-tool creation and
  // on dblclick of an existing text annotation).
  const [textEditing, setTextEditing] = useState<{ id: string; value: string } | null>(null);
  // Escape must DISCARD the in-progress edit, not commit it. Removing a
  // focused input from the DOM fires NO blur/focusout (WHATWG focus-fixup
  // rule), so ALL cancel cleanup happens synchronously in cancelTextEditing;
  // this ref exists only to swallow a genuinely stray blur racing the
  // unmount. Both editor-open sites disarm it so a never-consumed flag can't
  // leak into (and silently discard) the NEXT edit session's commit.
  const textEditCancelRef = useRef(false);
  // A text annotation freshly placed by the Text tool exists ONLY in the local
  // query cache until its first real text is committed (single 'add text'
  // history entry — one Ctrl+Z fully removes it). Escape/empty on a fresh one
  // is a pure local removal: the server never saw it. Holds the fresh id, or
  // null when the inline editor targets an already-persisted annotation.
  const freshTextIdRef = useRef<string | null>(null);
  // Live override of a line/arrow's points WHILE an endpoint handle is being
  // dragged (see handleEndpointDragMove/-End) — gives immediate visual
  // feedback without committing on every mousemove.
  const [endpointDraft, setEndpointDraft] = useState<{ id: string; points_mm: [number, number, number, number] } | null>(null);
  // Actual rendered size (mm) of auto-width text annotations, reported by
  // CanvasAnnotationNode post-layout (a pure-geometry helper can't know
  // browser font metrics) — read by marquee/snap/bbox code below.
  const measuredTextRef = useRef<Map<string, { w_mm: number; h_mm: number }>>(new Map());
  const [, bumpMeasure] = useState(0);
  // U8 5d/6: debounced inspector field edits — mirrors the U7 nudge
  // accumulator (one before/after snapshot per edit "session", committed
  // ~400ms after the last change to that field).
  const annoEditAccumRef = useRef<{ id: string; before: CanvasAnnotation } | null>(null);
  const annoEditTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const panels = useMemo(
    () => (canvas?.panels ?? []).slice().sort((a, b) => a.z_order - b.z_order || byCodepoint(a.id, b.id)),
    [canvas?.panels],
  );
  const annotations = useMemo(
    () => (canvas?.annotations ?? []).slice().sort((a, b) => a.z - b.z || byCodepoint(a.id, b.id)),
    [canvas?.annotations],
  );
  // Single selection keeps every existing single-panel affordance (toolbar,
  // color/text editors, overlay). 2+ selected panels switch to the
  // align/distribute toolbar instead (rendered where selectedPanel is null).
  const selectedPanel = selectedIds.length === 1 ? panels.find((p) => p.id === selectedIds[0]) ?? null : null;
  // U8: selection composition drives which sidebar/toolbar shows (see render).
  const selectedPanelIds = useMemo(() => selectedIds.filter((id) => panels.some((p) => p.id === id)), [selectedIds, panels]);
  const selectedAnnotationIds = useMemo(() => selectedIds.filter((id) => annotations.some((a) => a.id === id)), [selectedIds, annotations]);
  const selectedAnnotations = useMemo(
    () => selectedAnnotationIds.map((id) => annotations.find((a) => a.id === id)).filter((a): a is CanvasAnnotation => Boolean(a)),
    [selectedAnnotationIds, annotations],
  );

  // Fit scale (px/mm): the whole canvas fits the viewport with a margin; zoom
  // multiplies this via the Stage scale (uniform).
  const pxPerMm = useMemo(
    () => (canvas ? fitPxPerMm(canvas.width_mm, canvas.height_mm, viewport.w, viewport.h) : 1),
    [canvas?.width_mm, canvas?.height_mm, viewport.w, viewport.h, canvas],
  );

  // U9: grid line positions (visible-range only — see computeGridLines) for
  // the grid overlay. Recomputed only while the grid is actually shown.
  const gridLines = useMemo(
    () => (showGrid && canvas ? computeGridLines(canvas.width_mm, canvas.height_mm, pxPerMm, view, viewport) : null),
    [showGrid, canvas, pxPerMm, view, viewport],
  );

  // ── viewport measurement ──
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setViewport({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // Re-run once the canvas has loaded: on the first (loading) render the
    // container div isn't mounted yet, so containerRef is null and the observer
    // never attaches. Keying on canvas presence re-measures when it appears.
  }, [Boolean(canvas)]);

  // ── fit / center the view ──
  const fitView = useCallback(() => {
    if (!canvas || !viewport.w || !viewport.h) return;
    const cw = mmToPx(canvas.width_mm, pxPerMm);
    const ch = mmToPx(canvas.height_mm, pxPerMm);
    setView({ zoom: 1, x: (viewport.w - cw) / 2, y: (viewport.h - ch) / 2 });
  }, [canvas, viewport.w, viewport.h, pxPerMm]);

  // Auto-fit on first measure and whenever the canvas physical size changes.
  const fitSig = `${viewport.w}x${viewport.h}:${canvas?.width_mm}x${canvas?.height_mm}`;
  useEffect(() => {
    fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitSig]);
  useEffect(() => {
    fitViewRef.current = fitView;
  });

  // ── attach transformer to every selected node (U7 8: multi-node resize) ──
  // U8: line/arrow annotations are excluded — they get draggable endpoint
  // handles instead (rendered alongside the Transformer further below).
  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const nodes = selectedIds
      .filter((id) => panels.some((p) => p.id === id) || annotations.some((a) => a.id === id && a.type !== 'line' && a.type !== 'arrow'))
      .map((id) => nodeRefs.current.get(id))
      .filter((n): n is Konva.Group => Boolean(n));
    tr.nodes(nodes);
    tr.getLayer()?.batchDraw();
  }, [selectedIds, panels, annotations, view.zoom]);

  // ── keyboard: undo/redo, delete, escape ──
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Never hijack keys while the user is typing in a form control.
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        applyHistoryRef.current(e.shiftKey ? 'redo' : 'undo');
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        applyHistoryRef.current('redo');
        return;
      }
      // U8: tool shortcuts (V/T/A/L/R/O) — must work with NO selection, so
      // this runs before the selectedIds gate below. Guarded against focused
      // buttons/switches (the same a11y guard the Space-pan handler uses)
      // so e.g. tabbing to a toolbar button and pressing a letter mnemonic
      // elsewhere never gets stolen.
      if (!mod && !e.altKey) {
        const toolKey = TOOL_KEY_MAP[e.key.toLowerCase()];
        if (toolKey) {
          const role = el?.getAttribute('role') ?? '';
          const isControl = Boolean(el && (tag === 'BUTTON' || tag === 'A'
            || ['button', 'switch', 'checkbox', 'menuitem', 'tab', 'combobox'].includes(role)));
          if (!isControl) {
            e.preventDefault();
            setActiveTool(toolKey);
            return;
          }
        }
      }
      // U9: zoom shortcuts — '1' 100%, Shift+1 fit-to-view, Shift+2 zoom to
      // selection. Digits are read via e.code (layout-independent: e.key for
      // Shift+1 is the shifted SYMBOL, e.g. '!' on a US keyboard, not '1'),
      // guarded the same way as the tool shortcuts above.
      if (!mod && !e.altKey && (e.code === 'Digit1' || e.code === 'Digit2')) {
        const role = el?.getAttribute('role') ?? '';
        const isControl = Boolean(el && (tag === 'BUTTON' || tag === 'A'
          || ['button', 'switch', 'checkbox', 'menuitem', 'tab', 'combobox'].includes(role)));
        if (!isControl) {
          if (e.code === 'Digit1' && !e.shiftKey) {
            e.preventDefault();
            zoomTo100Ref.current();
            return;
          }
          if (e.code === 'Digit1' && e.shiftKey) {
            e.preventDefault();
            fitViewRef.current();
            return;
          }
          if (e.code === 'Digit2' && e.shiftKey) {
            e.preventDefault();
            zoomToSelectionRef.current();
            return;
          }
          // bare '2' has no assigned shortcut — fall through unhandled.
        }
      }
      if (e.key === 'Escape') {
        // Esc always returns to the Select tool, in addition to the existing
        // deselect — unconditional (works with an empty selection too).
        setActiveTool('select');
        setSelectedIds([]);
        return;
      }
      if (selectedIds.length === 0) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        // Guard the keyboard shortcut — a stray Delete/Backspace shouldn't
        // silently drop a panel/annotation. (History-applied deletes skip
        // this confirm.)
        deleteSelected();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        nudgeSelectedRef.current(e.key, e.shiftKey);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds]);

  // ── space+drag pan (U7 Q1) + alt (resize-snap bypass, item 6) ──
  useEffect(() => {
    function isTypingTarget(el: HTMLElement | null) {
      const tag = el?.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(el?.isContentEditable);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Alt') {
        altHeldRef.current = true;
        return;
      }
      if (e.key === ' ' && !isTypingTarget(document.activeElement as HTMLElement | null)) {
        // Keyboard a11y: Space on a focused button/switch/link must activate
        // it, not arm panning.
        const el = document.activeElement as HTMLElement | null;
        const role = el?.getAttribute('role') ?? '';
        if (el && (el.tagName === 'BUTTON' || el.tagName === 'A'
          || ['button', 'switch', 'checkbox', 'menuitem', 'tab', 'combobox'].includes(role))) return;
        e.preventDefault(); // stop the page from scrolling
        setSpaceHeld(true);
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === 'Alt') altHeldRef.current = false;
      else if (e.key === ' ') setSpaceHeld(false);
    }
    // A stuck-held modifier (alt-tab away mid-keypress etc.) would otherwise
    // leave panning/snap-bypass wedged on with no key to release it.
    function onBlur() {
      altHeldRef.current = false;
      setSpaceHeld(false);
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // ── local cache helpers (optimistic) ──
  const patchLocalPanel = useCallback(
    (panelId: string, partial: Partial<CanvasPanel>) => {
      qc.setQueryData<CanvasDetail>(queryKey, (old) =>
        old ? { ...old, panels: old.panels.map((p) => (p.id === panelId ? { ...p, ...partial } : p)) } : old,
      );
    },
    [qc, queryKey],
  );

  // ── mutations ──
  // Recording model: user-initiated call sites pass a `history` payload (the
  // known BEFORE values) / `record: true`, and the op is recorded in onSuccess
  // — i.e. only once the server accepted the edit. Undo/redo application calls
  // the SAME mutations but omits the payload, so nothing is re-recorded (and
  // CanvasHistory.record() additionally no-ops while `isApplying`).
  const patchPanel = useMutation({
    mutationFn: ({ panelId, data }: {
      panelId: string;
      data: Parameters<typeof updateCanvasPanel>[2];
      history?: { before: PanelFields; label: string };
    }) => updateCanvasPanel(canvasId, panelId, data),
    onMutate: async ({ panelId, data }) => {
      await qc.cancelQueries({ queryKey });
      // Surgical rollback: snapshot ONLY the touched panel's prior values for
      // the keys we are changing. Restoring the whole cache snapshot would
      // clobber sibling panels committed concurrently in the same batch.
      const prevPanel = qc.getQueryData<CanvasDetail>(queryKey)?.panels.find((p) => p.id === panelId);
      const restore: Partial<CanvasPanel> = {};
      if (prevPanel) {
        for (const key of Object.keys(data) as (keyof CanvasPanel)[]) {
          (restore as Record<string, unknown>)[key] = prevPanel[key];
        }
      }
      patchLocalPanel(panelId, data as Partial<CanvasPanel>);
      return { panelId, restore: prevPanel ? restore : null };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.restore) patchLocalPanel(ctx.panelId, ctx.restore);
      toast.error('Could not update panel');
    },
    onSuccess: (updated, vars) => {
      qc.setQueryData<CanvasDetail>(queryKey, (old) =>
        old ? { ...old, panels: old.panels.map((p) => (p.id === updated.id ? updated : p)) } : old,
      );
      if (vars.history) {
        historyRef.current?.record({
          type: 'panel-update',
          panelId: vars.panelId,
          before: vars.history.before,
          after: vars.data as PanelFields,
          label: vars.history.label,
        });
      }
    },
  });

  // U7: multi-panel batch commit (group move / align / distribute / group
  // resize / nudge) — every panel's PATCH goes through the same `patchPanel`
  // mutation (optimistic update + rollback + error toast per panel, unchanged),
  // but recorded as ONE 'panels-update' history entry only once every panel in
  // the batch has been accepted by the server (mirrors applyHistory's own
  // try/mutateAsync/catch shape below).
  async function commitPanelsBatch(
    items: { panelId: string; before: PanelFields; after: PanelFields }[],
    label: string,
  ) {
    if (items.length === 0) return;
    const results = await Promise.allSettled(
      items.map((it) => patchPanel.mutateAsync({ panelId: it.panelId, data: it.after })),
    );
    const ok = items.filter((_, i) => results[i].status === 'fulfilled');
    const failed = items.filter((_, i) => results[i].status === 'rejected');
    // Rejected items: restore the TRUE pre-gesture values. patchPanel's own
    // rollback restores the pre-MUTATION cache, which for optimistic gestures
    // (nudge) is already the moved position — the editor would silently
    // diverge from the server without this.
    for (const f of failed) patchLocalPanel(f.panelId, f.before as Partial<CanvasPanel>);
    // Record only what the server accepted, so every committed move stays
    // undoable even when a sibling failed.
    if (ok.length) historyRef.current?.record({ type: 'panels-update', items: ok, label });
  }

  const addPanel = useMutation({
    mutationFn: ({ data }: { data: Parameters<typeof addCanvasPanel>[1]; record?: boolean }) =>
      addCanvasPanel(canvasId, data),
    onSuccess: (panel, vars) => {
      qc.setQueryData<CanvasDetail>(queryKey, (old) =>
        old ? { ...old, panels: [...old.panels, panel] } : old,
      );
      setSelectedIds([panel.id]);
      if (vars.record) {
        historyRef.current?.record({ type: 'panel-add', snapshot: snapshotOf(panel), label: 'add panel' });
      }
    },
    onError: () => toast.error('Could not add figure'),
  });

  const removePanel = useMutation({
    mutationFn: ({ panelId }: { panelId: string; record?: boolean }) => deleteCanvasPanel(canvasId, panelId),
    onMutate: async ({ panelId }) => {
      await qc.cancelQueries({ queryKey });
      const prev = qc.getQueryData<CanvasDetail>(queryKey);
      const removed = prev?.panels.find((p) => p.id === panelId) ?? null;
      qc.setQueryData<CanvasDetail>(queryKey, (old) =>
        old ? { ...old, panels: old.panels.filter((p) => p.id !== panelId) } : old,
      );
      setSelectedIds((cur) => cur.filter((id) => id !== panelId));
      return { prev, removed };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKey, ctx.prev);
      toast.error('Could not delete panel');
    },
    onSuccess: (_res, vars, ctx) => {
      if (vars.record && ctx?.removed) {
        historyRef.current?.record({ type: 'panel-delete', snapshot: snapshotOf(ctx.removed), label: 'delete panel' });
      }
    },
  });

  const patchCanvas = useMutation({
    mutationFn: ({ data }: {
      data: Parameters<typeof updateCanvas>[1];
      history?: { before: CanvasSize; after: CanvasSize };
    }) => updateCanvas(canvasId, data),
    onSuccess: (updated, vars) => {
      qc.setQueryData<CanvasDetail>(queryKey, (old) => (old ? { ...old, ...updated } : updated));
      if (vars.history) {
        historyRef.current?.record({
          type: 'canvas-size',
          before: vars.history.before,
          after: vars.history.after,
          label: 'canvas size',
        });
      }
    },
    onError: (e) => toast.error(e instanceof Error && e.message ? e.message : 'Could not update canvas'),
  });

  // ── U8: annotations — whole-array replace (server sanitizes + 400s
  // BAD_ANNOTATIONS on structural errors; the client mirrors the same clamps
  // in annotations.ts for optimistic UX, but the server is the source of
  // truth on conflict). Optimistic update + rollback, same shape as
  // patchPanel; history is ONE whole-array snapshot per gesture (see
  // canvasHistory.ts 'annotations-update'). ──
  const patchAnnotations = useMutation({
    // base_annotations_rev is read at request time (pre-increment server rev
    // from the cache): the server 409s ANNOTATIONS_CONFLICT when another
    // editor replaced the array since this client last loaded it, instead of
    // silently destroying their objects (whole-array last-write-wins).
    mutationFn: ({ data }: {
      data: { annotations: CanvasAnnotation[] };
      history?: { before: CanvasAnnotation[]; after: CanvasAnnotation[]; label: string };
    }) => updateCanvas(canvasId, {
      ...data,
      base_annotations_rev: qc.getQueryData<CanvasDetail>(queryKey)?.annotations_rev,
    }),
    onMutate: async ({ data }) => {
      await qc.cancelQueries({ queryKey });
      const prev = qc.getQueryData<CanvasDetail>(queryKey);
      qc.setQueryData<CanvasDetail>(queryKey, (old) => (old ? { ...old, annotations: data.annotations } : old));
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKey, ctx.prev);
      if (e instanceof ApiError && e.status === 409) {
        // Another editor changed the annotations — reload server truth; the
        // local history entries recorded against the stale array may fail to
        // apply, which surfaces as this same toast rather than clobbering.
        void qc.invalidateQueries({ queryKey });
        toast.error('Annotations were changed by another editor — reloaded; please redo your edit');
        return;
      }
      toast.error('Could not update annotations');
    },
    onSuccess: (updated, vars) => {
      qc.setQueryData<CanvasDetail>(queryKey, (old) => (old
        ? { ...old, annotations: updated.annotations, annotations_rev: updated.annotations_rev }
        : updated));
      if (vars.history) {
        historyRef.current?.record({
          type: 'annotations-update',
          before: vars.history.before,
          after: vars.history.after,
          label: vars.history.label,
        });
      }
    },
  });

  // Any pending debounced inspector-field edit (see draftAnnotationField)
  // MUST land before another annotation commit or an undo/redo application —
  // same F10 rule the U7 nudge accumulator follows, and for the same reason
  // (a stale trailing commit would otherwise fire later and revert it).
  function flushAnnotationEdit(): void {
    if (annoEditTimerRef.current) {
      clearTimeout(annoEditTimerRef.current);
      annoEditTimerRef.current = null;
      commitPendingAnnotationEdit();
    }
  }
  // Revert a drafted (uncommitted) inspector edit in the live cache back to
  // its pre-edit-session value. Required before delete-on-empty-text: the
  // delete's history `before` snapshots the LIVE cache, and a drafted-empty
  // text: '' recorded there would make undoing that delete PATCH an array the
  // server 400s on (BAD_ANNOTATIONS "requires non-empty text") — the failed
  // op then re-pushes forever and wedges the whole undo stack.
  function revertAnnotationDraft(accum: { id: string; before: CanvasAnnotation }): void {
    qc.setQueryData<CanvasDetail>(queryKey, (old) => (old
      ? { ...old, annotations: old.annotations.map((a) => (a.id === accum.id ? accum.before : a)) }
      : old));
  }
  function commitPendingAnnotationEdit(): void {
    const accum = annoEditAccumRef.current;
    annoEditAccumRef.current = null;
    if (!accum) return;
    const live = qc.getQueryData<CanvasDetail>(queryKey)?.annotations ?? annotations;
    const current = live.find((a) => a.id === accum.id);
    // The backend REJECTS an empty/whitespace-only text string (400
    // BAD_ANNOTATIONS) — if a debounced text edit landed on empty (e.g. the
    // user select-alled to retype and paused >400ms before typing the
    // replacement), delete the annotation instead of sending a PATCH the
    // server would reject anyway. Restore the pre-draft value FIRST so the
    // delete's history `before` stays server-valid (see revertAnnotationDraft).
    if (current?.type === 'text' && !(current.text ?? '').trim()) {
      revertAnnotationDraft(accum);
      deleteAnnotationIds([accum.id]);
      return;
    }
    const before = live.map((a) => (a.id === accum.id ? accum.before : a));
    if (JSON.stringify(before) === JSON.stringify(live)) return; // no-op edit session
    patchAnnotations.mutate({ data: { annotations: live }, history: { before, after: live, label: 'edit annotation' } });
  }
  /** Optimistic-only local patch (no server call, no history yet) — gives
   * live canvas feedback while typing/dragging a slider; the actual PATCH +
   * history entry is debounced 400ms after the last call for a given id. */
  function draftAnnotationField(id: string, patch: Partial<CanvasAnnotation>) {
    const live = qc.getQueryData<CanvasDetail>(queryKey)?.annotations ?? annotations;
    const current = live.find((a) => a.id === id);
    if (!current) return;
    if (!annoEditAccumRef.current || annoEditAccumRef.current.id !== id) {
      // Switching which annotation/field is being edited — flush whatever was
      // pending so it gets its OWN correctly-scoped history entry instead of
      // being silently folded into this one.
      flushAnnotationEdit();
      annoEditAccumRef.current = { id, before: current };
    }
    qc.setQueryData<CanvasDetail>(queryKey, (old) => (old
      ? { ...old, annotations: old.annotations.map((a) => (a.id === id ? { ...a, ...patch } : a)) }
      : old));
    if (annoEditTimerRef.current) clearTimeout(annoEditTimerRef.current);
    annoEditTimerRef.current = setTimeout(() => { annoEditTimerRef.current = null; commitPendingAnnotationEdit(); }, 400);
  }
  /** Canonical annotation commit primitive: flush any pending debounce, read
   * the current live array, transform it, and commit ONE canvas PATCH + ONE
   * history entry. Every annotation mutation (create/move/resize/endpoint-
   * drag/inspector edit/delete/z-change) funnels through this. */
  function commitAnnotations(buildNext: (current: CanvasAnnotation[]) => CanvasAnnotation[], label: string) {
    flushAnnotationEdit();
    const before = qc.getQueryData<CanvasDetail>(queryKey)?.annotations ?? annotations;
    const after = buildNext(before);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    patchAnnotations.mutate({ data: { annotations: after }, history: { before, after, label } });
  }
  function deleteAnnotationIds(ids: string[]) {
    if (ids.length === 0) return;
    commitAnnotations((cur) => cur.filter((a) => !ids.includes(a.id)), 'delete');
    setSelectedIds((cur) => cur.filter((id) => !ids.includes(id)));
  }
  function zBumpAnnotations(ids: string[], delta: number) {
    if (ids.length === 0) return;
    commitAnnotations((cur) => cur.map((a) => (ids.includes(a.id) ? { ...a, z: a.z + delta } : a)), delta > 0 ? 'bring forward' : 'send backward');
  }
  /** Inspector discrete-action commit (swatch pick, align, fill toggle, font
   * size/stroke width on blur, text content on blur) — single id, immediate. */
  function commitAnnotationField(id: string, patch: Partial<CanvasAnnotation>, label: string) {
    // Same backend "text required" guard as commitPendingAnnotationEdit — the
    // inspector's own text field can blur on an empty value too. Cancel the
    // pending debounce (its flush inside commitAnnotations would race a
    // second, still-corrupt delete) and restore the pre-draft value so the
    // delete's history `before` stays server-valid.
    if ('text' in patch && !(patch.text ?? '').trim()) {
      if (annoEditTimerRef.current) {
        clearTimeout(annoEditTimerRef.current);
        annoEditTimerRef.current = null;
      }
      const accum = annoEditAccumRef.current;
      annoEditAccumRef.current = null;
      if (accum && accum.id === id) revertAnnotationDraft(accum);
      deleteAnnotationIds([id]);
      return;
    }
    commitAnnotations((cur) => cur.map((a) => (a.id === id ? { ...a, ...patch } : a)), label);
  }
  function getMeasuredTextMm(id: string) {
    return measuredTextRef.current.get(id);
  }
  // Unified Delete/Backspace target: panels keep their existing per-panel
  // confirm+mutate path (unchanged), annotations delete via ONE commit.
  function deleteSelected() {
    const selPanelIds = selectedIds.filter((id) => panels.some((p) => p.id === id));
    const selAnnoIds = selectedIds.filter((id) => annotations.some((a) => a.id === id));
    const count = selPanelIds.length + selAnnoIds.length;
    if (count === 0) return;
    const noun = selPanelIds.length && selAnnoIds.length ? 'item' : selAnnoIds.length ? 'annotation' : 'panel';
    const prompt = count === 1 ? `Remove this ${noun} from the canvas?` : `Remove ${count} ${noun}s from the canvas?`;
    if (!window.confirm(prompt)) return;
    // v1: one history entry per panel + one combined entry for all
    // annotations (acceptable per plan — a single fully-combined multi-delete
    // undo op is a possible follow-up, same tradeoff U7 already accepted).
    for (const id of selPanelIds) removePanel.mutate({ panelId: id, record: true });
    if (selAnnoIds.length) deleteAnnotationIds(selAnnoIds);
  }

  // ── undo/redo application ──
  // Re-create a deleted panel from its snapshot via the same addCanvasPanel
  // mutation (record omitted → not re-recorded), then remap the snapshot's old
  // id to the new server id so later history entries keep resolving.
  async function recreatePanel(snap: PanelSnapshot) {
    const created = await addPanel.mutateAsync({
      data: {
        figure_id: snap.figure_id,
        x_mm: snap.x_mm,
        y_mm: snap.y_mm,
        width_mm: snap.width_mm,
        height_mm: snap.height_mm,
        z_order: snap.z_order,
        label: snap.label ?? undefined,
        pinned_version_id: snap.pinned_version_id ?? undefined,
      },
    });
    history.remap(snap.panelId, created.id);
    // addCanvasPanel cannot set label_visible — patch it if it differs.
    if (created.label_visible !== snap.label_visible) {
      await patchPanel.mutateAsync({ panelId: created.id, data: { label_visible: snap.label_visible } });
    }
  }

  async function applyHistory(direction: 'undo' | 'redo') {
    // Reentrancy guard must be SYNCHRONOUS: history.isApplying is set/cleared
    // synchronously inside begin/endApply, whereas `applyingHistory` is React
    // state whose reset lags a render. Two ops fired within one render cycle
    // (rapid Ctrl+Z / Ctrl+Shift+Z, or a redo immediately followed by an
    // undo) would read a stale applyingHistory=true and the SECOND op would be
    // silently dropped. `applyingHistory` remains only for the buttons'
    // disabled styling.
    if (history.isApplying) return;
    await flushNudge(); // pending nudge commits (and records) BEFORE we pop an op
    flushAnnotationEdit(); // ditto for a pending debounced annotation-field edit
    const op = direction === 'undo' ? history.undo() : history.redo();
    if (!op) return;
    history.beginApply();
    setApplyingHistory(true);
    try {
      switch (op.type) {
        case 'panel-update': {
          const fields = direction === 'undo' ? op.before : op.after;
          await patchPanel.mutateAsync({ panelId: history.mapId(op.panelId), data: fields });
          break;
        }
        case 'panels-update': {
          const results = await Promise.allSettled(op.items.map((it) => patchPanel.mutateAsync({
            panelId: history.mapId(it.panelId),
            data: direction === 'undo' ? it.before : it.after,
          })));
          // A panel deleted elsewhere (404) can never be re-applied: prune it
          // from the op PERMANENTLY (the op object lives on the history stack)
          // so retries stop re-attempting it. Any non-404 failure still throws
          // to the rollback path — succeeded siblings are idempotent to retry.
          const keep: typeof op.items = [];
          let hardFail = false;
          results.forEach((r, i) => {
            if (r.status === 'fulfilled') keep.push(op.items[i]);
            else if ((r.reason as { status?: number } | undefined)?.status === 404) { /* prune */ }
            else { hardFail = true; keep.push(op.items[i]); }
          });
          op.items = keep;
          if (hardFail) throw new Error('panels-update partially failed');
          break;
        }
        case 'panel-add': {
          // History-applied delete: intentionally NO window.confirm.
          if (direction === 'undo') await removePanel.mutateAsync({ panelId: history.mapId(op.snapshot.panelId) });
          else await recreatePanel(op.snapshot);
          break;
        }
        case 'panel-delete': {
          if (direction === 'undo') await recreatePanel(op.snapshot);
          else await removePanel.mutateAsync({ panelId: history.mapId(op.snapshot.panelId) });
          break;
        }
        case 'canvas-size': {
          await patchCanvas.mutateAsync({ data: direction === 'undo' ? op.before : op.after });
          break;
        }
        case 'annotations-update': {
          // No id remapping needed (unlike panels): annotation ids are
          // client-generated uuids that persist unchanged across undo/redo —
          // there's no server-assigned id swap to track.
          await patchAnnotations.mutateAsync({ data: { annotations: direction === 'undo' ? op.before : op.after } });
          break;
        }
      }
      toast.success(`${direction === 'undo' ? 'Undid' : 'Redid'} ${op.label}`);
    } catch {
      // The mutation already showed its own error toast and rolled back the
      // optimistic cache; put the op back so the user can retry.
      history.rollback(direction);
    } finally {
      history.endApply();
      setApplyingHistory(false);
    }
  }
  useEffect(() => {
    applyHistoryRef.current = applyHistory;
  });
  useEffect(() => {
    finalizeMarqueeRef.current = finalizeMarquee;
  });
  // Konva binds mouseup on its container only — a release outside the stage
  // (over the toolbar/sidebar/another window) never reaches handleStageMouseUp
  // and the marquee would keep tracking. Finalize on ANY window release while
  // a marquee is live (for in-stage releases the stage handler runs first and
  // this is a no-op — marqueeRef is already null).
  const marqueeActive = marquee !== null;
  useEffect(() => {
    if (!marqueeActive) return;
    const onWinUp = () => finalizeMarqueeRef.current();
    window.addEventListener('mouseup', onWinUp);
    return () => window.removeEventListener('mouseup', onWinUp);
  }, [marqueeActive]);
  // U8: same window-mouseup-fallback pattern, for an in-progress shape/line/
  // arrow creation drag.
  useEffect(() => {
    finalizeDrawingRef.current = finalizeDrawing;
  });
  const drawingActive = drawing !== null;
  useEffect(() => {
    if (!drawingActive) return;
    const onWinUp = () => finalizeDrawingRef.current();
    window.addEventListener('mouseup', onWinUp);
    return () => window.removeEventListener('mouseup', onWinUp);
  }, [drawingActive]);
  // Clear the gesture flag on the WINDOW so releases outside the canvas (or
  // over chrome) still end the gesture — Konva only binds mouseup on its own
  // container (the U7 marquee lesson).
  useEffect(() => {
    if (!pointerGestureActive) return;
    const end = () => setPointerGestureActive(false);
    window.addEventListener('mouseup', end);
    window.addEventListener('touchend', end);
    return () => {
      window.removeEventListener('mouseup', end);
      window.removeEventListener('touchend', end);
    };
  }, [pointerGestureActive]);
  // F13: prune selection against BOTH live item lists — a cross-tab delete
  // otherwise leaves ghost ids that wedge group-resize's arrival counter,
  // no-op align, and mislead the "N items selected" count. U8: annotations
  // share selectedIds and MUST be kept here — `panels` gets a new identity on
  // every optimistic panel patch (patchLocalPanel/patchPanel), which would
  // otherwise strip annotation ids from a mixed selection right after the
  // first panel-touching gesture (nudge, group drag, undo/redo).
  useEffect(() => {
    setSelectedIds((cur) => {
      const next = cur.filter((id) => panels.some((p) => p.id === id) || annotations.some((a) => a.id === id));
      return next.length === cur.length ? cur : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panels, annotations]);

  // ── export: compose the canvas into a file (vector SVG/PDF, or raster
  // PNG/TIFF at 300|600 dpi) and download it. ──
  const exportCanvas = useMutation({
    mutationFn: ({ format, dpi }: { format: 'svg' | 'pdf' | 'png' | 'tiff'; dpi?: 300 | 600 }) => {
      const base = (canvas?.name?.trim() || 'canvas').replace(/[/\\:*?"<>|]+/g, '_');
      const suffix = dpi ? `_${dpi}dpi` : '';
      return downloadCanvasExport(canvasId, format, `${base}${suffix}.${format}`, dpi);
    },
    onSuccess: (_res, vars) => toast.success(`Canvas exported as ${vars.format.toUpperCase()}${vars.dpi ? ` (${vars.dpi} dpi)` : ''}`),
    onError: () => toast.error('Could not export canvas'),
  });

  // ── U9: duplicate the whole canvas (panels + annotations) and jump to it. ──
  const duplicateCanvasMut = useMutation({
    mutationFn: () => duplicateCanvas(canvasId),
    onSuccess: (created) => {
      toast.success('Canvas duplicated');
      qc.invalidateQueries({ queryKey: ['canvases'] });
      router.push(`/canvases/${created.id}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not duplicate canvas'),
  });

  // U7 5a: apply the leader's post-snap delta to the rest of a multi-selection
  // being dragged as a group. No-ops unless `leaderId` IS the gesture's leader
  // (groupMoveRef is only set on that one item's dragstart). U8: genericized
  // to an id (was `panel: CanvasPanel`) so it works for annotation leaders too
  // — it's pure node-translation and never needed panel fields.
  function applyGroupDragDelta(leaderId: string, node: Konva.Group) {
    const group = groupMoveRef.current;
    if (!group || group.leaderId !== leaderId) return;
    const start = group.startPx.get(leaderId);
    if (!start) return;
    const dx = node.x() - start.x;
    const dy = node.y() - start.y;
    for (const [id, s] of group.startPx) {
      if (id === leaderId) continue;
      const sibling = nodeRefs.current.get(id);
      if (!sibling) continue;
      sibling.x(s.x + dx);
      sibling.y(s.y + dy);
    }
  }

  // U8: shared dragstart setup for BOTH panels and annotations — snapshots
  // every selected node's start position (+ its current origin mm, for the
  // eventual history "before") so handleDragMove/handleDragEnd can apply the
  // leader's delta to the rest, regardless of item kind.
  function beginGroupMove(leaderId: string) {
    if (selectedIds.length > 1 && selectedIds.includes(leaderId)) {
      const startPx = new Map<string, { x: number; y: number }>();
      const beforeMm = new Map<string, { x_mm: number; y_mm: number }>();
      for (const id of selectedIds) {
        const node = nodeRefs.current.get(id);
        if (node) startPx.set(id, { x: node.x(), y: node.y() });
        const p = panels.find((pp) => pp.id === id);
        if (p) { beforeMm.set(id, { x_mm: p.x_mm, y_mm: p.y_mm }); continue; }
        const a = annotations.find((aa) => aa.id === id);
        if (a) { const o = originMm(a); beforeMm.set(id, { x_mm: o.x, y_mm: o.y }); }
      }
      groupMoveRef.current = { leaderId, startPx, beforeMm };
    } else {
      groupMoveRef.current = null;
    }
  }

  // U8: commit a completed group-move gesture (mixed panel+annotation
  // selections included) — panels batch-commit via commitPanelsBatch
  // (unchanged U7 path); annotations batch-commit as ONE canvas PATCH. A
  // MIXED gesture therefore records TWO history entries (one per op type,
  // per canvasHistory.ts's typed ops) rather than a single combined one —
  // undo needs two Ctrl+Z presses to fully revert a mixed drag. Documented
  // tradeoff, not a bug: keeps each op type's history shape simple.
  function commitGroupMove(group: NonNullable<typeof groupMoveRef.current>) {
    if (!canvas) return;
    const panelItems: { panelId: string; before: PanelFields; after: PanelFields }[] = [];
    const annoUpdates = new Map<string, CanvasAnnotation>();
    for (const [id, before] of group.beforeMm) {
      const n = nodeRefs.current.get(id);
      if (!n) continue;
      const p = panels.find((pp) => pp.id === id);
      if (p) {
        const x_mm = clampPosMm(pxToMm(n.x(), pxPerMm), p.width_mm, canvas.width_mm);
        const y_mm = clampPosMm(pxToMm(n.y(), pxPerMm), p.height_mm, canvas.height_mm);
        n.x(mmToPx(x_mm, pxPerMm));
        n.y(mmToPx(y_mm, pxPerMm));
        if (Math.abs(x_mm - before.x_mm) < EPS_MM && Math.abs(y_mm - before.y_mm) < EPS_MM) continue;
        panelItems.push({ panelId: id, before: { x_mm: before.x_mm, y_mm: before.y_mm }, after: { x_mm, y_mm } });
        continue;
      }
      const a = annotations.find((aa) => aa.id === id);
      if (!a) continue;
      const x_mm = roundMm(clampNum(pxToMm(n.x(), pxPerMm), -1000, 3000));
      const y_mm = roundMm(clampNum(pxToMm(n.y(), pxPerMm), -1000, 3000));
      n.x(mmToPx(x_mm, pxPerMm));
      n.y(mmToPx(y_mm, pxPerMm));
      if (Math.abs(x_mm - before.x_mm) < EPS_MM && Math.abs(y_mm - before.y_mm) < EPS_MM) continue;
      annoUpdates.set(id, translateAnnotation(a, x_mm - before.x_mm, y_mm - before.y_mm));
    }
    if (panelItems.length) commitPanelsBatch(panelItems, 'move');
    if (annoUpdates.size) commitAnnotations((cur) => cur.map((a) => annoUpdates.get(a.id) ?? a), 'move');
  }

  // ── move: convert node px → mm; position only (NO re-render) ──
  function handleDragMove(panel: CanvasPanel, e: Konva.KonvaEventObject<DragEvent>) {
    if (!canvas) return;
    const node = e.target as Konva.Group;
    // Alt/Option temporarily disables snapping for pixel-precise placement.
    if (e.evt.altKey) {
      setGuides({ x: null, y: null });
      applyGroupDragDelta(panel.id, node);
      return;
    }
    const thr = SNAP_PX / view.zoom;
    const w = mmToPx(panel.width_mm, pxPerMm);
    const h = mmToPx(panel.height_mm, pxPerMm);
    const cw = mmToPx(canvas.width_mm, pxPerMm);
    const ch = mmToPx(canvas.height_mm, pxPerMm);
    let x = node.x();
    let y = node.y();

    const others = panels.filter((p) => p.id !== panel.id);
    // U9: grid lines (5mm pitch) join the snap targets when grid-snap is on —
    // appended, not substituted, so "nearest wins" picks whichever is closer.
    const gridX = gridSnapEnabled ? gridSnapTargetsPx(canvas.width_mm, pxPerMm) : [];
    const gridY = gridSnapEnabled ? gridSnapTargetsPx(canvas.height_mm, pxPerMm) : [];
    // U8: annotation bounding boxes join the panel snap target set.
    const xTargets = [0, cw, cw / 2, ...gridX, ...others.flatMap((p) => {
      const px = mmToPx(p.x_mm, pxPerMm);
      const pw = mmToPx(p.width_mm, pxPerMm);
      return [px, px + pw, px + pw / 2];
    }), ...annotations.flatMap((a) => {
      const box = annotationBoxPx(a, pxPerMm, measuredTextRef.current.get(a.id));
      return [box.x0, box.x1, (box.x0 + box.x1) / 2];
    })];
    const yTargets = [0, ch, ch / 2, ...gridY, ...others.flatMap((p) => {
      const py = mmToPx(p.y_mm, pxPerMm);
      const ph = mmToPx(p.height_mm, pxPerMm);
      return [py, py + ph, py + ph / 2];
    }), ...annotations.flatMap((a) => {
      const box = annotationBoxPx(a, pxPerMm, measuredTextRef.current.get(a.id));
      return [box.y0, box.y1, (box.y0 + box.y1) / 2];
    })];

    let guideX: number | null = null;
    let guideY: number | null = null;
    // Snap each axis to the NEAREST target line within the threshold. Scanning
    // all (edge, target) pairs for the global minimum — a first-match pick can
    // warp toward a farther line when several 6px bands overlap, which users
    // perceive as the panel "jumping" at certain spots.
    let bestX: { d: number; delta: number; t: number } | null = null;
    for (const edge of [x, x + w, x + w / 2]) {
      for (const t of xTargets) {
        const d = Math.abs(edge - t);
        if (d <= thr && (!bestX || d < bestX.d)) bestX = { d, delta: t - edge, t };
      }
    }
    let bestY: { d: number; delta: number; t: number } | null = null;
    for (const edge of [y, y + h, y + h / 2]) {
      for (const t of yTargets) {
        const d = Math.abs(edge - t);
        if (d <= thr && (!bestY || d < bestY.d)) bestY = { d, delta: t - edge, t };
      }
    }
    if (bestX) { x += bestX.delta; guideX = bestX.t; }
    if (bestY) { y += bestY.delta; guideY = bestY.t; }
    node.x(x);
    node.y(y);
    setGuides({ x: guideX, y: guideY });
    // Group siblings follow the LEADER's post-snap position (snap only ever
    // applies to the dragged node, per U7 5a).
    applyGroupDragDelta(panel.id, node);
  }

  function handleDragEnd(panel: CanvasPanel, e: Konva.KonvaEventObject<DragEvent>) {
    setGuides({ x: null, y: null });
    if (!canvas) return;
    const node = e.target as Konva.Group;
    const group = groupMoveRef.current;
    if (group && group.leaderId === panel.id) {
      groupMoveRef.current = null;
      commitGroupMove(group);
      return;
    }
    // Position clamp is [0, canvas − panel] (clampCanvasMm is a SIZE clamp
    // whose 20mm floor forbade placing panels near the top/left edges).
    const x_mm = clampPosMm(pxToMm(node.x(), pxPerMm), panel.width_mm, canvas.width_mm);
    const y_mm = clampPosMm(pxToMm(node.y(), pxPerMm), panel.height_mm, canvas.height_mm);
    // Re-sync the node to the clamped position (same stranded-node hazard as
    // the group branch when the clamp lands back on the pre-drag mm).
    node.x(mmToPx(x_mm, pxPerMm));
    node.y(mmToPx(y_mm, pxPerMm));
    // Ignore a pure click (no meaningful move) — avoids a redundant PATCH
    // (and thus records no history entry for pure clicks).
    if (Math.abs(x_mm - panel.x_mm) < EPS_MM && Math.abs(y_mm - panel.y_mm) < EPS_MM) return;
    // One history entry per gesture: `panel` still holds start-of-gesture mm
    // (the cache is only patched on commit), so it IS the "before".
    patchPanel.mutate({
      panelId: panel.id,
      data: { x_mm, y_mm }, // position only → no re-render
      history: { before: { x_mm: panel.x_mm, y_mm: panel.y_mm }, label: 'move' },
    });
  }

  // ── U8: annotation move — same alt-bypass + nearest-target snap shape as
  // handleDragMove, but the snap target set is panels + every OTHER
  // annotation (a panel drag's targets, symmetrically, now include every
  // annotation — see handleDragMove above). ──
  function handleAnnotationDragMove(ann: CanvasAnnotation, e: Konva.KonvaEventObject<DragEvent>) {
    if (!canvas) return;
    const node = e.target as Konva.Group;
    if (e.evt.altKey) {
      setGuides({ x: null, y: null });
      applyGroupDragDelta(ann.id, node);
      return;
    }
    const thr = SNAP_PX / view.zoom;
    const selfSize = sizeMm(ann, measuredTextRef.current.get(ann.id));
    const w = mmToPx(selfSize.w_mm, pxPerMm);
    const h = mmToPx(selfSize.h_mm, pxPerMm);
    const cw = mmToPx(canvas.width_mm, pxPerMm);
    const ch = mmToPx(canvas.height_mm, pxPerMm);
    let x = node.x();
    let y = node.y();

    const otherAnnos = annotations.filter((a) => a.id !== ann.id);
    // U9: grid lines join the snap targets when grid-snap is on (same
    // "append, nearest wins" convention as the panel-drag path above).
    const gridX = gridSnapEnabled ? gridSnapTargetsPx(canvas.width_mm, pxPerMm) : [];
    const gridY = gridSnapEnabled ? gridSnapTargetsPx(canvas.height_mm, pxPerMm) : [];
    const xTargets = [0, cw, cw / 2, ...gridX, ...panels.flatMap((p) => {
      const px = mmToPx(p.x_mm, pxPerMm);
      const pw = mmToPx(p.width_mm, pxPerMm);
      return [px, px + pw, px + pw / 2];
    }), ...otherAnnos.flatMap((a) => {
      const box = annotationBoxPx(a, pxPerMm, measuredTextRef.current.get(a.id));
      return [box.x0, box.x1, (box.x0 + box.x1) / 2];
    })];
    const yTargets = [0, ch, ch / 2, ...gridY, ...panels.flatMap((p) => {
      const py = mmToPx(p.y_mm, pxPerMm);
      const ph = mmToPx(p.height_mm, pxPerMm);
      return [py, py + ph, py + ph / 2];
    }), ...otherAnnos.flatMap((a) => {
      const box = annotationBoxPx(a, pxPerMm, measuredTextRef.current.get(a.id));
      return [box.y0, box.y1, (box.y0 + box.y1) / 2];
    })];

    let guideX: number | null = null;
    let guideY: number | null = null;
    let bestX: { d: number; delta: number; t: number } | null = null;
    for (const edge of [x, x + w, x + w / 2]) {
      for (const t of xTargets) {
        const d = Math.abs(edge - t);
        if (d <= thr && (!bestX || d < bestX.d)) bestX = { d, delta: t - edge, t };
      }
    }
    let bestY: { d: number; delta: number; t: number } | null = null;
    for (const edge of [y, y + h, y + h / 2]) {
      for (const t of yTargets) {
        const d = Math.abs(edge - t);
        if (d <= thr && (!bestY || d < bestY.d)) bestY = { d, delta: t - edge, t };
      }
    }
    if (bestX) { x += bestX.delta; guideX = bestX.t; }
    if (bestY) { y += bestY.delta; guideY = bestY.t; }
    node.x(x);
    node.y(y);
    setGuides({ x: guideX, y: guideY });
    applyGroupDragDelta(ann.id, node);
  }

  function handleAnnotationDragEnd(ann: CanvasAnnotation, e: Konva.KonvaEventObject<DragEvent>) {
    setGuides({ x: null, y: null });
    const node = e.target as Konva.Group;
    const group = groupMoveRef.current;
    if (group && group.leaderId === ann.id) {
      groupMoveRef.current = null;
      commitGroupMove(group);
      return;
    }
    const origin = originMm(ann);
    // Annotations aren't clamped to the canvas sheet like panels (a large
    // arrow legitimately runs off-edge) — just the same generous sanity range
    // the backend enforces server-side.
    const x_mm = roundMm(clampNum(pxToMm(node.x(), pxPerMm), -1000, 3000));
    const y_mm = roundMm(clampNum(pxToMm(node.y(), pxPerMm), -1000, 3000));
    node.x(mmToPx(x_mm, pxPerMm));
    node.y(mmToPx(y_mm, pxPerMm));
    if (Math.abs(x_mm - origin.x) < EPS_MM && Math.abs(y_mm - origin.y) < EPS_MM) return;
    const updated = translateAnnotation(ann, x_mm - origin.x, y_mm - origin.y);
    commitAnnotations((cur) => cur.map((a) => (a.id === ann.id ? updated : a)), 'move');
  }

  // ── U8: line/arrow endpoint handles (excluded from the shared Transformer —
  // see isTransformerEligible) — a small draggable circle per endpoint, shown
  // only while that ONE line/arrow is the sole selection (rendered in the JSX
  // below). `endpointDraft` gives live visual feedback during the drag
  // (CanvasAnnotationNode renders whichever of {live annotation, draft} is
  // current — see the `.map()` in the render section) without committing on
  // every mousemove. ──
  function handleEndpointDragMove(annId: string, which: 0 | 1, e: Konva.KonvaEventObject<DragEvent>) {
    const ann = annotations.find((a) => a.id === annId);
    if (!ann || !ann.points_mm) return;
    const node = e.target;
    const xMm = pxToMm(node.x(), pxPerMm);
    const yMm = pxToMm(node.y(), pxPerMm);
    const base = endpointDraft?.id === annId ? endpointDraft.points_mm : ann.points_mm;
    const next: [number, number, number, number] = [...base] as [number, number, number, number];
    next[which * 2] = xMm;
    next[which * 2 + 1] = yMm;
    setEndpointDraft({ id: annId, points_mm: next });
  }
  function handleEndpointDragEnd(annId: string, which: 0 | 1, e: Konva.KonvaEventObject<DragEvent>) {
    setEndpointDraft(null);
    const ann = annotations.find((a) => a.id === annId);
    if (!ann || !ann.points_mm) return;
    const node = e.target;
    const xMm = roundMm(clampNum(pxToMm(node.x(), pxPerMm), -1000, 3000));
    const yMm = roundMm(clampNum(pxToMm(node.y(), pxPerMm), -1000, 3000));
    const before = ann.points_mm;
    const next: [number, number, number, number] = [...before] as [number, number, number, number];
    next[which * 2] = xMm;
    next[which * 2 + 1] = yMm;
    if (
      Math.abs(next[0] - before[0]) < EPS_MM && Math.abs(next[1] - before[1]) < EPS_MM
      && Math.abs(next[2] - before[2]) < EPS_MM && Math.abs(next[3] - before[3]) < EPS_MM
    ) return;
    commitAnnotations((cur) => cur.map((a) => (a.id === annId ? { ...a, points_mm: next } : a)), 'endpoint');
  }

  // ── resize = RE-LAYOUT: reset the transient Konva scale, commit new mm; the
  // panel image then re-renders at the NEW physical size via usePanelImage. ──
  function handleTransformEnd(panel: CanvasPanel, e: Konva.KonvaEventObject<Event>) {
    setGuides({ x: null, y: null }); // clear any resize-snap guide (item 6)
    const node = e.target as Konva.Group;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    // New size in fit-px, then drop the transient scale used during the gesture.
    const newWpx = Math.max(mmToPx(PANEL_MM_MIN, pxPerMm), node.width() * scaleX);
    const newHpx = Math.max(mmToPx(PANEL_MM_MIN, pxPerMm), node.height() * scaleY);
    node.scaleX(1);
    node.scaleY(1);
    const width_mm = roundMm(clampPanelMm(pxToMm(newWpx, pxPerMm)));
    const height_mm = roundMm(clampPanelMm(pxToMm(newHpx, pxPerMm)));
    // The transform may also shift the top-left (resizing from a non-BR handle).
    // Same [0, canvas − panel] position rule as drag (NOT the 20mm size clamp).
    const x_mm = canvas ? clampPosMm(pxToMm(node.x(), pxPerMm), width_mm, canvas.width_mm) : roundMm(pxToMm(node.x(), pxPerMm));
    const y_mm = canvas ? clampPosMm(pxToMm(node.y(), pxPerMm), height_mm, canvas.height_mm) : roundMm(pxToMm(node.y(), pxPerMm));
    const noChange = Math.abs(width_mm - panel.width_mm) < EPS_MM &&
      Math.abs(height_mm - panel.height_mm) < EPS_MM &&
      Math.abs(x_mm - panel.x_mm) < EPS_MM &&
      Math.abs(y_mm - panel.y_mm) < EPS_MM;

    // U7 8: multi-node resize. Konva's Transformer fires 'transformend' once
    // PER attached node — accumulate every node's result and commit ONE batch
    // (+ one history entry) once the last of the selection has reported in.
    if (groupResizeActiveRef.current) {
      if (!noChange) {
        groupResizeItemsRef.current.push({
          panelId: panel.id,
          before: { x_mm: panel.x_mm, y_mm: panel.y_mm, width_mm: panel.width_mm, height_mm: panel.height_mm },
          after: { x_mm, y_mm, width_mm, height_mm },
        });
      }
      groupResizeSeenRef.current += 1;
      if (groupResizeSeenRef.current >= groupResizeEligibleCountRef.current) {
        groupResizeActiveRef.current = false;
        const items = groupResizeItemsRef.current;
        groupResizeItemsRef.current = [];
        const annoItems = groupResizeAnnotationItemsRef.current;
        groupResizeAnnotationItemsRef.current = [];
        groupResizeSeenRef.current = 0;
        if (items.length) commitPanelsBatch(items, 'resize');
        if (annoItems.length) {
          const byId = new Map(annoItems.map((it) => [it.id, it.after]));
          commitAnnotations((cur) => cur.map((a) => byId.get(a.id) ?? a), 'resize');
        }
      }
      return;
    }

    if (noChange) return;
    // Commit new physical size (+ position). Updating width_mm/height_mm changes
    // the panel image key → usePanelImage calls renderCanvasPreview at the NEW mm
    // size and swaps in a freshly laid-out render (absolute-pt fonts preserved).
    // One history entry per resize gesture (before = start-of-gesture geometry).
    patchPanel.mutate({
      panelId: panel.id,
      data: { x_mm, y_mm, width_mm, height_mm },
      history: {
        before: { x_mm: panel.x_mm, y_mm: panel.y_mm, width_mm: panel.width_mm, height_mm: panel.height_mm },
        label: 'resize',
      },
    });
  }

  // ── U8: annotation resize — text gets WIDTH ONLY (font_pt/height untouched;
  // enforced both here and via the text-only enabledAnchors set below), rect/
  // ellipse get free width+height. line/arrow never attach to the Transformer
  // (excluded from nodeRefs eligibility) so this never fires for them. ──
  const ANNOTATION_MM_MIN = 2;
  function handleAnnotationTransformEnd(ann: CanvasAnnotation, e: Konva.KonvaEventObject<Event>) {
    setGuides({ x: null, y: null });
    const node = e.target as Konva.Group;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    const newWpx = Math.max(mmToPx(ANNOTATION_MM_MIN, pxPerMm), node.width() * scaleX);
    const newHpx = Math.max(mmToPx(ANNOTATION_MM_MIN, pxPerMm), node.height() * scaleY);
    node.scaleX(1);
    node.scaleY(1);
    const x_mm = roundMm(clampNum(pxToMm(node.x(), pxPerMm), -1000, 3000));
    const y_mm = roundMm(clampNum(pxToMm(node.y(), pxPerMm), -1000, 3000));
    const width_mm = roundMm(clampNum(pxToMm(newWpx, pxPerMm), 0.5, 2000));

    let updated: CanvasAnnotation;
    if (ann.type === 'text') {
      updated = { ...ann, x_mm, y_mm, w_mm: width_mm };
    } else {
      const height_mm = roundMm(clampNum(pxToMm(newHpx, pxPerMm), 0.5, 2000));
      updated = { ...ann, x_mm, y_mm, w_mm: width_mm, h_mm: height_mm };
    }
    const noChange = JSON.stringify(updated) === JSON.stringify(ann);

    if (groupResizeActiveRef.current) {
      if (!noChange) groupResizeAnnotationItemsRef.current.push({ id: ann.id, after: updated });
      groupResizeSeenRef.current += 1;
      if (groupResizeSeenRef.current >= groupResizeEligibleCountRef.current) {
        groupResizeActiveRef.current = false;
        const items = groupResizeItemsRef.current;
        groupResizeItemsRef.current = [];
        const annoItems = groupResizeAnnotationItemsRef.current;
        groupResizeAnnotationItemsRef.current = [];
        groupResizeSeenRef.current = 0;
        if (items.length) commitPanelsBatch(items, 'resize');
        if (annoItems.length) {
          const byId = new Map(annoItems.map((it) => [it.id, it.after]));
          commitAnnotations((cur) => cur.map((a) => byId.get(a.id) ?? a), 'resize');
        }
      }
      return;
    }

    if (noChange) return;
    commitAnnotations((cur) => cur.map((a) => (a.id === ann.id ? updated : a)), 'resize');
  }

  // ── z-order ──
  function bringForward(panel: CanvasPanel) {
    const maxZ = Math.max(0, ...panels.map((p) => p.z_order));
    if (panel.z_order >= maxZ && panels[panels.length - 1]?.id === panel.id) return;
    patchPanel.mutate({
      panelId: panel.id,
      data: { z_order: maxZ + 1 },
      history: { before: { z_order: panel.z_order }, label: 'reorder' },
    });
  }
  function sendBack(panel: CanvasPanel) {
    const minZ = Math.min(0, ...panels.map((p) => p.z_order));
    if (panel.z_order <= minZ && panels[0]?.id === panel.id) return;
    patchPanel.mutate({
      panelId: panel.id,
      data: { z_order: minZ - 1 },
      history: { before: { z_order: panel.z_order }, label: 'reorder' },
    });
  }

  // ── U7 5c: align / distribute the selection — pure mm math, one batch commit ──
  async function alignSelected(mode: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom') {
    if (!canvas || selectedIds.length < 2) return;
    await flushNudge();
    const sel = selectedIds.map((id) => panels.find((p) => p.id === id)).filter((p): p is CanvasPanel => Boolean(p));
    if (sel.length < 2) return;
    const items: { panelId: string; before: PanelFields; after: PanelFields }[] = [];
    if (mode === 'left' || mode === 'hcenter' || mode === 'right') {
      const minX = Math.min(...sel.map((p) => p.x_mm));
      const maxX = Math.max(...sel.map((p) => p.x_mm + p.width_mm));
      for (const p of sel) {
        let x_mm = p.x_mm;
        if (mode === 'left') x_mm = minX;
        else if (mode === 'right') x_mm = maxX - p.width_mm;
        else x_mm = (minX + maxX) / 2 - p.width_mm / 2;
        x_mm = clampPosMm(x_mm, p.width_mm, canvas.width_mm);
        if (Math.abs(x_mm - p.x_mm) < EPS_MM) continue;
        items.push({ panelId: p.id, before: { x_mm: p.x_mm }, after: { x_mm } });
      }
    } else {
      const minY = Math.min(...sel.map((p) => p.y_mm));
      const maxY = Math.max(...sel.map((p) => p.y_mm + p.height_mm));
      for (const p of sel) {
        let y_mm = p.y_mm;
        if (mode === 'top') y_mm = minY;
        else if (mode === 'bottom') y_mm = maxY - p.height_mm;
        else y_mm = (minY + maxY) / 2 - p.height_mm / 2;
        y_mm = clampPosMm(y_mm, p.height_mm, canvas.height_mm);
        if (Math.abs(y_mm - p.y_mm) < EPS_MM) continue;
        items.push({ panelId: p.id, before: { y_mm: p.y_mm }, after: { y_mm } });
      }
    }
    commitPanelsBatch(items, 'align');
  }
  async function distributeSelected(axis: 'h' | 'v') {
    if (!canvas || selectedIds.length < 3) return;
    await flushNudge();
    const sel = selectedIds.map((id) => panels.find((p) => p.id === id)).filter((p): p is CanvasPanel => Boolean(p));
    if (sel.length < 3) return;
    const items: { panelId: string; before: PanelFields; after: PanelFields }[] = [];
    // Equal-gap distribution between the two extreme edges (Figma/Illustrator
    // convention): the first and last panel's outer edges never move.
    if (axis === 'h') {
      const sorted = [...sel].sort((a, b) => a.x_mm - b.x_mm);
      const minX = sorted[0].x_mm;
      const maxX = Math.max(...sorted.map((p) => p.x_mm + p.width_mm));
      const totalW = sorted.reduce((s, p) => s + p.width_mm, 0);
      const gap = (maxX - minX - totalW) / (sorted.length - 1);
      let cursor = minX;
      for (const p of sorted) {
        const x_mm = clampPosMm(cursor, p.width_mm, canvas.width_mm);
        if (Math.abs(x_mm - p.x_mm) >= EPS_MM) items.push({ panelId: p.id, before: { x_mm: p.x_mm }, after: { x_mm } });
        cursor += p.width_mm + gap;
      }
    } else {
      const sorted = [...sel].sort((a, b) => a.y_mm - b.y_mm);
      const minY = sorted[0].y_mm;
      const maxY = Math.max(...sorted.map((p) => p.y_mm + p.height_mm));
      const totalH = sorted.reduce((s, p) => s + p.height_mm, 0);
      const gap = (maxY - minY - totalH) / (sorted.length - 1);
      let cursor = minY;
      for (const p of sorted) {
        const y_mm = clampPosMm(cursor, p.height_mm, canvas.height_mm);
        if (Math.abs(y_mm - p.y_mm) >= EPS_MM) items.push({ panelId: p.id, before: { y_mm: p.y_mm }, after: { y_mm } });
        cursor += p.height_mm + gap;
      }
    }
    commitPanelsBatch(items, 'distribute');
  }

  // ── U7 5d: keyboard nudge — optimistic local move, debounced batched commit ──
  function nudgeSelected(key: string, shift: boolean) {
    // Read the live cache (not the `panels`/`canvas` closures) so rapid
    // key-repeat bursts each start from the latest optimistic position, even
    // if React hasn't re-rendered between two keydown events yet.
    const cv = qc.getQueryData<CanvasDetail>(queryKey);
    if (!cv || selectedIds.length === 0) return;
    const step = shift ? 5 : 1;
    let dx = 0, dy = 0;
    if (key === 'ArrowUp') dy = -step;
    else if (key === 'ArrowDown') dy = step;
    else if (key === 'ArrowLeft') dx = -step;
    else if (key === 'ArrowRight') dx = step;
    if (dx === 0 && dy === 0) return;
    for (const id of selectedIds) {
      const p = cv.panels.find((pp) => pp.id === id);
      if (p) {
        const x_mm = clampPosMm(p.x_mm + dx, p.width_mm, cv.width_mm);
        const y_mm = clampPosMm(p.y_mm + dy, p.height_mm, cv.height_mm);
        if (Math.abs(x_mm - p.x_mm) < EPS_MM && Math.abs(y_mm - p.y_mm) < EPS_MM) continue;
        patchLocalPanel(id, { x_mm, y_mm });
        const existing = nudgeAccumRef.current.get(id);
        nudgeAccumRef.current.set(id, {
          before: existing ? existing.before : { x_mm: p.x_mm, y_mm: p.y_mm },
          after: { x_mm, y_mm },
        });
        continue;
      }
      // U8: same optimistic-local + accumulate pattern, for an annotation.
      const a = (cv.annotations ?? []).find((aa) => aa.id === id);
      if (!a) continue;
      const translated = translateAnnotation(a, dx, dy);
      if (!nudgeAnnotationAccumRef.current.has(id)) nudgeAnnotationAccumRef.current.set(id, a);
      qc.setQueryData<CanvasDetail>(queryKey, (old) => (old
        ? { ...old, annotations: old.annotations.map((aa) => (aa.id === id ? translated : aa)) }
        : old));
    }
    if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
    nudgeTimerRef.current = setTimeout(commitNudge, 400);
  }
  function commitAnnotationNudge(): void {
    const beforeMap = nudgeAnnotationAccumRef.current;
    nudgeAnnotationAccumRef.current = new Map();
    if (beforeMap.size === 0) return;
    const live = qc.getQueryData<CanvasDetail>(queryKey)?.annotations ?? annotations;
    const before = live.map((a) => beforeMap.get(a.id) ?? a);
    if (JSON.stringify(before) === JSON.stringify(live)) return;
    patchAnnotations.mutate({ data: { annotations: live }, history: { before, after: live, label: 'nudge' } });
  }
  function commitNudge(): Promise<void> {
    nudgeTimerRef.current = null;
    const items = Array.from(nudgeAccumRef.current.entries())
      .filter(([, v]) => Math.abs(v.after.x_mm - v.before.x_mm) >= EPS_MM || Math.abs(v.after.y_mm - v.before.y_mm) >= EPS_MM)
      .map(([panelId, v]) => ({ panelId, before: v.before, after: v.after }));
    nudgeAccumRef.current.clear();
    commitAnnotationNudge();
    return commitPanelsBatch(items, 'nudge');
  }
  // F10: a pending debounced nudge MUST land before any other gesture commits
  // or history is applied — otherwise the stale 400ms PATCH fires after the
  // later gesture and reverts it (and its record() would clear the redo stack
  // mid-undo).
  function flushNudge(): Promise<void> {
    if (!nudgeTimerRef.current && nudgeAccumRef.current.size === 0 && nudgeAnnotationAccumRef.current.size === 0) {
      return Promise.resolve();
    }
    if (nudgeTimerRef.current) {
      clearTimeout(nudgeTimerRef.current);
      nudgeTimerRef.current = null;
    }
    return commitNudge();
  }
  useEffect(() => {
    nudgeSelectedRef.current = nudgeSelected;
  });

  // ── add figure ──
  // New panels default to the figure's NATIVE render size (mm) so it looks
  // identical to the figure page — fonts are absolute pt, so a different panel
  // size re-layouts the plot and reads as "changed". Shrunk uniformly (aspect
  // preserved) if the native size exceeds ~90% of the canvas; 60×45 fallback
  // when the figure has no version (native size unknown).
  function fitToCanvasMm(nw: number, nh: number): { width_mm: number; height_mm: number } {
    if (!canvas) return { width_mm: nw, height_mm: nh };
    let s = Math.min(1, (canvas.width_mm * 0.9) / nw, (canvas.height_mm * 0.9) / nh);
    // Keep BOTH sides ≥ PANEL_MM_MIN by raising the uniform scale (a per-axis
    // floor would break the aspect ratio the whole function exists to keep).
    s = Math.max(s, PANEL_MM_MIN / nw, PANEL_MM_MIN / nh);
    return { width_mm: roundMm(nw * s), height_mm: roundMm(nh * s) };
  }
  // Position clamp: keep the panel's top-left inside [0, canvas − panel] on
  // each axis. NOT clampCanvasMm — that is a SIZE clamp whose 20mm floor would
  // shove near-canvas-width panels off the sheet.
  function clampPosMm(pos: number, panelMm: number, canvasMm: number): number {
    return roundMm(Math.max(0, Math.min(pos, canvasMm - panelMm)));
  }
  async function handlePick(fig: FigureListItem, opts: { copy: boolean }) {
    setPickerOpen(false);
    if (!canvas) return;
    let figureId = fig.id;
    if (opts.copy) {
      // Canvas-only copy (grilling Q1-b): duplicate the figure and place the
      // copy — edits inside this canvas never touch the original figure or
      // other canvases that reference it.
      const copying = toast.loading('Copying figure…');
      try {
        const dup = await duplicateFigure(fig.id);
        figureId = dup.id;
        toast.dismiss(copying);
      } catch {
        toast.dismiss(copying);
        toast.error('Could not copy the figure');
        return;
      }
    }
    const { width_mm, height_mm } = fig.native_width_mm && fig.native_height_mm
      ? fitToCanvasMm(fig.native_width_mm, fig.native_height_mm)
      : { width_mm: 60, height_mm: 45 };
    const n = panels.length;
    // Stagger new panels so they don't stack exactly, kept inside the canvas.
    const x_mm = clampPosMm(10 + (n % 4) * 8, width_mm, canvas.width_mm);
    const y_mm = clampPosMm(10 + (n % 4) * 8, height_mm, canvas.height_mm);
    addPanel.mutate({
      data: {
        figure_id: figureId,
        x_mm: roundMm(x_mm),
        y_mm: roundMm(y_mm),
        width_mm,
        height_mm,
        z_order: (Math.max(0, ...panels.map((p) => p.z_order)) || 0) + 1,
        label: nextLabel(panels),
      },
      record: true,
    });
  }

  // ── wheel: scroll pans, pinch / Ctrl(Cmd)+wheel zooms (Figma convention) ──
  // Browsers emit trackpad pinch as wheel events with ctrlKey=true and
  // two-finger scroll as plain wheel — that's the only reliable way to tell
  // them apart. Mouse users zoom with Ctrl+wheel or the ± toolbar buttons.
  function handleWheel(e: Konva.KonvaEventObject<WheelEvent>) {
    e.evt.preventDefault(); // also stops browser page-zoom on ctrl+wheel
    const stage = e.target.getStage();
    if (!stage) return;
    // Normalize delta: deltaMode 1 = lines (Firefox), 2 = pages.
    const unit = e.evt.deltaMode === 1 ? 16 : e.evt.deltaMode === 2 ? viewport.h : 1;
    const dx = e.evt.deltaX * unit;
    const dy = e.evt.deltaY * unit;
    if (e.evt.ctrlKey || e.evt.metaKey) {
      // Zoom toward the pointer. exp() makes speed proportional to gesture
      // magnitude (a fixed per-event factor compounds runaway fast at pinch's
      // 30-60 events/sec); the per-event clamp guards inertial spikes.
      // Functional update: pinch streams outpace re-renders, so consecutive
      // events must accumulate on the latest view, not a stale closure.
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      const factor = Math.min(1.25, Math.max(0.8, Math.exp(-dy * 0.002)));
      setView((v) => {
        const newScale = Math.min(8, Math.max(0.15, v.zoom * factor));
        const pointTo = { x: (pointer.x - v.x) / v.zoom, y: (pointer.y - v.y) / v.zoom };
        return { zoom: newScale, x: pointer.x - pointTo.x * newScale, y: pointer.y - pointTo.y * newScale };
      });
    } else {
      // Plain wheel = two-finger trackpad scroll (or mouse wheel) → pan.
      setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
    }
  }
  function zoomBy(factor: number) {
    const oldScale = view.zoom;
    const newScale = Math.min(8, Math.max(0.15, oldScale * factor));
    // Zoom toward the viewport center.
    const cx = viewport.w / 2;
    const cy = viewport.h / 2;
    const pointTo = { x: (cx - view.x) / oldScale, y: (cy - view.y) / oldScale };
    setView({ zoom: newScale, x: cx - pointTo.x * newScale, y: cy - pointTo.y * newScale });
  }
  // U9: '1' shortcut — snap to exactly 100%, anchored at the viewport center
  // (same anchor convention as zoomBy/the toolbar ± buttons).
  function zoomTo100() {
    if (!viewport.w || !viewport.h) return;
    const oldScale = view.zoom;
    const cx = viewport.w / 2;
    const cy = viewport.h / 2;
    const pointTo = { x: (cx - view.x) / oldScale, y: (cy - view.y) / oldScale };
    setView({ zoom: 1, x: cx - pointTo.x, y: cy - pointTo.y });
  }
  // U9: Shift+2 — zoom to fit the union bbox of the current selection (panels
  // + annotations) with a ~40px margin; no-op when nothing is selected (or
  // the selection resolves to nothing, e.g. a stale id mid-delete).
  function zoomToSelection() {
    if (selectedIds.length === 0 || !viewport.w || !viewport.h) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of selectedIds) {
      const p = panels.find((pp) => pp.id === id);
      if (p) {
        const px0 = mmToPx(p.x_mm, pxPerMm);
        const py0 = mmToPx(p.y_mm, pxPerMm);
        x0 = Math.min(x0, px0);
        y0 = Math.min(y0, py0);
        x1 = Math.max(x1, px0 + mmToPx(p.width_mm, pxPerMm));
        y1 = Math.max(y1, py0 + mmToPx(p.height_mm, pxPerMm));
        continue;
      }
      const a = annotations.find((aa) => aa.id === id);
      if (!a) continue;
      const box = annotationBoxPx(a, pxPerMm, measuredTextRef.current.get(a.id));
      x0 = Math.min(x0, box.x0);
      y0 = Math.min(y0, box.y0);
      x1 = Math.max(x1, box.x1);
      y1 = Math.max(y1, box.y1);
    }
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return;
    const marginPx = 40;
    const bw = Math.max(1e-3, x1 - x0);
    const bh = Math.max(1e-3, y1 - y0);
    const availW = Math.max(1, viewport.w - marginPx * 2);
    const availH = Math.max(1, viewport.h - marginPx * 2);
    const newZoom = Math.min(8, Math.max(0.15, Math.min(availW / bw, availH / bh)));
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    setView({ zoom: newZoom, x: viewport.w / 2 - cx * newZoom, y: viewport.h / 2 - cy * newZoom });
  }
  useEffect(() => {
    zoomTo100Ref.current = zoomTo100;
  });
  useEffect(() => {
    zoomToSelectionRef.current = zoomToSelection;
  });

  // ── U7 4/5a: panel selection ──
  // Shift+click toggles membership; a plain click selects only that panel —
  // EXCEPT mousedown on a panel that's already part of a multi-selection must
  // NOT collapse the selection (the user may be about to drag the whole group).
  // That collapse instead happens in handlePanelClick, which only runs for a
  // genuine click (no intervening drag — see dragMovedRef).
  function handlePanelMouseDown(panel: CanvasPanel, e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) {
    dragMovedRef.current = false;
    setPointerGestureActive(true); // see the state's docblock (layout-shift teleport)
    const shift = 'shiftKey' in e.evt && e.evt.shiftKey;
    if (shift) {
      // Shift semantics (F5): ADD immediately (enables shift+drag-into-group);
      // REMOVAL is deferred to the click so shift+drag on a selected member
      // keeps it in the group instead of tearing it out at mousedown.
      setSelectedIds((cur) => {
        if (cur.includes(panel.id)) {
          shiftDeferredRef.current = panel.id;
          return cur;
        }
        shiftDeferredRef.current = null;
        return [...cur, panel.id];
      });
      return;
    }
    shiftDeferredRef.current = null;
    setSelectedIds((cur) => (cur.includes(panel.id) && cur.length > 1 ? cur : [panel.id]));
  }
  function handlePanelClick(panel: CanvasPanel, e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) {
    // Konva fires 'click' whenever pointerup lands back on the shape it started
    // on — including right after a real drag-release — so dragMovedRef (set on
    // dragstart, which only fires once Konva's own dragDistance is exceeded) is
    // what actually distinguishes a genuine click from a completed drag.
    if (dragMovedRef.current) {
      dragMovedRef.current = false;
      shiftDeferredRef.current = null; // a real drag keeps membership
      return;
    }
    const shift = 'shiftKey' in e.evt && e.evt.shiftKey;
    if (shift) {
      // Deferred shift-removal (F5): a genuine shift+click on an already-
      // selected member removes it here, after we know no drag happened.
      if (shiftDeferredRef.current === panel.id) {
        setSelectedIds((cur) => cur.filter((id) => id !== panel.id));
      }
      shiftDeferredRef.current = null;
      return;
    }
    setSelectedIds([panel.id]);
  }
  function handlePanelDragStart(panel: CanvasPanel) {
    dragMovedRef.current = true;
    shiftDeferredRef.current = null; // a drag keeps shift-clicked membership
    void flushNudge(); // pending nudge must not fire mid-drag and revert it
    // U7 5a / U8: dragging an item that's part of a multi-selection moves the
    // whole group (now possibly mixed panels+annotations) — see beginGroupMove.
    beginGroupMove(panel.id);
  }

  // ── U8: annotation selection — mirrors handlePanelMouseDown/Click/DragStart
  // exactly (shared selectedIds, same shift-defer / group-move semantics). ──
  function handleAnnotationMouseDown(ann: CanvasAnnotation, e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) {
    dragMovedRef.current = false;
    setPointerGestureActive(true); // see the state's docblock (layout-shift teleport)
    const shift = 'shiftKey' in e.evt && e.evt.shiftKey;
    if (shift) {
      setSelectedIds((cur) => {
        if (cur.includes(ann.id)) {
          shiftDeferredRef.current = ann.id;
          return cur;
        }
        shiftDeferredRef.current = null;
        return [...cur, ann.id];
      });
      return;
    }
    shiftDeferredRef.current = null;
    setSelectedIds((cur) => (cur.includes(ann.id) && cur.length > 1 ? cur : [ann.id]));
  }
  function handleAnnotationClick(ann: CanvasAnnotation, e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) {
    if (dragMovedRef.current) {
      dragMovedRef.current = false;
      shiftDeferredRef.current = null;
      return;
    }
    const shift = 'shiftKey' in e.evt && e.evt.shiftKey;
    if (shift) {
      if (shiftDeferredRef.current === ann.id) {
        setSelectedIds((cur) => cur.filter((id) => id !== ann.id));
      }
      shiftDeferredRef.current = null;
      return;
    }
    setSelectedIds([ann.id]);
  }
  function handleAnnotationDragStart(ann: CanvasAnnotation) {
    dragMovedRef.current = true;
    shiftDeferredRef.current = null;
    void flushNudge();
    flushAnnotationEdit();
    beginGroupMove(ann.id);
  }
  function handleAnnotationDblClick(ann: CanvasAnnotation) {
    if (ann.type !== 'text') return;
    setSelectedIds([ann.id]);
    textEditCancelRef.current = false; // disarm a leftover cancel flag (see ref docblock)
    setTextEditing({ id: ann.id, value: ann.text ?? '' });
  }
  /** Escape-path discard. Unmounting the focused input fires NO blur (see
   * textEditCancelRef docblock), so commitTextEditing's onBlur never runs
   * once textEditing flips to null — everything must happen here, now. A
   * fresh (local-only) annotation is removed outright; the server never saw
   * it. */
  function cancelTextEditing() {
    const freshId = freshTextIdRef.current;
    freshTextIdRef.current = null;
    textEditCancelRef.current = true;
    setTextEditing(null);
    if (freshId) removeLocalAnnotation(freshId);
  }
  /** Remove a never-persisted (fresh, local-cache-only) annotation without
   * any server call or history entry — the server never saw it. */
  function removeLocalAnnotation(id: string) {
    qc.setQueryData<CanvasDetail>(queryKey, (old) => (old
      ? { ...old, annotations: old.annotations.filter((a) => a.id !== id) }
      : old));
    setSelectedIds((cur) => cur.filter((sel) => sel !== id));
  }
  function commitTextEditing() {
    const freshId = freshTextIdRef.current;
    freshTextIdRef.current = null;
    if (textEditCancelRef.current) {
      // Escape already discarded this session — ignore a possible stray
      // blur from the input being unmounted while still focused. A FRESH
      // annotation is local-only, so discarding means removing it outright.
      textEditCancelRef.current = false;
      setTextEditing(null);
      if (freshId) removeLocalAnnotation(freshId);
      return;
    }
    const te = textEditing;
    setTextEditing(null);
    if (!te) return;
    const isFresh = freshId === te.id;
    const ann = annotations.find((a) => a.id === te.id);
    if (!ann) return;
    const trimmed = sanitizeText(te.value).trim();
    if (!trimmed) {
      // An empty text box is pointless clutter (and fails the backend's
      // "text required" validation). Fresh → pure local removal (nothing was
      // ever persisted); existing → real delete commit.
      if (isFresh) removeLocalAnnotation(te.id);
      else deleteAnnotationIds([te.id]);
      return;
    }
    const value = sanitizeText(te.value);
    if (isFresh) {
      // First commit of a freshly-placed text annotation: ONE history entry
      // whose `before` is the pre-creation array, so a single Ctrl+Z removes
      // the annotation entirely (not "revert to placeholder"). Bypasses
      // commitAnnotations because the live cache already contains the fresh
      // item — `before` must exclude it.
      flushAnnotationEdit();
      const live = qc.getQueryData<CanvasDetail>(queryKey)?.annotations ?? annotations;
      const before = live.filter((a) => a.id !== te.id);
      const after = live.map((a) => (a.id === te.id ? { ...a, text: value } : a));
      patchAnnotations.mutate({ data: { annotations: after }, history: { before, after, label: 'add text' } });
      return;
    }
    if (value === (ann.text ?? '')) return;
    commitAnnotations((cur) => cur.map((a) => (a.id === te.id ? { ...a, text: value } : a)), 'edit text');
  }

  // ── U7 2: rubber-band select (replaces empty-drag pan; Space+drag or scroll
  // still pans — see the Stage's `draggable={spaceHeld}`). Marquee state is in
  // CANVAS ("fit px") coordinates, same space as panel x/y, for a plain AABB
  // hit test against panels (and, U8, annotations too). ──
  function updateMarquee(m: { x0: number; y0: number; x1: number; y1: number } | null) {
    marqueeRef.current = m;
    setMarquee(m);
  }

  // ── U8: shape/line/arrow creation drag (same coordinate space + window-
  // mouseup-fallback convention as the marquee above) and text-tool
  // click-to-create. ──
  function updateDrawing(d: typeof drawing) {
    drawingRef.current = d;
    setDrawing(d);
  }
  function createTextAt(xFit: number, yFit: number) {
    const x_mm = roundMm(pxToMm(xFit, pxPerMm));
    const y_mm = roundMm(pxToMm(yFit, pxPerMm));
    const ann = createAnnotation('text', { x_mm, y_mm }, nextAnnotationZ(annotations));
    // LOCAL-only optimistic insert — no PATCH, no history. The annotation is
    // persisted as ONE 'add text' entry when the inline editor commits real
    // text (see commitTextEditing), so a single undo removes it; Escape or
    // an empty commit silently drops it without the server ever seeing it.
    // Blur resolves the fresh state before any other gesture can commit (all
    // other mutations fire on mouseup/dragend, after the input's blur).
    flushAnnotationEdit();
    // An in-flight refetch (e.g. the visibilitychange invalidate near the top
    // of the component) would resolve over this local-only insert and wipe
    // it — cancel it first, same guard patchAnnotations.onMutate uses.
    void qc.cancelQueries({ queryKey });
    textEditCancelRef.current = false; // disarm a leftover cancel flag (see ref docblock)
    freshTextIdRef.current = ann.id;
    qc.setQueryData<CanvasDetail>(queryKey, (old) => (old
      ? { ...old, annotations: [...old.annotations, ann] }
      : old));
    setActiveTool('select');
    setSelectedIds([ann.id]);
    setTextEditing({ id: ann.id, value: '' });
  }
  function finalizeDrawing() {
    const d = drawingRef.current;
    updateDrawing(null);
    if (!d || !canvas) return;
    if (d.type === 'line' || d.type === 'arrow') {
      const x1mm = pxToMm(d.x0, pxPerMm);
      const y1mm = pxToMm(d.y0, pxPerMm);
      const x2mm = pxToMm(d.x1, pxPerMm);
      const y2mm = pxToMm(d.y1, pxPerMm);
      // Straight-line distance, not the AABB box — a purely horizontal/
      // vertical drag has a zero-height/width bbox and would always fail a
      // box-based minimum check.
      if (Math.hypot(x2mm - x1mm, y2mm - y1mm) < MIN_CREATE_DRAG_MM) return;
      const ann = createAnnotation(d.type, {
        x_mm: 0, y_mm: 0,
        points_mm: [roundMm(x1mm), roundMm(y1mm), roundMm(x2mm), roundMm(y2mm)],
      }, nextAnnotationZ(annotations));
      commitAnnotations((cur) => [...cur, ann], `add ${ann.type}`);
      setActiveTool('select');
      setSelectedIds([ann.id]);
      return;
    }
    const x0mm = pxToMm(Math.min(d.x0, d.x1), pxPerMm);
    const y0mm = pxToMm(Math.min(d.y0, d.y1), pxPerMm);
    const wmm = pxToMm(Math.abs(d.x1 - d.x0), pxPerMm);
    const hmm = pxToMm(Math.abs(d.y1 - d.y0), pxPerMm);
    if (wmm < MIN_CREATE_DRAG_MM || hmm < MIN_CREATE_DRAG_MM) return;
    const ann = createAnnotation(d.type, {
      x_mm: roundMm(x0mm), y_mm: roundMm(y0mm), w_mm: roundMm(wmm), h_mm: roundMm(hmm),
    }, nextAnnotationZ(annotations));
    commitAnnotations((cur) => [...cur, ann], `add ${ann.type}`);
    setActiveTool('select');
    setSelectedIds([ann.id]);
  }

  function handleStageMouseDown(e: Konva.KonvaEventObject<MouseEvent>) {
    const stage = e.target.getStage();
    if (!stage || e.target !== stage) return; // a panel/annotation handles its own selection
    if (spaceHeld) return; // Stage is draggable (pan) instead in this mode
    if (e.evt.button !== 0) return; // right/middle button must not arm a marquee/drawing
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    const xFit = (pointer.x - view.x) / view.zoom;
    const yFit = (pointer.y - view.y) / view.zoom;
    if (activeTool === 'text') {
      // The inline editor mounts+autofocuses DURING this mousedown dispatch;
      // without this, the browser's mousedown DEFAULT action (moving focus to
      // the click target / body) runs after the handler returns and instantly
      // blurs the input — the empty-value blur commit then removes the fresh
      // annotation before the user ever sees it.
      e.evt.preventDefault();
      createTextAt(xFit, yFit);
      return;
    }
    if (activeTool !== 'select') {
      updateDrawing({ type: activeTool, x0: xFit, y0: yFit, x1: xFit, y1: yFit });
      return;
    }
    marqueeShiftRef.current = e.evt.shiftKey;
    updateMarquee({ x0: xFit, y0: yFit, x1: xFit, y1: yFit });
  }
  function handleStageMouseMove(e: Konva.KonvaEventObject<MouseEvent>) {
    if (drawingRef.current) {
      // Missed release, same fallback as the marquee below.
      if (e.evt.buttons === 0) { finalizeDrawing(); return; }
      const stage = e.target.getStage();
      if (!stage) return;
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      const xFit = (pointer.x - view.x) / view.zoom;
      const yFit = (pointer.y - view.y) / view.zoom;
      updateDrawing(drawingRef.current ? { ...drawingRef.current, x1: xFit, y1: yFit } : null);
      return;
    }
    if (!marquee) return;
    // Missed release (mouseup landed outside the browser/stage): Konva only
    // delivers stage mouseup for in-stage releases, so treat a button-less
    // move as the release we never got.
    if (e.evt.buttons === 0) {
      finalizeMarquee();
      return;
    }
    const stage = e.target.getStage();
    if (!stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    const x = (pointer.x - view.x) / view.zoom;
    const y = (pointer.y - view.y) / view.zoom;
    updateMarquee(marqueeRef.current ? { ...marqueeRef.current, x1: x, y1: y } : null);
  }
  function finalizeMarquee() {
    const m = marqueeRef.current;
    if (!m) return;
    const x0 = Math.min(m.x0, m.x1);
    const x1 = Math.max(m.x0, m.x1);
    const y0 = Math.min(m.y0, m.y1);
    const y1 = Math.max(m.y0, m.y1);
    updateMarquee(null);
    // Click-vs-drag threshold in SCREEN px (constant feel at any zoom, same
    // convention as SNAP_PX) — fit-px would range ~0.6-32 screen px.
    if ((x1 - x0) * view.zoom < 4 && (y1 - y0) * view.zoom < 4) {
      // Too small to be an intentional rubber-band — plain click on empty
      // space, same as before U7: deselect.
      setSelectedIds([]);
      return;
    }
    const hitPanelIds = panels
      .filter((p) => {
        const px0 = mmToPx(p.x_mm, pxPerMm);
        const py0 = mmToPx(p.y_mm, pxPerMm);
        const px1 = px0 + mmToPx(p.width_mm, pxPerMm);
        const py1 = py0 + mmToPx(p.height_mm, pxPerMm);
        return px0 < x1 && px1 > x0 && py0 < y1 && py1 > y0;
      })
      .map((p) => p.id);
    // U8: annotations join the marquee hit test using their bounding box.
    const hitAnnoIds = annotations
      .filter((a) => {
        const box = annotationBoxPx(a, pxPerMm, measuredTextRef.current.get(a.id));
        return box.x0 < x1 && box.x1 > x0 && box.y0 < y1 && box.y1 > y0;
      })
      .map((a) => a.id);
    const hitIds = [...hitPanelIds, ...hitAnnoIds];
    setSelectedIds((cur) => (marqueeShiftRef.current ? Array.from(new Set([...cur, ...hitIds])) : hitIds));
  }
  function handleStageMouseUp() {
    if (drawingRef.current) { finalizeDrawing(); return; }
    finalizeMarquee();
  }
  function handleStageDragMove(e: Konva.KonvaEventObject<DragEvent>) {
    // Same guard as handleStageDragEnd: panel/annotation drags bubble here
    // too — only the Stage's own pan may write the view. Live sync keeps the
    // U9 rulers and the grid's visible-range culling tracking the pan instead
    // of freezing until dragend. No rAF throttle needed: the wheel path
    // already does per-event setView by design, and re-applying the stage's
    // own current position can't fight the in-progress drag.
    const stage = e.target.getStage();
    if (e.target !== stage || !stage) return;
    setView((v) => ({ ...v, x: stage.x(), y: stage.y() }));
  }
  function handleStageDragEnd(e: Konva.KonvaEventObject<DragEvent>) {
    // Only the Stage's own pan updates the view (panel drags bubble here too).
    const stage = e.target.getStage();
    if (e.target !== stage || !stage) return;
    setView((v) => ({ ...v, x: stage.x(), y: stage.y() }));
  }

  // U8: a panel is always Transformer-eligible; an annotation is eligible
  // unless it's a line/arrow (those get draggable endpoint handles instead —
  // see the Circle handles rendered near the Transformer in the JSX below).
  function isTransformerEligible(id: string): boolean {
    if (panels.some((p) => p.id === id)) return true;
    const a = annotations.find((aa) => aa.id === id);
    return Boolean(a && a.type !== 'line' && a.type !== 'arrow');
  }

  // ── U8: simpler resize bound box for any selection touching an annotation —
  // deliberately WITHOUT the panel path's snap-to-target machinery (kept
  // isolated below to avoid entangling the two): just a size floor, plus a
  // locked height for an all-text selection (text resizes WIDTH only). ──
  function annotationResizeBoundBox(
    oldBox: { x: number; y: number; width: number; height: number; rotation: number },
    newBox: { x: number; y: number; width: number; height: number; rotation: number },
    eligibleIds: string[],
  ): { x: number; y: number; width: number; height: number; rotation: number } {
    if (guides.x !== null || guides.y !== null) setGuides({ x: null, y: null });
    const minPx = mmToPx(ANNOTATION_MM_MIN, pxPerMm) * view.zoom;
    const allText = eligibleIds.length > 0
      && eligibleIds.every((id) => annotations.find((a) => a.id === id)?.type === 'text');
    if (allText) {
      // Width-only: lock the box's height/y to whatever they were before this
      // transform frame regardless of which anchor fired (enabledAnchors
      // already restricts to middle-left/right for an all-text selection —
      // this is a defensive backstop against float drift).
      const width = Math.max(newBox.width, minPx);
      return { ...newBox, width, height: oldBox.height, y: oldBox.y };
    }
    if (newBox.width < minPx || newBox.height < minPx) return oldBox;
    return newBox;
  }

  // ── U7 6: resize snap guides — same target set + threshold as drag-move,
  // applied to the MOVING edge(s) inside the Transformer's boundBoxFunc. Box
  // coordinates there are stage/screen space (already zoom+pan applied); the
  // math below works in the same "fit px" space as handleDragMove and converts
  // back to screen space (*zoom + view offset) only for the returned box. ──
  function resizeBoundBox(
    oldBox: { x: number; y: number; width: number; height: number; rotation: number },
    newBox: { x: number; y: number; width: number; height: number; rotation: number },
  ): { x: number; y: number; width: number; height: number; rotation: number } {
    const eligibleIds = selectedIds.filter(isTransformerEligible);
    if (eligibleIds.some((id) => annotations.some((a) => a.id === id))) {
      return annotationResizeBoundBox(oldBox, newBox, eligibleIds);
    }
    // F4: for group transforms the floor is the union box at which the
    // smallest member reaches PANEL_MM_MIN (captured per-gesture), not the
    // flat single-panel minimum.
    const minW = (groupMinBoxRef.current ? mmToPx(groupMinBoxRef.current.w, pxPerMm) : mmToPx(PANEL_MM_MIN, pxPerMm)) * view.zoom;
    const minH = (groupMinBoxRef.current ? mmToPx(groupMinBoxRef.current.h, pxPerMm) : mmToPx(PANEL_MM_MIN, pxPerMm)) * view.zoom;
    if (newBox.width < minW || newBox.height < minH) return oldBox;
    // Never snap a multi-node (group) transform, and nothing to snap against
    // without a canvas.
    if (!canvas || selectedIds.length !== 1 || altHeldRef.current) {
      if (guides.x !== null || guides.y !== null) setGuides({ x: null, y: null });
      return newBox;
    }
    const thr = SNAP_PX / view.zoom;
    const cw = mmToPx(canvas.width_mm, pxPerMm);
    const ch = mmToPx(canvas.height_mm, pxPerMm);
    const others = panels.filter((p) => p.id !== selectedIds[0]);
    // U9: grid lines join the resize snap targets when grid-snap is on.
    const gridX = gridSnapEnabled ? gridSnapTargetsPx(canvas.width_mm, pxPerMm) : [];
    const gridY = gridSnapEnabled ? gridSnapTargetsPx(canvas.height_mm, pxPerMm) : [];
    const xTargets = [0, cw, cw / 2, ...gridX, ...others.flatMap((p) => {
      const px = mmToPx(p.x_mm, pxPerMm);
      const pw = mmToPx(p.width_mm, pxPerMm);
      return [px, px + pw, px + pw / 2];
    })];
    const yTargets = [0, ch, ch / 2, ...gridY, ...others.flatMap((p) => {
      const py = mmToPx(p.y_mm, pxPerMm);
      const ph = mmToPx(p.height_mm, pxPerMm);
      return [py, py + ph, py + ph / 2];
    })];

    let xFit = (newBox.x - view.x) / view.zoom;
    let yFit = (newBox.y - view.y) / view.zoom;
    let wFit = newBox.width / view.zoom;
    let hFit = newBox.height / view.zoom;
    const oldXFit = (oldBox.x - view.x) / view.zoom;
    const oldYFit = (oldBox.y - view.y) / view.zoom;
    const oldWFit = oldBox.width / view.zoom;
    const oldHFit = oldBox.height / view.zoom;

    const leftMoved = Math.abs(xFit - oldXFit) > 1e-4;
    const rightMoved = Math.abs(xFit + wFit - (oldXFit + oldWFit)) > 1e-4;
    const topMoved = Math.abs(yFit - oldYFit) > 1e-4;
    const bottomMoved = Math.abs(yFit + hFit - (oldYFit + oldHFit)) > 1e-4;

    // F3: a locked-ratio CORNER drag moves both axes together; snapping one
    // axis independently would silently break the aspect the lock promises.
    // Skip snapping for that case (guides off) rather than fight keepRatio.
    if (lockAspect && (leftMoved || rightMoved) && (topMoved || bottomMoved)) {
      if (guides.x !== null || guides.y !== null) setGuides({ x: null, y: null });
      return newBox;
    }

    let guideX: number | null = null;
    let guideY: number | null = null;

    if (leftMoved) {
      const right = xFit + wFit;
      let best: { d: number; t: number } | null = null;
      for (const t of xTargets) {
        const d = Math.abs(xFit - t);
        if (d <= thr && (!best || d < best.d)) best = { d, t };
      }
      if (best) { xFit = best.t; wFit = right - xFit; guideX = best.t; }
    } else if (rightMoved) {
      let best: { d: number; t: number } | null = null;
      for (const t of xTargets) {
        const d = Math.abs(xFit + wFit - t);
        if (d <= thr && (!best || d < best.d)) best = { d, t };
      }
      if (best) { wFit = best.t - xFit; guideX = best.t; }
    }

    if (topMoved) {
      const bottom = yFit + hFit;
      let best: { d: number; t: number } | null = null;
      for (const t of yTargets) {
        const d = Math.abs(yFit - t);
        if (d <= thr && (!best || d < best.d)) best = { d, t };
      }
      if (best) { yFit = best.t; hFit = bottom - yFit; guideY = best.t; }
    } else if (bottomMoved) {
      let best: { d: number; t: number } | null = null;
      for (const t of yTargets) {
        const d = Math.abs(yFit + hFit - t);
        if (d <= thr && (!best || d < best.d)) best = { d, t };
      }
      if (best) { hFit = best.t - yFit; guideY = best.t; }
    }

    setGuides({ x: guideX, y: guideY });

    const snapped = {
      x: xFit * view.zoom + view.x,
      y: yFit * view.zoom + view.y,
      width: wFit * view.zoom,
      height: hFit * view.zoom,
      rotation: newBox.rotation,
    };
    // A snap that would push below the min-size floor is dropped in favor of
    // the un-snapped (but still legal) box, rather than freezing the gesture.
    if (snapped.width < minW || snapped.height < minH) return newBox;
    return snapped;
  }
  // U7 8: (re)arm the group-resize batch counter at the start of every
  // transform gesture — see the accumulation logic in handleTransformEnd.
  function handleTransformStart() {
    void flushNudge();
    flushAnnotationEdit();
    // U8: the real "last one in" threshold is the ELIGIBLE count — line/arrow
    // annotations never attach to the Transformer, so selectedIds.length would
    // overcount and the group commit would wait forever for a transformend
    // that never fires.
    const eligibleIds = selectedIds.filter(isTransformerEligible);
    groupResizeActiveRef.current = eligibleIds.length > 1;
    groupResizeItemsRef.current = [];
    groupResizeAnnotationItemsRef.current = [];
    groupResizeEligibleCountRef.current = eligibleIds.length;
    groupResizeSeenRef.current = 0;
    // F4: the union min-size floor for a group resize must scale so the
    // SMALLEST member never squeezes below PANEL_MM_MIN (a flat union floor
    // lets individual panels go sub-minimum and commit mismatched geometry).
    // (Only meaningful for an all-panel group — a group touching an
    // annotation routes through annotationResizeBoundBox instead, which
    // never reads groupMinBoxRef.)
    if (eligibleIds.length > 1) {
      const sel = eligibleIds.map((id) => panels.find((p) => p.id === id)).filter((p): p is CanvasPanel => Boolean(p));
      if (sel.length > 1) {
        const minX = Math.min(...sel.map((p) => p.x_mm));
        const maxX = Math.max(...sel.map((p) => p.x_mm + p.width_mm));
        const minY = Math.min(...sel.map((p) => p.y_mm));
        const maxY = Math.max(...sel.map((p) => p.y_mm + p.height_mm));
        const wMin = Math.min(...sel.map((p) => p.width_mm));
        const hMin = Math.min(...sel.map((p) => p.height_mm));
        groupMinBoxRef.current = {
          w: ((maxX - minX) * PANEL_MM_MIN) / Math.max(wMin, PANEL_MM_MIN),
          h: ((maxY - minY) * PANEL_MM_MIN) / Math.max(hMin, PANEL_MM_MIN),
        };
      } else groupMinBoxRef.current = null;
    } else groupMinBoxRef.current = null;
  }

  // ── canvas rename / size ──
  function startRename() {
    setNameDraft(canvas?.name ?? '');
    setRenamingCanvas(true);
  }
  function commitRename() {
    const name = nameDraft.trim();
    setRenamingCanvas(false);
    if (name && name !== canvas?.name) patchCanvas.mutate({ data: { name } });
  }
  function commitSize() {
    if (!canvas) return;
    const width_mm = clampCanvasMm(Number(sizeDraft.w));
    const height_mm = clampCanvasMm(Number(sizeDraft.h));
    if (!Number.isFinite(width_mm) || !Number.isFinite(height_mm)) return;
    if (width_mm === canvas.width_mm && height_mm === canvas.height_mm) return;
    const after = { width_mm: roundMm(width_mm), height_mm: roundMm(height_mm) };
    patchCanvas.mutate({
      data: after,
      history: { before: { width_mm: canvas.width_mm, height_mm: canvas.height_mm }, after },
    });
  }
  useEffect(() => {
    if (canvas) setSizeDraft({ w: String(roundMm(canvas.width_mm)), h: String(roundMm(canvas.height_mm)) });
  }, [canvas?.width_mm, canvas?.height_mm, canvas]);

  // ── render states ──
  if (isLoading) {
    return <div className="flex flex-1 items-center justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }
  if (isError || !canvas) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
        <p className="text-sm text-muted-foreground">This canvas could not be loaded.</p>
        <Link href="/canvases" className="text-sm text-primary hover:underline">Back to canvases</Link>
      </div>
    );
  }

  const transparent = canvas.background === 'transparent';
  const canvasWpx = mmToPx(canvas.width_mm, pxPerMm);
  const canvasHpx = mmToPx(canvas.height_mm, pxPerMm);

  // Screen-space rect of the selected panel (fit-px × zoom + pan) so the color
  // editor can lay its inline-SVG overlay exactly over the konva panel raster.
  const overlayRect = selectedPanel
    ? {
        left: view.x + mmToPx(selectedPanel.x_mm, pxPerMm) * view.zoom,
        top: view.y + mmToPx(selectedPanel.y_mm, pxPerMm) * view.zoom,
        width: mmToPx(selectedPanel.width_mm, pxPerMm) * view.zoom,
        height: mmToPx(selectedPanel.height_mm, pxPerMm) * view.zoom,
      }
    : null;

  // U8: selection composition drives the toolbar/sidebar below.
  const isAnnotationOnlySelection = selectedAnnotationIds.length > 0 && selectedPanelIds.length === 0;
  const isMixedSelection = selectedPanelIds.length > 0 && selectedAnnotationIds.length > 0;
  // Text-only selection (single or multi) resizes WIDTH only via the shared
  // Transformer — everything else keeps the full 8-anchor set.
  const transformEligibleIds = selectedIds.filter((id) => panels.some((p) => p.id === id)
    || annotations.some((a) => a.id === id && a.type !== 'line' && a.type !== 'arrow'));
  const textOnlyTransform = transformEligibleIds.length > 0
    && transformEligibleIds.every((id) => annotations.find((a) => a.id === id)?.type === 'text');
  const transformerAnchors: string[] = textOnlyTransform
    ? ['middle-left', 'middle-right']
    : ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'middle-left', 'middle-right', 'top-center', 'bottom-center'];

  // Sole-selected line/arrow annotation → render draggable endpoint handles
  // instead of the Transformer (which excludes them — see isTransformerEligible).
  const soleLineLikeAnnotation = selectedIds.length === 1
    ? annotations.find((a) => a.id === selectedIds[0] && (a.type === 'line' || a.type === 'arrow'))
    : undefined;

  // Inline text-edit overlay: screen-space position over the annotation being edited.
  const textEditingAnn = textEditing ? annotations.find((a) => a.id === textEditing.id) : null;
  const textEditRect = textEditingAnn
    ? (() => {
        const o = originMm(textEditingAnn);
        const s = sizeMm(textEditingAnn, measuredTextRef.current.get(textEditingAnn.id));
        return {
          left: view.x + mmToPx(o.x, pxPerMm) * view.zoom,
          top: view.y + mmToPx(o.y, pxPerMm) * view.zoom,
          width: Math.max(mmToPx(s.w_mm, pxPerMm) * view.zoom, 60),
          fontSizePx: Math.max(10, annPtToMm(textEditingAnn.font_pt ?? ANN_FONT_PT_DEFAULT) * pxPerMm * view.zoom),
        };
      })()
    : null;

  return (
    <div className="flex flex-1 flex-col">
      {/* top bar */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2">
        <div className="mr-1 flex items-center gap-1 text-sm text-muted-foreground">
          <Link href="/canvases" className="hover:underline">Canvases</Link><span>/</span>
          {canvas.project_id && (
            <>
              <Link href={`/projects/${canvas.project_id}`} className="flex items-center gap-1 hover:underline" title="Open the project this canvas belongs to">
                <FlaskConical className="h-3.5 w-3.5" />
                {projects?.find((p) => p.id === canvas.project_id)?.name ?? 'Project'}
              </Link>
              <span>/</span>
            </>
          )}
        </div>
        {renamingCanvas ? (
          <span className="flex items-center gap-1">
            <Input
              autoFocus
              className="h-7 w-56"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') setRenamingCanvas(false); }}
              onBlur={commitRename}
              aria-label="Canvas name"
            />
            <Button type="button" size="icon-sm" variant="ghost" onClick={commitRename}><Check className="h-4 w-4" /></Button>
          </span>
        ) : (
          <button type="button" className="flex items-center gap-1.5 font-semibold hover:underline" onClick={startRename}>
            {canvas.name}
            <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <Label htmlFor="canvas-w" className="text-xs text-muted-foreground">W</Label>
            <Input
              id="canvas-w"
              className="h-7 w-16"
              type="number"
              value={sizeDraft.w}
              onChange={(e) => setSizeDraft((s) => ({ ...s, w: e.target.value }))}
              onBlur={commitSize}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              aria-label="Canvas width in mm"
            />
            <Label htmlFor="canvas-h" className="text-xs text-muted-foreground">H</Label>
            <Input
              id="canvas-h"
              className="h-7 w-16"
              type="number"
              value={sizeDraft.h}
              onChange={(e) => setSizeDraft((s) => ({ ...s, h: e.target.value }))}
              onBlur={commitSize}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              aria-label="Canvas height in mm"
            />
            <span className="text-xs text-muted-foreground">mm</span>
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              onClick={() => applyHistory('undo')}
              disabled={!history.canUndo || applyingHistory}
              aria-label="Undo"
              title="Undo (Ctrl/Cmd+Z)"
            >
              <Undo2 className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              onClick={() => applyHistory('redo')}
              disabled={!history.canRedo || applyingHistory}
              aria-label="Redo"
              title="Redo (Ctrl/Cmd+Shift+Z)"
            >
              <Redo2 className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex items-center gap-0.5">
            <Button type="button" size="icon-sm" variant="outline" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out" title="Zoom out"><ZoomOut className="h-4 w-4" /></Button>
            <span className="w-12 text-center text-xs tabular-nums text-muted-foreground">{Math.round(view.zoom * 100)}%</span>
            <Button type="button" size="icon-sm" variant="outline" onClick={() => zoomBy(1.2)} aria-label="Zoom in" title="Zoom in"><ZoomIn className="h-4 w-4" /></Button>
            <Button type="button" size="icon-sm" variant="outline" onClick={fitView} aria-label="Fit to view" title="Fit the whole canvas in the viewport"><Maximize2 className="h-4 w-4" /></Button>
          </div>
          {/* U9: grid visibility + grid-snap — independent toggles, each persisted
              in localStorage (see GRID_SHOW_KEY/GRID_SNAP_KEY above). */}
          <div className="flex items-center gap-0.5">
            <Button
              type="button"
              size="icon-sm"
              variant={showGrid ? 'default' : 'outline'}
              aria-label="Show grid"
              aria-pressed={showGrid}
              title="Show grid (5mm lines, 10mm accent) — editor only, never in the export"
              onClick={toggleShowGrid}
            >
              <Grid3x3 className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant={gridSnapEnabled ? 'default' : 'outline'}
              aria-label="Snap to grid"
              aria-pressed={gridSnapEnabled}
              title="Snap panels/annotations to the 5mm grid while dragging or resizing"
              onClick={toggleGridSnap}
            >
              <Magnet className="h-4 w-4" />
            </Button>
          </div>
          {/* Tooltip wrapper: the style-source select inside has no title of its
              own (the Apply button does), and this file may not edit CanvasApplyStyle. */}
          <span
            className="inline-flex items-center"
            title="Copy one panel's figure style to all other panels (creates new figure versions)"
          >
            <CanvasApplyStyle canvasId={canvasId} panels={panels} />
          </span>
          {isOwner && (
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label="Move to project"
              title="Move this canvas into a project (or make it personal)"
              onClick={() => { setMoveTarget(canvas.project_id ?? 'personal'); setMoveOpen(true); }}
            >
              <FlaskConical className="h-4 w-4" />
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => duplicateCanvasMut.mutate()}
            disabled={duplicateCanvasMut.isPending}
            aria-label="Duplicate this canvas"
            title="Duplicate this canvas, including its panels and annotations"
          >
            {duplicateCanvasMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CopyPlus className="h-4 w-4" />}
            Duplicate
          </Button>
          <CanvasHelpPopover />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={panels.length === 0 || exportCanvas.isPending}
                  title={panels.length === 0 ? 'Add a panel before exporting' : 'Export the composed canvas'}
                />
              }
            >
              {exportCanvas.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Export
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={exportCanvas.isPending} onClick={() => exportCanvas.mutate({ format: 'svg' })}>
                SVG (vector)
              </DropdownMenuItem>
              <DropdownMenuItem disabled={exportCanvas.isPending} onClick={() => exportCanvas.mutate({ format: 'pdf' })}>
                PDF (vector)
              </DropdownMenuItem>
              <DropdownMenuItem disabled={exportCanvas.isPending} onClick={() => exportCanvas.mutate({ format: 'png', dpi: 300 })}>
                PNG (300 dpi)
              </DropdownMenuItem>
              <DropdownMenuItem disabled={exportCanvas.isPending} onClick={() => exportCanvas.mutate({ format: 'png', dpi: 600 })}>
                PNG (600 dpi)
              </DropdownMenuItem>
              <DropdownMenuItem disabled={exportCanvas.isPending} onClick={() => exportCanvas.mutate({ format: 'tiff', dpi: 300 })}>
                TIFF (300 dpi)
              </DropdownMenuItem>
              <DropdownMenuItem disabled={exportCanvas.isPending} onClick={() => exportCanvas.mutate({ format: 'tiff', dpi: 600 })}>
                TIFF (600 dpi)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button type="button" size="sm" onClick={() => setPickerOpen(true)}>
            <Plus className="h-4 w-4" /> Add figure
          </Button>
        </div>
      </div>

      {/* selected-panel toolbar (mount deferred while a pointer gesture
          is active — see pointerGestureActive) */}
      {selectedPanel && !pointerGestureActive && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-1.5 text-sm">
          <span className="text-xs text-muted-foreground">
            Panel {selectedPanel.label || '—'} · {roundMm(selectedPanel.width_mm)}×{roundMm(selectedPanel.height_mm)} mm
          </span>
          <span className="mx-1 flex items-center gap-1">
            <Tag className="h-3.5 w-3.5 text-muted-foreground" />
            <Input
              className="h-6 w-14 text-xs"
              maxLength={8}
              value={selectedPanel.label ?? ''}
              onFocus={() => { labelEditStart.current = selectedPanel.label ?? null; }}
              onChange={(e) => patchLocalPanel(selectedPanel.id, { label: e.target.value })}
              onBlur={(e) => {
                const label = e.target.value.trim() || null;
                const before = labelEditStart.current;
                patchPanel.mutate({
                  panelId: selectedPanel.id,
                  data: { label },
                  // Keystrokes patched the local cache, so the true before was
                  // captured on focus. Only record when the label changed.
                  history: label !== before ? { before: { label: before }, label: 'label' } : undefined,
                });
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              aria-label="Panel label"
              placeholder="A"
            />
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Switch
                checked={selectedPanel.label_visible}
                onCheckedChange={(v) => patchPanel.mutate({
                  panelId: selectedPanel.id,
                  data: { label_visible: v },
                  history: { before: { label_visible: selectedPanel.label_visible }, label: 'label visibility' },
                })}
                aria-label="Toggle label visibility"
              />
              label
            </span>
          </span>
          <Button type="button" size="xs" variant="outline" onClick={() => bringForward(selectedPanel)} title="Bring this panel in front of overlapping panels">
            <ArrowUp className="h-3.5 w-3.5" /> Forward
          </Button>
          <Button type="button" size="xs" variant="outline" onClick={() => sendBack(selectedPanel)} title="Send this panel behind overlapping panels">
            <ArrowDown className="h-3.5 w-3.5" /> Back
          </Button>
          <Button type="button" size="xs" variant={lockAspect ? 'default' : 'outline'} onClick={() => setLockAspect((v) => !v)} title="Keep the aspect ratio while resizing from a corner">
            {lockAspect ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />} Aspect
          </Button>
          {selectedPanel.native_width_mm && selectedPanel.native_height_mm ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              title="Resize this panel to the figure's original render size"
              onClick={() => {
                const fit = fitToCanvasMm(selectedPanel.native_width_mm!, selectedPanel.native_height_mm!);
                // Growing in place can push the panel past the sheet — pull the
                // top-left back so the restored panel stays fully on-canvas.
                const x_mm = clampPosMm(selectedPanel.x_mm, fit.width_mm, canvas.width_mm);
                const y_mm = clampPosMm(selectedPanel.y_mm, fit.height_mm, canvas.height_mm);
                if (
                  Math.abs(fit.width_mm - selectedPanel.width_mm) < EPS_MM &&
                  Math.abs(fit.height_mm - selectedPanel.height_mm) < EPS_MM &&
                  Math.abs(x_mm - selectedPanel.x_mm) < EPS_MM &&
                  Math.abs(y_mm - selectedPanel.y_mm) < EPS_MM
                ) return;
                patchPanel.mutate({
                  panelId: selectedPanel.id,
                  data: { ...fit, x_mm, y_mm },
                  history: {
                    before: {
                      x_mm: selectedPanel.x_mm,
                      y_mm: selectedPanel.y_mm,
                      width_mm: selectedPanel.width_mm,
                      height_mm: selectedPanel.height_mm,
                    },
                    label: 'resize',
                  },
                });
              }}
            >
              <Maximize2 className="h-3.5 w-3.5" /> Original size
            </Button>
          ) : null}
          <Button
            type="button"
            size="xs"
            variant="outline"
            title="Open this figure in the figure editor (new tab)"
            onClick={() => window.open(`/figures/${selectedPanel.figure_id}`, '_blank', 'noopener')}
          >
            <ExternalLink className="h-3.5 w-3.5" /> Edit figure
          </Button>
          <Button type="button" size="xs" variant="ghost" className="text-destructive" title="Remove this panel from the canvas" onClick={() => { if (window.confirm('Remove this panel from the canvas?')) removePanel.mutate({ panelId: selectedPanel.id, record: true }); }}>
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        </div>
      )}

      {/* U7 5c: align/distribute toolbar — replaces the single-panel toolbar
          once 2+ panels are selected. U8: scoped to a PURE panel multi-
          selection (a mixed panel+annotation selection shows the minimal
          strip below instead — align/distribute don't have an obvious
          meaning once annotations are mixed in). */}
      {selectedPanelIds.length >= 2 && selectedAnnotationIds.length === 0 && !pointerGestureActive && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-1.5 text-sm">
          <span className="text-xs text-muted-foreground">{selectedIds.length} panels selected</span>
          <div className="flex items-center gap-0.5">
            <Button type="button" size="icon-sm" variant="outline" aria-label="Align left" title="Align left" onClick={() => alignSelected('left')}>
              <AlignStartVertical className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" size="icon-sm" variant="outline" aria-label="Align center horizontally" title="Align center (horizontal)" onClick={() => alignSelected('hcenter')}>
              <AlignCenterVertical className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" size="icon-sm" variant="outline" aria-label="Align right" title="Align right" onClick={() => alignSelected('right')}>
              <AlignEndVertical className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="flex items-center gap-0.5">
            <Button type="button" size="icon-sm" variant="outline" aria-label="Align top" title="Align top" onClick={() => alignSelected('top')}>
              <AlignStartHorizontal className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" size="icon-sm" variant="outline" aria-label="Align middle vertically" title="Align middle (vertical)" onClick={() => alignSelected('vcenter')}>
              <AlignCenterHorizontal className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" size="icon-sm" variant="outline" aria-label="Align bottom" title="Align bottom" onClick={() => alignSelected('bottom')}>
              <AlignEndHorizontal className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label="Distribute horizontally"
              title="Distribute horizontally"
              disabled={selectedIds.length < 3}
              onClick={() => distributeSelected('h')}
            >
              <AlignHorizontalDistributeCenter className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label="Distribute vertically"
              title="Distribute vertically"
              disabled={selectedIds.length < 3}
              onClick={() => distributeSelected('v')}
            >
              <AlignVerticalDistributeCenter className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* U8: mixed panel+annotation selection — a minimal strip (no
          align/distribute, no per-type property editing; the inspector on
          the right only opens for a PURE annotation selection). */}
      {isMixedSelection && !pointerGestureActive && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-1.5 text-sm">
          <span className="text-xs text-muted-foreground">
            {selectedIds.length} items selected ({selectedPanelIds.length} panel{selectedPanelIds.length === 1 ? '' : 's'}, {selectedAnnotationIds.length} annotation{selectedAnnotationIds.length === 1 ? '' : 's'})
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-destructive"
            title="Remove the selected items from the canvas"
            onClick={() => deleteSelected()}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        </div>
      )}

      {/* one-time gesture hints (empty canvases are guided by the empty state) */}
      <CanvasHintsBar show={panels.length > 0} />

      {/* stage + color editor sidebar */}
      <div className="flex flex-1 overflow-hidden" style={{ minHeight: 480 }}>
      <div
        ref={setContainerRef}
        className="relative flex-1 overflow-hidden bg-muted/30"
        style={spaceHeld ? { cursor: 'grab' } : activeTool !== 'select' ? { cursor: 'crosshair' } : undefined}
      >
        <CanvasAnnotationToolbar active={activeTool} onSelect={setActiveTool} />
        {viewport.w > 0 && viewport.h > 0 && (
          <Stage
            width={viewport.w}
            height={viewport.h}
            scaleX={view.zoom}
            scaleY={view.zoom}
            x={view.x}
            y={view.y}
            draggable={spaceHeld}
            dragDistance={3}
            onWheel={handleWheel}
            onMouseDown={handleStageMouseDown}
            onMouseMove={handleStageMouseMove}
            onMouseUp={handleStageMouseUp}
            onDragMove={handleStageDragMove}
            onDragEnd={handleStageDragEnd}
          >
            <Layer>
              {/* canvas sheet */}
              <Rect
                x={0}
                y={0}
                width={canvasWpx}
                height={canvasHpx}
                fill={transparent ? '#f1f5f9' : 'white'}
                stroke="#94a3b8"
                strokeWidth={1}
                shadowColor="rgba(0,0,0,0.15)"
                shadowBlur={12}
                shadowOffsetY={2}
                // The sheet is decorative: without this, a mousedown anywhere
                // on the visible page hits THIS Rect (not the Stage), so the
                // marquee never armed inside the sheet — the primary use case.
                listening={false}
              />
              {/* U9: grid overlay — editor-only chrome (the export is composed
                  server-side and never sees this); two Shape nodes (not one
                  per line) so a 100-line grid is one draw call per tier
                  instead of ~100 React-reconciled Konva nodes on every pan/
                  zoom frame. listening=false, so it never affects hit-testing
                  (the marquee/panel-drag machinery is untouched either way). */}
              {gridLines && (
                <>
                  <Shape
                    listening={false}
                    stroke="#e2e8f0"
                    strokeWidth={1 / view.zoom}
                    sceneFunc={(ctx, shape) => {
                      ctx.beginPath();
                      for (const x of gridLines.minorV) { ctx.moveTo(x, 0); ctx.lineTo(x, canvasHpx); }
                      for (const y of gridLines.minorH) { ctx.moveTo(0, y); ctx.lineTo(canvasWpx, y); }
                      ctx.strokeShape(shape);
                    }}
                  />
                  <Shape
                    listening={false}
                    stroke="#cbd5e1"
                    strokeWidth={1.25 / view.zoom}
                    sceneFunc={(ctx, shape) => {
                      ctx.beginPath();
                      for (const x of gridLines.majorV) { ctx.moveTo(x, 0); ctx.lineTo(x, canvasHpx); }
                      for (const y of gridLines.majorH) { ctx.moveTo(0, y); ctx.lineTo(canvasWpx, y); }
                      ctx.strokeShape(shape);
                    }}
                  />
                </>
              )}
              {panels.map((panel) => (
                <CanvasPanelNode
                  key={panel.id}
                  panel={panel}
                  pxPerMm={pxPerMm}
                  draggableEnabled={!spaceHeld}
                  // U8: unlistenable while a creation tool is active, so a
                  // shape/text drag can start ON TOP of an existing panel
                  // instead of the panel intercepting the mousedown.
                  listening={activeTool === 'select'}
                  selected={selectedIds.includes(panel.id)}
                  transparent={transparent}
                  registerNode={registerNode}
                  onPanelMouseDown={handlePanelMouseDown}
                  onPanelClick={handlePanelClick}
                  onDragStart={handlePanelDragStart}
                  onDragMove={handleDragMove}
                  onDragEnd={handleDragEnd}
                  onTransformEnd={handleTransformEnd}
                />
              ))}
              {/* U8: annotations paint ABOVE panels, sorted by z (the `annotations`
                  memo is already z-sorted). A sole-selected line/arrow gets
                  draggable endpoint handles instead of the shared Transformer. */}
              {annotations.map((ann) => {
                const effective = endpointDraft?.id === ann.id ? { ...ann, points_mm: endpointDraft.points_mm } : ann;
                return (
                  <CanvasAnnotationNode
                    key={ann.id}
                    annotation={effective}
                    pxPerMm={pxPerMm}
                    draggableEnabled={!spaceHeld}
                    listening={activeTool === 'select'}
                    selected={selectedIds.includes(ann.id)}
                    measuredTextMm={getMeasuredTextMm(ann.id)}
                    registerNode={registerNode}
                    onMeasured={(id, size) => { measuredTextRef.current.set(id, size); bumpMeasure((v) => v + 1); }}
                    onMouseDown={handleAnnotationMouseDown}
                    onClick={handleAnnotationClick}
                    onDblClick={handleAnnotationDblClick}
                    onDragStart={handleAnnotationDragStart}
                    onDragMove={handleAnnotationDragMove}
                    onDragEnd={handleAnnotationDragEnd}
                    onTransformEnd={handleAnnotationTransformEnd}
                  />
                );
              })}
              {/* U8: in-progress shape/line/arrow creation drag preview */}
              {drawing && (drawing.type === 'rect' || drawing.type === 'ellipse') && (
                <Rect
                  x={Math.min(drawing.x0, drawing.x1)}
                  y={Math.min(drawing.y0, drawing.y1)}
                  width={Math.abs(drawing.x1 - drawing.x0)}
                  height={Math.abs(drawing.y1 - drawing.y0)}
                  stroke="#2563EB"
                  strokeWidth={1 / view.zoom}
                  dash={[4 / view.zoom]}
                  listening={false}
                />
              )}
              {drawing && (drawing.type === 'line' || drawing.type === 'arrow') && (
                <Line
                  points={[drawing.x0, drawing.y0, drawing.x1, drawing.y1]}
                  stroke="#2563EB"
                  strokeWidth={1 / view.zoom}
                  dash={[4 / view.zoom]}
                  listening={false}
                />
              )}
              {/* U8: line/arrow endpoint handles — only while that ONE
                  line/arrow is the sole selection (Transformer excludes them). */}
              {soleLineLikeAnnotation && (() => {
                const effective = endpointDraft?.id === soleLineLikeAnnotation.id ? endpointDraft.points_mm : (soleLineLikeAnnotation.points_mm ?? [0, 0, 0, 0]);
                return ([0, 1] as const).map((which) => (
                  <Circle
                    key={which}
                    x={mmToPx(effective[which * 2], pxPerMm)}
                    y={mmToPx(effective[which * 2 + 1], pxPerMm)}
                    radius={6 / view.zoom}
                    fill="#ffffff"
                    stroke="#2563EB"
                    strokeWidth={1.5 / view.zoom}
                    draggable={!spaceHeld}
                    onDragMove={(e) => handleEndpointDragMove(soleLineLikeAnnotation.id, which, e)}
                    onDragEnd={(e) => handleEndpointDragEnd(soleLineLikeAnnotation.id, which, e)}
                  />
                ));
              })()}
              {/* alignment guides */}
              {guides.x !== null && (
                <Line points={[guides.x, 0, guides.x, canvasHpx]} stroke="#2563EB" strokeWidth={1 / view.zoom} dash={[4 / view.zoom, 4 / view.zoom]} listening={false} />
              )}
              {guides.y !== null && (
                <Line points={[0, guides.y, canvasWpx, guides.y]} stroke="#2563EB" strokeWidth={1 / view.zoom} dash={[4 / view.zoom, 4 / view.zoom]} listening={false} />
              )}
              {/* U7 2: rubber-band marquee */}
              {marquee && (
                <Rect
                  x={Math.min(marquee.x0, marquee.x1)}
                  y={Math.min(marquee.y0, marquee.y1)}
                  width={Math.abs(marquee.x1 - marquee.x0)}
                  height={Math.abs(marquee.y1 - marquee.y0)}
                  fill="rgba(37,99,235,0.08)"
                  stroke="#2563EB"
                  strokeWidth={1 / view.zoom}
                  dash={[4 / view.zoom]}
                  listening={false}
                />
              )}
              <Transformer
                ref={trRef}
                rotateEnabled={false}
                keepRatio={lockAspect}
                enabledAnchors={transformerAnchors}
                anchorSize={8}
                borderStroke="#2563EB"
                anchorStroke="#2563EB"
                onTransformStart={handleTransformStart}
                boundBoxFunc={resizeBoundBox}
              />
            </Layer>
          </Stage>
        )}
        {/* U9: mm rulers — always on, editor-only chrome (never composed into
            the export), pointer-events:none so they never steal a drag from
            the Stage. Rendered AFTER the Stage on purpose: they overlay via
            absolute positioning + z-20 regardless of DOM order, and keeping
            the Konva canvas as the document's FIRST <canvas> preserves the
            qa-e2e suite's page.locator('canvas').first() convention (the
            rulers are real <canvas> elements too). */}
        <CanvasRulers viewport={viewport} view={view} pxPerMm={pxPerMm} />
        {panels.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <p className="rounded-md bg-background/80 px-4 py-2 text-sm text-muted-foreground shadow-sm">
              Empty canvas — use “＋ Add figure” to place your first panel.
            </p>
          </div>
        )}
        {/* U8: inline text-edit overlay — opened immediately on text-tool
            creation and on dblclick of an existing text annotation. */}
        {textEditing && textEditRect && containerEl && createPortal(
          <input
            autoFocus
            aria-label="Annotation text"
            className="absolute z-30 rounded border border-primary bg-white px-1.5 py-0.5 shadow-md outline-none"
            style={{ left: textEditRect.left, top: textEditRect.top, minWidth: textEditRect.width, fontSize: textEditRect.fontSizePx }}
            value={textEditing.value}
            maxLength={500}
            placeholder="Empty text is removed on blur"
            onChange={(e) => setTextEditing((s) => (s ? { ...s, value: sanitizeText(e.target.value) } : s))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              else if (e.key === 'Escape') cancelTextEditing(); // discard, not commit
              e.stopPropagation();
            }}
            onBlur={commitTextEditing}
          />,
          containerEl,
        )}
        </div>

        {selectedPanel && !pointerGestureActive && (
          <CanvasColorEditor
            key={selectedPanel.id}
            panel={selectedPanel}
            canvasId={canvasId}
            canvasName={canvas.name}
            containerEl={containerEl}
            overlayRect={overlayRect}
          />
        )}
        {isAnnotationOnlySelection && !pointerGestureActive && (
          <CanvasAnnotationInspector
            selected={selectedAnnotations}
            onDraft={draftAnnotationField}
            onCommit={commitAnnotationField}
            onBringForward={(ids) => zBumpAnnotations(ids, 1)}
            onSendBackward={(ids) => zBumpAnnotations(ids, -1)}
            onDelete={deleteAnnotationIds}
          />
        )}
      </div>

      {moveOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" role="presentation" onClick={() => setMoveOpen(false)}>
          <div
            role="dialog"
            aria-label="Move canvas to project"
            className="w-80 rounded-lg border bg-background p-4 shadow-xl outline-none"
            onClick={(e) => e.stopPropagation()}
            // Modal behavior: hold focus so Escape closes THIS dialog and the
            // editor's window-level keys (Delete/Escape/undo) never fire behind.
            tabIndex={-1}
            ref={(el) => el?.focus()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setMoveOpen(false);
              e.stopPropagation();
            }}
          >
            <p className="mb-1 text-sm font-semibold">Move canvas</p>
            <p className="mb-3 text-xs text-muted-foreground">
              Project canvases are shared with project members. Only the canvas owner can move it.
            </p>
            {panels.length > 0 && (
              <p className="mb-3 rounded bg-amber-50 p-2 text-[11px] text-amber-700">
                Panels whose figures live outside the target project won’t be visible to its members.
              </p>
            )}
            <select
              aria-label="Target project"
              className="mb-3 w-full rounded border bg-background px-2 py-1.5 text-sm"
              value={moveTarget}
              onChange={(e) => setMoveTarget(e.target.value)}
            >
              <option value="personal">Personal (no project)</option>
              {(projects ?? []).filter((p) => p.role !== 'viewer').map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setMoveOpen(false)}>Cancel</Button>
              <Button
                type="button"
                size="sm"
                disabled={patchCanvas.isPending}
                onClick={async () => {
                  const target = moveTarget === 'personal' ? null : moveTarget;
                  if ((canvas.project_id ?? null) === target) { setMoveOpen(false); return; }
                  try {
                    await patchCanvas.mutateAsync({ data: { project_id: target } });
                    qc.invalidateQueries({ queryKey: ['canvases'] });
                    toast.success(target ? 'Canvas moved to project' : 'Canvas is now personal');
                    setMoveOpen(false);
                  } catch {
                    /* patchCanvas onError already toasts (owner-only 403 etc.) */
                  }
                }}
              >
                {patchCanvas.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Move
              </Button>
            </div>
          </div>
        </div>
      )}

      <FigurePickerDialog open={pickerOpen} onOpenChange={setPickerOpen} onPick={handlePick} projectId={canvas.project_id ?? null} />
    </div>
  );
}
