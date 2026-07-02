'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, Paintbrush } from 'lucide-react';
import { applyCanvasStyle, getFigure } from '@/lib/api';
import type { CanvasPanel } from '@/lib/types';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

/**
 * Canvas-wide "Apply style to all panels": the user picks a SOURCE panel, and its
 * style is copied onto every OTHER panel figure via applyCanvasStyle. This bumps
 * each other figure's version, so follow-latest panels re-render — we invalidate the
 * canvas + figure queries on success so the stage reloads at the new versions.
 */
export function CanvasApplyStyle({ canvasId, panels }: { canvasId: string; panels: CanvasPanel[] }) {
  const qc = useQueryClient();
  const [sourcePanelId, setSourcePanelId] = useState<string | null>(null);

  // Figure names for the dropdown labels (shares the ['figure', id] cache with the
  // color editor, so these are usually already resolved / cheap).
  const uniqueFigureIds = useMemo(
    () => Array.from(new Set(panels.map((p) => p.figure_id))),
    [panels],
  );
  const figureQueries = useQueries({
    queries: uniqueFigureIds.map((id) => ({
      queryKey: ['figure', id],
      queryFn: () => getFigure(id),
      staleTime: 60_000,
    })),
  });
  const nameByFigureId = useMemo(() => {
    const m = new Map<string, string>();
    figureQueries.forEach((q, i) => {
      if (q.data) m.set(uniqueFigureIds[i], q.data.name);
    });
    return m;
  }, [figureQueries, uniqueFigureIds]);

  const apply = useMutation({
    mutationFn: (sourceFigureId: string) => applyCanvasStyle(canvasId, sourceFigureId),
    onSuccess: (res) => {
      const updated = res.updated.length;
      const skipped = res.skipped.length;
      if (updated === 0) {
        toast.info(skipped ? `No panels updated (${skipped} skipped)` : 'No other panels to update');
      } else {
        toast.success(
          `Style applied to ${updated} panel${updated === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped` : ''}`,
        );
      }
      // Other figures got new versions → follow-latest panels must reload; the color
      // editor's per-figure queries refresh too.
      qc.invalidateQueries({ queryKey: ['canvas', canvasId] });
      for (const id of uniqueFigureIds) qc.invalidateQueries({ queryKey: ['figure', id] });
    },
    onError: () => toast.error('Could not apply style to panels'),
  });

  // Need a source and at least one OTHER panel to be a meaningful operation.
  if (panels.length < 2) return null;

  const sourcePanel = panels.find((p) => p.id === sourcePanelId) ?? null;

  function handleApply() {
    if (!sourcePanel || apply.isPending) return;
    const others = panels.filter((p) => p.figure_id !== sourcePanel!.figure_id).length;
    const srcName = nameByFigureId.get(sourcePanel.figure_id) ?? 'this panel';
    if (!window.confirm(
      `Apply the style of “${srcName}” to all other panels? This creates a new version of each other panel figure.`,
    )) return;
    if (others === 0) {
      toast.info('No other panels use a different figure.');
      return;
    }
    apply.mutate(sourcePanel.figure_id);
  }

  return (
    <div className="flex items-center gap-1">
      <Select value={sourcePanelId ?? undefined} onValueChange={setSourcePanelId}>
        <SelectTrigger className="h-8 w-44" aria-label="Style source panel">
          <SelectValue placeholder="Style source…" />
        </SelectTrigger>
        <SelectContent>
          {panels.map((p) => {
            const name = nameByFigureId.get(p.figure_id) ?? 'Figure';
            const label = p.label ? `${name} · ${p.label}` : name;
            return (
              <SelectItem key={p.id} value={p.id}>
                <span className="truncate">{label}</span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!sourcePanel || apply.isPending}
        onClick={handleApply}
        title={sourcePanel ? 'Apply this panel’s style to all other panels' : 'Pick a source panel first'}
      >
        {apply.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paintbrush className="h-4 w-4" />}
        Apply style
      </Button>
    </div>
  );
}
