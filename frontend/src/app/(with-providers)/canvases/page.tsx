'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { deleteCanvas, duplicateCanvas, listCanvases, listProjects } from '@/lib/api';
import { AppHeader } from '@/components/layout/AppHeader';
import { NewCanvasDialog } from '@/components/canvases/NewCanvasDialog';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertTriangle, Copy, FlaskConical, LayoutGrid, Layers, Loader2, Plus, RotateCcw, Search, SearchX, Trash2 } from 'lucide-react';

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

  const { data: canvases, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['canvases'],
    queryFn: () => listCanvases(),
  });
  // Project names for the badge on project-scoped canvases (U3).
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: listProjects });
  const projectNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects ?? []) m.set(p.id, p.name);
    return m;
  }, [projects]);

  const visibleCanvases = useMemo(() => {
    if (!canvases) return [];
    const q = search.trim().toLowerCase();
    return q ? canvases.filter((c) => c.name.toLowerCase().includes(q)) : canvases;
  }, [canvases, search]);

  const del = useMutation({
    mutationFn: deleteCanvas,
    onSuccess: () => { toast.success('Canvas deleted'); qc.invalidateQueries({ queryKey: ['canvases'] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Delete failed'),
  });
  const duplicate = useMutation({
    mutationFn: duplicateCanvas,
    onSuccess: () => { toast.success('Canvas duplicated'); qc.invalidateQueries({ queryKey: ['canvases'] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Duplicate failed'),
  });

  return (
    <div className="min-h-screen bg-muted/20">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Canvases</h1>
            <p className="text-sm text-muted-foreground">Compose multi-panel figures at physical (mm) print size.</p>
          </div>
          <Button onClick={() => setOpen(true)}><Plus className="mr-1 h-4 w-4" /> New canvas</Button>
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
                        <div className="flex items-center gap-0.5">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={`Duplicate canvas ${c.name}`}
                            title="Duplicate this canvas (panels, annotations included)"
                            onClick={() => duplicate.mutate(c.id)}
                            disabled={duplicate.isPending}
                          >
                            <Copy className="h-4 w-4 text-muted-foreground" />
                          </Button>
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
                      </div>
                      <button
                        type="button"
                        onClick={() => router.push(`/canvases/${c.id}`)}
                        className="mt-3 flex w-full items-center justify-between gap-2 text-left"
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <Badge variant="secondary">
                            <Layers className="mr-1 h-3 w-3" />
                            {c.panel_count} panel{c.panel_count === 1 ? '' : 's'}
                          </Badge>
                          {c.project_id && (
                            <Badge variant="outline" className="min-w-0">
                              <FlaskConical className="mr-1 h-3 w-3 shrink-0" />
                              <span className="truncate">{projectNames.get(c.project_id) ?? 'Project'}</span>
                            </Badge>
                          )}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">Updated {formatUpdated(c.updated_at)}</span>
                      </button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}
      </main>

      <NewCanvasDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
