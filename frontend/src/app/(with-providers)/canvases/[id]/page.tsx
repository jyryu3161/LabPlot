'use client';

import { use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { downloadCanvasExport, getCanvas, listFigures, renderCanvas, updateCanvas } from '@/lib/api';
import type { CanvasPanelItem, CanvasState } from '@/lib/types';
import { AppHeader } from '@/components/layout/AppHeader';
import { FigurePickerDialog } from '@/components/canvases/FigurePickerDialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertTriangle, ArrowLeft, Check, Download, Images, LayoutGrid, Loader2, Pencil, Play, Plus, RotateCcw, Save, X,
} from 'lucide-react';

const GRID_SIZES = ['1', '2', '3', '4'];
type LabelStyle = NonNullable<CanvasState['label_style']>;
const LABEL_STYLE_LABELS: Record<LabelStyle, string> = { lower: 'a, b, c', upper: 'A, B, C', none: 'None' };

function defaultLabel(style: CanvasState['label_style'], index: number): string | undefined {
  if (style === 'none') return undefined;
  const letter = String.fromCharCode(97 + (index % 26));
  return style === 'upper' ? letter.toUpperCase() : letter;
}

// Reassign default labels in reading order (used when the label style changes).
function relabelItems(items: CanvasPanelItem[], style: CanvasState['label_style']): CanvasPanelItem[] {
  return [...items]
    .sort((a, b) => a.row - b.row || a.col - b.col)
    .map((item, index) => ({ ...item, label: defaultLabel(style, index) }));
}

export default function CanvasDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const { data: canvas, isLoading, isError, error, refetch } = useQuery({ queryKey: ['canvas', id], queryFn: () => getCanvas(id) });
  // Figure metadata (name + thumbnail) for the panels placed on this canvas.
  const { data: figures } = useQuery({ queryKey: ['figures'], queryFn: () => listFigures() });
  const figMap = useMemo(() => new Map((figures ?? []).map((f) => [f.id, f])), [figures]);

  const [draft, setDraft] = useState<CanvasState | null>(null);
  const [renderResult, setRenderResult] = useState<{ png_url: string; pdf_url: string } | null>(null);
  const [pickerCell, setPickerCell] = useState<{ row: number; col: number } | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);

  const state = draft ?? canvas?.state ?? null;
  const dirty = Boolean(draft && canvas && JSON.stringify(draft) !== JSON.stringify(canvas.state));
  const previewPngUrl = renderResult?.png_url ?? canvas?.png_url ?? null;
  // Draft edits invalidate whatever composite was rendered before.
  const previewStale = dirty && Boolean(previewPngUrl);

  // Warn before losing an unsaved layout on reload/close.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const save = useMutation({
    mutationFn: (nextState: CanvasState) => updateCanvas(id, { state: nextState }),
    onSuccess: (updated) => {
      toast.success('Layout saved');
      setDraft(null);
      setRenderResult(null); // PATCHing state clears the render output server-side.
      qc.setQueryData(['canvas', id], updated);
      qc.invalidateQueries({ queryKey: ['canvases'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Save failed'),
  });

  const rename = useMutation({
    mutationFn: (name: string) => updateCanvas(id, { name }),
    onSuccess: (updated) => {
      toast.success('Canvas renamed');
      setEditingName(null);
      qc.setQueryData(['canvas', id], updated);
      qc.invalidateQueries({ queryKey: ['canvases'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Rename failed'),
  });

  const render = useMutation({
    mutationFn: async () => {
      // Persist a dirty layout first: rendering always applies the saved state.
      if (dirty && draft) {
        const updated = await updateCanvas(id, { state: draft });
        setDraft(null);
        qc.setQueryData(['canvas', id], updated);
      }
      return renderCanvas(id);
    },
    onSuccess: (res) => {
      toast.success('Canvas rendered');
      setRenderResult(res);
      qc.invalidateQueries({ queryKey: ['canvas', id] });
      qc.invalidateQueries({ queryKey: ['canvases'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Render failed'),
  });

  function updateState(mutator: (current: CanvasState) => CanvasState) {
    if (!state) return;
    setDraft(mutator({ ...state, items: state.items.map((item) => ({ ...item })) }));
  }

  function setGridSize(dim: 'rows' | 'cols', value: number) {
    updateState((current) => {
      const next = { ...current, [dim]: value };
      const kept = current.items.filter((item) => item.row <= next.rows && item.col <= next.cols);
      const dropped = current.items.length - kept.length;
      if (dropped > 0) toast.info(`${dropped} panel${dropped === 1 ? '' : 's'} removed — outside the new grid`);
      return { ...next, items: kept };
    });
  }

  function setLabelStyle(style: LabelStyle) {
    updateState((current) => ({ ...current, label_style: style, items: relabelItems(current.items, style) }));
  }

  function addPanel(cell: { row: number; col: number }, selection: { figureId: string; versionId: string }) {
    updateState((current) => ({
      ...current,
      items: [
        ...current.items,
        {
          figure_id: selection.figureId,
          version_id: selection.versionId,
          row: cell.row,
          col: cell.col,
          label: defaultLabel(current.label_style ?? 'lower', current.items.length),
        },
      ],
    }));
  }

  function removePanel(row: number, col: number) {
    updateState((current) => ({ ...current, items: current.items.filter((item) => item.row !== row || item.col !== col) }));
  }

  function setPanelLabel(row: number, col: number, label: string) {
    updateState((current) => ({
      ...current,
      items: current.items.map((item) => (item.row === row && item.col === col ? { ...item, label: label || undefined } : item)),
    }));
  }

  function submitRename() {
    const name = editingName?.trim();
    if (!name || name === canvas?.name) { setEditingName(null); return; }
    rename.mutate(name);
  }

  async function doDownload(fmt: 'png' | 'pdf') {
    try { await downloadCanvasExport(id, fmt, `${canvas?.name ?? 'canvas'}.${fmt}`); }
    catch { toast.error('Export failed'); }
  }

  return (
    <div className="min-h-screen bg-muted/20">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-4 py-8">
        {isLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : isError || !canvas || !state ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-12 text-center">
            <AlertTriangle className="mx-auto mb-2 h-8 w-8 text-destructive" />
            <p className="mb-4 text-sm text-muted-foreground">{error instanceof Error ? error.message : 'Could not load this canvas.'}</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}><RotateCcw className="mr-1 h-4 w-4" /> Retry</Button>
          </div>
        ) : (
          <>
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <Link
                  href="/canvases"
                  className="mb-1 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                  onClick={(event) => {
                    if (dirty && !window.confirm('You have unsaved layout changes. Leave this page and discard them?')) event.preventDefault();
                  }}
                >
                  <ArrowLeft className="h-4 w-4" /> Canvases
                </Link>
                {editingName !== null ? (
                  <div className="flex items-center gap-2">
                    <Input
                      className="h-9 max-w-sm text-lg font-semibold"
                      value={editingName}
                      maxLength={255}
                      autoFocus
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitRename();
                        if (e.key === 'Escape') setEditingName(null);
                      }}
                    />
                    <Button type="button" size="icon-sm" variant="secondary" aria-label="Save name" disabled={rename.isPending} onClick={submitRename}>
                      {rename.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    </Button>
                    <Button type="button" size="icon-sm" variant="ghost" aria-label="Cancel rename" onClick={() => setEditingName(null)}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <h1 className="truncate text-2xl font-bold">{canvas.name}</h1>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label="Rename canvas" onClick={() => setEditingName(canvas.name)}>
                      <Pencil className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    {dirty && <Badge variant="outline" className="border-amber-400 text-amber-600">Unsaved changes</Badge>}
                  </div>
                )}
                {canvas.description && <p className="text-sm text-muted-foreground">{canvas.description}</p>}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={() => draft && save.mutate(draft)} disabled={!dirty || save.isPending || render.isPending}>
                  {save.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />} Save layout
                </Button>
                <Button onClick={() => render.mutate()} disabled={render.isPending || save.isPending || state.items.length === 0}>
                  {render.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Play className="mr-1 h-4 w-4" />} Render
                </Button>
              </div>
            </div>

            <Card className="mb-6">
              <CardContent className="flex flex-wrap items-end gap-4 pt-6">
                <div className="space-y-1">
                  <Label htmlFor="canvas-rows">Rows</Label>
                  <Select value={String(state.rows)} onValueChange={(v) => setGridSize('rows', Number(v))}>
                    <SelectTrigger id="canvas-rows" size="sm" aria-label="Rows" className="w-20">
                      <SelectValue>{(v) => String(v)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {GRID_SIZES.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="canvas-cols">Columns</Label>
                  <Select value={String(state.cols)} onValueChange={(v) => setGridSize('cols', Number(v))}>
                    <SelectTrigger id="canvas-cols" size="sm" aria-label="Columns" className="w-20">
                      <SelectValue>{(v) => String(v)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {GRID_SIZES.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="canvas-labels">Panel labels</Label>
                  <Select value={state.label_style ?? 'lower'} onValueChange={(v) => setLabelStyle(v as LabelStyle)}>
                    <SelectTrigger id="canvas-labels" size="sm" aria-label="Panel labels" className="w-28">
                      <SelectValue>{(v) => LABEL_STYLE_LABELS[v as LabelStyle] ?? LABEL_STYLE_LABELS.lower}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(LABEL_STYLE_LABELS) as LabelStyle[]).map((key) => (
                        <SelectItem key={key} value={key}>{LABEL_STYLE_LABELS[key]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Badge variant="secondary" className="mb-1 ml-auto">
                  <LayoutGrid className="mr-1 h-3 w-3" />{state.items.length} / {state.rows * state.cols} panels
                </Badge>
              </CardContent>
            </Card>

            <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${state.cols}, minmax(0, 1fr))` }}>
              {Array.from({ length: state.rows }).flatMap((_, rowIndex) =>
                Array.from({ length: state.cols }).map((_, colIndex) => {
                  const row = rowIndex + 1;
                  const col = colIndex + 1;
                  const item = state.items.find((i) => i.row === row && i.col === col);
                  if (!item) {
                    return (
                      <button
                        key={`${row}-${col}`}
                        type="button"
                        className="flex aspect-[4/3] flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-sm text-muted-foreground transition hover:border-primary hover:text-foreground"
                        onClick={() => setPickerCell({ row, col })}
                      >
                        <Plus className="h-5 w-5" /> Add panel
                      </button>
                    );
                  }
                  const figure = figMap.get(item.figure_id);
                  return (
                    <div key={`${row}-${col}`} className="relative flex flex-col overflow-hidden rounded-lg border bg-background">
                      {item.label && (
                        <span className="absolute left-1.5 top-1.5 z-10 rounded bg-background/85 px-1.5 py-0.5 text-sm font-bold">{item.label}</span>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="absolute right-1.5 top-1.5 z-10 bg-background/85"
                        aria-label={`Remove panel at row ${row}, column ${col}`}
                        onClick={() => removePanel(row, col)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                      {figure?.thumb_url
                        ? <img src={figure.thumb_url} alt={figure.name} loading="lazy" decoding="async" className="aspect-[4/3] w-full bg-white object-contain" />
                        : <div className="flex aspect-[4/3] items-center justify-center bg-muted text-muted-foreground"><Images className="h-6 w-6" /></div>}
                      <div className="flex items-center gap-2 border-t p-2">
                        <p className="min-w-0 flex-1 truncate text-xs font-medium">{figure?.name ?? 'Figure'}</p>
                        <Label htmlFor={`panel-label-${row}-${col}`} className="sr-only">Panel label</Label>
                        <Input
                          id={`panel-label-${row}-${col}`}
                          className="h-7 w-16 text-xs"
                          placeholder="Label"
                          maxLength={8}
                          value={item.label ?? ''}
                          onChange={(e) => setPanelLabel(row, col, e.target.value)}
                        />
                      </div>
                    </div>
                  );
                }))}
            </div>

            <Card className="mt-6">
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base">Rendered output</CardTitle>
                  {previewPngUrl && (
                    <div className="flex items-center gap-2">
                      {previewStale && <Badge variant="outline" className="border-amber-400 text-amber-600">Outdated — re-render to update</Badge>}
                      <Button variant="outline" size="sm" onClick={() => doDownload('png')}>
                        <Download className="mr-1 h-4 w-4" /> PNG
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => doDownload('pdf')}>
                        <Download className="mr-1 h-4 w-4" /> PDF
                      </Button>
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {render.isPending ? (
                  <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin" /></div>
                ) : previewPngUrl ? (
                  <img src={previewPngUrl} alt={`${canvas.name} composite`} className="mx-auto max-h-[70vh] w-auto rounded-md border bg-white object-contain" />
                ) : (
                  <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
                    {state.items.length === 0
                      ? 'Add at least one panel, then render to compose the figure.'
                      : 'Not rendered yet. Click Render to compose the panels into one figure.'}
                  </div>
                )}
              </CardContent>
            </Card>

            <FigurePickerDialog
              open={pickerCell !== null}
              onOpenChange={(next) => { if (!next) setPickerCell(null); }}
              onPick={(selection) => { if (pickerCell) addPanel(pickerCell, selection); }}
            />
          </>
        )}
      </main>
    </div>
  );
}
