'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import Konva from 'konva';
import { Stage, Layer, Rect, Group, Image as KonvaImage, Text, Transformer, Line } from 'react-konva';
import {
  getCanvas, updateCanvas, addCanvasPanel, updateCanvasPanel, deleteCanvasPanel, renderCanvasPreview,
  downloadCanvasExport,
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
  Download,
} from 'lucide-react';
import {
  mmToPx, pxToMm, roundMm, fitPxPerMm, clampCanvasMm, clampPanelMm, PANEL_MM_MIN,
} from './mm';
import { FigurePickerDialog } from './FigurePickerDialog';
import { CanvasColorEditor } from './CanvasColorEditor';
import { CanvasApplyStyle } from './CanvasApplyStyle';

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

  useEffect(() => {
    registerNode(panel.id, groupRef.current);
    return () => registerNode(panel.id, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.id]);

  const w = mmToPx(panel.width_mm, pxPerMm);
  const h = mmToPx(panel.height_mm, pxPerMm);

  return (
    <Group
      ref={groupRef}
      x={mmToPx(panel.x_mm, pxPerMm)}
      y={mmToPx(panel.y_mm, pxPerMm)}
      width={w}
      height={h}
      draggable
      onMouseDown={() => onSelect(panel.id)}
      onClick={() => onSelect(panel.id)}
      onTap={() => onSelect(panel.id)}
      onDragStart={() => onSelect(panel.id)}
      onDragMove={(e) => onDragMove(panel, e)}
      onDragEnd={(e) => onDragEnd(panel, e)}
      onTransformEnd={(e) => onTransformEnd(panel, e)}
    >
      <Rect
        width={w}
        height={h}
        fill={transparent ? undefined : 'white'}
        stroke={selected ? '#2563EB' : '#cbd5e1'}
        strokeWidth={selected ? 2 : 1}
      />
      {img && <KonvaImage image={img} width={w} height={h} listening={false} />}
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
  const [lockAspect, setLockAspect] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const [renamingCanvas, setRenamingCanvas] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [sizeDraft, setSizeDraft] = useState<{ w: string; h: string }>({ w: '', h: '' });

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

  // ── keyboard: delete / escape ──
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!selectedId) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        // Guard the keyboard shortcut — a stray Delete/Backspace shouldn't
        // silently drop a panel (there is no undo in the canvas editor).
        if (window.confirm('Remove this panel from the canvas?')) removePanel.mutate(selectedId);
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
  const patchPanel = useMutation({
    mutationFn: ({ panelId, data }: { panelId: string; data: Parameters<typeof updateCanvasPanel>[2] }) =>
      updateCanvasPanel(canvasId, panelId, data),
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
    onSuccess: (updated) => {
      qc.setQueryData<CanvasDetail>(queryKey, (old) =>
        old ? { ...old, panels: old.panels.map((p) => (p.id === updated.id ? updated : p)) } : old,
      );
    },
  });

  const addPanel = useMutation({
    mutationFn: (data: Parameters<typeof addCanvasPanel>[1]) => addCanvasPanel(canvasId, data),
    onSuccess: (panel) => {
      qc.setQueryData<CanvasDetail>(queryKey, (old) =>
        old ? { ...old, panels: [...old.panels, panel] } : old,
      );
      setSelectedId(panel.id);
    },
    onError: () => toast.error('Could not add figure'),
  });

  const removePanel = useMutation({
    mutationFn: (panelId: string) => deleteCanvasPanel(canvasId, panelId),
    onMutate: async (panelId) => {
      await qc.cancelQueries({ queryKey });
      const prev = qc.getQueryData<CanvasDetail>(queryKey);
      qc.setQueryData<CanvasDetail>(queryKey, (old) =>
        old ? { ...old, panels: old.panels.filter((p) => p.id !== panelId) } : old,
      );
      setSelectedId((cur) => (cur === panelId ? null : cur));
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKey, ctx.prev);
      toast.error('Could not delete panel');
    },
  });

  const patchCanvas = useMutation({
    mutationFn: (data: Parameters<typeof updateCanvas>[1]) => updateCanvas(canvasId, data),
    onSuccess: (updated) => {
      qc.setQueryData<CanvasDetail>(queryKey, (old) => (old ? { ...old, ...updated } : updated));
    },
    onError: () => toast.error('Could not update canvas'),
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
    // snap the dragged panel's left / right / center edge to any target line
    for (const edge of [x, x + w, x + w / 2]) {
      const hit = xTargets.find((t) => Math.abs(edge - t) <= thr);
      if (hit !== undefined) { x += hit - edge; guideX = hit; break; }
    }
    for (const edge of [y, y + h, y + h / 2]) {
      const hit = yTargets.find((t) => Math.abs(edge - t) <= thr);
      if (hit !== undefined) { y += hit - edge; guideY = hit; break; }
    }
    node.x(x);
    node.y(y);
    setGuides({ x: guideX, y: guideY });
  }

  function handleDragEnd(panel: CanvasPanel, e: Konva.KonvaEventObject<DragEvent>) {
    setGuides({ x: null, y: null });
    const node = e.target as Konva.Group;
    const x_mm = roundMm(clampCanvasMm(pxToMm(node.x(), pxPerMm)));
    const y_mm = roundMm(clampCanvasMm(pxToMm(node.y(), pxPerMm)));
    // Ignore a pure click (no meaningful move) — avoids a redundant PATCH.
    if (Math.abs(x_mm - panel.x_mm) < EPS_MM && Math.abs(y_mm - panel.y_mm) < EPS_MM) return;
    patchPanel.mutate({ panelId: panel.id, data: { x_mm, y_mm } }); // position only → no re-render
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
    const x_mm = roundMm(clampCanvasMm(pxToMm(node.x(), pxPerMm)));
    const y_mm = roundMm(clampCanvasMm(pxToMm(node.y(), pxPerMm)));
    if (
      Math.abs(width_mm - panel.width_mm) < EPS_MM &&
      Math.abs(height_mm - panel.height_mm) < EPS_MM &&
      Math.abs(x_mm - panel.x_mm) < EPS_MM &&
      Math.abs(y_mm - panel.y_mm) < EPS_MM
    ) return;
    // Commit new physical size (+ position). Updating width_mm/height_mm changes
    // the panel image key → usePanelImage calls renderCanvasPreview at the NEW mm
    // size and swaps in a freshly laid-out render (absolute-pt fonts preserved).
    patchPanel.mutate({ panelId: panel.id, data: { x_mm, y_mm, width_mm, height_mm } });
  }

  // ── z-order ──
  function bringForward(panel: CanvasPanel) {
    const maxZ = Math.max(0, ...panels.map((p) => p.z_order));
    if (panel.z_order >= maxZ && panels[panels.length - 1]?.id === panel.id) return;
    patchPanel.mutate({ panelId: panel.id, data: { z_order: maxZ + 1 } });
  }
  function sendBack(panel: CanvasPanel) {
    const minZ = Math.min(0, ...panels.map((p) => p.z_order));
    if (panel.z_order <= minZ && panels[0]?.id === panel.id) return;
    patchPanel.mutate({ panelId: panel.id, data: { z_order: minZ - 1 } });
  }

  // ── add figure ──
  function handlePick(fig: FigureListItem) {
    setPickerOpen(false);
    if (!canvas) return;
    const DEFAULT_W = 60;
    const DEFAULT_H = 45;
    const n = panels.length;
    // Stagger new panels so they don't stack exactly, clamped inside the canvas.
    const x_mm = clampCanvasMm(Math.min(10 + (n % 4) * 8, Math.max(0, canvas.width_mm - DEFAULT_W)));
    const y_mm = clampCanvasMm(Math.min(10 + (n % 4) * 8, Math.max(0, canvas.height_mm - DEFAULT_H)));
    addPanel.mutate({
      figure_id: fig.id,
      x_mm: roundMm(x_mm),
      y_mm: roundMm(y_mm),
      width_mm: DEFAULT_W,
      height_mm: DEFAULT_H,
      z_order: (Math.max(0, ...panels.map((p) => p.z_order)) || 0) + 1,
      label: nextLabel(panels),
    });
  }

  // ── zoom (wheel + buttons, uniform, toward pointer) ──
  function handleWheel(e: Konva.KonvaEventObject<WheelEvent>) {
    e.evt.preventDefault();
    const stage = e.target.getStage();
    if (!stage) return;
    const oldScale = view.zoom;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    const mousePointTo = { x: (pointer.x - view.x) / oldScale, y: (pointer.y - view.y) / oldScale };
    const direction = e.evt.deltaY > 0 ? -1 : 1;
    const factor = 1.08;
    const newScale = Math.min(8, Math.max(0.15, direction > 0 ? oldScale * factor : oldScale / factor));
    setView({
      zoom: newScale,
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale,
    });
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
    if (name && name !== canvas?.name) patchCanvas.mutate({ name });
  }
  function commitSize() {
    if (!canvas) return;
    const width_mm = clampCanvasMm(Number(sizeDraft.w));
    const height_mm = clampCanvasMm(Number(sizeDraft.h));
    if (!Number.isFinite(width_mm) || !Number.isFinite(height_mm)) return;
    if (width_mm === canvas.width_mm && height_mm === canvas.height_mm) return;
    patchCanvas.mutate({ width_mm: roundMm(width_mm), height_mm: roundMm(height_mm) });
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
            <Button type="button" size="icon-sm" variant="outline" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out"><ZoomOut className="h-4 w-4" /></Button>
            <span className="w-12 text-center text-xs tabular-nums text-muted-foreground">{Math.round(view.zoom * 100)}%</span>
            <Button type="button" size="icon-sm" variant="outline" onClick={() => zoomBy(1.2)} aria-label="Zoom in"><ZoomIn className="h-4 w-4" /></Button>
            <Button type="button" size="icon-sm" variant="outline" onClick={fitView} aria-label="Fit to view"><Maximize2 className="h-4 w-4" /></Button>
          </div>
          <CanvasApplyStyle canvasId={canvasId} panels={panels} />
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
              onChange={(e) => patchLocalPanel(selectedPanel.id, { label: e.target.value })}
              onBlur={(e) => patchPanel.mutate({ panelId: selectedPanel.id, data: { label: e.target.value.trim() || null } })}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              aria-label="Panel label"
              placeholder="A"
            />
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Switch
                checked={selectedPanel.label_visible}
                onCheckedChange={(v) => patchPanel.mutate({ panelId: selectedPanel.id, data: { label_visible: v } })}
                aria-label="Toggle label visibility"
              />
              label
            </span>
          </span>
          <Button type="button" size="xs" variant="outline" onClick={() => bringForward(selectedPanel)}>
            <ArrowUp className="h-3.5 w-3.5" /> Forward
          </Button>
          <Button type="button" size="xs" variant="outline" onClick={() => sendBack(selectedPanel)}>
            <ArrowDown className="h-3.5 w-3.5" /> Back
          </Button>
          <Button type="button" size="xs" variant={lockAspect ? 'default' : 'outline'} onClick={() => setLockAspect((v) => !v)}>
            {lockAspect ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />} Aspect
          </Button>
          <Button type="button" size="xs" variant="ghost" className="text-destructive" onClick={() => { if (window.confirm('Remove this panel from the canvas?')) removePanel.mutate(selectedPanel.id); }}>
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        </div>
      )}

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
