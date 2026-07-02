'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { getFigure, listFigures } from '@/lib/api';
import type { FigureListItem } from '@/lib/types';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Images, Loader2, Search, SearchX } from 'lucide-react';

interface FigurePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the chosen figure and its current rendered version. */
  onPick: (selection: { figureId: string; versionId: string }) => void;
}

// Dialog listing the user's ready figures; picking one resolves its current
// version (must have a rendered PNG) before handing the selection back.
export function FigurePickerDialog({ open, onOpenChange, onPick }: FigurePickerDialogProps) {
  const [search, setSearch] = useState('');
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const { data: figures, isLoading } = useQuery({ queryKey: ['figures'], queryFn: () => listFigures(), enabled: open });

  const candidates = useMemo(() => {
    const ready = (figures ?? []).filter((f) => f.status === 'ready' && f.thumb_url);
    const q = search.trim().toLowerCase();
    return q
      ? ready.filter((f) => f.name.toLowerCase().includes(q) || f.plot_type.toLowerCase().includes(q))
      : ready;
  }, [figures, search]);

  async function choose(figure: FigureListItem) {
    if (resolvingId) return;
    setResolvingId(figure.id);
    try {
      const detail = await getFigure(figure.id);
      const versionId = detail.current_version_id ?? detail.versions[detail.versions.length - 1]?.id;
      const version = detail.versions.find((v) => v.id === versionId);
      if (!versionId || !version?.png_url) {
        toast.error('This figure has no rendered PNG version yet.');
        return;
      }
      onPick({ figureId: figure.id, versionId });
      setSearch('');
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load figure');
    } finally {
      setResolvingId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) setSearch(''); }}>
      <DialogContent className="max-h-[85vh] w-[95vw] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a panel</DialogTitle>
          <DialogDescription>Choose one of your rendered figures to place in this cell.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Label htmlFor="panel-figure-search" className="sr-only">Search figures</Label>
          <Input
            id="panel-figure-search"
            type="search"
            placeholder="Search figures…"
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {isLoading ? (
          <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : candidates.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            {figures?.length
              ? <><SearchX className="mx-auto mb-2 h-6 w-6" /> No rendered figures match your search.</>
              : <><Images className="mx-auto mb-2 h-6 w-6" /> No rendered figures yet. Create a figure from a dataset first.</>}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            {candidates.map((f) => (
              <button
                key={f.id}
                type="button"
                className="group overflow-hidden rounded-lg border text-left transition hover:border-primary hover:shadow-sm disabled:opacity-60"
                onClick={() => choose(f)}
                disabled={Boolean(resolvingId)}
              >
                <div className="relative">
                  <img src={f.thumb_url} alt={f.name} loading="lazy" decoding="async" className="aspect-[4/3] w-full bg-white object-contain" />
                  {resolvingId === f.id && (
                    <div className="absolute inset-0 flex items-center justify-center bg-background/60">
                      <Loader2 className="h-5 w-5 animate-spin" />
                    </div>
                  )}
                </div>
                <div className="p-2">
                  <p className="truncate text-sm font-medium">{f.name}</p>
                  <p className="text-xs text-muted-foreground">{f.plot_type}</p>
                </div>
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
