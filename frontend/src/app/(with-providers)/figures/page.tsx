'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { deleteFigureTemplateFavorite, listFigures, deleteFigure, saveFigureTemplateFavorite, updateFigure } from '@/lib/api';
import { AppHeader } from '@/components/layout/AppHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertTriangle, Check, Images, Loader2, Pencil, RotateCcw, Search, SearchX, Star, Trash2, X } from 'lucide-react';
import { formatStylePreset } from '@/lib/style-presets';

type SortKey = 'saved' | 'name' | 'newest' | 'oldest';
const SORT_LABELS: Record<SortKey, string> = {
  saved: 'Saved order',
  name: 'Name A–Z',
  newest: 'Newest',
  oldest: 'Oldest',
};

export default function FiguresPage() {
  const qc = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('saved');
  const { data: figures, isLoading, isError, error, refetch } = useQuery({ queryKey: ['figures'], queryFn: () => listFigures() });

  const visibleFigures = useMemo(() => {
    if (!figures) return [];
    const q = search.trim().toLowerCase();
    const filtered = q
      ? figures.filter((f) => f.name.toLowerCase().includes(q) || f.plot_type.toLowerCase().includes(q))
      : figures;
    if (sort === 'saved') return filtered;
    const sorted = [...filtered];
    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'newest') sorted.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    else if (sort === 'oldest') sorted.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    return sorted;
  }, [figures, search, sort]);
  const del = useMutation({
    mutationFn: deleteFigure,
    onSuccess: () => { toast.success('Figure deleted'); qc.invalidateQueries({ queryKey: ['figures'] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Delete failed'),
  });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => updateFigure(id, { name }),
    onSuccess: () => {
      toast.success('Figure renamed');
      setEditingId(null);
      setEditingName('');
      qc.invalidateQueries({ queryKey: ['figures'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Rename failed'),
  });
  const favorite = useMutation({
    mutationFn: async ({ id, next }: { id: string; next: boolean }) => {
      if (next) {
        await saveFigureTemplateFavorite(id);
        return true;
      }
      await deleteFigureTemplateFavorite(id);
      return false;
    },
    onSuccess: (saved) => {
      toast.success(saved ? 'Saved as a template' : 'Removed from saved templates');
      qc.invalidateQueries({ queryKey: ['figures'] });
      qc.invalidateQueries({ queryKey: ['figure-template-favorites'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Template update failed'),
  });

  function beginRename(id: string, name: string) {
    setEditingId(id);
    setEditingName(name);
  }

  function submitRename(id: string, fallbackName: string) {
    const name = editingName.trim();
    if (!name || name === fallbackName) {
      setEditingId(null);
      setEditingName('');
      return;
    }
    rename.mutate({ id, name });
  }

  return (
    <div className="min-h-screen bg-muted/20">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold">Figures</h1>
        {isLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : isError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-12 text-center">
            <AlertTriangle className="mx-auto mb-2 h-8 w-8 text-destructive" />
            <p className="mb-4 text-sm text-muted-foreground">{error instanceof Error ? error.message : 'Could not load figures.'}</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}><RotateCcw className="mr-1 h-4 w-4" /> Retry</Button>
          </div>
        ) : !figures?.length ? (
          <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
            <Images className="mx-auto mb-2 h-8 w-8" /> No figures yet. Open a dataset to create one.
          </div>
        ) : (
          <>
            <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative w-full sm:max-w-xs">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Label htmlFor="figures-search" className="sr-only">Search figures</Label>
                <Input id="figures-search" type="search" placeholder="Search figures…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <Select value={sort} onValueChange={(value) => setSort(value as SortKey)}>
                <SelectTrigger id="figures-sort" size="sm" aria-label="Sort figures" className="w-[160px]">
                  <SelectValue>{(value) => SORT_LABELS[value as SortKey] ?? SORT_LABELS.saved}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="saved">Saved order</SelectItem>
                  <SelectItem value="name">Name A–Z</SelectItem>
                  <SelectItem value="newest">Newest</SelectItem>
                  <SelectItem value="oldest">Oldest</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {visibleFigures.length === 0 ? (
              <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
                <SearchX className="mx-auto mb-2 h-8 w-8" /> No figures match your search.
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {visibleFigures.map((f) => (
              <Card key={f.id} className="group overflow-hidden transition hover:shadow-md">
                <Link href={`/figures/${f.id}`}>
                  {f.thumb_url
                    ? <img src={f.thumb_url} alt={f.name} loading="lazy" decoding="async" className="aspect-[4/3] w-full bg-white object-contain" />
                    : <div className="flex aspect-[4/3] items-center justify-center bg-muted text-muted-foreground"><Images className="h-8 w-8" /></div>}
                </Link>
                <CardContent className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      {editingId === f.id ? (
                        <div className="space-y-1">
                          <Input
                            className="h-8 text-sm"
                            value={editingName}
                            maxLength={255}
                            autoFocus
                            onChange={(event) => setEditingName(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') submitRename(f.id, f.name);
                              if (event.key === 'Escape') {
                                setEditingId(null);
                                setEditingName('');
                              }
                            }}
                          />
                          <div className="flex gap-1">
                            <Button type="button" size="icon-xs" variant="secondary" disabled={rename.isPending} onClick={() => submitRename(f.id, f.name)}>
                              {rename.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                            </Button>
                            <Button type="button" size="icon-xs" variant="ghost" onClick={() => { setEditingId(null); setEditingName(''); }}>
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Link href={`/figures/${f.id}`} className="block min-w-0">
                          <p className="truncate text-sm font-medium">{f.name}</p>
                          <p className="text-xs text-muted-foreground">{f.plot_type}</p>
                        </Link>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Rename ${f.name}`}
                      onClick={() => beginRename(f.id, f.name)}
                      disabled={rename.isPending && editingId === f.id}
                    >
                      <Pencil className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={f.is_favorite ? `Remove ${f.name} from saved templates` : `Save ${f.name} as template`}
                      onClick={() => favorite.mutate({ id: f.id, next: !f.is_favorite })}
                      disabled={favorite.isPending}
                    >
                      <Star className={`h-4 w-4 ${f.is_favorite ? 'fill-amber-400 text-amber-500' : 'text-muted-foreground'}`} />
                    </Button>
                    <Button type="button" variant="ghost" size="sm" aria-label={`Delete ${f.name}`} onClick={() => { if (confirm(`Delete ${f.name}?`)) del.mutate(f.id); }}>
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                  <Badge variant="outline" className="mt-2">{formatStylePreset(f.style_preset)}</Badge>
                </CardContent>
              </Card>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
