'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { createCanvas, deleteCanvas, listCanvases } from '@/lib/api';
import { AppHeader } from '@/components/layout/AppHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertTriangle, LayoutGrid, Loader2, Plus, RotateCcw, Trash2 } from 'lucide-react';

const GRID_SIZES = ['1', '2', '3', '4'];

export default function CanvasesPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const { data: canvases, isLoading, isError, error, refetch } = useQuery({ queryKey: ['canvases'], queryFn: () => listCanvases() });

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [rows, setRows] = useState('2');
  const [cols, setCols] = useState('2');

  function resetForm() {
    setName('');
    setDesc('');
    setRows('2');
    setCols('2');
  }

  const create = useMutation({
    mutationFn: () => createCanvas({
      name: name.trim(),
      description: desc.trim() || undefined,
      state: { rows: Number(rows), cols: Number(cols), label_style: 'lower', items: [] },
    }),
    onSuccess: (created) => {
      toast.success('Canvas created');
      resetForm();
      setOpen(false);
      qc.invalidateQueries({ queryKey: ['canvases'] });
      router.push(`/canvases/${created.id}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Create failed'),
  });
  const del = useMutation({
    mutationFn: deleteCanvas,
    onSuccess: () => { toast.success('Canvas deleted'); qc.invalidateQueries({ queryKey: ['canvases'] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Delete failed'),
  });

  return (
    <div className="min-h-screen bg-muted/20">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Canvases</h1>
            <p className="text-sm text-muted-foreground">Compose multi-panel figures from your rendered plots.</p>
          </div>
          <Button onClick={() => setOpen(true)}><Plus className="mr-1 h-4 w-4" /> New canvas</Button>
        </div>

        <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) resetForm(); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>New canvas</DialogTitle>
              <DialogDescription>Pick a name and a starting grid. You can change the grid later.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="canvas-name">Name</Label>
                <Input id="canvas-name" value={name} maxLength={255} onChange={(e) => setName(e.target.value)} placeholder="e.g. Figure 2 — dose response" autoFocus />
              </div>
              <div className="space-y-1">
                <Label htmlFor="canvas-desc">Description</Label>
                <Input id="canvas-desc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Optional" />
              </div>
              <div className="flex gap-4">
                <div className="space-y-1">
                  <Label htmlFor="canvas-rows">Rows</Label>
                  <Select value={rows} onValueChange={(v) => setRows(v as string)}>
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
                  <Select value={cols} onValueChange={(v) => setCols(v as string)}>
                    <SelectTrigger id="canvas-cols" size="sm" aria-label="Columns" className="w-20">
                      <SelectValue>{(v) => String(v)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {GRID_SIZES.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setOpen(false); resetForm(); }}>Cancel</Button>
              <Button onClick={() => create.mutate()} disabled={create.isPending || !name.trim()}>
                {create.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />} Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

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
            <LayoutGrid className="mx-auto mb-2 h-8 w-8" /> No canvases yet. Create one to arrange your figures into a multi-panel composite.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {canvases.map((c) => (
              <Card key={c.id} className="group overflow-hidden transition hover:shadow-md">
                <Link href={`/canvases/${c.id}`}>
                  {c.png_url
                    ? <img src={c.png_url} alt={c.name} loading="lazy" decoding="async" className="aspect-[4/3] w-full bg-white object-contain" />
                    : <div className="flex aspect-[4/3] items-center justify-center bg-muted text-muted-foreground"><LayoutGrid className="h-8 w-8" /></div>}
                </Link>
                <CardContent className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <Link href={`/canvases/${c.id}`} className="block min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{c.name}</p>
                      <p className="text-xs text-muted-foreground">Updated {new Date(c.updated_at).toLocaleDateString()}</p>
                    </Link>
                    <Button type="button" variant="ghost" size="sm" aria-label={`Delete ${c.name}`} onClick={() => { if (confirm(`Delete canvas "${c.name}"?`)) del.mutate(c.id); }}>
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                  <Badge variant="secondary" className="mt-2">
                    <LayoutGrid className="mr-1 h-3 w-3" />{c.panel_count} panel{c.panel_count === 1 ? '' : 's'}
                  </Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
