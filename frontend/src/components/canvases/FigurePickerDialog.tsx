'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listFigures } from '@/lib/api';
import type { FigureListItem } from '@/lib/types';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Loader2, ImageOff } from 'lucide-react';

/**
 * Figure picker for "＋ Add figure". Lists the user's figures with rendered
 * thumbnails; only `status: 'ready'` figures can be added (others have no
 * committed version to render into a panel). Clicking a card calls `onPick`.
 */
export function FigurePickerDialog({
  open,
  onOpenChange,
  onPick,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (figure: FigureListItem, opts: { copy: boolean }) => void;
  /** Project-canvas scope (U3, grilling Q7-a): default the list to this
   *  project's figures; personal figures placed on a shared canvas 404 for
   *  collaborators, so mixing is steered against (never hard-blocked). */
  projectId?: string | null;
}) {
  const [query, setQuery] = useState('');
  // "Canvas-only copy": duplicate the figure and place the copy, so edits made
  // inside this canvas never propagate to the original (or other canvases).
  // Reset when the dialog closes — a sticky checkbox would surprise on reopen.
  const [copy, setCopy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    if (!open) { setCopy(false); setShowAll(false); }
  }, [open]);
  const scoped = Boolean(projectId) && !showAll;
  const { data: figures, isLoading } = useQuery({
    queryKey: ['figures', scoped ? projectId : 'all'],
    queryFn: () => (scoped ? listFigures(projectId as string) : listFigures()),
    enabled: open,
  });

  const ready = (figures ?? []).filter((f) => f.status === 'ready');
  const q = query.trim().toLowerCase();
  const visible = q
    ? ready.filter((f) => f.name.toLowerCase().includes(q) || f.plot_type.toLowerCase().includes(q))
    : ready;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] w-[95vw] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a figure</DialogTitle>
          <DialogDescription>Pick a ready figure to place on the canvas as a new panel.</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          placeholder="Search figures…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search figures"
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            {/* Accessible name comes from the wrapping label text (WCAG 2.5.3). */}
            <input
              type="checkbox"
              checked={copy}
              onChange={(e) => setCopy(e.target.checked)}
            />
            Add as a canvas-only copy — edits in this canvas won’t change the original figure
          </label>
          {projectId && (
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
              />
              Show all my figures (not just this project’s)
            </label>
          )}
        </div>
        <div className="max-h-[55vh] overflow-y-auto">
          {isLoading ? (
            <div className="py-12 text-center text-muted-foreground">
              <Loader2 className="mx-auto h-5 w-5 animate-spin" />
            </div>
          ) : visible.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {ready.length === 0 ? 'No ready figures yet. Create a figure first.' : 'No figures match your search.'}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 p-1 sm:grid-cols-3">
              {visible.map((fig) => (
                <button
                  key={fig.id}
                  type="button"
                  onClick={() => onPick(fig, { copy })}
                  className="group flex flex-col overflow-hidden rounded-lg border bg-card text-left transition hover:border-primary hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex aspect-[4/3] items-center justify-center bg-white">
                    {fig.thumb_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={fig.thumb_url}
                        alt={fig.name}
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <ImageOff className="h-6 w-6 text-muted-foreground" />
                    )}
                  </div>
                  <div className="border-t px-2 py-1.5">
                    <p className="truncate text-xs font-medium" title={fig.name}>{fig.name}</p>
                    <p className="truncate text-[10px] text-muted-foreground">{fig.plot_type}</p>
                    {projectId && showAll && fig.project_id !== projectId && (
                      <p className="mt-0.5 truncate text-[10px] text-amber-600" title="This figure is outside the project — project collaborators won't be able to see this panel.">
                        ⚠ Not visible to collaborators
                      </p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
