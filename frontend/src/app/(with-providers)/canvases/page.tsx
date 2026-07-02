'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { createCanvas, deleteCanvas, getCanvasPresets, listCanvases } from '@/lib/api';
import { AppHeader } from '@/components/layout/AppHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertTriangle, LayoutGrid, Layers, Loader2, Plus, RotateCcw, Search, SearchX, Trash2 } from 'lucide-react';

const MM_MIN = 20;
const MM_MAX = 500;
const CUSTOM = 'custom';

function clampMm(value: number): number {
  if (Number.isNaN(value)) return MM_MIN;
  return Math.min(MM_MAX, Math.max(MM_MIN, Math.round(value)));
}

function formatUpdated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function CanvasesPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);

  // Create-dialog form state
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [presetKey, setPresetKey] = useState<string>(CUSTOM);
  const [widthMm, setWidthMm] = useState<number>(180);
  const [heightMm, setHeightMm] = useState<number>(120);

  const { data: canvases, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['canvases'],
    queryFn: () => listCanvases(),
  });
  const { data: presets } = useQuery({
    queryKey: ['canvas-presets'],
    queryFn: getCanvasPresets,
  });

  // Seed the form with the first preset once presets load and while the dialog is closed.
  useEffect(() => {
    if (!open && presets?.length && presetKey === CUSTOM) {
      const first = presets[0];
      setPresetKey(first.key);
      setWidthMm(first.width_mm);
      setHeightMm(first.height_mm);
    }
  }, [presets, open, presetKey]);

  const visibleCanvases = useMemo(() => {
    if (!canvases) return [];
    const q = search.trim().toLowerCase();
    return q ? canvases.filter((c) => c.name.toLowerCase().includes(q)) : canvases;
  }, [canvases, search]);

  const create = useMutation({
    mutationFn: () => createCanvas({
      name: name.trim(),
      description: desc.trim() || undefined,
      preset: presetKey === CUSTOM ? undefined : presetKey,
      width_mm: clampMm(widthMm),
      height_mm: clampMm(heightMm),
    }),
    onSuccess: (canvas) => {
      toast.success('Canvas created');
      qc.invalidateQueries({ queryKey: ['canvases'] });
      setOpen(false);
      router.push(`/canvases/${canvas.id}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Create failed'),
  });

  const del = useMutation({
    mutationFn: deleteCanvas,
    onSuccess: () => { toast.success('Canvas deleted'); qc.invalidateQueries({ queryKey: ['canvases'] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Delete failed'),
  });

  function onPresetChange(key: string | null) {
    const next = key ?? CUSTOM;
    setPresetKey(next);
    if (next !== CUSTOM) {
      const preset = presets?.find((p) => p.key === next);
      if (preset) {
        setWidthMm(preset.width_mm);
        setHeightMm(preset.height_mm);
      }
    }
  }

  function onDialogOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      // Reset to a clean form, seeded with the first preset if available.
      setName('');
      setDesc('');
      const first = presets?.[0];
      if (first) {
        setPresetKey(first.key);
        setWidthMm(first.width_mm);
        setHeightMm(first.height_mm);
      } else {
        setPresetKey(CUSTOM);
      }
    }
  }

  const canSubmit = name.trim().length > 0 && !create.isPending;

  return (
    <div className="min-h-screen bg-muted/20">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Canvases</h1>
            <p className="text-sm text-muted-foreground">Compose multi-panel figures at physical (mm) print size.</p>
          </div>
          <Button onClick={() => onDialogOpenChange(true)}><Plus className="mr-1 h-4 w-4" /> New canvas</Button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : isError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-12 text-center">
            <AlertTriangle className="mx-auto mb-2 h-8 w-8 text-destructive" />
            <p className="mb-4 text-sm text-muted-foreground">{error instanceof Error ? error.message : 'Could not load canvases.'}</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}><RotateCcw className="mr-1 h-4 w-4" /> Retry</Button>
          </div>
        ) : !canvases?.length ? (
          <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
            <LayoutGrid className="mx-auto mb-2 h-8 w-8" /> No canvases yet. Create one to compose a multi-panel figure.
          </div>
        ) : (
          <>
            <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative w-full sm:max-w-xs">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Label htmlFor="canvases-search" className="sr-only">Search canvases</Label>
                <Input id="canvases-search" type="search" placeholder="Search canvases…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
            </div>
            {visibleCanvases.length === 0 ? (
              <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
                <SearchX className="mx-auto mb-2 h-8 w-8" /> No canvases match your search.
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {visibleCanvases.map((c) => (
                  <Card key={c.id} className="group h-full transition hover:shadow-md">
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => router.push(`/canvases/${c.id}`)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <p className="flex items-center gap-2 truncate font-medium">
                            <LayoutGrid className="h-4 w-4 shrink-0 text-primary" />
                            <span className="truncate">{c.name}</span>
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {c.width_mm} × {c.height_mm} mm
                          </p>
                        </button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Delete canvas ${c.name}`}
                          onClick={() => { if (confirm(`Delete canvas "${c.name}"?`)) del.mutate(c.id); }}
                          disabled={del.isPending}
                        >
                          <Trash2 className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      </div>
                      <button
                        type="button"
                        onClick={() => router.push(`/canvases/${c.id}`)}
                        className="mt-3 flex w-full items-center justify-between text-left"
                      >
                        <Badge variant="secondary">
                          <Layers className="mr-1 h-3 w-3" />
                          {c.panel_count} panel{c.panel_count === 1 ? '' : 's'}
                        </Badge>
                        <span className="text-xs text-muted-foreground">Updated {formatUpdated(c.updated_at)}</span>
                      </button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}
      </main>

      <Dialog open={open} onOpenChange={onDialogOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New canvas</DialogTitle>
            <DialogDescription>Pick a journal preset or set a custom physical size (mm).</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => { e.preventDefault(); if (canSubmit) create.mutate(); }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="canvas-name">Name</Label>
              <Input
                id="canvas-name"
                value={name}
                autoFocus
                maxLength={255}
                placeholder="e.g. Figure 1 — main"
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="canvas-preset">Preset</Label>
              <Select value={presetKey} onValueChange={onPresetChange}>
                <SelectTrigger id="canvas-preset" aria-label="Canvas size preset" className="w-full">
                  <SelectValue placeholder="Choose a preset" />
                </SelectTrigger>
                <SelectContent>
                  {presets?.map((p) => (
                    <SelectItem key={p.key} value={p.key}>
                      {p.label} ({p.width_mm} × {p.height_mm} mm)
                    </SelectItem>
                  ))}
                  <SelectItem value={CUSTOM}>Custom size</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="canvas-width">Width (mm)</Label>
                <Input
                  id="canvas-width"
                  type="number"
                  inputMode="numeric"
                  min={MM_MIN}
                  max={MM_MAX}
                  value={widthMm}
                  onChange={(e) => { setWidthMm(Number(e.target.value)); setPresetKey(CUSTOM); }}
                  onBlur={() => setWidthMm((v) => clampMm(v))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="canvas-height">Height (mm)</Label>
                <Input
                  id="canvas-height"
                  type="number"
                  inputMode="numeric"
                  min={MM_MIN}
                  max={MM_MAX}
                  value={heightMm}
                  onChange={(e) => { setHeightMm(Number(e.target.value)); setPresetKey(CUSTOM); }}
                  onBlur={() => setHeightMm((v) => clampMm(v))}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">Each side is clamped to {MM_MIN}–{MM_MAX} mm.</p>

            <div className="space-y-1.5">
              <Label htmlFor="canvas-desc">Description</Label>
              <Textarea
                id="canvas-desc"
                value={desc}
                rows={2}
                placeholder="Optional"
                onChange={(e) => setDesc(e.target.value)}
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={create.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {create.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
                Create canvas
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
