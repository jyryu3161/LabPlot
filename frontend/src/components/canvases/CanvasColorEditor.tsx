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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { roundMm } from './mm';
import {
  computeScopeBoxes, recolorSvg, seriesAtElement, seriesAtPoint, type Box, type LegendKey,
} from './recolor';
import { textRegionBoxes, regionCssRect, axisRegionBoxes, REGION_OPTION_KEY, REGION_LABEL, type TextRegion, type AxisRegion } from './regions';
import { CanvasAxisPopover } from './CanvasAxisPopover';

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

  // ── text elements (U4 P1): title / x label / y label ──
  // Effective version's stored options — prefill source for text edits.
  const effOptions = useMemo(() => {
    if (!figure) return {} as Record<string, unknown>;
    const effId = panel.effective_version_id ?? figure.current_version_id;
    const version = figure.versions.find((v) => v.id === effId) ?? figure.versions[0];
    return (version?.options as Record<string, unknown>) ?? {};
  }, [figure, panel.effective_version_id]);
  const optionText = (key: string): string => {
    const v = effOptions[key];
    return typeof v === 'string' ? v : '';
  };
  // Click-target boxes from the sidecar (absent for DEVICE_TYPES/old renders →
  // the sidebar inputs below remain the only path — graceful degradation).
  const regionBoxes = useMemo(() => textRegionBoxes(layout as Record<string, unknown> | null), [layout]);
  const hasRegions = Object.keys(regionBoxes).length > 0;
  // coord_flip (options.flip_coords) swaps which AESTHETIC each gtable cell
  // shows: the bottom label cell renders the y-label and vice versa. Verified
  // in-container: with coord_flip the xlab-b grob carries labs(y=...). Map the
  // clicked CELL to the option that actually renders there.
  const flipped = Boolean(effOptions.flip_coords);
  const optionKeyFor = (r: TextRegion) =>
    flipped && r === 'xlab' ? 'y_label' : flipped && r === 'ylab' ? 'x_label' : REGION_OPTION_KEY[r];
  const labelFor = (r: TextRegion) =>
    flipped && r === 'xlab' ? REGION_LABEL.ylab : flipped && r === 'ylab' ? REGION_LABEL.xlab : REGION_LABEL[r];
  // ── axis strips (U5): tick-strip click → anchored popover ──
  const axisBoxes = useMemo(() => axisRegionBoxes(layout as Record<string, unknown> | null), [layout]);
  const [axisEdit, setAxisEdit] = useState<AxisRegion | null>(null);
  // The clicked strip is POSITIONAL; the options it edits follow the aesthetic
  // that renders there (coord_flip swaps them). Discreteness is panel-space
  // (sidecar x_discrete describes the horizontal axis), so it stays positional.
  const axisAestheticFor = (r: AxisRegion): 'x' | 'y' =>
    r === 'xaxis' ? (flipped ? 'y' : 'x') : (flipped ? 'x' : 'y');
  const axisDiscreteFor = (r: AxisRegion): boolean =>
    Boolean(r === 'xaxis' ? (layout as Record<string, unknown> | null)?.x_discrete : (layout as Record<string, unknown> | null)?.y_discrete);
  // Inline editor state: region being edited, live value, pre-edit value, and
  // whether the option was SET before (unset restores the rendered default —
  // distinct from '', which explicitly blanks a label backend-side).
  const [textEdit, setTextEdit] = useState<{ region: TextRegion; value: string; prev: string; prevSet: boolean } | null>(null);
  // Sidebar drafts (batch-applied). Reseed ONLY when the effective version
  // changes — reseeding on every figure refetch (color apply, canvas
  // invalidation) would wipe half-typed drafts.
  const effVersionId = panel.effective_version_id ?? figure?.current_version_id ?? null;
  const [textDrafts, setTextDrafts] = useState<{ title: string; x_label: string; y_label: string } | null>(null);
  useEffect(() => {
    if (figure) {
      setTextDrafts({
        title: optionText('title'),
        x_label: optionText('x_label'),
        y_label: optionText('y_label'),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [figure?.id, effVersionId]);

  // Commit a text-option patch through the same rerender path as colors. One
  // FigureVersion per commit; base_version_id guards cross-tab conflicts; the
  // success toast offers a one-shot Undo (grilling Q5-c) that re-commits the
  // previous values — canvas Ctrl+Z stays placement-only by design.
  const commitText = useMutation({
    // patch values: string sets the option; null UNSETS it (restores the
    // rendered default — '' would explicitly blank a label backend-side).
    mutationFn: async (vars: { patch: Record<string, string | number | boolean | null>; note: string; revert?: Record<string, string | number | boolean | null>; kind?: 'text' | 'axis' }) => {
      const fig = await getFigure(panel.figure_id);
      // Merge base = the version our edits are relative to (the conflict-guard
      // ref, which advances after every commit here). Using the panel prop's
      // effective_version_id instead would race the canvas refetch: a quick
      // second commit would merge onto the PRE-first-commit options and
      // silently revert the first edit.
      const baseId = baseVersionIdRef.current ?? panel.pinned_version_id ?? fig.current_version_id;
      const version = fig.versions.find((v) => v.id === baseId) ?? fig.versions[0];
      const options = { ...((version?.options as Record<string, unknown>) ?? {}) };
      for (const [key, value] of Object.entries(vars.patch)) {
        if (value === null) delete options[key];
        else options[key] = value;
      }
      return rerenderFigure(panel.figure_id, {
        options,
        change_note: vars.note,
        base_version_id: baseVersionIdRef.current ?? undefined,
      });
    },
    onSuccess: (version, vars) => {
      // Advance the conflict guard to the version we just created, else the
      // NEXT commit from this editor would 409 against our own edit.
      baseVersionIdRef.current = version.id;
      setTextEdit(null);
      setAxisEdit(null);
      qc.invalidateQueries({ queryKey: ['canvas', canvasId] });
      qc.invalidateQueries({ queryKey: ['figure', panel.figure_id] });
      const kindLabel = vars.kind === 'axis' ? 'Axis' : 'Text';
      if (vars.revert) {
        const revert = vars.revert;
        toast.success(`${kindLabel} updated`, {
          action: {
            label: 'Undo',
            onClick: () => commitText.mutate({
              patch: revert,
              note: `Canvas '${canvasName}': revert ${vars.kind ?? 'text'} edit`,
            }),
          },
        });
      } else {
        toast.success(`${kindLabel} updated`);
      }
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        toast.error('This figure changed elsewhere — reload the canvas and retry.');
        qc.invalidateQueries({ queryKey: ['canvas', canvasId] });
        qc.invalidateQueries({ queryKey: ['figure', panel.figure_id] });
        return;
      }
      toast.error(err instanceof ApiError ? err.message : 'Could not update text');
    },
  });

  function commitRegionEdit() {
    if (!textEdit) return;
    const key = optionKeyFor(textEdit.region); // flip-aware
    const value = textEdit.value.trim();
    if (value === textEdit.prev.trim()) { setTextEdit(null); return; } // no-op
    commitText.mutate({
      patch: { [key]: value },
      note: `Canvas '${canvasName}': edit ${labelFor(textEdit.region)}`,
      // Undo restores the pre-edit state exactly: the old string if the option
      // was set, else UNSET (null) — not '' (which would blank the label).
      revert: { [key]: textEdit.prevSet ? textEdit.prev : null },
    });
  }

  // ── instant preview recolor: re-parse pristine SVG, then apply the full edits map
  // spatially scoped to panel_px(inset)+legend boxes. Re-parsing each change keeps the
  // recolor correct (matching is against the series' CURRENT hex, not a prior edit). ──
  const editsJson = JSON.stringify(edits);
  useEffect(() => {
    const wrap = svgWrapRef.current;
    // Inline only for color editing (recolor needs a DOM SVG). Text-only mode
    // renders NO svg — the konva raster below is the same render, and skipping
    // the white-background overlay keeps the panel draggable + flash-free.
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
  }, [preview.svgText, canEdit, hasRegions, editsJson, scopeBoxes, preview.loading]);

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
      // Same merge-base rule as commitText: our conflict-guard ref, not the
      // possibly-stale panel prop (a quick second commit would otherwise merge
      // onto pre-first-commit options and revert it).
      const baseId = baseVersionIdRef.current ?? panel.pinned_version_id ?? fig.current_version_id;
      const version = fig.versions.find((v) => v.id === baseId) ?? fig.versions[0];
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
    onSuccess: (version) => {
      // Advance the conflict guard so a second commit from this same editor
      // doesn't 409 against the version we just created.
      baseVersionIdRef.current = version.id;
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
  // Two modes: COLOR mode (canEdit) inlines the SVG for scoped recolor — the
  // overlay intercepts clicks (M3 behavior). TEXT-ONLY mode (color-locked
  // types) renders NO svg and is pointer-events-none except the small label
  // hit targets, so the selected panel stays draggable and wheel-pannable and
  // transparent canvases never flash white.
  const overlay =
    (canEdit || hasRegions) && preview.svgText && containerEl && overlayRect
      ? createPortal(
          <>
          <div
            className={`absolute z-20 overflow-hidden ${canEdit ? 'bg-white shadow-sm ring-1 ring-primary' : 'pointer-events-none'}`}
            style={{
              left: overlayRect.left,
              top: overlayRect.top,
              width: overlayRect.width,
              height: overlayRect.height,
              cursor: canEdit ? 'crosshair' : undefined,
            }}
            onClick={canEdit ? handleOverlayClick : undefined}
            role="presentation"
          >
            {canEdit && <div ref={svgWrapRef} className="h-full w-full" />}
            {/* text-element click targets (sidecar boxes as real DOM targets) */}
            {imgPx && !textEdit && !preview.loading
              ? (Object.entries(regionBoxes) as [TextRegion, Box][]).map(([region, box]) => {
                  const rect = regionCssRect(box, imgPx);
                  return (
                    <button
                      key={region}
                      type="button"
                      aria-label={`Edit ${labelFor(region)}`}
                      title={`Edit ${labelFor(region)}`}
                      // pointer-events-auto re-enables clicks inside the
                      // pointer-events-none text-only container. No inline
                      // background — it would override the hover:bg class.
                      className="pointer-events-auto absolute cursor-text rounded-sm bg-transparent hover:bg-primary/10 hover:ring-1 hover:ring-primary/60"
                      style={{ ...rect, border: 'none', padding: 0 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        const raw = effOptions[optionKeyFor(region)];
                        const prevSet = typeof raw === 'string';
                        const prev = prevSet ? (raw as string) : '';
                        setAxisEdit(null);
                        setTextEdit({ region, value: prev, prev, prevSet });
                      }}
                    />
                  );
                })
              : null}
            {/* axis strip click targets (U5) */}
            {imgPx && !textEdit && !axisEdit && !preview.loading
              ? (Object.entries(axisBoxes) as [AxisRegion, Box][]).map(([region, box]) => {
                  const rect = regionCssRect(box, imgPx);
                  return (
                    <button
                      key={region}
                      type="button"
                      aria-label={`Edit ${axisAestheticFor(region)} axis`}
                      title={`Edit ${axisAestheticFor(region)} axis (range, ticks, scale)`}
                      className="pointer-events-auto absolute cursor-pointer rounded-sm bg-transparent hover:bg-primary/10 hover:ring-1 hover:ring-primary/60"
                      style={{ ...rect, border: 'none', padding: 0 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setTextEdit(null);
                        setAxisEdit(region);
                      }}
                    />
                  );
                })
              : null}
            {/* inline text editor over the clicked region */}
            {imgPx && textEdit && regionBoxes[textEdit.region] ? (() => {
              const rect = regionCssRect(regionBoxes[textEdit.region]!, imgPx);
              return (
                <div
                  className="pointer-events-auto absolute z-30"
                  // ylab is a thin vertical strip — a rotated input is unusable,
                  // so the editor floats horizontally from the strip's position.
                  style={{ left: rect.left, top: rect.top, minWidth: 200, maxWidth: '85%' }}
                >
                  <input
                    autoFocus
                    aria-label={`${labelFor(textEdit.region)} text`}
                    className="w-full rounded border border-primary bg-white px-1.5 py-0.5 text-xs shadow-md outline-none"
                    value={textEdit.value}
                    placeholder={`${labelFor(textEdit.region)} (empty hides it)`}
                    maxLength={200}
                    disabled={commitText.isPending}
                    onChange={(e) => setTextEdit((s) => (s ? { ...s, value: e.target.value } : s))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRegionEdit();
                      else if (e.key === 'Escape') setTextEdit(null); // cancel = free (pre-commit)
                      e.stopPropagation();
                    }}
                    onBlur={() => { if (!commitText.isPending) commitRegionEdit(); }}
                  />
                  {commitText.isPending && (
                    <Loader2 className="absolute -right-5 top-1 h-3.5 w-3.5 animate-spin text-primary" />
                  )}
                </div>
              );
            })() : null}
          </div>
          {/* axis popover (U5): sibling of the overlay so the overlay's
              overflow-hidden can't clip it; flips above/below the strip. */}
          {imgPx && axisEdit && axisBoxes[axisEdit] ? (() => {
            const box = axisBoxes[axisEdit]!;
            const POP_H = 300; // approximate popover height for placement
            if (axisEdit === 'xaxis') {
              const stripTop = overlayRect.top + overlayRect.height * (box.y0 / imgPx.h);
              const stripBottom = overlayRect.top + overlayRect.height * (box.y1 / imgPx.h);
              const placeAbove = stripTop > POP_H + 8;
              return (
                <div
                  className="pointer-events-auto absolute z-30"
                  style={{
                    left: overlayRect.left + overlayRect.width * 0.3,
                    top: placeAbove ? stripTop - 4 : stripBottom + 6,
                    transform: placeAbove ? 'translateY(-100%)' : undefined,
                  }}
                >
                  <CanvasAxisPopover
                    key={`${axisEdit}-${effVersionId ?? 'v'}`}
                    aesthetic={axisAestheticFor(axisEdit)}
                    discrete={axisDiscreteFor(axisEdit)}
                    showAngle={axisAestheticFor(axisEdit) === 'x' && !flipped}
                    options={effOptions}
                    pending={commitText.isPending}
                    onApply={(patch, revert) => commitText.mutate({
                      patch,
                      note: `Canvas '${canvasName}': edit ${axisAestheticFor(axisEdit)} axis`,
                      revert,
                      kind: 'axis',
                    })}
                    onClose={() => setAxisEdit(null)}
                  />
                </div>
              );
            }
            const stripRight = overlayRect.left + overlayRect.width * (box.x1 / imgPx.w);
            return (
              <div
                className="pointer-events-auto absolute z-30"
                style={{ left: stripRight + 8, top: Math.max(8, overlayRect.top + overlayRect.height * 0.08) }}
              >
                <CanvasAxisPopover
                  key={`${axisEdit}-${effVersionId ?? 'v'}`}
                  aesthetic={axisAestheticFor(axisEdit)}
                  discrete={axisDiscreteFor(axisEdit)}
                  showAngle={false}
                  options={effOptions}
                  pending={commitText.isPending}
                  onApply={(patch, revert) => commitText.mutate({
                    patch,
                    note: `Canvas '${canvasName}': edit ${axisAestheticFor(axisEdit)} axis`,
                    revert,
                    kind: 'axis',
                  })}
                  onClose={() => setAxisEdit(null)}
                />
              </div>
            );
          })() : null}
          </>,
          containerEl,
        )
      : null;

  // Trimmed comparison — whitespace-only edits must not enable Apply (a
  // trimmed patch would commit a full no-op re-render against render quota).
  const draftsDirty = textDrafts !== null && (
    textDrafts.title.trim() !== optionText('title').trim()
    || textDrafts.x_label.trim() !== optionText('x_label').trim()
    || textDrafts.y_label.trim() !== optionText('y_label').trim()
  );

  return (
    <div className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-l bg-background p-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-semibold">Edit panel</span>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {/* ── text: title + axis labels (all plot types; commits a new version) ── */}
      {textDrafts && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Text</span>
          {hasRegions && (
            <p className="text-[11px] text-muted-foreground">
              Tip: click the title or an axis label directly on the figure.
            </p>
          )}
          {([
            ['title', 'Title'],
            ['x_label', 'X label'],
            ['y_label', 'Y label'],
          ] as const).map(([key, label]) => (
            <span key={key} className="flex items-center gap-1.5">
              <Label htmlFor={`panel-text-${key}`} className="w-12 shrink-0 text-[11px] text-muted-foreground">{label}</Label>
              <Input
                id={`panel-text-${key}`}
                className="h-7 text-xs"
                maxLength={200}
                value={textDrafts[key]}
                placeholder={key === 'title' ? 'No title' : 'Default (empty hides)'}
                onChange={(e) => setTextDrafts((d) => (d ? { ...d, [key]: e.target.value } : d))}
              />
            </span>
          ))}
          {draftsDirty && (
            <Button
              type="button"
              size="sm"
              disabled={commitText.isPending}
              onClick={() => {
                if (!textDrafts) return;
                const patch: Record<string, string | null> = {};
                const revert: Record<string, string | null> = {};
                for (const key of ['title', 'x_label', 'y_label'] as const) {
                  if (textDrafts[key].trim() !== optionText(key).trim()) {
                    patch[key] = textDrafts[key].trim();
                    const raw = effOptions[key];
                    // Undo restores set values verbatim; unset stays unset
                    // (null deletes the key — '' would blank the label).
                    revert[key] = typeof raw === 'string' ? raw : null;
                  }
                }
                if (!Object.keys(patch).length) return;
                commitText.mutate({
                  patch,
                  note: `Canvas '${canvasName}': edit ${Object.keys(patch).join(', ')}`,
                  revert,
                });
              }}
            >
              {commitText.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Apply text
            </Button>
          )}
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Colors</span>
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
