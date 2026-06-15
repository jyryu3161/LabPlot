'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Download, FileText, Grid2X2, ImagePlus, Loader2, Palette, Save, Sparkles, Type, ZoomIn, ZoomOut } from 'lucide-react';
import { Stage, Layer, Image as KonvaImage, Rect, Text, Transformer, Group } from 'react-konva';
import type Konva from 'konva';
import type { FigureCanvas, CanvasItem, CanvasState, CanvasStyleSuggestion, FigureDetail, FigureListItem, FigureVersion, PaletteDef, Project } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const DEFAULT_PALETTE = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#56B4E9', '#E69F00'];

interface FigureCanvasEditorProps {
  canvas: FigureCanvas;
  figures: FigureListItem[];
  palettes: PaletteDef[];
  onLoadFigure: (figureId: string) => Promise<FigureDetail>;
  onSaveCanvas: (state: CanvasState, name: string) => Promise<void>;
  onSaveFigureVersion: (item: CanvasItem, svg: string) => Promise<FigureVersion>;
  onSuggestStyle: (selectedItemId?: string) => Promise<CanvasStyleSuggestion>;
  onGenerateLegend: () => Promise<{ legend: string }>;
  project?: Project;
}

function normalizeState(canvas: FigureCanvas): CanvasState {
  const s = canvas.state || {};
  return {
    version: 1,
    preset: s.preset || canvas.preset || 'double_column',
    widthPx: Number(s.widthPx || canvas.width_px || 720),
    heightPx: Number(s.heightPx || canvas.height_px || 500),
    widthIn: Number(s.widthIn || 7.2),
    heightIn: Number(s.heightIn || 5),
    exportDpi: Number(s.exportDpi || 300),
    panelLabelMode: s.panelLabelMode || 'letters',
    unifiedFontSize: Number(s.unifiedFontSize || 7),
    legend: typeof s.legend === 'string' ? s.legend : '',
    items: Array.isArray(s.items) ? s.items : [],
  };
}

function nextLabel(index: number): string {
  return LETTERS[index] ?? String(index + 1);
}

function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function safeFilename(name: string, ext: string): string {
  const base = name.trim().replace(/[^A-Za-z0-9_.-]+/g, '_') || 'canvas';
  return `${base}.${ext}`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function useCanvasImage(src?: string) {
  const [loaded, setLoaded] = useState<{ src: string; image: HTMLImageElement } | null>(null);
  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { if (!cancelled) setLoaded({ src, image: img }); };
    img.src = src;
    return () => { cancelled = true; };
  }, [src]);
  if (!loaded || loaded.src !== src) return null;
  return loaded.image;
}

function sanitizeSvg(raw: string): SVGSVGElement {
  const parser = new DOMParser();
  const doc = parser.parseFromString(raw, 'image/svg+xml');
  const svg = doc.querySelector('svg');
  if (!svg || doc.querySelector('parsererror')) throw new Error('Invalid SVG');
  doc.querySelectorAll('script,foreignObject,iframe,object,embed,link').forEach((el) => el.remove());
  doc.querySelectorAll('*').forEach((el) => {
    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith('on') || value.startsWith('javascript:')) el.removeAttribute(attr.name);
    });
  });
  if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return svg;
}

function isNeutralColor(value: string): boolean {
  const v = value.trim().toLowerCase();
  return !v || v === 'none' || v === 'transparent' || v === '#fff' || v === '#ffffff' || v === 'white' || v === '#000' || v === '#000000' || v === 'black';
}

function applySvgStyle(raw: string, palette: string[], fontSize: number): string {
  const svg = sanitizeSvg(raw);
  const colors = palette.length ? palette : DEFAULT_PALETTE;
  const colorMap = new Map<string, string>();
  let cursor = 0;
  svg.querySelectorAll('*').forEach((el) => {
    for (const attrName of ['fill', 'stroke']) {
      const current = el.getAttribute(attrName);
      if (!current || isNeutralColor(current) || current.startsWith('url(')) continue;
      const key = current.trim().toLowerCase();
      if (!colorMap.has(key)) {
        colorMap.set(key, colors[cursor % colors.length]);
        cursor += 1;
      }
      el.setAttribute(attrName, colorMap.get(key)!);
    }
  });
  svg.querySelectorAll('text,tspan').forEach((el) => {
    el.setAttribute('font-size', `${fontSize}pt`);
    el.setAttribute('font-family', 'Arial');
    (el as SVGElement).style.setProperty('font-size', `${fontSize}pt`);
    (el as SVGElement).style.setProperty('font-family', 'Arial');
  });
  return new XMLSerializer().serializeToString(svg);
}

function canvasItemSource(item: CanvasItem): string | undefined {
  if (item.editedSvg) return svgToDataUrl(item.editedSvg);
  return item.svgUrl || item.pngUrl;
}

function fitInside(boxW: number, boxH: number, image?: HTMLImageElement | null) {
  const sourceW = image?.naturalWidth || image?.width || boxW;
  const sourceH = image?.naturalHeight || image?.height || boxH;
  const scale = Math.min(boxW / Math.max(1, sourceW), boxH / Math.max(1, sourceH));
  const width = Math.max(1, sourceW * scale);
  const height = Math.max(1, sourceH * scale);
  return {
    x: (boxW - width) / 2,
    y: (boxH - height) / 2,
    width,
    height,
  };
}

function arrangeCanvasItems(state: CanvasState, layout: CanvasStyleSuggestion['layout'] = 'grid'): CanvasItem[] {
  const n = state.items.length;
  if (!n) return state.items;
  const cols = layout === 'single_row' ? n : layout === 'two_column' ? Math.min(2, n) : n <= 1 ? 1 : n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const margin = 44;
  const gap = 28;
  const cellW = (state.widthPx - margin * 2 - gap * (cols - 1)) / cols;
  const cellH = (state.heightPx - margin * 2 - gap * (rows - 1)) / rows;
  return state.items.map((item, i) => {
    const aspect = item.width / Math.max(1, item.height);
    let width = cellW;
    let height = width / aspect;
    if (height > cellH) {
      height = cellH;
      width = height * aspect;
    }
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      ...item,
      label: nextLabel(i),
      x: Math.round(margin + col * (cellW + gap) + (cellW - width) / 2),
      y: Math.round(margin + row * (cellH + gap) + (cellH - height) / 2),
      width: Math.round(width),
      height: Math.round(height),
    };
  });
}

function FigurePanelNode({
  item,
  selected,
  onSelect,
  onChange,
  labelMode,
  labelFontSize,
}: {
  item: CanvasItem;
  selected: boolean;
  onSelect: () => void;
  onChange: (next: CanvasItem) => void;
  labelMode: CanvasState['panelLabelMode'];
  labelFontSize: number;
}) {
  const image = useCanvasImage(canvasItemSource(item));
  const groupRef = useRef<Konva.Group | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const fitted = fitInside(item.width, item.height, image);

  useEffect(() => {
    if (!selected || !groupRef.current || !transformerRef.current) return;
    transformerRef.current.nodes([groupRef.current]);
    transformerRef.current.getLayer()?.batchDraw();
  }, [selected]);

  const label = labelMode === 'hidden' ? '' : item.label;

  return (
    <>
      <Rect
        x={item.x}
        y={item.y}
        width={item.width}
        height={item.height}
        fill="transparent"
        listening={false}
      />
      <Group
        ref={groupRef}
        x={item.x}
        y={item.y}
        rotation={item.rotation || 0}
        draggable
        onClick={onSelect}
        onTap={onSelect}
        onDragEnd={(e) => onChange({ ...item, x: Math.round(e.target.x()), y: Math.round(e.target.y()) })}
        onTransformEnd={() => {
          const node = groupRef.current;
          if (!node) return;
          const scaleX = node.scaleX();
          const scaleY = node.scaleY();
          node.scaleX(1);
          node.scaleY(1);
          onChange({
            ...item,
            x: Math.round(node.x()),
            y: Math.round(node.y()),
            width: Math.max(36, Math.round(item.width * scaleX)),
            height: Math.max(36, Math.round(item.height * scaleY)),
            rotation: Math.round(node.rotation() || 0),
          });
        }}
      >
        <Rect
          x={-1}
          y={-1}
          width={item.width + 2}
          height={item.height + 2}
          fill="white"
          stroke={selected ? '#2563eb' : '#d4d4d8'}
          strokeWidth={selected ? 1.2 : 0.5}
        />
        <KonvaImage
          image={image || undefined}
          x={fitted.x}
          y={fitted.y}
          width={fitted.width}
          height={fitted.height}
          listening={false}
        />
      </Group>
      {label && (
        <Text
          x={item.x}
          y={Math.max(0, item.y - labelFontSize - 5)}
          text={label}
          fontSize={labelFontSize}
          fontStyle="bold"
          fontFamily="Arial"
          fill="#111827"
          listening={false}
        />
      )}
      {item.hasUnsavedSvgEdit && (
        <Text
          x={item.x + item.width - 54}
          y={item.y + item.height + 5}
          text="draft"
          fontSize={10}
          fill="#b45309"
          listening={false}
        />
      )}
      {selected && (
        <Transformer
          ref={transformerRef}
          rotateEnabled={false}
          keepRatio={false}
          enabledAnchors={['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right']}
          boundBoxFunc={(oldBox, newBox) => (newBox.width < 36 || newBox.height < 36 ? oldBox : newBox)}
        />
      )}
    </>
  );
}

export function FigureCanvasEditor({ canvas, figures, palettes, onLoadFigure, onSaveCanvas, onSaveFigureVersion, onSuggestStyle, onGenerateLegend, project }: FigureCanvasEditorProps) {
  const [name, setName] = useState(canvas.name);
  const [state, setState] = useState<CanvasState>(() => normalizeState(canvas));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paletteKey, setPaletteKey] = useState('okabe_ito');
  const [busy, setBusy] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0.72);
  const [legend, setLegend] = useState(() => normalizeState(canvas).legend || '');
  const stageRef = useRef<Konva.Stage | null>(null);

  useEffect(() => {
    const normalized = normalizeState(canvas);
    setName(canvas.name);
    setState(normalized);
    setLegend(normalized.legend || '');
    setSelectedId(null);
  }, [canvas]);

  const selectedItem = state.items.find((item) => item.id === selectedId) || null;
  const figuresOnCanvas = useMemo(() => new Set(state.items.map((item) => item.figureId)), [state.items]);
  const selectedPalette = palettes.find((p) => p.key === paletteKey);
  const palette = selectedPalette?.hex?.length ? selectedPalette.hex : DEFAULT_PALETTE;
  const labelFontSize = 8;

  function updateItem(id: string, next: CanvasItem) {
    setState((prev) => ({ ...prev, items: prev.items.map((item) => (item.id === id ? next : item)) }));
  }

  async function addFigure(figureId: string) {
    setBusy(`add-${figureId}`);
    try {
      const fig = await onLoadFigure(figureId);
      const version = fig.versions.find((v) => v.id === fig.current_version_id) || fig.versions[fig.versions.length - 1];
      if (!version) throw new Error('Figure has no version');
      const index = state.items.length;
      const w = Math.round(state.widthPx * 0.40);
      const h = Math.round(state.heightPx * 0.23);
      let editedSvg: string | undefined;
      let hasUnsavedSvgEdit = false;
      if (version.svg_url) {
        try {
          const res = await fetch(version.svg_url, { credentials: 'same-origin' });
          if (res.ok) {
            editedSvg = applySvgStyle(await res.text(), palette, state.unifiedFontSize);
            hasUnsavedSvgEdit = true;
          }
        } catch {
          editedSvg = undefined;
        }
      }
      const item: CanvasItem = {
        id: crypto.randomUUID(),
        figureId: fig.id,
        versionId: version.id,
        name: fig.name,
        label: nextLabel(index),
        x: 56 + (index % 2) * (w + 44),
        y: 72 + Math.floor(index / 2) * (h + 70),
        width: w,
        height: h,
        svgUrl: version.svg_url,
        pngUrl: version.png_url,
        editedSvg,
        hasUnsavedSvgEdit,
      };
      setState((prev) => ({ ...prev, items: [...prev.items, item] }));
      setSelectedId(item.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add figure');
    } finally {
      setBusy(null);
    }
  }

  function removeSelected() {
    if (!selectedId) return;
    setState((prev) => ({ ...prev, items: prev.items.filter((item) => item.id !== selectedId) }));
    setSelectedId(null);
  }

  function autoArrange() {
    setState((prev) => ({ ...prev, items: arrangeCanvasItems(prev, 'grid') }));
  }

  async function fetchItemSvg(item: CanvasItem): Promise<string> {
    if (item.editedSvg) return item.editedSvg;
    if (!item.svgUrl) throw new Error('This panel does not have an SVG source');
    const res = await fetch(item.svgUrl, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`SVG load failed (${res.status})`);
    return res.text();
  }

  async function harmonizeSelected() {
    if (!selectedItem) return;
    setBusy('harmonize');
    try {
      const svg = await fetchItemSvg(selectedItem);
      const editedSvg = applySvgStyle(svg, palette, state.unifiedFontSize);
      updateItem(selectedItem.id, { ...selectedItem, editedSvg, hasUnsavedSvgEdit: true });
      toast.success('Panel colors and font size harmonized');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'SVG harmonization failed');
    } finally {
      setBusy(null);
    }
  }

  async function harmonizeAllWith(colors: string[], fontSize: number, layout: CanvasStyleSuggestion['layout'] = 'keep') {
    const items = await Promise.all(state.items.map(async (item) => {
      try {
        const svg = await fetchItemSvg(item);
        return { ...item, editedSvg: applySvgStyle(svg, colors, fontSize), hasUnsavedSvgEdit: true };
      } catch {
        return item;
      }
    }));
    setState((prev) => {
      const next = { ...prev, unifiedFontSize: fontSize, items };
      return layout === 'keep' ? next : { ...next, items: arrangeCanvasItems(next, layout) };
    });
  }

  async function harmonizeAll() {
    setBusy('harmonize-all');
    try {
      await harmonizeAllWith(palette, state.unifiedFontSize);
      toast.success('Canvas SVG panels harmonized');
    } finally {
      setBusy(null);
    }
  }

  async function aiHarmonizeAll() {
    setBusy('ai-harmonize');
    try {
      const suggestion = await onSuggestStyle(selectedItem?.id || undefined);
      const suggestedPalette = palettes.find((p) => p.key === suggestion.palette_key);
      const colors = suggestedPalette?.hex?.length ? suggestedPalette.hex : DEFAULT_PALETTE;
      setPaletteKey(suggestion.palette_key);
      await harmonizeAllWith(colors, suggestion.font_size, suggestion.layout);
      toast.success(suggestion.rationale || 'AI harmonization applied');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'AI harmonization failed');
    } finally {
      setBusy(null);
    }
  }

  async function saveSelectedAsVersion() {
    if (!selectedItem?.editedSvg) return;
    setBusy('save-version');
    try {
      const version = await onSaveFigureVersion(selectedItem, selectedItem.editedSvg);
      updateItem(selectedItem.id, {
        ...selectedItem,
        versionId: version.id,
        svgUrl: version.svg_url,
        pngUrl: version.png_url,
        editedSvg: undefined,
        hasUnsavedSvgEdit: false,
      });
      toast.success(`Saved source figure version v${version.version_number}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Version save failed');
    } finally {
      setBusy(null);
    }
  }

  async function saveCanvas() {
    setBusy('save-canvas');
    try {
      await onSaveCanvas({ ...state, legend }, name);
      toast.success('Canvas saved');
    } finally {
      setBusy(null);
    }
  }

  function downloadPng() {
    const stage = stageRef.current;
    if (!stage) return;
    const ratio = Math.max(1, Math.round((state.widthIn * state.exportDpi) / state.widthPx));
    const previous = {
      width: stage.width(),
      height: stage.height(),
      scaleX: stage.scaleX(),
      scaleY: stage.scaleY(),
    };
    stage.width(state.widthPx);
    stage.height(state.heightPx);
    stage.scale({ x: 1, y: 1 });
    stage.batchDraw();
    const url = stage.toDataURL({ pixelRatio: ratio, mimeType: 'image/png' });
    stage.width(previous.width);
    stage.height(previous.height);
    stage.scale({ x: previous.scaleX, y: previous.scaleY });
    stage.batchDraw();
    const a = document.createElement('a');
    a.href = url;
    a.download = safeFilename(name, 'png');
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function sourceAsDataUrl(item: CanvasItem): Promise<string | null> {
    if (item.editedSvg) return svgToDataUrl(item.editedSvg);
    const src = item.svgUrl || item.pngUrl;
    if (!src) return null;
    const res = await fetch(src, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const blob = await res.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  }

  async function downloadSvg() {
    setBusy('svg');
    try {
      const panels = await Promise.all(state.items.map(async (item) => {
        const href = await sourceAsDataUrl(item);
        return { item, href };
      }));
      const labelNodes = state.panelLabelMode === 'hidden' ? '' : state.items.map((item) => (
        `<text x="${item.x}" y="${Math.max(0, item.y - labelFontSize - 5) + labelFontSize}" font-family="Arial" font-size="${labelFontSize}pt" font-weight="700" fill="#111827">${escapeXml(item.label)}</text>`
      )).join('\n');
      const imageNodes = panels.map(({ item, href }) => {
        if (!href) return '';
        return `<rect x="${item.x - 1}" y="${item.y - 1}" width="${item.width + 2}" height="${item.height + 2}" fill="#fff" stroke="#d4d4d8" stroke-width="0.5"/><image href="${href}" x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" preserveAspectRatio="xMidYMid meet"/>`;
      }).join('\n');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${state.widthPx}" height="${state.heightPx}" viewBox="0 0 ${state.widthPx} ${state.heightPx}"><rect width="100%" height="100%" fill="#fff"/>\n${imageNodes}\n${labelNodes}\n</svg>`;
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = safeFilename(name, 'svg');
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(null);
    }
  }

  async function generateLegend() {
    setBusy('legend');
    try {
      await onSaveCanvas({ ...state, legend }, name);
      const result = await onGenerateLegend();
      setLegend(result.legend);
      setState((prev) => ({ ...prev, legend: result.legend }));
      toast.success('Canvas legend generated');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Legend generation failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)_320px]">
      <aside className="space-y-3 rounded-lg border bg-background p-3">
        <div className="space-y-1">
          <Label className="text-xs">Canvas name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-md border p-2">
            <div className="text-muted-foreground">Preset</div>
            <div className="font-medium">{state.preset === 'a4_portrait' ? 'A4 portrait' : state.preset.replaceAll('_', ' ')}</div>
          </div>
          <div className="rounded-md border p-2">
            <div className="text-muted-foreground">Export</div>
            <div className="font-medium">{state.widthIn} x {state.heightIn} in @ {state.exportDpi} dpi</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={saveCanvas} disabled={busy === 'save-canvas'}>
            {busy === 'save-canvas' ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-2 h-3.5 w-3.5" />} Save
          </Button>
          <Button size="sm" variant="outline" onClick={downloadPng}><Download className="mr-2 h-3.5 w-3.5" /> PNG</Button>
          <Button size="sm" variant="outline" onClick={downloadSvg} disabled={busy === 'svg'}>{busy === 'svg' ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-2 h-3.5 w-3.5" />} SVG</Button>
        </div>

        <div className="border-t pt-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Figures</h2>
            <Badge variant="secondary">{state.items.length} on canvas</Badge>
          </div>
          {project && <p className="mb-2 text-xs text-muted-foreground">Project: {project.name}</p>}
          <div className="max-h-[55vh] space-y-1 overflow-auto pr-1">
            {figures.map((fig) => {
              const onCanvas = figuresOnCanvas.has(fig.id);
              return (
                <button
                  key={fig.id}
                  type="button"
                  onClick={() => {
                    if (!onCanvas) addFigure(fig.id);
                  }}
                  disabled={onCanvas || busy === `add-${fig.id}`}
                  className="flex w-full items-center gap-2 rounded-md border bg-background p-2 text-left text-xs hover:bg-muted/60 disabled:cursor-default disabled:opacity-80 disabled:hover:bg-background"
                >
                  {fig.thumb_url ? <img src={fig.thumb_url} alt="" className="h-10 w-12 rounded border bg-white object-contain" /> : <div className="h-10 w-12 rounded border bg-muted" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{fig.name}</span>
                    <span className="text-muted-foreground">{fig.plot_type}</span>
                  </span>
                  {busy === `add-${fig.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : onCanvas ? <Badge variant="outline">On</Badge> : <ImagePlus className="h-3.5 w-3.5" />}
                </button>
              );
            })}
          </div>
        </div>
      </aside>

      <section className="min-w-0 overflow-auto rounded-lg border bg-zinc-100 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={autoArrange}><Grid2X2 className="mr-2 h-3.5 w-3.5" /> Auto arrange</Button>
          <Button size="sm" variant="outline" onClick={() => setState((prev) => ({ ...prev, panelLabelMode: prev.panelLabelMode === 'hidden' ? 'letters' : 'hidden' }))}>
            <Type className="mr-2 h-3.5 w-3.5" /> Labels {state.panelLabelMode === 'hidden' ? 'off' : 'on'}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setZoom((z) => Math.max(0.35, Number((z - 0.1).toFixed(2))))}><ZoomOut className="mr-2 h-3.5 w-3.5" /> Zoom</Button>
          <Button size="sm" variant="outline" onClick={() => setZoom((z) => Math.min(1.4, Number((z + 0.1).toFixed(2))))}><ZoomIn className="mr-2 h-3.5 w-3.5" /> {Math.round(zoom * 100)}%</Button>
          <span className="text-xs text-muted-foreground">Canvas: {state.widthPx} x {state.heightPx} logical px, {state.widthIn} x {state.heightIn} in export</span>
        </div>
        <div className="inline-block bg-white shadow-sm" style={{ width: state.widthPx * zoom, height: state.heightPx * zoom }}>
          <Stage
            ref={stageRef}
            width={state.widthPx * zoom}
            height={state.heightPx * zoom}
            scaleX={zoom}
            scaleY={zoom}
            onMouseDown={(e) => {
              if (e.target === e.target.getStage()) setSelectedId(null);
            }}
          >
            <Layer>
              <Rect x={0} y={0} width={state.widthPx} height={state.heightPx} fill="white" />
              {state.items.map((item) => (
                <FigurePanelNode
                  key={item.id}
                  item={item}
                  selected={item.id === selectedId}
                  onSelect={() => setSelectedId(item.id)}
                  onChange={(next) => updateItem(item.id, next)}
                  labelMode={state.panelLabelMode}
                  labelFontSize={labelFontSize}
                />
              ))}
            </Layer>
          </Stage>
        </div>
      </section>

      <aside className="space-y-3 rounded-lg border bg-background p-3">
        <div>
          <h2 className="text-sm font-semibold">Selected panel</h2>
          {selectedItem ? (
            <p className="mt-1 truncate text-xs text-muted-foreground">{selectedItem.label}. {selectedItem.name}</p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">Select a figure on the canvas.</p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Panel label</Label>
            <Input disabled={!selectedItem} value={selectedItem?.label ?? ''} onChange={(e) => selectedItem && updateItem(selectedItem.id, { ...selectedItem, label: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Graph font (pt)</Label>
            <Input type="number" min="6" max="18" value={state.unifiedFontSize} onChange={(e) => setState((prev) => ({ ...prev, unifiedFontSize: Number(e.target.value || 7) }))} />
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Palette</Label>
          <select className="w-full rounded-md border bg-background px-2 py-2 text-sm" value={paletteKey} onChange={(e) => setPaletteKey(e.target.value)}>
            {palettes.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          <div className="flex gap-1 pt-1">
            {palette.slice(0, 8).map((hex) => <span key={hex} className="h-4 w-5 rounded-sm border" style={{ backgroundColor: hex }} />)}
          </div>
        </div>
        <div className="space-y-2 border-t pt-3">
          <Button className="w-full" size="sm" disabled={!state.items.length || busy === 'ai-harmonize'} onClick={aiHarmonizeAll}>
            {busy === 'ai-harmonize' ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-2 h-3.5 w-3.5" />} AI harmonize all
          </Button>
          <Button className="w-full" size="sm" variant="outline" disabled={!selectedItem || busy === 'harmonize'} onClick={harmonizeSelected}>
            {busy === 'harmonize' ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Palette className="mr-2 h-3.5 w-3.5" />} Harmonize selected SVG
          </Button>
          <Button className="w-full" size="sm" variant="outline" disabled={!state.items.length || busy === 'harmonize-all'} onClick={harmonizeAll}>
            {busy === 'harmonize-all' ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Palette className="mr-2 h-3.5 w-3.5" />} Harmonize all SVGs
          </Button>
          <Button className="w-full" size="sm" disabled={!selectedItem?.editedSvg || busy === 'save-version'} onClick={saveSelectedAsVersion}>
            {busy === 'save-version' ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-2 h-3.5 w-3.5" />} Save panel as figure version
          </Button>
          <Button className="w-full" size="sm" variant="destructive" disabled={!selectedItem} onClick={removeSelected}>Remove from canvas</Button>
        </div>
        <div className="space-y-2 border-t pt-3">
          <Button className="w-full" size="sm" variant="outline" disabled={!state.items.length || busy === 'legend'} onClick={generateLegend}>
            {busy === 'legend' ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <FileText className="mr-2 h-3.5 w-3.5" />} AI figure legend
          </Button>
          <Textarea
            value={legend}
            onChange={(e) => {
              setLegend(e.target.value);
              setState((prev) => ({ ...prev, legend: e.target.value }));
            }}
            rows={5}
            placeholder="Generated canvas-level legend appears here."
            className="min-h-28 text-xs"
          />
        </div>
        {selectedItem?.hasUnsavedSvgEdit && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
            This panel has local SVG changes. Save it as a figure version before relying on the canvas state.
          </div>
        )}
      </aside>
    </div>
  );
}
