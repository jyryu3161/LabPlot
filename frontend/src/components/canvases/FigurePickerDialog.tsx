'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { getPublicGallery, listFigures } from '@/lib/api';
import type { FigureListItem, PublicFigure } from '@/lib/types';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Loader2, ImageOff } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

const RECENT_FIGURES_KEY = 'labplot.canvas.recent-figures.v1';
type FigureSource = 'project' | 'mine' | 'templates' | 'recent';

function readRecentFigureIds(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_FIGURES_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 24) : [];
  } catch {
    return [];
  }
}

function rememberFigure(figureId: string): string[] {
  const ids = [figureId, ...readRecentFigureIds().filter((id) => id !== figureId)].slice(0, 24);
  localStorage.setItem(RECENT_FIGURES_KEY, JSON.stringify(ids));
  return ids;
}

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
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [placementMode, setPlacementMode] = useState<'linked' | 'copy'>('linked');
  const [source, setSource] = useState<FigureSource>(projectId ? 'project' : 'mine');
  const [chartType, setChartType] = useState('all');
  const [recentIds, setRecentIds] = useState<string[]>([]);
  useEffect(() => {
    if (open) {
      setSource(projectId ? 'project' : 'mine');
      setRecentIds(readRecentFigureIds());
      return;
    }
    setPlacementMode('linked');
    setQuery('');
    setChartType('all');
  }, [open, projectId]);
  const copy = placementMode === 'copy';
  const scoped = source === 'project' && Boolean(projectId);
  const { data: figures, isLoading: figuresLoading } = useQuery({
    queryKey: ['figures', scoped ? projectId : 'all'],
    queryFn: () => (scoped ? listFigures(projectId as string) : listFigures()),
    enabled: open && source !== 'templates',
  });
  const { data: gallery, isLoading: galleryLoading } = useQuery({
    queryKey: ['public-gallery', 120],
    queryFn: () => getPublicGallery(120),
    enabled: open,
  });

  const templateIds = new Set((gallery?.figures ?? []).map((figure) => figure.id));
  const ownedReady = (figures ?? []).filter((figure) => figure.status === 'ready' && !templateIds.has(figure.id));
  const sourceFigures = source === 'recent'
    ? recentIds.map((id) => ownedReady.find((figure) => figure.id === id)).filter((figure): figure is FigureListItem => Boolean(figure))
    : ownedReady;
  const sourceTemplates = gallery?.figures ?? [];
  const sourceItems: Array<FigureListItem | PublicFigure> = source === 'templates' ? sourceTemplates : sourceFigures;
  const plotTypes = Array.from(new Set(sourceItems.map((item) => item.plot_type))).sort();
  const q = query.trim().toLowerCase();
  const visible = sourceItems.filter((item) => (
    (chartType === 'all' || item.plot_type === chartType)
    && (!q || item.name.toLowerCase().includes(q) || item.plot_type.replace(/_/g, ' ').toLowerCase().includes(q))
  ));
  const isLoading = source === 'templates' ? galleryLoading : figuresLoading || galleryLoading;

  function pickFigure(figure: FigureListItem) {
    setRecentIds(rememberFigure(figure.id));
    onPick(figure, { copy });
  }

  function openTemplate(template: PublicFigure) {
    onOpenChange(false);
    router.push(`/gallery/template/${template.id}`);
  }

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
        <Tabs value={source} onValueChange={(value) => { setSource(value as FigureSource); setChartType('all'); }}>
          <TabsList aria-label="Figure source" className="max-w-full flex-wrap">
            {projectId && <TabsTrigger value="project">Current project</TabsTrigger>}
            <TabsTrigger value="mine">My figures</TabsTrigger>
            <TabsTrigger value="templates">Gallery templates</TabsTrigger>
            <TabsTrigger value="recent">Recent</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="figure-chart-type">Chart type</Label>
            <select
              id="figure-chart-type"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={chartType}
              onChange={(event) => setChartType(event.target.value)}
            >
              <option value="all">All chart types</option>
              {plotTypes.map((type) => <option key={type} value={type}>{type.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          <label className="flex h-9 items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked disabled readOnly />
            Latest versions only
          </label>
        </div>
        <fieldset className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
          <legend className="px-1 text-xs font-medium">Figure connection</legend>
          <label className="flex cursor-pointer items-start gap-2 text-xs">
            <input type="radio" name="figure-connection" value="linked" checked={placementMode === 'linked'} onChange={() => setPlacementMode('linked')} />
            <span><strong className="block">Linked to original</strong><span className="text-muted-foreground">Follows new versions unless you pin the panel.</span></span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 text-xs">
            <input type="radio" name="figure-connection" value="copy" checked={placementMode === 'copy'} onChange={() => setPlacementMode('copy')} />
            <span><strong className="block">Independent copy</strong><span className="text-muted-foreground">Canvas edits never change the source figure.</span></span>
          </label>
        </fieldset>
        <div className="max-h-[55vh] overflow-y-auto">
          {isLoading ? (
            <div className="py-12 text-center text-muted-foreground">
              <Loader2 className="mx-auto h-5 w-5 animate-spin" />
            </div>
          ) : visible.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {source === 'recent' && recentIds.length === 0
                ? 'No recently used figures yet.'
                : sourceItems.length === 0
                  ? source === 'templates' ? 'No Gallery templates are available.' : 'No ready figures yet. Create a figure first.'
                  : 'No figures match these filters.'}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 p-1 sm:grid-cols-3">
              {visible.map((fig) => {
                const template = source === 'templates';
                return (
                <button
                  key={fig.id}
                  type="button"
                  onClick={() => template ? openTemplate(fig as PublicFigure) : pickFigure(fig as FigureListItem)}
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
                    <p className="truncate text-[10px] text-muted-foreground">
                      {fig.plot_type.replace(/_/g, ' ')}
                      {template
                        ? ` · ${(fig as PublicFigure).domain_label ?? 'Gallery'}`
                        : ` · updated ${new Date((fig as FigureListItem).updated_at).toLocaleDateString()}`}
                    </p>
                    {!template && projectId && source === 'mine' && (fig as FigureListItem).project_id !== projectId && (
                      <p className="mt-0.5 truncate text-[10px] text-amber-600" title="This figure is outside the project — project collaborators won't be able to see this panel.">
                        ⚠ Not visible to collaborators
                      </p>
                    )}
                    {template && <p className="mt-0.5 text-[10px] font-medium text-primary">Open template setup</p>}
                  </div>
                </button>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
