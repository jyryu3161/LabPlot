'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, X, RefreshCw } from 'lucide-react';
import {
  getCanvasPresets, getCanvasJournalCheck, applyCanvasTypography, type CanvasExportFormat,
} from '@/lib/api';
import type { CanvasDetail, CanvasPanel, CanvasLabelStyle, CanvasStyle } from '@/lib/types';
import { FONT_FAMILY_OPTIONS } from '@/lib/font-families';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ComplianceChecklist } from '@/components/figures/ComplianceChecklist';
import {
  DEFAULT_LABEL_STYLE, LABEL_FORMATS, LABEL_PT_MIN, LABEL_PT_MAX, LABEL_OFFSET_MM_MIN, LABEL_OFFSET_MM_MAX,
  resolveLabelStyle, type LabelFormat,
} from './panelLabel';

type PatchCanvasArgs = {
  data: { preset?: string; width_mm?: number; height_mm?: number; style?: CanvasStyle };
  history?: { before: { width_mm: number; height_mm: number }; after: { width_mm: number; height_mm: number } };
};

const CHECK_FORMATS: { value: CanvasExportFormat; label: string }[] = [
  { value: 'pdf', label: 'PDF' },
  { value: 'eps', label: 'EPS' },
  { value: 'svg', label: 'SVG' },
  { value: 'png', label: 'PNG' },
  { value: 'tiff', label: 'TIFF' },
];

const LABEL_FORMAT_LABEL: Record<LabelFormat, string> = {
  A: 'A',
  a: 'a',
  '(A)': '(A)',
  'A.': 'A.',
};

/**
 * Journal submission panel (M-C1 §7): preset picker, panel-label style
 * controls, canvas-wide typography, and a live journal-compliance checklist.
 * Rendered in the editor's right sidebar when nothing is selected — see the
 * "Journal" toolbar toggle in CanvasEditor.
 */
export function CanvasJournalPanel({
  canvasId,
  canvas,
  panels,
  onPatchCanvas,
  patchPending,
  onClose,
}: {
  canvasId: string;
  canvas: CanvasDetail;
  panels: CanvasPanel[];
  onPatchCanvas: (args: PatchCanvasArgs) => void;
  patchPending: boolean;
  onClose?: () => void;
}) {
  const qc = useQueryClient();
  const labelStyle = resolveLabelStyle(canvas.style?.label);

  // ── preset ──
  const { data: presets } = useQuery({ queryKey: ['canvas-presets'], queryFn: getCanvasPresets });
  const grouped = useMemo(() => {
    const standard: NonNullable<typeof presets> = [];
    const byJournal = new Map<string, NonNullable<typeof presets>>();
    for (const p of presets ?? []) {
      if (!p.journal) { standard.push(p); continue; }
      const arr = byJournal.get(p.journal) ?? [];
      arr.push(p);
      byJournal.set(p.journal, arr);
    }
    return { standard, byJournal };
  }, [presets]);

  function applyPreset(key: string) {
    if (!key || !presets) return;
    const preset = presets.find((p) => p.key === key);
    if (!preset) return;
    const after = { width_mm: preset.width_mm, height_mm: preset.height_mm };
    onPatchCanvas({
      data: { preset: key, width_mm: after.width_mm, height_mm: after.height_mm },
      history: { before: { width_mm: canvas.width_mm, height_mm: canvas.height_mm }, after },
    });
  }

  // ── label style ──
  // Finding [10]: build the patch from the freshest query-cache canvas.style,
  // not the render-time `canvas` prop. patchCanvas now applies `style`
  // optimistically (CanvasEditor.tsx), so a second click issued before React
  // re-renders this component with the first response still sees the first
  // edit reflected in the cache and carries it forward — the server's
  // whole-object replace (contract §3) then converges to the user's last
  // intent instead of the second request clobbering the first with stale data.
  function patchLabelStyle(patch: Partial<CanvasLabelStyle>) {
    const latest = qc.getQueryData<CanvasDetail>(['canvas', canvasId])?.style ?? canvas.style;
    const next: CanvasLabelStyle = { ...resolveLabelStyle(latest?.label), ...patch };
    onPatchCanvas({ data: { style: { ...latest, label: next } } });
  }
  const [ptDraft, setPtDraft] = useState(String(labelStyle.pt));
  const [offsetDraft, setOffsetDraft] = useState(String(labelStyle.offset_mm));
  const seededLabelStyleRef = useRef<string>('');
  useEffect(() => {
    const key = `${labelStyle.pt}|${labelStyle.offset_mm}`;
    if (seededLabelStyleRef.current === key) return;
    seededLabelStyleRef.current = key;
    setPtDraft(String(labelStyle.pt));
    setOffsetDraft(String(labelStyle.offset_mm));
  }, [labelStyle.pt, labelStyle.offset_mm]);

  // ── typography ──
  const distinctFigureIds = useMemo(
    () => Array.from(new Set(panels.filter((p) => p.figure_id).map((p) => p.figure_id as string))),
    [panels],
  );
  const [fontFamily, setFontFamily] = useState(canvas.style?.typography?.font_family ?? '');
  const [basePt, setBasePt] = useState(canvas.style?.typography?.base_pt != null ? String(canvas.style.typography.base_pt) : '');
  const [axisWidth, setAxisWidth] = useState(canvas.style?.typography?.axis_line_width_pt != null ? String(canvas.style.typography.axis_line_width_pt) : '');
  const [dataWidth, setDataWidth] = useState(canvas.style?.typography?.data_line_width_pt != null ? String(canvas.style.typography.data_line_width_pt) : '');
  const seededCanvasIdRef = useRef<string>('');
  useEffect(() => {
    if (seededCanvasIdRef.current === canvasId) return;
    seededCanvasIdRef.current = canvasId;
    setFontFamily(canvas.style?.typography?.font_family ?? '');
    setBasePt(canvas.style?.typography?.base_pt != null ? String(canvas.style.typography.base_pt) : '');
    setAxisWidth(canvas.style?.typography?.axis_line_width_pt != null ? String(canvas.style.typography.axis_line_width_pt) : '');
    setDataWidth(canvas.style?.typography?.data_line_width_pt != null ? String(canvas.style.typography.data_line_width_pt) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasId]);

  function buildTypographyPatch(): Record<string, unknown> | null {
    const patch: Record<string, unknown> = {};
    if (fontFamily) patch.font_family = fontFamily;
    const base = Number(basePt);
    if (basePt.trim() && Number.isFinite(base)) patch.base_pt = base;
    const axis = Number(axisWidth);
    if (axisWidth.trim() && Number.isFinite(axis)) patch.axis_line_width_pt = axis;
    const data = Number(dataWidth);
    if (dataWidth.trim() && Number.isFinite(data)) patch.data_line_width_pt = data;
    return Object.keys(patch).length ? patch : null;
  }

  const applyTypography = useMutation({
    mutationFn: (patch: Record<string, unknown>) => applyCanvasTypography(canvasId, patch),
    onSuccess: (res) => {
      const updated = res.updated.length;
      const skipped = res.skipped.length;
      toast.success(
        updated
          ? `Typography applied to ${updated} figure${updated === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped` : ''}`
          : `No figures updated${skipped ? ` (${skipped} skipped)` : ''}`,
      );
      qc.invalidateQueries({ queryKey: ['canvas', canvasId] });
      for (const figId of distinctFigureIds) qc.invalidateQueries({ queryKey: ['figure', figId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not apply typography'),
  });

  function handleApplyTypography() {
    const patch = buildTypographyPatch();
    if (!patch) { toast.error('Set at least one typography value first'); return; }
    const n = distinctFigureIds.length;
    if (n === 0) { toast.info('No figure panels on this canvas yet'); return; }
    if (!window.confirm(`Re-renders ${n} figure${n === 1 ? '' : 's'} as new versions. Continue?`)) return;
    applyTypography.mutate(patch);
  }

  // ── journal check ──
  const [checkFormat, setCheckFormat] = useState<CanvasExportFormat>('pdf');
  const [checkDpi, setCheckDpi] = useState<300 | 600>(300);
  const checkSignature = useMemo(() => JSON.stringify({
    w: canvas.width_mm, h: canvas.height_mm, preset: canvas.preset, style: canvas.style,
    panels: panels.map((p) => [p.id, p.x_mm, p.y_mm, p.width_mm, p.height_mm, p.figure_id, p.effective_version_id, p.label, p.label_visible]),
    annotations: canvas.annotations.map((a) => [a.id, a.type === 'text' ? a.font_pt : null]),
  }), [canvas.width_mm, canvas.height_mm, canvas.preset, canvas.style, panels, canvas.annotations]);
  const { data: journalReport, isFetching: checking, refetch: refetchCheck } = useQuery({
    queryKey: ['canvas-journal-check', canvasId, checkFormat, checkDpi, checkSignature],
    queryFn: () => getCanvasJournalCheck(canvasId, { format: checkFormat, dpi: checkDpi }),
  });

  return (
    <div className="flex w-64 shrink-0 flex-col gap-4 overflow-y-auto border-l bg-background p-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-semibold">Journal</span>
        {onClose && (
          <Button type="button" size="icon-sm" variant="ghost" aria-label="Close journal panel" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* preset */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="journal-preset" className="text-[11px] text-muted-foreground">Journal preset</Label>
        <select
          id="journal-preset"
          className="w-full rounded border bg-background px-2 py-1.5 text-xs"
          value={canvas.preset ?? ''}
          disabled={patchPending}
          onChange={(e) => applyPreset(e.target.value)}
        >
          <option value="">Custom size ({canvas.width_mm} × {canvas.height_mm} mm)</option>
          {grouped.standard.length > 0 && (
            <optgroup label="Standard">
              {grouped.standard.map((p) => (
                <option key={p.key} value={p.key}>{p.label} ({p.width_mm} × {p.height_mm} mm)</option>
              ))}
            </optgroup>
          )}
          {Array.from(grouped.byJournal.entries()).map(([journal, ps]) => (
            <optgroup key={journal} label={journal}>
              {ps.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label} ({p.width_mm} mm{p.max_height_mm ? `, max ${p.max_height_mm} mm` : ''})
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {/* label style */}
      <div className="flex flex-col gap-1.5 border-t pt-3">
        <span className="text-[11px] font-medium text-muted-foreground">Panel labels</span>
        <div className="flex items-center gap-1">
          {LABEL_FORMATS.map((fmt) => (
            <Button
              key={fmt}
              type="button"
              size="xs"
              variant={labelStyle.format === fmt ? 'default' : 'outline'}
              aria-pressed={labelStyle.format === fmt}
              onClick={() => patchLabelStyle({ format: fmt })}
            >
              {LABEL_FORMAT_LABEL[fmt]}
            </Button>
          ))}
        </div>
        <span className="flex items-center justify-between text-[11px] text-muted-foreground">
          <Label htmlFor="label-bold">Bold</Label>
          <Switch id="label-bold" checked={labelStyle.bold} onCheckedChange={(v) => patchLabelStyle({ bold: Boolean(v) })} />
        </span>
        <Label htmlFor="label-pt" className="text-[11px] text-muted-foreground">Size (pt)</Label>
        <Input
          id="label-pt"
          className="h-7 text-xs"
          type="number"
          min={LABEL_PT_MIN}
          max={LABEL_PT_MAX}
          value={ptDraft}
          onChange={(e) => setPtDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }}
          onBlur={() => {
            const n = Math.min(LABEL_PT_MAX, Math.max(LABEL_PT_MIN, Math.round(Number(ptDraft) || DEFAULT_LABEL_STYLE.pt)));
            setPtDraft(String(n));
            if (n !== labelStyle.pt) patchLabelStyle({ pt: n });
          }}
        />
        <div className="flex items-center gap-1">
          {(['inside', 'outside'] as const).map((placement) => (
            <Button
              key={placement}
              type="button"
              size="xs"
              variant={labelStyle.placement === placement ? 'default' : 'outline'}
              aria-pressed={labelStyle.placement === placement}
              onClick={() => patchLabelStyle({ placement })}
            >
              {placement === 'inside' ? 'Inside' : 'Outside'}
            </Button>
          ))}
        </div>
        <Label htmlFor="label-offset" className="text-[11px] text-muted-foreground">Offset (mm)</Label>
        <Input
          id="label-offset"
          className="h-7 text-xs"
          type="number"
          min={LABEL_OFFSET_MM_MIN}
          max={LABEL_OFFSET_MM_MAX}
          step={0.1}
          value={offsetDraft}
          onChange={(e) => setOffsetDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }}
          onBlur={() => {
            const n = Math.min(LABEL_OFFSET_MM_MAX, Math.max(LABEL_OFFSET_MM_MIN, Number(offsetDraft) || 0));
            setOffsetDraft(String(n));
            if (n !== labelStyle.offset_mm) patchLabelStyle({ offset_mm: n });
          }}
        />
      </div>

      {/* typography */}
      <div className="flex flex-col gap-1.5 border-t pt-3">
        <span className="text-[11px] font-medium text-muted-foreground">Typography (all panels)</span>
        <Label htmlFor="journal-font-family" className="text-[11px] text-muted-foreground">Font family</Label>
        <select
          id="journal-font-family"
          className="w-full rounded border bg-background px-2 py-1.5 text-xs"
          value={fontFamily}
          onChange={(e) => setFontFamily(e.target.value)}
        >
          {FONT_FAMILY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.value === '' ? 'No change' : opt.label}</option>
          ))}
        </select>
        <Label htmlFor="journal-base-pt" className="text-[11px] text-muted-foreground">Base font size (pt, 5–14)</Label>
        <Input
          id="journal-base-pt"
          className="h-7 text-xs"
          type="number"
          min={5}
          max={14}
          placeholder="No change"
          value={basePt}
          onChange={(e) => setBasePt(e.target.value)}
        />
        <Label htmlFor="journal-axis-width" className="text-[11px] text-muted-foreground">Axis line width (pt, 0.1–3)</Label>
        <Input
          id="journal-axis-width"
          className="h-7 text-xs"
          type="number"
          min={0.1}
          max={3}
          step={0.1}
          placeholder="No change"
          value={axisWidth}
          onChange={(e) => setAxisWidth(e.target.value)}
        />
        <Label htmlFor="journal-data-width" className="text-[11px] text-muted-foreground">Data line width (pt, 0.1–3)</Label>
        <Input
          id="journal-data-width"
          className="h-7 text-xs"
          type="number"
          min={0.1}
          max={3}
          step={0.1}
          placeholder="No change"
          value={dataWidth}
          onChange={(e) => setDataWidth(e.target.value)}
        />
        <Button type="button" size="sm" variant="outline" disabled={applyTypography.isPending} onClick={handleApplyTypography}>
          {applyTypography.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Apply typography
        </Button>
      </div>

      {/* journal check */}
      <div className="flex flex-col gap-1.5 border-t pt-3">
        <span className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
          Journal check
          <Button type="button" size="icon-sm" variant="ghost" aria-label="Re-check" title="Re-run the journal check" onClick={() => refetchCheck()}>
            <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} />
          </Button>
        </span>
        <div className="flex items-center gap-1">
          <Label htmlFor="journal-check-format" className="sr-only">Export format for the check</Label>
          <select
            id="journal-check-format"
            className="flex-1 rounded border bg-background px-2 py-1 text-xs"
            value={checkFormat}
            onChange={(e) => setCheckFormat(e.target.value as CanvasExportFormat)}
          >
            {CHECK_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
          <Label htmlFor="journal-check-dpi" className="sr-only">Resolution for the check</Label>
          <select
            id="journal-check-dpi"
            className="w-20 rounded border bg-background px-2 py-1 text-xs"
            value={checkDpi}
            onChange={(e) => setCheckDpi(Number(e.target.value) as 300 | 600)}
          >
            <option value={300}>300 dpi</option>
            <option value={600}>600 dpi</option>
          </select>
        </div>
        {checking && !journalReport ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…</div>
        ) : journalReport ? (
          <ComplianceChecklist
            passed={journalReport.passed}
            checks={journalReport.checks}
            extra={journalReport.skipped_panels.length > 0 ? (
              <p role="alert" className="rounded bg-red-50 px-2 py-1 text-xs text-red-800 dark:bg-red-950/30 dark:text-red-200">
                {journalReport.skipped_panels.length} panel{journalReport.skipped_panels.length === 1 ? '' : 's'} skipped: {journalReport.skipped_panels.map((s) => s.reason).join('; ')}
              </p>
            ) : null}
          />
        ) : (
          <p className="text-xs text-muted-foreground">Could not run the journal check.</p>
        )}
      </div>
    </div>
  );
}
