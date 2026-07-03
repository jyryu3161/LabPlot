'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, RotateCcw, Check } from 'lucide-react';
import {
  getFigure, getPlotTypes, rerenderFigure, renderCanvasPreview, ApiError,
} from '@/lib/api';
import type { CanvasPanel, CanvasPreviewResult, SeriesStyle } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { roundMm } from './mm';
import {
  computeScopeBoxes, recolorSvg, seriesAtElement, seriesAtPoint, type Box, type LegendKey,
} from './recolor';

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

// Preview key: a re-render is only needed when figure / effective version / physical
// size changes — the same inputs as the M2 panel image cache. After a color commit,
// the panel's effective_version_id changes → this refetches the committed render.
function previewKey(panel: CanvasPanel): string {
  return `${panel.figure_id}|${panel.effective_version_id ?? 'latest'}|${roundMm(panel.width_mm)}|${roundMm(panel.height_mm)}`;
}

/**
 * Parallel to M2's `usePanelImage`: for the SELECTED panel it keeps the full preview
 * RESULT (svg_url + layout with series_hex/legend_keys/panel_px/img_px) AND fetches the
 * SVG text so it can be inlined and recolored client-side.
 */
function usePanelPreview(panel: CanvasPanel, enabled: boolean) {
  const [state, setState] = useState<{ result: CanvasPreviewResult | null; svgText: string | null; loading: boolean }>(
    { result: null, svgText: null, loading: enabled },
  );
  const key = previewKey(panel);

  useEffect(() => {
    if (!enabled) {
      setState({ result: null, svgText: null, loading: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    (async () => {
      try {
        const result = await renderCanvasPreview({
          figure_id: panel.figure_id,
          version_id: panel.effective_version_id ?? undefined,
          width_mm: roundMm(panel.width_mm),
          height_mm: roundMm(panel.height_mm),
        });
        const svgText = await fetch(result.svg_url).then((r) => r.text());
        if (cancelled) return;
        setState({ result, svgText, loading: false });
      } catch {
        if (!cancelled) setState({ result: null, svgText: null, loading: false });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);

  return state;
}

export function CanvasColorEditor({
  panel,
  canvasId,
  canvasName,
  containerEl,
  overlayRect,
}: {
  panel: CanvasPanel;
  canvasId: string;
  canvasName: string;
  containerEl: HTMLElement | null;
  overlayRect: { left: number; top: number; width: number; height: number } | null;
}) {
  const qc = useQueryClient();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [selectedSeries, setSelectedSeries] = useState<string | null>(null);
  const svgWrapRef = useRef<HTMLDivElement>(null);

  // Capability: type→color_editable map + this figure's plot_type + resolved series.
  const { data: plotTypesData } = useQuery({ queryKey: ['plot-types'], queryFn: getPlotTypes });
  const colorMap = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const t of plotTypesData?.plot_types ?? []) m.set(t.type, t.color_editable === true);
    return m;
  }, [plotTypesData]);

  const { data: figure, isLoading: figLoading } = useQuery({
    queryKey: ['figure', panel.figure_id],
    queryFn: () => getFigure(panel.figure_id),
  });

  // Capture the version the user's edits are based on WHEN the editor first loaded
  // this figure (the editor remounts per panel via `key`, so this is the version on
  // screen). It's sent as base_version_id so the backend can reject (409) if the
  // figure was changed elsewhere in the meantime — see the commit mutation below.
  const baseVersionIdRef = useRef<string | null>(null);
  if (baseVersionIdRef.current === null && figure) {
    baseVersionIdRef.current = panel.effective_version_id ?? figure.current_version_id ?? null;
  }

  const preview = usePanelPreview(panel, true);
  const layout = preview.result?.layout ?? null;

  // Derive series/scope from the preview layout in one memo so the boxes have a
  // stable identity (a fresh `?? []` each render would defeat downstream memos).
  const { seriesHex, legendKeys, imgPx, scopeBoxes, seriesNames } = useMemo(() => {
    const sHex = (layout?.series_hex as Record<string, string> | undefined) ?? null;
    const lKeys: LegendKey[] = (layout?.legend_keys as LegendKey[] | undefined) ?? [];
    const pPx = (layout?.panel_px as Box | undefined) ?? null;
    return {
      seriesHex: sHex,
      legendKeys: lKeys,
      imgPx: layout?.img_px ?? null,
      scopeBoxes: pPx ? computeScopeBoxes(pPx, lKeys) : ([] as Box[]),
      seriesNames: sHex ? Object.keys(sHex) : [],
    };
  }, [layout]);

  const editableByType = figure ? colorMap.get(figure.plot_type) === true : undefined;
  const loading = figLoading || preview.loading || !plotTypesData;
  const canEdit = editableByType === true && seriesNames.length > 0;

  // ── instant preview recolor: re-parse pristine SVG, then apply the full edits map
  // spatially scoped to panel_px(inset)+legend boxes. Re-parsing each change keeps the
  // recolor correct (matching is against the series' CURRENT hex, not a prior edit). ──
  const editsJson = JSON.stringify(edits);
  useEffect(() => {
    const wrap = svgWrapRef.current;
    if (!wrap || !preview.svgText || !canEdit) return;
    wrap.innerHTML = preview.svgText;
    const svg = wrap.querySelector('svg');
    if (!svg) return;
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    // While a resize re-render is in flight the wrap already has the NEW panel
    // aspect but svgText is still the OLD render — letterbox ('meet') instead
    // of stretching it; snap back to exact fill once the fresh SVG arrives.
    svg.setAttribute('preserveAspectRatio', preview.loading ? 'xMidYMid meet' : 'none');
    (svg as unknown as HTMLElement).style.display = 'block';
    if (seriesHex && scopeBoxes.length && Object.keys(edits).length) {
      recolorSvg(svg, edits, seriesHex, scopeBoxes);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.svgText, canEdit, editsJson, scopeBoxes, preview.loading]);

  // ── click-to-select a series on the panel ──
  function handleOverlayClick(e: React.MouseEvent) {
    const wrap = svgWrapRef.current;
    if (!wrap || !imgPx) return;
    // The rect→imgPx mapping assumes the SVG fills the wrap exactly; while a
    // re-render is letterboxed ('meet') the math is off — ignore clicks.
    if (preview.loading) return;
    const rect = wrap.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const sx = ((e.clientX - rect.left) / rect.width) * imgPx.w;
    const sy = ((e.clientY - rect.top) / rect.height) * imgPx.h;
    let series = seriesAtPoint(sx, sy, legendKeys);
    if (!series && seriesHex) series = seriesAtElement(e.target as Element, seriesHex, edits);
    if (series) setSelectedSeries(series);
  }

  function setColor(series: string, hex: string) {
    setEdits((prev) => {
      const next = { ...prev };
      const base = seriesHex?.[series];
      // No-op edits (back to the committed color) are dropped so Apply stays clean.
      if (base && hex.toLowerCase() === base.toLowerCase()) delete next[series];
      else next[series] = hex;
      return next;
    });
  }
  function resetSeries(series: string) {
    setEdits((prev) => {
      const next = { ...prev };
      delete next[series];
      return next;
    });
  }

  // ── commit: reuse the figure rerender path (scale-level series_styles ⇒ graph +
  // legend + all facet panels sync). The backend creates a version ONLY on success. ──
  const apply = useMutation({
    mutationFn: async () => {
      const fig = await getFigure(panel.figure_id);
      const effId = panel.effective_version_id ?? fig.current_version_id;
      const version = fig.versions.find((v) => v.id === effId) ?? fig.versions[0];
      const options = (version?.options as Record<string, unknown>) ?? {};
      const prevStyles = (options.series_styles as Record<string, SeriesStyle> | undefined) ?? {};
      const mergedStyles: Record<string, SeriesStyle> = { ...prevStyles };
      for (const [series, hex] of Object.entries(edits)) {
        mergedStyles[series] = { ...(prevStyles[series] ?? {}), color: hex };
      }
      return rerenderFigure(panel.figure_id, {
        options: { ...options, series_styles: mergedStyles },
        change_note: `Canvas '${canvasName}': recolor ${Object.keys(edits).join(', ')}`,
        // Conflict guard: the version the edits are based on. If the figure changed
        // elsewhere since load, the backend returns 409 (VERSION_CONFLICT).
        base_version_id: baseVersionIdRef.current ?? undefined,
      });
    },
    onSuccess: () => {
      toast.success('Colors applied');
      setEdits({});
      // New version → follow-latest panels pick up the new current_version_id and the
      // preview refetches (keyed on effective_version_id) → overlay shows the committed
      // colors, matching the freshly re-rendered raster.
      qc.invalidateQueries({ queryKey: ['canvas', canvasId] });
      qc.invalidateQueries({ queryKey: ['figure', panel.figure_id] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        // The figure was changed elsewhere (another panel / tab) since this editor
        // loaded it. KEEP the user's edits so they can retry after refreshing, and
        // reload the newer version underneath (canvas + figure) so the next attempt
        // bases on the up-to-date version.
        toast.error('This figure changed elsewhere — reload the canvas and retry.');
        qc.invalidateQueries({ queryKey: ['canvas', canvasId] });
        qc.invalidateQueries({ queryKey: ['figure', panel.figure_id] });
        return;
      }
      // Generic failure: backend created NO version → roll back the instant preview by
      // discarding the uncommitted edits so the overlay reverts to the committed
      // colors. Never leave a half-applied state.
      setEdits({});
      toast.error(err instanceof ApiError ? err.message : 'Could not apply colors');
    },
  });

  const editCount = Object.keys(edits).length;

  // ── overlay (portal into the stage container, positioned over the konva panel) ──
  const overlay =
    canEdit && preview.svgText && containerEl && overlayRect
      ? createPortal(
          <div
            className="absolute z-20 overflow-hidden bg-white shadow-sm ring-1 ring-primary"
            style={{
              left: overlayRect.left,
              top: overlayRect.top,
              width: overlayRect.width,
              height: overlayRect.height,
              cursor: 'crosshair',
            }}
            onClick={handleOverlayClick}
            role="presentation"
          >
            <div ref={svgWrapRef} className="h-full w-full" />
          </div>,
          containerEl,
        )
      : null;

  return (
    <div className="flex w-64 shrink-0 flex-col gap-3 border-l bg-background p-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-semibold">Colors</span>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {!loading && !canEdit && (
        <p className="rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
          Colors can’t be edited for this plot type.
        </p>
      )}

      {canEdit && (
        <>
          <p className="text-[11px] text-muted-foreground">
            Pick a series here or click it on the figure. Colors apply to the graph and legend together and are saved as a new figure version.
          </p>
          <div className="flex flex-col gap-1.5">
            {seriesNames.map((series) => {
              const effective = edits[series] ?? seriesHex![series];
              const dirty = series in edits;
              const active = selectedSeries === series;
              return (
                <div
                  key={series}
                  className={`flex items-center gap-2 rounded-md border p-1.5 ${active ? 'border-primary bg-primary/5' : 'border-transparent'}`}
                  onClick={() => setSelectedSeries(series)}
                  role="presentation"
                >
                  <input
                    type="color"
                    value={HEX_RE.test(effective) ? effective : '#000000'}
                    onChange={(e) => setColor(series, e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    className="h-6 w-8 shrink-0 cursor-pointer rounded border p-0"
                    aria-label={`Color for ${series}`}
                  />
                  <span className="flex-1 truncate" title={series}>{series}</span>
                  <span className="font-mono text-[10px] uppercase text-muted-foreground">{effective}</span>
                  {dirty && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); resetSeries(series); }}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={`Reset ${series}`}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-1 flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              className="flex-1"
              disabled={editCount === 0 || apply.isPending}
              onClick={() => apply.mutate()}
            >
              {apply.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Apply colors{editCount ? ` (${editCount})` : ''}
            </Button>
            {editCount > 0 && !apply.isPending && (
              <Button type="button" size="sm" variant="ghost" onClick={() => setEdits({})}>
                Reset
              </Button>
            )}
          </div>
        </>
      )}

      {overlay}
    </div>
  );
}
