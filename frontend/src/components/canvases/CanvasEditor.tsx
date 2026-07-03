'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import Konva from 'konva';
import { Stage, Layer, Rect, Group, Image as KonvaImage, Text, Transformer, Line } from 'react-konva';
import {
  getCanvas, updateCanvas, addCanvasPanel, updateCanvasPanel, deleteCanvasPanel, renderCanvasPreview,
  downloadCanvasExport, duplicateFigure,
} from '@/lib/api';
import type { CanvasDetail, CanvasPanel, FigureListItem } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import {
  Loader2, Plus, Trash2, ArrowUp, ArrowDown, Maximize2, ZoomIn, ZoomOut, Lock, Unlock, Tag, Pencil, Check,
  Download, Undo2, Redo2, ExternalLink,
} from 'lucide-react';
import {
  mmToPx, pxToMm, roundMm, fitPxPerMm, clampCanvasMm, clampPanelMm, PANEL_MM_MIN,
} from './mm';
import { CanvasHistory, type PanelFields, type PanelSnapshot, type CanvasSize } from './canvasHistory';
import { FigurePickerDialog } from './FigurePickerDialog';
import { CanvasColorEditor } from './CanvasColorEditor';
import { CanvasApplyStyle } from './CanvasApplyStyle';
import { CanvasHelpPopover, CanvasHintsBar } from './CanvasHints';

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
  registerNode,
  onSelect,
  onDragMove,
  onDragEnd,
  onTransformEnd,
}: {
  panel: CanvasPanel;
  pxPerMm: number;
  selected: boolean;
  transparent: boolean;
  registerNode: (id: string, node: Konva.Group | null) => void;
  onSelect: (id: string) => void;
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
      draggable
      dragDistance={3}
      onMouseDown={() => onSelect(panel.id)}
      onClick={() => onSelect(panel.id)}
      onTap={() => onSelect(panel.id)}
      onDragStart={() => onSelect(panel.id)}
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
  const queryKey = useMemo(() => ['canvas', canvasId], [canvasId]);
  const { data: canvas, isLoading, isError } = useQuery({ queryKey, queryFn: () => getCanvas(canvasId) });

  // Figures can gain versions in another tab (the "Edit figure" button opens
  // one). Window-focus refetch is globally disabled (app-providers), so refetch
  // on tab return here — the new effective_version_id rotates each panelKey and
  // usePanelImage swaps in the fresh render. Without this, the editor would
  // keep showing the old figure while export uses the new version.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') qc.invalidateQueries({ queryKey });
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [qc, queryKey]);

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
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
  const [pickerOpen, setPickerOpen] = useState(false);
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

  const trRef = useRef<Konva.Transformer>(null);
  const nodeRefs = useRef<Map<string, Konva.Group>>(new Map());
  const registerNode = useCallback((id: string, node: Konva.Group | null) => {
    if (node) nodeRefs.current.set(id, node);
    else nodeRefs.current.delete(id);
  }, []);

  const panels = useMemo(
    () => (canvas?.panels ?? []).slice().sort((a, b) => a.z_order - b.z_order || a.id.localeCompare(b.id)),
    [canvas?.panels],
  );
  const selectedPanel = panels.find((p) => p.id === selectedId) ?? null;

  // Fit scale (px/mm): the whole canvas fits the viewport with a margin; zoom
  // multiplies this via the Stage scale (uniform).
  const pxPerMm = useMemo(
    () => (canvas ? fitPxPerMm(canvas.width_mm, canvas.height_mm, viewport.w, viewport.h) : 1),
    [canvas?.width_mm, canvas?.height_mm, viewport.w, viewport.h, canvas],
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

  // ── attach transformer to the selected node ──
  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const node = selectedId ? nodeRefs.current.get(selectedId) : null;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selectedId, panels, view.zoom]);

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
      if (!selectedId) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        // Guard the keyboard shortcut — a stray Delete/Backspace shouldn't
        // silently drop a panel. (History-applied deletes skip this confirm.)
        if (window.confirm('Remove this panel from the canvas?')) {
          removePanel.mutate({ panelId: selectedId, record: true });
        }
      } else if (e.key === 'Escape') {
        setSelectedId(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

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
      const prev = qc.getQueryData<CanvasDetail>(queryKey);
      patchLocalPanel(panelId, data as Partial<CanvasPanel>);
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKey, ctx.prev);
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

  const addPanel = useMutation({
    mutationFn: ({ data }: { data: Parameters<typeof addCanvasPanel>[1]; record?: boolean }) =>
      addCanvasPanel(canvasId, data),
    onSuccess: (panel, vars) => {
      qc.setQueryData<CanvasDetail>(queryKey, (old) =>
        old ? { ...old, panels: [...old.panels, panel] } : old,
      );
      setSelectedId(panel.id);
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
      setSelectedId((cur) => (cur === panelId ? null : cur));
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
    onError: () => toast.error('Could not update canvas'),
  });

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
    if (history.isApplying || applyingHistory) return;
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

  // ── export: compose the canvas into a vector file (SVG/PDF) and download it. ──
  const exportCanvas = useMutation({
    mutationFn: (format: 'svg' | 'pdf') => {
      const base = (canvas?.name?.trim() || 'canvas').replace(/[/\\:*?"<>|]+/g, '_');
      return downloadCanvasExport(canvasId, format, `${base}.${format}`);
    },
    onSuccess: (_res, format) => toast.success(`Canvas exported as ${format.toUpperCase()}`),
    onError: () => toast.error('Could not export canvas'),
  });

  // ── move: convert node px → mm; position only (NO re-render) ──
  function handleDragMove(panel: CanvasPanel, e: Konva.KonvaEventObject<DragEvent>) {
    if (!canvas) return;
    // Alt/Option temporarily disables snapping for pixel-precise placement.
    if (e.evt.altKey) {
      setGuides({ x: null, y: null });
      return;
    }
    const node = e.target as Konva.Group;
    const thr = SNAP_PX / view.zoom;
    const w = mmToPx(panel.width_mm, pxPerMm);
    const h = mmToPx(panel.height_mm, pxPerMm);
    const cw = mmToPx(canvas.width_mm, pxPerMm);
    const ch = mmToPx(canvas.height_mm, pxPerMm);
    let x = node.x();
    let y = node.y();

    const others = panels.filter((p) => p.id !== panel.id);
    const xTargets = [0, cw, cw / 2, ...others.flatMap((p) => {
      const px = mmToPx(p.x_mm, pxPerMm);
      const pw = mmToPx(p.width_mm, pxPerMm);
      return [px, px + pw, px + pw / 2];
    })];
    const yTargets = [0, ch, ch / 2, ...others.flatMap((p) => {
      const py = mmToPx(p.y_mm, pxPerMm);
      const ph = mmToPx(p.height_mm, pxPerMm);
      return [py, py + ph, py + ph / 2];
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
  }

  function handleDragEnd(panel: CanvasPanel, e: Konva.KonvaEventObject<DragEvent>) {
    setGuides({ x: null, y: null });
    if (!canvas) return;
    const node = e.target as Konva.Group;
    // Position clamp is [0, canvas − panel] (clampCanvasMm is a SIZE clamp
    // whose 20mm floor forbade placing panels near the top/left edges).
    const x_mm = clampPosMm(pxToMm(node.x(), pxPerMm), panel.width_mm, canvas.width_mm);
    const y_mm = clampPosMm(pxToMm(node.y(), pxPerMm), panel.height_mm, canvas.height_mm);
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

  // ── resize = RE-LAYOUT: reset the transient Konva scale, commit new mm; the
  // panel image then re-renders at the NEW physical size via usePanelImage. ──
  function handleTransformEnd(panel: CanvasPanel, e: Konva.KonvaEventObject<Event>) {
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
    if (
      Math.abs(width_mm - panel.width_mm) < EPS_MM &&
      Math.abs(height_mm - panel.height_mm) < EPS_MM &&
      Math.abs(x_mm - panel.x_mm) < EPS_MM &&
      Math.abs(y_mm - panel.y_mm) < EPS_MM
    ) return;
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

  function handleStageMouseDown(e: Konva.KonvaEventObject<MouseEvent>) {
    // Click on empty stage (not a panel) deselects.
    if (e.target === e.target.getStage()) setSelectedId(null);
  }
  function handleStageDragEnd(e: Konva.KonvaEventObject<DragEvent>) {
    // Only the Stage's own pan updates the view (panel drags bubble here too).
    const stage = e.target.getStage();
    if (e.target !== stage || !stage) return;
    setView((v) => ({ ...v, x: stage.x(), y: stage.y() }));
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

  return (
    <div className="flex flex-1 flex-col">
      {/* top bar */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2">
        <div className="mr-1 flex items-center gap-1 text-sm text-muted-foreground">
          <Link href="/canvases" className="hover:underline">Canvases</Link><span>/</span>
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
          {/* Tooltip wrapper: the style-source select inside has no title of its
              own (the Apply button does), and this file may not edit CanvasApplyStyle. */}
          <span
            className="inline-flex items-center"
            title="Copy one panel's figure style to all other panels (creates new figure versions)"
          >
            <CanvasApplyStyle canvasId={canvasId} panels={panels} />
          </span>
          <CanvasHelpPopover />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={panels.length === 0 || exportCanvas.isPending}
                  title={panels.length === 0 ? 'Add a panel before exporting' : 'Export the composed canvas as a vector file'}
                />
              }
            >
              {exportCanvas.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Export
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={exportCanvas.isPending} onClick={() => exportCanvas.mutate('svg')}>
                SVG (vector)
              </DropdownMenuItem>
              <DropdownMenuItem disabled={exportCanvas.isPending} onClick={() => exportCanvas.mutate('pdf')}>
                PDF (vector)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button type="button" size="sm" onClick={() => setPickerOpen(true)}>
            <Plus className="h-4 w-4" /> Add figure
          </Button>
        </div>
      </div>

      {/* selected-panel toolbar */}
      {selectedPanel && (
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

      {/* one-time gesture hints (empty canvases are guided by the empty state) */}
      <CanvasHintsBar show={panels.length > 0} />

      {/* stage + color editor sidebar */}
      <div className="flex flex-1 overflow-hidden" style={{ minHeight: 480 }}>
      <div ref={setContainerRef} className="relative flex-1 overflow-hidden bg-muted/30">
        {viewport.w > 0 && viewport.h > 0 && (
          <Stage
            width={viewport.w}
            height={viewport.h}
            scaleX={view.zoom}
            scaleY={view.zoom}
            x={view.x}
            y={view.y}
            draggable
            dragDistance={3}
            onWheel={handleWheel}
            onMouseDown={handleStageMouseDown}
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
              />
              {panels.map((panel) => (
                <CanvasPanelNode
                  key={panel.id}
                  panel={panel}
                  pxPerMm={pxPerMm}
                  selected={panel.id === selectedId}
                  transparent={transparent}
                  registerNode={registerNode}
                  onSelect={setSelectedId}
                  onDragMove={handleDragMove}
                  onDragEnd={handleDragEnd}
                  onTransformEnd={handleTransformEnd}
                />
              ))}
              {/* alignment guides */}
              {guides.x !== null && (
                <Line points={[guides.x, 0, guides.x, canvasHpx]} stroke="#2563EB" strokeWidth={1 / view.zoom} dash={[4 / view.zoom, 4 / view.zoom]} listening={false} />
              )}
              {guides.y !== null && (
                <Line points={[0, guides.y, canvasWpx, guides.y]} stroke="#2563EB" strokeWidth={1 / view.zoom} dash={[4 / view.zoom, 4 / view.zoom]} listening={false} />
              )}
              <Transformer
                ref={trRef}
                rotateEnabled={false}
                keepRatio={lockAspect}
                enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right']}
                anchorSize={8}
                borderStroke="#2563EB"
                anchorStroke="#2563EB"
                boundBoxFunc={(oldBox, newBox) => {
                  const min = mmToPx(PANEL_MM_MIN, pxPerMm) * view.zoom;
                  if (newBox.width < min || newBox.height < min) return oldBox;
                  return newBox;
                }}
              />
            </Layer>
          </Stage>
        )}
        {panels.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <p className="rounded-md bg-background/80 px-4 py-2 text-sm text-muted-foreground shadow-sm">
              Empty canvas — use “＋ Add figure” to place your first panel.
            </p>
          </div>
        )}
        </div>

        {selectedPanel && (
          <CanvasColorEditor
            key={selectedPanel.id}
            panel={selectedPanel}
            canvasId={canvasId}
            canvasName={canvas.name}
            containerEl={containerEl}
            overlayRect={overlayRect}
          />
        )}
      </div>

      <FigurePickerDialog open={pickerOpen} onOpenChange={setPickerOpen} onPick={handlePick} />
    </div>
  );
}
