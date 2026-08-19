'use client';

import { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  getFigure, getDataset, getPlotTypes, getStyles, getPalettes, rerenderFigure, reviewVersion,
  improveVersion, applyImprovement, applyImprovements, updateFigure, generateLegend, downloadExport, getExportText, enhancePrompt,
  deleteFigureVersion, getProject, saveFigureTemplateFavorite, deleteFigureTemplateFavorite, setFigureShare,
  createCustomPalette, updateCustomPalette, deleteCustomPalette, duplicateFigure,
  getColumnValues, getMethodsText, getAltText, ApiError,
} from '@/lib/api';
import type { ImproveVersionRequest } from '@/lib/api';
import type { FigureDetail, FigureVersion, Review, Improvement, PlotTypeDef, ColumnProfile, PaletteDef, SeriesStyle, UnsupportedRequestItem } from '@/lib/types';
import type { AiEditOutcome, AiEditPayload, AiSuggestionApplyOptions } from '@/components/figures/AiFigureEditor';
import { formatStylePreset } from '@/lib/style-presets';
import { publishFigureVersionCreated } from '@/lib/figure-version-events';
import { AiFigureEditor } from '@/components/figures/AiFigureEditor';
import { FigureCodeExport } from '@/components/figures/FigureCodeExport';
import { FigureComments } from '@/components/figures/FigureComments';
import { FigureAxisBreakControl } from '@/components/figures/FigureAxisBreakControl';
import { FigureSeriesStyleEditor } from '@/components/figures/FigureSeriesStyleEditor';
import { FigureVersionCompare } from '@/components/figures/FigureVersionCompare';
import { AppHeader } from '@/components/layout/AppHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Loader2, Star, Download, History, Pencil, FileText, Sparkles, Trash2, Copy, ArrowUp, ArrowDown, RefreshCw, Undo2, Redo2, Zap, CopyPlus, GitCompare, Search, X, PanelsTopLeft } from 'lucide-react';

const SCORE_COLOR = (s: number) => (s >= 80 ? 'text-green-600' : s >= 60 ? 'text-amber-600' : 'text-red-600');
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const DEFAULT_CUSTOM_COLORS = ['#4477AA', '#EE6677', '#228833', '#CCBB44'];
const AXIS_RANGE_OPTION_KEYS = new Set(['x_min', 'x_max', 'y_min', 'y_max']);
// Keys the generic per-type option renderer must NOT show as raw controls:
// axis ranges (handled by the Axis-scale block) plus structured/list options
// (annotations, series_styles) and interactive_html, each with a dedicated UI.
const GENERIC_OPTION_EXCLUDE = new Set([
  ...AXIS_RANGE_OPTION_KEYS, 'annotations', 'series_styles', 'interactive_html',
]);
const LIVE_PREVIEW_STORAGE_KEY = 'labplot-live-preview';
const HISTORY_CAP = 50;
const SERIES_AUTO_OPTION = '__series_auto__';

function seriesStyleMap(value: unknown): Record<string, SeriesStyle> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, SeriesStyle>;
}
type EditState = {
  plotType: string;
  mapping: Record<string, unknown>;
  options: Record<string, unknown>;
  style: string;
};
type EditorMode = 'basic' | 'advanced';
type AiUndoSource = {
  sourceVersionId: string;
  sourceVersionNumber: number;
  mapping: Record<string, unknown>;
  options: Record<string, unknown>;
  stylePreset: string;
};
type AiUndoTarget = AiUndoSource & { appliedVersionId: string; appliedVersionNumber: number };
type ImprovePlanMutation = {
  request?: ImproveVersionRequest;
  baseVersionId: string;
  requestToken: number;
};
const REPRESENTATIVE_COLORS = [
  '#4477AA', '#EE6677', '#228833', '#CCBB44', '#66CCEE', '#AA3377',
  '#332288', '#88CCEE', '#44AA99', '#117733', '#DDCC77', '#CC6677',
  '#882255', '#999933', '#000000', '#666666',
];
// Plot types whose color is driven by a continuous fill scale, where the
// universal discrete `palette_name` selector is a no-op. These expose their own
// `palette`/continuous color option instead (rendered by the generic loop).
const CONTINUOUS_FILL_KEYS = new Set([
  'heatmap', 'annotated_heatmap', 'correlation_heatmap', 'confusion_matrix',
  'volcano', 'contour', 'manhattan',
]);
function isContinuousFill(plotType: string): boolean {
  return CONTINUOUS_FILL_KEYS.has(plotType) || plotType.includes('enrichment') || plotType.includes('heatmap');
}
const FONT_FAMILY_OPTIONS = [
  { value: '', label: 'Default (sans)' },
  { value: 'sans', label: 'Sans-serif' },
  { value: 'arial', label: 'Arial-compatible sans' },
  { value: 'dejavu_sans', label: 'DejaVu Sans (installed Arial-compatible fallback)' },
  { value: 'helvetica', label: 'Helvetica-compatible sans' },
  { value: 'serif', label: 'Serif' },
  { value: 'mono', label: 'Monospace' },
];
const DPI_OPTIONS = ['150', '300', '600', '1200'];
const FACET_SCALE_OPTIONS = [
  { value: 'fixed', label: 'Fixed (shared)' },
  { value: 'free', label: 'Free (both)' },
  { value: 'free_x', label: 'Free X' },
  { value: 'free_y', label: 'Free Y' },
];
const ERROR_TYPE_OPTIONS = [
  { value: 'sd', label: 'Std. deviation (SD)' },
  { value: 'se', label: 'Std. error (SE)' },
  { value: 'ci95', label: '95% CI' },
];

function sliderNumber(value: number | readonly number[]): number {
  return Array.isArray(value) ? Number(value[0]) : Number(value);
}
function alphaSliderValue(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? Math.min(1, Math.max(0.05, num)) : fallback;
}
function setStringOption(options: Record<string, unknown>, key: string, value: string): Record<string, unknown> {
  const next = { ...options };
  if (value) next[key] = value;
  else delete next[key];
  return next;
}
function deleteOption(options: Record<string, unknown>, key: string): Record<string, unknown> {
  const next = { ...options };
  delete next[key];
  return next;
}
function offersSeriesAutoOption(plotType: string, optionKey: string, options: Record<string, unknown>) {
  return plotType === 'line'
    && options.redundant_series_encoding === true
    && (optionKey === 'line_type' || optionKey === 'point_shape');
}
function usesSeriesAutoOption(plotType: string, optionKey: string, options: Record<string, unknown>) {
  return offersSeriesAutoOption(plotType, optionKey, options)
    && !Object.prototype.hasOwnProperty.call(options, optionKey);
}
function stringListOption(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
// Merge a saved level order with the true distinct levels: keep saved entries
// that still exist (in order), then append any new levels not yet ordered.
function mergeLevelOrder(order: string[], levels: string[]): string[] {
  const known = new Set(levels);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const level of order) {
    if (known.has(level) && !seen.has(level)) { merged.push(level); seen.add(level); }
  }
  for (const level of levels) {
    if (!seen.has(level)) { merged.push(level); seen.add(level); }
  }
  return merged;
}
// Option search (U11): case-insensitive substring match against an option's
// label or key, plus a small highlighter for the matched substring in labels.
function optionSearchMatches(query: string, key: string, label: string): boolean {
  if (!query) return true;
  return label.toLowerCase().includes(query) || key.toLowerCase().includes(query);
}
function highlightOptionMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query);
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-amber-200 px-0.5 text-inherit">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}
function swapItems<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function normalizeHexColor(value: string): string {
  const clean = value.trim();
  return HEX_COLOR_RE.test(clean) ? clean.toUpperCase() : clean;
}

function numericOptionValue(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value;
  return '';
}

function scalarOptionValue(value: unknown, fallback: unknown = ''): string {
  const stringify = (candidate: unknown): string | null => {
    if (typeof candidate === 'string') return candidate;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
    return null;
  };
  return stringify(value) ?? stringify(fallback) ?? '';
}

function reviewEvidenceValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(unset)';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

type AccessibilityChecks = NonNullable<Review['payload']['accessibility_checks']>;

function accessibilityStatusLabel(status?: string): string {
  if (status === 'pass') return 'Pass';
  if (status === 'needs_review') return 'Needs review';
  if (status === 'evaluated') return 'Evaluated';
  if (status === 'not_evaluable') return 'Not evaluable';
  return status ? status.replaceAll('_', ' ') : 'Not evaluable';
}

function accessibilityStatusClass(status?: string): string {
  if (status === 'pass' || status === 'evaluated') return 'border-green-600/40 bg-green-50 text-green-800 dark:bg-green-950/30 dark:text-green-300';
  if (status === 'needs_review') return 'border-amber-600/40 bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300';
  return 'border-muted-foreground/30 bg-muted text-muted-foreground';
}

function metricValue(value: number | null | undefined, suffix = ''): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}${suffix}` : 'Not available';
}

function closestPairText(pair?: [string, string] | null): string | null {
  return pair?.length === 2 ? `${pair[0]} / ${pair[1]}` : null;
}

function AccessibilityReviewChecks({ checks }: { checks: AccessibilityChecks }) {
  const cvd = checks.cvd;
  const grayscale = checks.grayscale;
  const contrast = checks.minimum_contrast;
  const colors = checks.palette?.colors ?? [];
  return (
    <section className="space-y-2 rounded-md border p-3 text-xs" aria-label="Deterministic color accessibility checks">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-medium">Color accessibility checks</h3>
          <p className="text-muted-foreground">Calculated from the configured palette; these results are not an AI opinion.</p>
        </div>
        <Badge variant="outline" className={accessibilityStatusClass(checks.palette?.status)}>
          Palette {accessibilityStatusLabel(checks.palette?.status)}
        </Badge>
      </div>
      {colors.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label={`Evaluated palette: ${colors.join(', ')}`}>
          {colors.map((color, index) => (
            <span
              key={`${color}-${index}`}
              className="h-4 w-4 rounded-sm border"
              style={{ backgroundColor: color }}
              title={color}
              aria-hidden="true"
            />
          ))}
          <span className="text-muted-foreground">
            {checks.palette?.source ?? 'Resolved palette'}
            {checks.palette?.series_count != null ? ` · ${checks.palette.series_count} series` : ''}
          </span>
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded border bg-background p-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="font-medium">CVD simulation</span>
            <Badge variant="outline" className={accessibilityStatusClass(cvd?.status)}>{accessibilityStatusLabel(cvd?.status)}</Badge>
          </div>
          {cvd?.simulations?.length ? (
            <dl className="space-y-1 text-muted-foreground">
              {cvd.simulations.map((simulation) => (
                <div key={simulation.mode} className="flex items-start justify-between gap-2">
                  <dt className="capitalize">{simulation.mode}</dt>
                  <dd className="text-right">
                    ΔE {metricValue(simulation.min_delta_e)}
                    {closestPairText(simulation.closest_pair) ? <span className="block text-[10px]">{closestPairText(simulation.closest_pair)}</span> : null}
                  </dd>
                </div>
              ))}
            </dl>
          ) : <p className="text-muted-foreground">{cvd?.reason ?? 'No pairwise result is available.'}</p>}
          {cvd?.threshold_delta_e != null && <p className="mt-1 text-[10px] text-muted-foreground">Review threshold: ΔE {cvd.threshold_delta_e}</p>}
        </div>
        <div className="rounded border bg-background p-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="font-medium">Grayscale</span>
            <Badge variant="outline" className={accessibilityStatusClass(grayscale?.status)}>{accessibilityStatusLabel(grayscale?.status)}</Badge>
          </div>
          <p className="text-muted-foreground">Minimum ΔL {metricValue(grayscale?.min_delta_l)}</p>
          {closestPairText(grayscale?.closest_pair) && <p className="text-[10px] text-muted-foreground">Closest: {closestPairText(grayscale?.closest_pair)}</p>}
          {grayscale?.threshold_delta_l != null && <p className="mt-1 text-[10px] text-muted-foreground">Review threshold: ΔL {grayscale.threshold_delta_l}</p>}
          {grayscale?.reason && <p className="mt-1 text-muted-foreground">{grayscale.reason}</p>}
        </div>
        <div className="rounded border bg-background p-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="font-medium">Background contrast</span>
            <Badge variant="outline" className={accessibilityStatusClass(contrast?.status)}>{accessibilityStatusLabel(contrast?.status)}</Badge>
          </div>
          <p className="text-muted-foreground">Minimum ratio {metricValue(contrast?.ratio, ':1')}</p>
          {contrast?.foreground && <p className="text-[10px] text-muted-foreground">{contrast.foreground} on {contrast.background ?? '#FFFFFF'}</p>}
          {contrast?.threshold_ratio != null && <p className="mt-1 text-[10px] text-muted-foreground">Review threshold: {contrast.threshold_ratio}:1</p>}
          {contrast?.reason && <p className="mt-1 text-muted-foreground">{contrast.reason}</p>}
        </div>
      </div>
      {checks.palette?.reason && <p className="text-muted-foreground">{checks.palette.reason}</p>}
    </section>
  );
}

function updateNumericOption(options: Record<string, unknown>, key: string, rawValue: string): Record<string, unknown> {
  const next = { ...options };
  const value = rawValue.trim();
  if (!value) {
    delete next[key];
    return next;
  }
  const parsed = Number(value);
  if (Number.isFinite(parsed)) next[key] = parsed;
  return next;
}

function clearAxisRangeOptions(options: Record<string, unknown>): Record<string, unknown> {
  const next = { ...options };
  AXIS_RANGE_OPTION_KEYS.forEach((key) => delete next[key]);
  return next;
}

function normalizedCategoryColors(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([level, color]) => (
      level.trim().length > 0 && typeof color === 'string' && HEX_COLOR_RE.test(color)
    )).map(([level, color]) => [level.trim(), normalizeHexColor(String(color))]),
  );
}

function mappingValue(mapping: Record<string, unknown>, key: string): string | null {
  const value = mapping[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function categoryColorColumn(plotType: string, mapping: Record<string, unknown>, options: Record<string, unknown>): string | null {
  const explicit = mappingValue(mapping, 'group') || mappingValue(mapping, 'color');
  if (explicit) return explicit;
  if (plotType === 'box' || plotType === 'violin') return mappingValue(mapping, 'x');
  if (plotType === 'bar' && options.color_bars) return mappingValue(mapping, 'x');
  return null;
}

// The categorical column whose level order the R renderer honors via
// `level_order` (box/violin/bar/grouped_bar). Superset of categoryColorColumn:
// it also covers a plain bar chart (x axis) that has NO per-category colouring,
// so the reorder control is offered wherever the backend can actually apply it.
function reorderableColumn(plotType: string, mapping: Record<string, unknown>): string | null {
  const explicit = mappingValue(mapping, 'group') || mappingValue(mapping, 'color');
  if (explicit) return explicit;
  if (plotType === 'box' || plotType === 'violin' || plotType === 'bar') return mappingValue(mapping, 'x');
  return null;
}

// Numeric-aware alphabetical sort of category levels (matches the renderer's
// numeric-aware auto order). `desc` reverses it.
function sortLevels(levels: string[], dir: 'asc' | 'desc'): string[] {
  const sorted = [...levels].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  return dir === 'desc' ? sorted.reverse() : sorted;
}

// True distinct levels of the grouping column, sourced from the column-values
// endpoint and falling back to the profiled sample values before it loads.
function distinctColumnLevels(values: string[] | undefined, profile: ColumnProfile | undefined): string[] {
  const levels: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    const label = String(raw ?? '').trim();
    if (label && !seen.has(label)) { seen.add(label); levels.push(label); }
  };
  if (values?.length) values.forEach(push);
  else (profile?.sample_values ?? []).forEach(push);
  return levels;
}

// Konva-based overlay is client-only (react-konva touches the DOM/canvas).
const FigureAnnotationOverlay = dynamic(
  () => import('@/components/figures/FigureAnnotationOverlay').then((m) => m.FigureAnnotationOverlay),
  {
    ssr: false,
    loading: () => (
      <div className="py-20 text-center text-muted-foreground"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>
    ),
  },
);

export default function FigureDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnCanvasParam = searchParams.get('returnCanvas');
  const returnCanvasId = returnCanvasParam && /^[0-9a-f-]{36}$/i.test(returnCanvasParam)
    ? returnCanvasParam
    : null;
  const { data: fig, isLoading, isError, refetch } = useQuery({ queryKey: ['figure', id], queryFn: () => getFigure(id) });
  const { data: stylesData } = useQuery({ queryKey: ['styles'], queryFn: getStyles });
  const { data: plotTypesData } = useQuery({ queryKey: ['plot-types'], queryFn: getPlotTypes });
  const { data: palettesData } = useQuery({ queryKey: ['palettes'], queryFn: getPalettes });
  const { data: dataset } = useQuery({ queryKey: ['dataset', fig?.dataset_id], queryFn: () => getDataset(fig!.dataset_id), enabled: !!fig?.dataset_id });
  const { data: project } = useQuery({ queryKey: ['project', fig?.project_id], queryFn: () => getProject(fig!.project_id!), enabled: !!fig?.project_id });

  const [selectedVid, setSelectedVid] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [improvements, setImprovements] = useState<Improvement[] | null>(null);
  // A successful apply receipt is durable across subsequent plan reviews.
  // Draft-plan unsupported coverage is separate so reviewing another request
  // cannot erase the diff/verification/Undo for the version just created.
  const [aiAppliedOutcome, setAiAppliedOutcome] = useState<AiEditOutcome | null>(null);
  const [aiPlanOutcome, setAiPlanOutcome] = useState<AiEditOutcome | null>(null);
  const [aiUndoTarget, setAiUndoTarget] = useState<AiUndoTarget | null>(null);
  // A create-version response is already durable, but the figure-detail GET
  // that follows can take longer. Keep the existing tools mounted and show the
  // new version from the mutation response while that authoritative refetch is
  // in flight.
  const [syncingVersionId, setSyncingVersionId] = useState<string | null>(null);
  // Version compare slider (U11) - the dialog itself is keyed by figure id so
  // its base/compare selections and divider reset when the figure changes.
  const [compareOpen, setCompareOpen] = useState(false);

  // edit panel
  const [plotType, setPlotType] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Record<string, unknown> | null>(null);
  const [options, setOptions] = useState<Record<string, unknown> | null>(null);
  const [style, setStyle] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>('basic');
  // Option search (U11) - filters editablePlotOptions + the hardcoded extra
  // controls directly below them; see the render-time filtering below.
  const [optionSearch, setOptionSearch] = useState('');
  const [description, setDescription] = useState<string | null>(null);
  const [legend, setLegend] = useState<string | null>(null);
  const [improvePrompt, setImprovePrompt] = useState('');
  const [legendPrompt, setLegendPrompt] = useState('');
  const [palettePanelOpen, setPalettePanelOpen] = useState(false);
  const [paletteEditingId, setPaletteEditingId] = useState<string | null>(null);
  const [paletteName, setPaletteName] = useState('');
  const [paletteColors, setPaletteColors] = useState<string[]>(DEFAULT_CUSTOM_COLORS);
  const [newCategoryColorLevel, setNewCategoryColorLevel] = useState('');
  const [methodsText, setMethodsText] = useState<string | null>(null);
  const [altText, setAltText] = useState<string | null>(null);
  // Toggle between the static PNG preview and the interactive plotly HTML export.
  const [interactiveView, setInteractiveView] = useState(false);

  // Live preview (debounced auto-rerender) + client-side edit history (undo/redo).
  const [livePreview, setLivePreview] = useState(false);
  const [history, setHistory] = useState<{ stack: { sig: string; state: EditState }[]; index: number }>({ stack: [], index: -1 });
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRenderedSigRef = useRef<string | null>(null);
  const renderStartSigRef = useRef<string | null>(null);
  const editSignatureRef = useRef<string>('');
  // Drop an armed-but-not-yet-fired live-preview render. Called when an AI
  // apply starts so a stale draft can never race the reviewed patch.
  function cancelPendingLivePreview() {
    if (liveTimerRef.current) {
      clearTimeout(liveTimerRef.current);
      liveTimerRef.current = null;
    }
  }
  const isUndoRedoRef = useRef(false);
  const historyRef = useRef(history);
  // A plan belongs to the exact version from which it was requested. The
  // token also prevents a v1 -> v2 -> v1 switch from reviving the original v1
  // response merely because the version id happens to match again.
  const improvePlanRequestTokenRef = useRef(0);
  const selectedVersionRef = useRef<string | null>(null);
  historyRef.current = history;

  const plotTypes = plotTypesData?.plot_types ?? [];
  const styles = stylesData?.styles ?? [];
  const palettes = palettesData?.palettes ?? [];
  const columns: ColumnProfile[] = dataset?.column_profile ?? [];
  const effectiveSelectedVid = selectedVid ?? fig?.current_version_id ?? fig?.versions[fig.versions.length - 1]?.id ?? null;
  selectedVersionRef.current = effectiveSelectedVid;
  const version: FigureVersion | undefined = fig?.versions.find((v) => v.id === effectiveSelectedVid);
  // Version compare (U11) defaults: Compare = the version currently open;
  // Base = the version right before it (falls back to any other version if
  // the current one is the oldest, or is not found).
  const compareVersionsList = fig?.versions ?? [];
  const compareDefaultCompareId = effectiveSelectedVid;
  const compareCurrentIndex = compareVersionsList.findIndex((v) => v.id === effectiveSelectedVid);
  const compareDefaultBaseId = compareCurrentIndex > 0
    ? compareVersionsList[compareCurrentIndex - 1].id
    : (compareVersionsList.find((v) => v.id !== effectiveSelectedVid)?.id ?? effectiveSelectedVid);
  const effectivePlotType = plotType ?? fig?.plot_type ?? '';
  const effectiveStyle = style ?? fig?.style_preset ?? '';
  const effectiveMapping = mapping ?? version?.mapping ?? {};
  const effectiveOptions = options ?? version?.options ?? {};
  const selectedPaletteKey = scalarOptionValue(effectiveOptions.palette_name, 'preset');
  const selectedPalette = palettes.find((pl) => pl.key === selectedPaletteKey);
  const selectedStyle = styles.find((s) => s.key === effectiveStyle);
  const descriptionValue = description ?? fig?.description ?? '';
  const legendValue = legend ?? fig?.legend ?? '';
  const currentDef: PlotTypeDef | undefined = plotTypes.find((p) => p.type === effectivePlotType);
  const editablePlotOptions = (currentDef?.options ?? []).filter((option) => !GENERIC_OPTION_EXCLUDE.has(option.key));
  // Option search (U11) scope: the generic per-type option rows above, plus
  // the three hardcoded "extra" rows rendered directly below them (error
  // bars, secondary-Y column/label). Mapping REQUIRED/OPTIONAL fields and the
  // large "universal" appearance block further down stay always-visible -
  // there are few of the former, and the latter is a set of distinct
  // composite editors (palette, annotations, facets, ...) rather than simple
  // label/input rows, so filtering them row-by-row is out of scope here.
  const optionSearchQuery = optionSearch.trim().toLowerCase();
  const filteredPlotOptions = editablePlotOptions.filter((o) => optionSearchMatches(optionSearchQuery, o.key, o.label));
  const errorTypeRowApplicable = effectivePlotType === 'bar' && !editablePlotOptions.some((o) => o.key === 'error_type');
  const showErrorTypeRow = errorTypeRowApplicable && optionSearchMatches(optionSearchQuery, 'error_type', 'Error bars');
  const y2RowsApplicable = (effectivePlotType === 'line' || effectivePlotType === 'scatter') && !editablePlotOptions.some((o) => o.key === 'y2_column');
  const showY2ColumnRow = y2RowsApplicable && optionSearchMatches(optionSearchQuery, 'y2_column', 'Secondary Y column');
  const showY2LabelRow = y2RowsApplicable && optionSearchMatches(optionSearchQuery, 'y2_label', 'Secondary Y label');
  const noOptionSearchMatches = Boolean(optionSearchQuery) && filteredPlotOptions.length === 0 && !showErrorTypeRow && !showY2ColumnRow && !showY2LabelRow;
  const continuousFill = isContinuousFill(effectivePlotType);
  const categoryColors = normalizedCategoryColors(effectiveOptions.category_colors);
  const categoryColorColumnName = categoryColorColumn(effectivePlotType, effectiveMapping, effectiveOptions);
  // The column driving the reorder UI + the distinct-levels query. Superset of
  // categoryColorColumnName (it also covers a plain bar's x axis), and equal to
  // it whenever the colour column is set — so the same levels feed both the
  // colour pickers and the reorder list.
  const reorderColumnName = reorderableColumn(effectivePlotType, effectiveMapping);
  const reorderColumnProfile = columns.find((column) => column.name === reorderColumnName);
  // True distinct levels of the currently-mapped grouping/category column, used
  // to drive both the per-category color pickers and the level-order reorder UI.
  const { data: columnValues } = useQuery({
    queryKey: ['column-values', fig?.dataset_id, reorderColumnName],
    queryFn: () => getColumnValues(fig!.dataset_id, reorderColumnName!),
    enabled: !!fig?.dataset_id && !!reorderColumnName,
  });
  const distinctLevels = distinctColumnLevels(columnValues?.values, reorderColumnProfile);
  const categoryColorLevels = [
    ...distinctLevels,
    ...Object.keys(categoryColors).filter((level) => !distinctLevels.includes(level)),
  ].slice(0, 60);
  const orderedLevels = mergeLevelOrder(stringListOption(effectiveOptions.level_order), distinctLevels);
  const hasLevelOrder = Array.isArray(effectiveOptions.level_order);
  const canEditFigure = !fig?.project_id || project?.role === 'owner' || project?.role === 'editor';
  const isViewerOnly = Boolean(fig?.project_id && project?.role === 'viewer');
  const interactiveHtmlReady = Boolean(version?.html_url);
  const interactiveHtmlRequested = Boolean(effectiveOptions.interactive_html);
  const hasUnsavedEdits = Boolean(
    mapping !== null || options !== null
    || (plotType !== null && plotType !== fig?.plot_type)
    || (style !== null && style !== fig?.style_preset)
    || (description !== null && description !== (fig?.description ?? ''))
    || (legend !== null && legend !== (fig?.legend ?? '')),
  );
  // Render-relevant edits only (excludes notes/legend which have their own save).
  const hasRenderEdits = Boolean(
    mapping !== null || options !== null
    || (plotType !== null && plotType !== fig?.plot_type)
    || (style !== null && style !== fig?.style_preset),
  );
  // Stable signature of the current editable render state; drives both the
  // debounced live-preview trigger and the undo/redo history.
  const editSignature = JSON.stringify({
    plotType: effectivePlotType, mapping: effectiveMapping, options: effectiveOptions, style: effectiveStyle,
  });
  editSignatureRef.current = editSignature;

  function resetEditDrafts() {
    setPlotType(null); setMapping(null); setOptions(null); setStyle(null);
  }
  function transitionToExistingVersion(nextVersionId: string | null) {
    // Keep every version transition atomic from the AI planner's point of
    // view. In particular, a delete/409 callback and a held /improve response
    // can settle in the same task before React has rendered the new version.
    invalidateImprovePlanRequest();
    selectedVersionRef.current = nextVersionId;
    setSelectedVid(nextVersionId);
    setReview(null);
    setImprovements(null);
    setAiAppliedOutcome(null);
    setAiPlanOutcome(null);
    setAiUndoTarget(null);
  }
  function announceCreatedVersion(created: FigureVersion) {
    publishFigureVersionCreated({
      figureId: id,
      versionId: created.id,
      versionNumber: created.version_number,
      source: 'figure-editor',
    });
  }
  async function synchronizeCreatedVersion(created: FigureVersion): Promise<void> {
    invalidateImprovePlanRequest();
    selectedVersionRef.current = created.id;
    setSyncingVersionId(created.id);
    const seedCreatedVersion = () => {
      // Never select an id that is absent from the detail model. That transient
      // mismatch cleared `version` and could make the lower editor feel as if it
      // had disappeared until a manual reload completed.
      qc.setQueryData<FigureDetail>(['figure', id], (old) => old ? {
        ...old,
        current_version_id: created.id,
        style_preset: created.style_preset,
        updated_at: created.created_at || old.updated_at,
        versions: [...old.versions.filter((item) => item.id !== created.id), created],
      } : old);
    };
    seedCreatedVersion();
    setSelectedVid(created.id);
    try {
      // Reconcile all figure-level fields (including plot type/status) from the
      // server. The optimistic version above keeps every detail tool usable
      // while this request is pending or if a transient refetch fails.
      const refreshed = await refetch();
      if (!refreshed.data?.versions.some((item) => item.id === created.id)) {
        // A proxy/browser may briefly serve the pre-mutation detail. The POST
        // response is authoritative for this durable version, so do not let a
        // stale GET recreate the selected-id-without-version gap. Leave the
        // query stale so the next normal visit can reconcile again.
        seedCreatedVersion();
        qc.invalidateQueries({ queryKey: ['figure', id], exact: true, refetchType: 'none' });
      }
    } finally {
      setSyncingVersionId((current) => current === created.id ? null : current);
    }
  }
  function captureAiUndoSource(baseVersionId?: string): AiUndoSource | null {
    const source = fig?.versions.find((item) => item.id === (baseVersionId ?? effectiveSelectedVid));
    if (!source) return null;
    return {
      sourceVersionId: source.id,
      sourceVersionNumber: source.version_number,
      mapping: { ...(source.mapping ?? {}) },
      options: { ...(source.options ?? {}) },
      stylePreset: source.style_preset,
    };
  }
  const apply = useMutation({
    // base_version_id: reject (409) if the figure changed in another tab (e.g.
    // a canvas editor committed) since this draft was based on `version`.
    // ONLY sent when the CURRENT version is being edited — applying while
    // viewing an old version is the legitimate fork-from-history workflow and
    // must not trip the guard (backend compares against current_version_id).
    mutationFn: () => rerenderFigure(id, {
      plot_type: effectivePlotType, mapping: effectiveMapping, options: effectiveOptions, style_preset: effectiveStyle,
      change_note: 'Edited in figure editor',
      base_version_id: version?.id && version.id === fig?.current_version_id ? version.id : undefined,
    }),
    onSuccess: async (v) => {
      announceCreatedVersion(v);
      setReview(null); setImprovements(null); setAiAppliedOutcome(null); setAiPlanOutcome(null); setAiUndoTarget(null); resetEditDrafts();
      await synchronizeCreatedVersion(v);
      toast.success(`Re-rendered (v${v.version_number})`);
      qc.invalidateQueries({ queryKey: ['figures'] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) {
        toast.error('This figure changed elsewhere — review the latest version, then apply again.');
        // Re-guard the retry: clear the version pin so after the refetch the
        // page resolves to the NEW current version (and shows it). Without
        // this the guard was one-shot — the stale pin made the next Apply
        // omit base_version_id and silently supersede the other tab's work.
        transitionToExistingVersion(null);
        qc.invalidateQueries({ queryKey: ['figure', id] });
        return;
      }
      toast.error(e instanceof Error ? e.message : 'Render failed');
    },
  });
  // Debounced live-preview render. Unlike `apply` it stays quiet (no toast) and
  // only clears the drafts when no further edits arrived while it was in flight
  // (so keystrokes made mid-render are not lost).
  const livePreviewMut = useMutation({
    mutationFn: () => rerenderFigure(id, {
      plot_type: effectivePlotType,
      mapping: effectiveMapping,
      options: effectiveOptions,
      style_preset: effectiveStyle,
      change_note: 'Live preview',
      // Capture the current committed version when this delayed preview starts.
      // If another tab advances it while R is rendering, the backend rejects
      // this request instead of letting a stale preview overwrite newer work.
      base_version_id: fig?.current_version_id ?? undefined,
    }),
    onSuccess: async (v) => {
      announceCreatedVersion(v);
      setReview(null); setImprovements(null); setAiAppliedOutcome(null); setAiPlanOutcome(null); setAiUndoTarget(null);
      if (renderStartSigRef.current === editSignatureRef.current) resetEditDrafts();
      await synchronizeCreatedVersion(v);
      qc.invalidateQueries({ queryKey: ['figures'] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) {
        toast.error('Live preview was not applied because this figure changed elsewhere. Your draft is preserved; review the latest version and try again.');
        transitionToExistingVersion(null);
        qc.invalidateQueries({ queryKey: ['figure', id] });
        return;
      }
      toast.error(e instanceof Error ? e.message : 'Live preview failed');
    },
  });
  const duplicateMut = useMutation({
    mutationFn: () => duplicateFigure(id),
    onSuccess: (newFig) => {
      toast.success('Figure duplicated');
      qc.invalidateQueries({ queryKey: ['figures'] });
      // Hard navigation on purpose. The soft router.push (and a delayed
      // fallback) kept desynchronizing in the field: the page content
      // switched to the copy while the address bar kept the source id
      // (reproduced twice by the user, 2026-08-19). A full load of the
      // copy's canonical URL costs one extra fetch and can never diverge.
      window.location.assign(`/figures/${newFig.id}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Duplicate failed'),
  });
  const runReview = useMutation({
    mutationFn: () => reviewVersion(id, effectiveSelectedVid!),
    onSuccess: (r) => { setReview(r); toast.success('Review complete'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Review failed'),
  });
  function invalidateImprovePlanRequest() {
    improvePlanRequestTokenRef.current += 1;
  }
  function isCurrentImprovePlanRequest(request: ImprovePlanMutation): boolean {
    return request.requestToken === improvePlanRequestTokenRef.current
      && request.baseVersionId === selectedVersionRef.current;
  }
  const runImprove = useMutation({
    mutationFn: ({ request, baseVersionId }: ImprovePlanMutation) => improveVersion(
      id,
      baseVersionId,
      request ?? { prompt: improvePrompt },
    ),
    onSuccess: (l, request) => {
      // A slow v1 response must never become the visible/applicable plan after
      // the user has moved to v2 (or left and returned to v1 meanwhile).
      if (!isCurrentImprovePlanRequest(request)) return;
      setImprovements(l);
      // (U10b) Surface the unsupported reasons on Suggest too - they arrive on
      // every row of this improve call; without this the carrier row's "cannot
      // be applied" card would point at reasons rendered nowhere.
      const unsupported = dedupeUnsupported(l[0]?.unsupported ?? []);
      setAiPlanOutcome(unsupported.length
        ? { appliedChanges: [], droppedKeys: [], unsupported, verification: null }
        : null);
      toast.success(`${l.length} suggestions`);
    },
    onError: (e, request) => {
      if (!isCurrentImprovePlanRequest(request)) return;
      toast.error(e instanceof Error ? e.message : 'Improve failed');
    },
  });
  function startImprovePlan(request?: ImproveVersionRequest) {
    const baseVersionId = effectiveSelectedVid;
    if (!baseVersionId) {
      toast.error('Select a figure version before creating an AI plan.');
      return;
    }
    const requestToken = improvePlanRequestTokenRef.current + 1;
    improvePlanRequestTokenRef.current = requestToken;
    runImprove.mutate({ request, baseVersionId, requestToken });
  }
  function toastAppliedSkipped(v: FigureVersion, successMsg: string) {
    const skipped = v.skipped ?? [];
    if (skipped.length) {
      const appliedCount = (v.applied ?? []).length;
      toast.warning(`${appliedCount} change${appliedCount === 1 ? '' : 's'} applied; ${skipped.length} not supported: ${skipped.join(', ')}`);
    } else {
      toast.success(successMsg);
    }
  }
  // The same mark-scoped reason can repeat across every Improvement in one
  // /improve batch. Preserve identical prose for distinct marks while
  // collapsing copies of the same mark/reason.
  function dedupeUnsupported(items: UnsupportedRequestItem[]): UnsupportedRequestItem[] {
    const seen = new Set<string>();
    const out: UnsupportedRequestItem[] = [];
    for (const item of items) {
      const key = `${item.mark_id?.trim() || 'request'}::${item.request.trim()}::${item.reason.trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }
  function handleAiApplyError(error: unknown) {
    if (error instanceof ApiError && error.status === 409) {
      toast.error('This figure changed after the AI plan was created. Nothing was applied; review the latest version and create a new plan.');
      transitionToExistingVersion(null);
      qc.invalidateQueries({ queryKey: ['figure', id] });
      return;
    }
    toast.error(error instanceof Error ? error.message : 'AI edit failed');
  }
  const applyImp = useMutation({
    // retry:false - the user picked this exact suggestion; verification may
    // report an unsatisfied verdict but must never auto-apply another edit.
    onMutate: () => cancelPendingLivePreview(),
    mutationFn: ({ improvementId, options }: { improvementId: string; options: AiSuggestionApplyOptions; undoSource: AiUndoSource }) =>
      applyImprovement(id, improvementId, { ...options, retry: false }),
    onSuccess: async (result, { improvementId, undoSource }) => {
      announceCreatedVersion(result.version);
      const unsupported = dedupeUnsupported(improvements?.find((item) => item.id === improvementId)?.unsupported ?? []);
      setAiAppliedOutcome({ appliedChanges: result.applied_changes, droppedKeys: result.dropped_keys, unsupported, verification: result.verification ?? null });
      setAiPlanOutcome(null);
      setAiUndoTarget({ ...undoSource, appliedVersionId: result.version.id, appliedVersionNumber: result.version.version_number });
      setReview(null); setImprovements(null); resetEditDrafts();
      await synchronizeCreatedVersion(result.version);
      toastAppliedSkipped(result.version, `Applied as v${result.version.version_number}; R script regenerated`);
    },
    onError: handleAiApplyError,
  });
  const applyImps = useMutation({
    // retry:false for the same reason as applyImp above.
    onMutate: () => cancelPendingLivePreview(),
    mutationFn: ({ improvementIds, options }: { improvementIds: string[]; options: AiSuggestionApplyOptions; undoSource: AiUndoSource }) =>
      applyImprovements(id, improvementIds, { ...options, retry: false }),
    onSuccess: async (result, { improvementIds, undoSource }) => {
      announceCreatedVersion(result.version);
      const unsupported = dedupeUnsupported(
        (improvements ?? []).filter((item) => improvementIds.includes(item.id)).flatMap((item) => item.unsupported ?? []),
      );
      setAiAppliedOutcome({ appliedChanges: result.applied_changes, droppedKeys: result.dropped_keys, unsupported, verification: result.verification ?? null });
      setAiPlanOutcome(null);
      setAiUndoTarget({ ...undoSource, appliedVersionId: result.version.id, appliedVersionNumber: result.version.version_number });
      setReview(null); setImprovements(null); resetEditDrafts();
      await synchronizeCreatedVersion(result.version);
      toastAppliedSkipped(result.version, `Applied checked suggestions as v${result.version.version_number}; R script regenerated`);
      qc.invalidateQueries({ queryKey: ['figures'] });
    },
    onError: handleAiApplyError,
  });
  const directAiEdit = useMutation({
    onMutate: () => cancelPendingLivePreview(),
    mutationFn: async ({ request, baseVersionId }: { request: AiEditPayload; baseVersionId: string; undoSource: AiUndoSource }) => {
      const prompt = (request.prompt ?? improvePrompt).trim();
      if (!prompt) throw new Error('Describe the edit you want first');
      const verify = request.verify ?? true;
      const suggestions = await improveVersion(id, baseVersionId, {
        prompt,
        annotated_image: request.annotated_image,
        original_request: request.original_request,
        marks: request.marks,
      });
      const applicable = suggestions.filter((item) => item.param_patch && Object.keys(item.param_patch).length > 0);
      if (!applicable.length) {
        // (U10b) Nothing was applicable, but the AI may still have reported
        // WHY in `unsupported` - surface that instead of only an error toast.
        return { suggestions, appliedIds: [] as string[], result: null };
      }
      const appliedIds = applicable.map((item) => item.id);
      const applyOptions = {
        verify,
        original_request: request.original_request,
        verification_request: prompt,
        expected_base_version_id: baseVersionId,
      };
      const result = appliedIds.length === 1
        ? await applyImprovement(id, appliedIds[0], applyOptions)
        : await applyImprovements(id, appliedIds, applyOptions);
      return { suggestions, appliedIds, result };
    },
    onSuccess: async ({ suggestions, appliedIds, result }, { undoSource }) => {
      const unsupported = dedupeUnsupported(suggestions[0]?.unsupported ?? []);
      if (!result) {
        setImprovements(suggestions);
        setAiPlanOutcome({ appliedChanges: [], droppedKeys: [], unsupported, verification: null });
        toast[unsupported.length ? 'warning' : 'error'](
          unsupported.length ? 'AI did not return an applicable visual edit; see the reasons below.' : 'AI did not return an applicable visual edit',
        );
        return;
      }
      announceCreatedVersion(result.version);
      const applied = new Set(appliedIds);
      setImprovements(suggestions.map((item) => applied.has(item.id) ? { ...item, applied: true } : item));
      setAiAppliedOutcome({ appliedChanges: result.applied_changes, droppedKeys: result.dropped_keys, unsupported, verification: result.verification ?? null });
      setAiPlanOutcome(null);
      setAiUndoTarget({ ...undoSource, appliedVersionId: result.version.id, appliedVersionNumber: result.version.version_number });
      setReview(null);
      resetEditDrafts();
      await synchronizeCreatedVersion(result.version);
      toastAppliedSkipped(result.version, `AI edit applied as v${result.version.version_number}; R script regenerated`);
      qc.invalidateQueries({ queryKey: ['figures'] });
    },
    onError: handleAiApplyError,
  });
  const undoAiEdit = useMutation({
    mutationFn: (target: AiUndoTarget) => rerenderFigure(id, {
      mapping: target.mapping,
      options: target.options,
      style_preset: target.stylePreset,
      change_note: `Restored pre-AI settings from v${target.sourceVersionNumber} after v${target.appliedVersionNumber}`,
      // The one-click restore is valid only while the AI-applied version is
      // still current. A cross-tab edit produces 409 instead of being lost.
      base_version_id: target.appliedVersionId,
    }),
    onSuccess: async (restored) => {
      announceCreatedVersion(restored);
      setReview(null);
      setImprovements(null);
      setAiAppliedOutcome(null);
      setAiPlanOutcome(null);
      setAiUndoTarget(null);
      resetEditDrafts();
      await synchronizeCreatedVersion(restored);
      toast.success(`AI edit undone as v${restored.version_number}`);
      qc.invalidateQueries({ queryKey: ['figures'] });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        toast.error('Undo was not applied because this figure changed elsewhere. No newer work was overwritten.');
        transitionToExistingVersion(null);
        qc.invalidateQueries({ queryKey: ['figure', id] });
        return;
      }
      toast.error(error instanceof Error ? error.message : 'Could not undo the AI edit');
    },
  });
  function startApplySuggestion(improvementId: string, options: AiSuggestionApplyOptions) {
    const baseVersionId = options.expected_base_version_id ?? effectiveSelectedVid ?? undefined;
    const undoSource = captureAiUndoSource(baseVersionId);
    if (!baseVersionId || !undoSource) {
      toast.error('The version used for this AI plan is no longer available. Create a new plan from the latest version.');
      return;
    }
    applyImp.mutate({
      improvementId,
      options: { ...options, expected_base_version_id: baseVersionId },
      undoSource,
    });
  }
  function startApplySuggestions(improvementIds: string[], options: AiSuggestionApplyOptions) {
    const baseVersionId = options.expected_base_version_id ?? effectiveSelectedVid ?? undefined;
    const undoSource = captureAiUndoSource(baseVersionId);
    if (!baseVersionId || !undoSource) {
      toast.error('The version used for this AI plan is no longer available. Create a new plan from the latest version.');
      return;
    }
    applyImps.mutate({
      improvementIds,
      options: { ...options, expected_base_version_id: baseVersionId },
      undoSource,
    });
  }
  function startDirectAiEdit(request: AiEditPayload) {
    const baseVersionId = effectiveSelectedVid ?? undefined;
    const undoSource = captureAiUndoSource(baseVersionId);
    if (!baseVersionId || !undoSource) {
      toast.error('No saved figure version is available for this AI edit.');
      return;
    }
    directAiEdit.mutate({ request, baseVersionId, undoSource });
  }
  const saveDesc = useMutation({
    mutationFn: () => updateFigure(id, { description: descriptionValue }),
    onSuccess: () => { toast.success('Interpretation saved'); setDescription(null); qc.invalidateQueries({ queryKey: ['figure', id] }); },
  });
  const enhanceNotes = useMutation({
    mutationFn: () => enhancePrompt(descriptionValue, 'interpretation', fig ? `${fig.plot_type} figure: ${fig.name}` : undefined),
    onSuccess: (r) => { setDescription(r.enhanced); toast.success('Enhanced'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Enhance failed'),
  });
  const saveLegend = useMutation({
    mutationFn: () => updateFigure(id, { legend: legendValue }),
    onSuccess: () => { toast.success('Legend saved'); setLegend(null); qc.invalidateQueries({ queryKey: ['figure', id] }); },
  });
  const aiLegend = useMutation({
    mutationFn: () => generateLegend(id, effectiveSelectedVid!, {
      prompt: legendPrompt,
      current_legend: legendValue,
    }),
    onSuccess: (r) => {
      setLegend(r.legend);
      setLegendPrompt('');
      toast.success(legendPrompt.trim() ? 'AI legend revised' : 'AI legend generated');
      qc.invalidateQueries({ queryKey: ['figure', id] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Legend failed'),
  });
  const deleteVersion = useMutation({
    onMutate: () => cancelPendingLivePreview(),
    mutationFn: (versionId: string) => deleteFigureVersion(id, versionId),
    onSuccess: (updated, deletedVersionId) => {
      toast.success('Version deleted');
      // Deleting a version must never re-render anything: any leftover draft
      // would otherwise diff against the newly selected version and the
      // live-preview debounce would start minting unrequested "Live preview"
      // versions (2026-08-19 runaway report: one delete -> v3..v6 appeared).
      resetEditDrafts();
      qc.setQueryData(['figure', id], updated);
      qc.invalidateQueries({ queryKey: ['figure', id] });
      qc.invalidateQueries({ queryKey: ['figures'] });
      if (selectedVid === deletedVersionId || fig?.current_version_id === deletedVersionId) {
        transitionToExistingVersion(
          updated.current_version_id ?? updated.versions[updated.versions.length - 1]?.id ?? null,
        );
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Version delete failed'),
  });
  const toggleFavorite = useMutation({
    mutationFn: async () => {
      if (fig?.is_favorite) {
        await deleteFigureTemplateFavorite(id);
        return false;
      }
      await saveFigureTemplateFavorite(id, { source_version_id: effectiveSelectedVid ?? undefined });
      return true;
    },
    onSuccess: (saved) => {
      toast.success(saved ? 'Saved as a template' : 'Removed from saved templates');
      qc.setQueryData(['figure', id], fig ? { ...fig, is_favorite: saved } : fig);
      qc.invalidateQueries({ queryKey: ['figure', id] });
      qc.invalidateQueries({ queryKey: ['figures'] });
      qc.invalidateQueries({ queryKey: ['figure-template-favorites'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Template update failed'),
  });
  const saveCustomPalette = useMutation({
    mutationFn: () => {
      const name = paletteName.trim();
      const colors = paletteColors.map(normalizeHexColor).filter((c) => HEX_COLOR_RE.test(c));
      if (!name) throw new Error('Palette name is required');
      if (colors.length === 0) throw new Error('Choose at least one HEX color');
      if (paletteEditingId) return updateCustomPalette(paletteEditingId, { name, colors });
      return createCustomPalette({ name, colors });
    },
    onSuccess: (palette) => {
      toast.success(paletteEditingId ? 'Palette updated' : 'Palette saved');
      setOptions({ ...effectiveOptions, palette_name: palette.key });
      setPalettePanelOpen(false);
      setPaletteEditingId(null);
      qc.invalidateQueries({ queryKey: ['palettes'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Palette save failed'),
  });
  const removeCustomPalette = useMutation({
    mutationFn: (palette: PaletteDef) => {
      if (!palette.id) throw new Error('Palette id is missing');
      return deleteCustomPalette(palette.id);
    },
    onSuccess: (_, palette) => {
      toast.success('Palette deleted');
      if (selectedPaletteKey === palette.key) setOptions({ ...effectiveOptions, palette_name: 'preset' });
      setPalettePanelOpen(false);
      setPaletteEditingId(null);
      qc.invalidateQueries({ queryKey: ['palettes'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Palette delete failed'),
  });
  const publishToggle = useMutation({
    mutationFn: (isPublic: boolean) => updateFigure(id, { is_public: isPublic }),
    onSuccess: (updated) => {
      toast.success(updated.is_public ? 'Published to the gallery' : 'Removed from the gallery');
      qc.setQueryData(['figure', id], updated);
      qc.invalidateQueries({ queryKey: ['figure', id] });
      qc.invalidateQueries({ queryKey: ['figures'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Publish failed'),
  });
  const shareToggle = useMutation({
    mutationFn: (enable: boolean) => setFigureShare(id, enable),
    onSuccess: (res) => {
      toast.success(res.share_token ? 'Share link ready' : 'Share link disabled');
      qc.setQueryData(['figure', id], fig ? { ...fig, share_token: res.share_token } : fig);
      qc.invalidateQueries({ queryKey: ['figure', id] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Share link update failed'),
  });
  const methodsMut = useMutation({
    mutationFn: () => getMethodsText(id, effectiveSelectedVid!),
    onSuccess: (r) => { setMethodsText(r.methods_text); toast.success('Methods text generated'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Methods text failed'),
  });
  const altMut = useMutation({
    mutationFn: () => getAltText(id, effectiveSelectedVid!),
    onSuccess: (r) => { setAltText(r.alt_text); toast.success('Alt-text generated'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Alt-text failed'),
  });

  // Warn before losing unsaved edit-panel / notes / legend drafts on reload/close.
  useEffect(() => {
    if (!hasUnsavedEdits) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedEdits]);

  // Restore the persisted live-preview preference once on mount.
  useEffect(() => {
    try {
      if (localStorage.getItem(LIVE_PREVIEW_STORAGE_KEY) === '1') setLivePreview(true);
    } catch { /* localStorage unavailable */ }
  }, []);
  function toggleLivePreview(next: boolean) {
    setLivePreview(next);
    try { localStorage.setItem(LIVE_PREVIEW_STORAGE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
  }

  // Client-side edit history: push a new entry whenever the editable render
  // signature changes (unless the change came from an undo/redo). Capped at
  // HISTORY_CAP; the redo tail is truncated when a fresh edit is committed.
  useEffect(() => {
    if (!fig) return;
    if (isUndoRedoRef.current) { isUndoRedoRef.current = false; return; }
    setHistory((h) => {
      const cur = h.stack[h.index];
      if (cur && cur.sig === editSignature) return h;
      const state: EditState = { plotType: effectivePlotType, mapping: effectiveMapping, options: effectiveOptions, style: effectiveStyle };
      const truncated = h.stack.slice(0, h.index + 1);
      truncated.push({ sig: editSignature, state });
      const capped = truncated.slice(-HISTORY_CAP);
      return { stack: capped, index: capped.length - 1 };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editSignature, Boolean(fig)]);

  function applyEditState(s: EditState) {
    isUndoRedoRef.current = true;
    setPlotType(s.plotType);
    setMapping(s.mapping);
    setOptions(s.options);
    setStyle(s.style);
  }
  const canUndo = history.index > 0;
  const canRedo = history.index >= 0 && history.index < history.stack.length - 1;
  function undo() {
    const h = historyRef.current;
    if (h.index <= 0) return;
    applyEditState(h.stack[h.index - 1].state);
    setHistory((cur) => ({ ...cur, index: Math.max(0, cur.index - 1) }));
  }
  function redo() {
    const h = historyRef.current;
    if (h.index >= h.stack.length - 1) return;
    applyEditState(h.stack[h.index + 1].state);
    setHistory((cur) => ({ ...cur, index: Math.min(cur.stack.length - 1, cur.index + 1) }));
  }

  // Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z — scoped so it never steals undo from an
  // active text field (inputs, textareas, selects, contentEditable), or from
  // inside an open modal dialog (e.g. the version-compare slider), where the
  // edit panel is hidden and an undo would be silent and invisible.
  useEffect(() => {
    if (!canEditFigure) return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      if (el?.closest('[role="dialog"]')) return;
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEditFigure]);

  // Any AI-edit work in flight (plan, apply, undo). Live preview must stay
  // silent for its whole duration: a leftover draft firing mid-apply raced
  // the AI version and produced "Live preview" versions the user never asked
  // for (2026-08-19 P0 report: plan said 60°/right, v2 came out 90°/bottom).
  const aiEditBusy = runImprove.isPending || applyImp.isPending || applyImps.isPending
    || directAiEdit.isPending || undoAiEdit.isPending;

  // Debounced live-preview trigger. Fires 700ms after the last edit; while a
  // render is in flight the effect re-runs on settle and reschedules if newer
  // edits are pending, guaranteeing convergence to the latest edited state.
  useEffect(() => {
    if (!livePreview || !canEditFigure || !hasRenderEdits) return;
    if (editSignature === lastRenderedSigRef.current) return;
    if (livePreviewMut.isPending || apply.isPending || aiEditBusy) return; // will re-run when the flag flips
    if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
    liveTimerRef.current = setTimeout(() => {
      renderStartSigRef.current = editSignatureRef.current;
      lastRenderedSigRef.current = editSignatureRef.current;
      livePreviewMut.mutate();
    }, 700);
    return () => { if (liveTimerRef.current) clearTimeout(liveTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editSignature, livePreview, canEditFigure, hasRenderEdits, livePreviewMut.isPending, apply.isPending, aiEditBusy]);

  function confirmLeave(event: React.MouseEvent) {
    if (hasUnsavedEdits && !window.confirm('You have unsaved figure edits. Leave this page and discard them?')) {
      event.preventDefault();
    }
  }
  async function copyToClipboard(text: string, label: string) {
    try { await navigator.clipboard.writeText(text); toast.success(`${label} copied to clipboard`); }
    catch { toast.error('Copy failed'); }
  }
  async function copyRCode() {
    if (!version?.r_available) return;
    try {
      await copyToClipboard(await getExportText(id, version.id, 'r'), 'R code');
    } catch { toast.error('Could not load R code'); }
  }
  function setLevelOrder(next: string[]) {
    setOptions({ ...effectiveOptions, level_order: next });
  }
  function moveLevel(index: number, direction: -1 | 1) {
    const next = swapItems(orderedLevels, index, direction);
    if (next === orderedLevels) return;
    setLevelOrder(next);
  }

  async function doExport(fmt: string) {
    if (!version) return;
    try { await downloadExport(id, version.id, fmt, `${fig?.name ?? 'figure'}_v${version.version_number}.${fmt === 'r' ? 'R' : fmt}`); }
    catch { toast.error('Export failed'); }
  }

  const previewUrl = version?.png_url ?? version?.svg_url;
  const previewIsSvg = Boolean(previewUrl && previewUrl === version?.svg_url);
  const exportFormats = [
    { fmt: 'png', label: 'PNG', available: Boolean(version?.png_url) },
    { fmt: 'svg', label: 'SVG', available: Boolean(version?.svg_url) },
    { fmt: 'tiff', label: 'TIFF', available: Boolean(version?.tiff_url) },
    { fmt: 'pdf', label: 'PDF', available: Boolean(version?.pdf_url) },
    { fmt: 'eps', label: 'EPS', available: Boolean(version?.eps_url) },
    { fmt: 'r', label: 'R script', available: Boolean(version?.r_available) },
  ].filter((item) => item.available);

  function selectPlotType(pt: string) {
    setPlotType(pt);
    const def = plotTypes.find((p) => p.type === pt);
    const opt = { ...effectiveOptions };
    def?.options.forEach((o) => { if (opt[o.key] === undefined && o.default !== undefined) opt[o.key] = o.default; });
    setOptions(opt);
  }

  function openNewPalette() {
    setPaletteEditingId(null);
    setPaletteName('');
    setPaletteColors(selectedPalette?.hex?.length ? selectedPalette.hex.slice(0, 12) : DEFAULT_CUSTOM_COLORS);
    setPalettePanelOpen(true);
  }

  function openEditPalette(palette: PaletteDef) {
    if (!palette.custom || !palette.id) return;
    setPaletteEditingId(palette.id);
    setPaletteName(palette.name ?? palette.label.replace(/^Custom:\s*/, ''));
    setPaletteColors(palette.hex?.length ? palette.hex.slice(0, 12) : DEFAULT_CUSTOM_COLORS);
    setPalettePanelOpen(true);
  }

  function updatePaletteColor(index: number, color: string) {
    const next = [...paletteColors];
    next[index] = normalizeHexColor(color);
    setPaletteColors(next);
  }

  function addRepresentativeColor(color: string) {
    const next = [...paletteColors];
    const blankIndex = next.findIndex((c) => !c.trim());
    if (blankIndex >= 0) next[blankIndex] = color;
    else if (next.length < 12) next.push(color);
    else next[next.length - 1] = color;
    setPaletteColors(next);
  }

  function setCategoryColor(level: string, color: string) {
    const label = level.trim();
    const normalized = normalizeHexColor(color);
    if (!label || !HEX_COLOR_RE.test(normalized)) return;
    setOptions({ ...effectiveOptions, category_colors: { ...categoryColors, [label]: normalized } });
  }

  function removeCategoryColor(level: string) {
    const nextColors = { ...categoryColors };
    delete nextColors[level];
    const nextOptions = { ...effectiveOptions };
    if (Object.keys(nextColors).length) nextOptions.category_colors = nextColors;
    else delete nextOptions.category_colors;
    setOptions(nextOptions);
  }

  function addCategoryColorLevel() {
    const level = newCategoryColorLevel.trim();
    if (!level) return;
    setCategoryColor(level, '#4477AA');
    setNewCategoryColorLevel('');
  }

  function setSeriesStyles(next: Record<string, SeriesStyle>) {
    const nextOptions = { ...effectiveOptions };
    if (Object.keys(next).length) nextOptions.series_styles = next;
    else delete nextOptions.series_styles;
    setOptions(nextOptions);
  }

  function setInteractiveHtml(enabled: boolean) {
    const nextOptions = { ...effectiveOptions };
    if (enabled) nextOptions.interactive_html = true;
    else delete nextOptions.interactive_html;
    setOptions(nextOptions);
  }

  // The preview and Export card are two views of one workflow. Keep their
  // checked, pending, disabled and Generate states derived from the same
  // source so entering through the lower control cannot strand the user on a
  // different UI path (or conditionally replace the surrounding workspace).
  const interactiveHtmlPhase: 'idle' | 'requested' | 'generating' | 'ready' = interactiveHtmlReady
    ? 'ready'
    : apply.isPending && interactiveHtmlRequested
      ? 'generating'
      : interactiveHtmlRequested
        ? 'requested'
        : 'idle';

  function renderInteractiveHtmlControls(location: 'preview' | 'export') {
    const isPreview = location === 'preview';
    const controlId = `interactive-html-${location}`;
    return (
      <div
        className={isPreview
          ? 'flex flex-wrap items-center gap-2 rounded-md border bg-muted/20 px-2 py-1.5'
          : 'w-full space-y-1.5 rounded-md border bg-muted/20 p-2'}
        role="group"
        aria-label={`Interactive HTML ${location} controls`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={controlId} className="cursor-pointer text-xs">Interactive HTML</Label>
          <Switch
            id={controlId}
            checked={interactiveHtmlRequested}
            onCheckedChange={setInteractiveHtml}
            disabled={!canEditFigure || apply.isPending}
          />
          {interactiveHtmlPhase !== 'ready' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => apply.mutate()}
              disabled={interactiveHtmlPhase === 'idle' || interactiveHtmlPhase === 'generating'}
              aria-label="Generate interactive HTML"
            >
              {interactiveHtmlPhase === 'generating'
                ? <><Loader2 className="mr-1 h-4 w-4 animate-spin" /> Generating…</>
                : <><RefreshCw className="mr-1 h-4 w-4" /> Generate</>}
            </Button>
          )}
          {!isPreview && interactiveHtmlPhase === 'ready' && version?.html_url && (
            <Button variant="outline" size="sm" onClick={() => doExport('html')}>
              <Download className="mr-1 h-4 w-4" /> Download HTML
            </Button>
          )}
        </div>
        {!isPreview && (
          <p className="text-[11px] text-muted-foreground">
            {interactiveHtmlPhase === 'ready'
              ? 'An interactive HTML version is available for this figure.'
              : interactiveHtmlPhase === 'generating'
                ? 'Generating the interactive version. The figure workspace remains available.'
                : 'Enable and generate to create an interactive HTML version.'}
          </p>
        )}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="min-h-screen bg-muted/20">
        <AppHeader />
        <div className="flex flex-col items-center gap-4 px-4 py-20 text-center">
          <p className="text-sm text-muted-foreground">Could not load this figure.</p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void refetch()}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button>
            <Button variant="ghost" onClick={() => router.push('/figures')}>Back to figures</Button>
          </div>
        </div>
      </div>
    );
  }
  if (isLoading || !fig) {
    return (<div className="min-h-screen bg-muted/20"><AppHeader /><div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin" /></div></div>);
  }
  const p = review?.payload;
  const reviewEvidence = p?.evidence;

  return (
    <div className="min-h-screen bg-muted/20">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-4 py-8">
        <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
          <Link href="/figures" className="hover:underline" onClick={confirmLeave}>Figures</Link>
          {fig.project_id && <>/ <Link href={`/projects/${fig.project_id}`} className="hover:underline" onClick={confirmLeave}>project</Link></>}
          / {fig.name}
        </div>
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{fig.name}</h1>
          <Badge variant="secondary">{fig.plot_type}</Badge>
          <Badge variant="outline">{formatStylePreset(fig.style_preset)}</Badge>
          {isViewerOnly && <Badge variant="outline">viewer</Badge>}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => toggleFavorite.mutate()}
            disabled={toggleFavorite.isPending}
            aria-label={fig.is_favorite ? 'Remove from saved templates' : 'Save as template'}
          >
            <Star className={`h-4 w-4 ${fig.is_favorite ? 'fill-amber-400 text-amber-500' : 'text-muted-foreground'}`} />
            {fig.is_favorite ? 'Saved template' : 'Save as template'}
          </Button>
          {canEditFigure && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => duplicateMut.mutate()}
              disabled={duplicateMut.isPending}
              aria-label="Duplicate this figure"
            >
              {duplicateMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CopyPlus className="h-4 w-4" />}
              Duplicate
            </Button>
          )}
          {returnCanvasId && (
            <Link
              href={`/canvases/${returnCanvasId}`}
              className={buttonVariants({ variant: 'default', size: 'sm' })}
              title="Return to the canvas that opened this figure; it follows the latest version automatically"
            >
              <PanelsTopLeft className="h-4 w-4" /> Return to canvas
            </Link>
          )}
          {canEditFigure && (
            <div className="ml-auto flex items-center gap-2 rounded-md border px-3 py-1.5">
              <Label htmlFor="publish-gallery" className="cursor-pointer text-sm text-muted-foreground">Publish to gallery</Label>
              <Switch
                id="publish-gallery"
                checked={fig.is_public}
                onCheckedChange={(checked) => publishToggle.mutate(checked)}
                disabled={publishToggle.isPending}
                aria-label="Publish this figure to the public gallery"
              />
              <Badge variant={fig.is_public ? 'default' : 'secondary'} className="text-[10px]">{fig.is_public ? 'Public' : 'Private'}</Badge>
            </div>
          )}
        </div>

        {/* private share link (read-only, anyone with the URL) */}
        {canEditFigure && (
          <div className="mb-6 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
            <Label htmlFor="share-link" className="cursor-pointer text-sm text-muted-foreground">Share link</Label>
            <Switch
              id="share-link"
              checked={Boolean(fig.share_token)}
              onCheckedChange={(checked) => shareToggle.mutate(checked)}
              disabled={shareToggle.isPending}
              aria-label="Enable a read-only share link for this figure"
            />
            {fig.share_token ? (
              <>
                <Input
                  readOnly
                  value={typeof window !== 'undefined' ? `${window.location.origin}/share/${fig.share_token}` : `/share/${fig.share_token}`}
                  onFocus={(e) => e.currentTarget.select()}
                  className="h-8 min-w-0 flex-1 basis-64 font-mono text-xs"
                  aria-label="Share link URL"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => copyToClipboard(`${window.location.origin}/share/${fig.share_token}`, 'Share link')}
                >
                  <Copy className="mr-1 h-4 w-4" /> Copy
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={shareToggle.isPending}
                  title="Generate a new link; the previous link stops working"
                  onClick={() => shareToggle.mutate(true)}
                >
                  <RefreshCw className="mr-1 h-4 w-4" /> Rotate
                </Button>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">Anyone with the link can view this figure (read-only). Turn on to create a link.</span>
            )}
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-3">
          {/* left: image + paper-writing */}
          <div className="space-y-4 lg:col-span-2">
            <Card><CardContent className="space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Label htmlFor="interactive-view" className="cursor-pointer text-xs text-muted-foreground">Interactive view</Label>
                  <Switch
                    id="interactive-view"
                    checked={interactiveView && interactiveHtmlReady}
                    onCheckedChange={setInteractiveView}
                    disabled={!interactiveHtmlReady}
                    aria-label="Show the interactive HTML figure with hover tooltips"
                  />
                  <span className="text-[11px] text-muted-foreground">
                    {interactiveHtmlReady ? 'Hover points in the interactive version.' : 'Generate an interactive version to enable this view.'}
                  </span>
                </div>
                {!interactiveHtmlReady && canEditFigure && renderInteractiveHtmlControls('preview')}
              </div>
              {interactiveView && version?.html_url ? (
                <iframe
                  src={version.html_url}
                  title="Interactive figure"
                  sandbox="allow-scripts"
                  className="h-[480px] w-full rounded border bg-white"
                />
              ) : previewUrl ? (
                canEditFigure ? (
                  <FigureAnnotationOverlay
                    key={version?.id ?? 'no-version'}
                    imageUrl={previewUrl}
                    alt={fig.name}
                    layout={version?.layout}
                    elementOptions={effectiveOptions}
                    renderedElementOptions={version?.options}
                    onOptionsPatch={(patch) => {
                      // U6: element edits land in the DRAFT (undo/redo + live
                      // preview + Apply pipeline); null unsets an option.
                      const next = { ...effectiveOptions } as Record<string, unknown>;
                      for (const [key, value] of Object.entries(patch)) {
                        if (value === null) delete next[key];
                        else next[key] = value;
                      }
                      setOptions(next);
                    }}
                  />
                ) : (
                  <img src={previewUrl} alt={fig.name} decoding="async" className="mx-auto max-h-[58vh] w-auto rounded bg-white object-contain" />
                )
              ) : (
                <div className="py-20 text-center text-muted-foreground">No image</div>
              )}
              {previewIsSvg && !interactiveView && <p className="text-center text-xs text-muted-foreground">SVG preview</p>}
            </CardContent></Card>

            <AiFigureEditor
              key={version?.id ?? 'no-version'}
              imageUrl={version?.png_url ?? version?.svg_url}
              versionId={version?.id}
              versionNumber={version?.version_number}
              prompt={improvePrompt}
              improvements={improvements}
              plotType={fig.plot_type}
              currentMapping={version?.mapping}
              currentOptions={version?.options}
              currentStylePreset={version?.style_preset}
              layout={version?.layout}
              canEdit={canEditFigure}
              isSuggesting={runImprove.isPending}
              isApplyingPrompt={directAiEdit.isPending}
              isApplyingSuggestion={applyImp.isPending || applyImps.isPending}
              isUndoingLastEdit={undoAiEdit.isPending}
              canUndoLastEdit={Boolean(aiUndoTarget && aiAppliedOutcome?.appliedChanges.length)}
              appliedOutcome={aiAppliedOutcome}
              planOutcome={aiPlanOutcome}
              onPromptChange={setImprovePrompt}
              onSuggest={startImprovePlan}
              onApplyPrompt={startDirectAiEdit}
              onApplySuggestion={startApplySuggestion}
              onApplySuggestions={startApplySuggestions}
              onUndoLastEdit={() => aiUndoTarget && undoAiEdit.mutate(aiUndoTarget)}
            />

            <Card role="region" aria-label="Figure exports">
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Download className="h-4 w-4" /> Export {version && `(v${version.version_number})`}</CardTitle></CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {exportFormats.map((f) => <Button key={f.fmt} variant="outline" size="sm" onClick={() => doExport(f.fmt)}>{f.label}</Button>)}
                {version?.r_available && (
                  <Button variant="outline" size="sm" onClick={copyRCode} aria-label="Copy R code to clipboard">
                    <Copy className="mr-1 h-4 w-4" /> Copy R code
                  </Button>
                )}
                <FigureCodeExport figureId={id} versionId={effectiveSelectedVid} />
                {exportFormats.length === 0 && <p className="text-sm text-muted-foreground">No export files available for this version.</p>}
                {/* Interactive HTML uses the same request/generate state as the
                    preview controls above, including pending and disabled UI. */}
                {renderInteractiveHtmlControls('export')}
              </CardContent>
            </Card>

            {/* AI figure legend (for the manuscript) */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base"><FileText className="h-4 w-4" /> Figure legend</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Textarea value={legendValue} onChange={(e) => setLegend(e.target.value)} rows={4} readOnly={!canEditFigure} placeholder="AI-generated or hand-written figure legend for your manuscript…" />
                {canEditFigure ? (
                  <>
                    <div className="space-y-1">
                      <Label htmlFor="legend-revision-request" className="text-xs">Optional AI revision request</Label>
                      <Textarea
                        id="legend-revision-request"
                        value={legendPrompt}
                        onChange={(e) => setLegendPrompt(e.target.value)}
                        rows={2}
                        maxLength={1500}
                        placeholder="Example: make it shorter, clarify the groups, and avoid interpreting the result."
                      />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => aiLegend.mutate()} disabled={aiLegend.isPending || !effectiveSelectedVid}>
                        {aiLegend.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}
                        {legendPrompt.trim() ? 'Revise with AI' : 'AI generate'}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => saveLegend.mutate()} disabled={saveLegend.isPending}>Save legend</Button>
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">Editor access is required to change the legend.</p>
                )}
              </CardContent>
            </Card>

            {/* interpretation / notes */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Pencil className="h-4 w-4" /> Interpretation / notes</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                <Textarea value={descriptionValue} onChange={(e) => setDescription(e.target.value)} rows={3} readOnly={!canEditFigure} placeholder="Your interpretation of this figure (results, takeaways) for the paper…" />
                {canEditFigure ? (
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => enhanceNotes.mutate()} disabled={enhanceNotes.isPending}>
                      {enhanceNotes.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />} Enhance
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => saveDesc.mutate()} disabled={saveDesc.isPending}>Save notes</Button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Editor access is required to change notes.</p>
                )}
              </CardContent>
            </Card>

            {/* Methods text + accessibility alt-text */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><FileText className="h-4 w-4" /> Methods &amp; accessibility</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label className="text-xs">Methods text</Label>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => methodsMut.mutate()} disabled={methodsMut.isPending || !effectiveSelectedVid}>
                        {methodsMut.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <FileText className="mr-1 h-4 w-4" />} Generate Methods text
                      </Button>
                      {methodsText && (
                        <Button size="sm" variant="ghost" onClick={() => copyToClipboard(methodsText, 'Methods text')} aria-label="Copy methods text to clipboard">
                          <Copy className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                  {methodsText && <Textarea value={methodsText} readOnly rows={4} className="text-xs" />}
                </div>
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label className="text-xs">Figure alt-text</Label>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => altMut.mutate()} disabled={altMut.isPending || !effectiveSelectedVid}>
                        {altMut.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />} Generate alt-text
                      </Button>
                      {altText && (
                        <Button size="sm" variant="ghost" onClick={() => copyToClipboard(altText, 'Alt-text')} aria-label="Copy alt-text to clipboard">
                          <Copy className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                  {altText && <Textarea value={altText} readOnly rows={3} className="text-xs" />}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* right: editor + versions + AI */}
          <div className="space-y-4" aria-busy={Boolean(syncingVersionId)}>
            {syncingVersionId && (
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground" role="status" aria-live="polite">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                Refreshing the complete figure details…
              </div>
            )}
            {/* EDIT panel */}
            <Card>
              <CardHeader className="gap-2 pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-base"><Pencil className="h-4 w-4" /> Edit figure</CardTitle>
                  {canEditFigure && (
                    <div className="flex rounded-md border bg-muted/30 p-0.5" role="group" aria-label="Editor mode" aria-describedby="editor-mode-description">
                      <Button
                        type="button"
                        variant={editorMode === 'basic' ? 'secondary' : 'ghost'}
                        size="sm"
                        className="h-7 px-2.5"
                        aria-pressed={editorMode === 'basic'}
                        onClick={() => setEditorMode('basic')}
                      >
                        Basic
                      </Button>
                      <Button
                        type="button"
                        variant={editorMode === 'advanced' ? 'secondary' : 'ghost'}
                        size="sm"
                        className="h-7 px-2.5"
                        aria-pressed={editorMode === 'advanced'}
                        onClick={() => setEditorMode('advanced')}
                      >
                        Advanced
                      </Button>
                    </div>
                  )}
                </div>
                {canEditFigure && (
                  <p id="editor-mode-description" className="text-xs text-muted-foreground" role="status">
                    {editorMode === 'basic'
                      ? 'Basic shows data mapping, labels, and the main style controls.'
                      : 'Advanced adds plot options, axis controls, annotations, layout, and export settings.'}
                  </p>
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                {!canEditFigure ? (
                  <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">Viewer access is read-only. You can download existing exports, but changing mappings, options, or versions requires editor access.</p>
                ) : (
                  <>
                    {/* live preview + undo/redo toolbar */}
                    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/20 px-2 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <Zap className={`h-3.5 w-3.5 ${livePreview ? 'text-amber-500' : 'text-muted-foreground'}`} />
                        <Label htmlFor="live-preview" className="cursor-pointer text-xs">Live preview</Label>
                        <Switch
                          id="live-preview"
                          checked={livePreview}
                          onCheckedChange={toggleLivePreview}
                          aria-label="Auto re-render on every change"
                        />
                      </div>
                      {livePreview && livePreviewMut.isPending && (
                        <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> updating…</span>
                      )}
                      <div className="ml-auto flex items-center gap-1">
                        <Button type="button" variant="ghost" size="icon-xs" aria-label="Undo (Ctrl+Z)" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
                          <Undo2 className="h-3.5 w-3.5" />
                        </Button>
                        <Button type="button" variant="ghost" size="icon-xs" aria-label="Redo (Ctrl+Shift+Z)" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>
                          <Redo2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="figure-chart-type">Chart type</Label>
                      <select id="figure-chart-type" className="w-full rounded-md border px-3 py-2 text-sm" value={effectivePlotType} onChange={(e) => selectPlotType(e.target.value)}>
                        {plotTypes.map((pt) => <option key={pt.type} value={pt.type}>{pt.label}</option>)}
                      </select>
                    </div>
                    {currentDef && [...currentDef.required.map((f) => ({ ...f, req: true })), ...currentDef.optional.map((f) => ({ ...f, req: false }))].map((f) => {
                      const controlId = `figure-mapping-${f.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
                      return (
                      <div key={f.key} className="space-y-1">
                        <Label htmlFor={f.multi ? undefined : controlId} className="text-xs">{f.label}{f.req && <span className="text-red-500"> *</span>}</Label>
                        {f.multi ? (
                          <div className="max-h-28 overflow-y-auto rounded-md border p-2" role="group" aria-label={f.label}>
                            {columns.map((c) => {
                              const raw = effectiveMapping[f.key];
                              const arr = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
                              return (
                                <label key={c.name} className="flex items-center gap-2 py-0.5 text-xs">
                                  <input type="checkbox" checked={arr.includes(c.name)} onChange={(e) => {
                                    const next = e.target.checked ? [...arr, c.name] : arr.filter((x) => x !== c.name);
                                    setMapping({ ...effectiveMapping, [f.key]: next });
                                  }} /> {c.name}
                                </label>
                              );
                            })}
                          </div>
                        ) : (
                          <select id={controlId} className="w-full rounded-md border px-2 py-1.5 text-sm" value={scalarOptionValue(effectiveMapping[f.key])} onChange={(e) => setMapping({ ...effectiveMapping, [f.key]: e.target.value || null })}>
                            <option value="">{f.req ? 'Select…' : '(none)'}</option>
                            {columns.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.role})</option>)}
                          </select>
                        )}
                      </div>
                      );
                    })}

                    <div id="advanced-plot-options" hidden={editorMode !== 'advanced'} className="space-y-3">
                    {/* option search (U11) - filters the plot-specific option rows just below */}
                    <div className="space-y-1">
                      <Label htmlFor="option-search" className="text-xs">Search options</Label>
                      <div className="relative">
                        <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          id="option-search"
                          type="search"
                          aria-label="Search options"
                          placeholder="Search options…"
                          value={optionSearch}
                          onChange={(e) => setOptionSearch(e.target.value)}
                          className="h-8 pr-7 pl-7 text-sm"
                        />
                        {optionSearch && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            aria-label="Clear option search"
                            className="absolute top-1/2 right-1 -translate-y-1/2"
                            onClick={() => setOptionSearch('')}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>

                    {/* plot-specific options */}
                    {filteredPlotOptions.map((o) => (
                      <div key={o.key} className="space-y-1">
                        <Label className="text-xs">{highlightOptionMatch(o.label, optionSearchQuery)}</Label>
                        {o.type === 'bool' ? (
                          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={Boolean(effectiveOptions[o.key])} onChange={(e) => setOptions({ ...effectiveOptions, [o.key]: e.target.checked })} /> enabled</label>
                        ) : o.type === 'select' ? (
                          <select
                            aria-label={o.label}
                            className="w-full rounded-md border px-2 py-1.5 text-sm"
                            value={usesSeriesAutoOption(effectivePlotType, o.key, effectiveOptions) ? SERIES_AUTO_OPTION : scalarOptionValue(effectiveOptions[o.key], o.default)}
                            onChange={(e) => setOptions(e.target.value === SERIES_AUTO_OPTION
                              ? deleteOption(effectiveOptions, o.key)
                              : { ...effectiveOptions, [o.key]: e.target.value })}
                          >
                            {offersSeriesAutoOption(effectivePlotType, o.key, effectiveOptions) && (
                              <option value={SERIES_AUTO_OPTION}>Auto by series (accessible)</option>
                            )}
                            {o.choices?.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        ) : o.type === 'number' ? (
                          <Input aria-label={o.label} type="number" value={numericOptionValue(effectiveOptions[o.key] ?? o.default)} onChange={(e) => setOptions(updateNumericOption(effectiveOptions, o.key, e.target.value))} />
                        ) : <Input aria-label={o.label} value={scalarOptionValue(effectiveOptions[o.key])} onChange={(e) => setOptions({ ...effectiveOptions, [o.key]: e.target.value })} />}
                      </div>
                    ))}

                    {/* error-bar statistic (bar charts only) */}
                    {showErrorTypeRow && (
                      <div className="space-y-1">
                        <Label htmlFor="error-type" className="text-xs">{highlightOptionMatch('Error bars', optionSearchQuery)}</Label>
                        <select id="error-type" className="w-full rounded-md border px-2 py-1.5 text-sm" value={scalarOptionValue(effectiveOptions.error_type, 'sd')} onChange={(e) => setOptions({ ...effectiveOptions, error_type: e.target.value })}>
                          {ERROR_TYPE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                        </select>
                      </div>
                    )}

                    {/* secondary Y axis (line & scatter only) */}
                    {y2RowsApplicable && (
                      <>
                        {showY2ColumnRow && (
                          <div className="space-y-1">
                            <Label htmlFor="y2-column" className="text-xs">{highlightOptionMatch('Secondary Y column', optionSearchQuery)}</Label>
                            <select id="y2-column" className="w-full rounded-md border px-2 py-1.5 text-sm" value={scalarOptionValue(effectiveOptions.y2_column)} onChange={(e) => setOptions(setStringOption(effectiveOptions, 'y2_column', e.target.value))}>
                              <option value="">None</option>
                              {columns.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.role})</option>)}
                            </select>
                          </div>
                        )}
                        {showY2LabelRow && (
                          <div className="space-y-1">
                            <Label htmlFor="y2-label" className="text-xs">{highlightOptionMatch('Secondary Y label', optionSearchQuery)}</Label>
                            <Input id="y2-label" className="text-sm" maxLength={120} value={scalarOptionValue(effectiveOptions.y2_label)} onChange={(e) => setOptions(setStringOption(effectiveOptions, 'y2_label', e.target.value))} placeholder="Right axis label" />
                          </div>
                        )}
                      </>
                    )}

                    {noOptionSearchMatches && (
                      // Honest about scope: only the plot-specific list above is
                      // filtered — a user searching "DPI"/"palette" would otherwise
                      // read this as "the option doesn't exist" while the control
                      // sits unfiltered in the appearance section below.
                      <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
                        No plot-specific options match &ldquo;{optionSearch.trim()}&rdquo;. Appearance controls below are not filtered.
                      </p>
                    )}
                    </div>

                    {/* universal label/axis/appearance controls */}
                    <div className="grid grid-cols-1 gap-2 border-t pt-2">
                      <div className="space-y-1"><Label htmlFor="figure-title" className="text-xs">In-plot title (usually blank)</Label><Input id="figure-title" className="text-sm" value={scalarOptionValue(effectiveOptions.title)} onChange={(e) => setOptions({ ...effectiveOptions, title: e.target.value })} placeholder="Leave blank for manuscript-style figures" /></div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1"><Label htmlFor="figure-x-label" className="text-xs">X label</Label><Input id="figure-x-label" className="text-sm" value={scalarOptionValue(effectiveOptions.x_label)} onChange={(e) => setOptions({ ...effectiveOptions, x_label: e.target.value })} /></div>
                        <div className="space-y-1"><Label htmlFor="figure-y-label" className="text-xs">Y label</Label><Input id="figure-y-label" className="text-sm" value={scalarOptionValue(effectiveOptions.y_label)} onChange={(e) => setOptions({ ...effectiveOptions, y_label: e.target.value })} /></div>
                      </div>
                      <div hidden={editorMode !== 'advanced'} className="space-y-2 rounded-md border bg-muted/20 p-2">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <Label className="text-xs">Axis scale</Label>
                            <p className="text-[11px] text-muted-foreground">Leave blank to auto-fit to the selected data.</p>
                          </div>
                          <Button type="button" variant="outline" size="sm" onClick={() => setOptions(clearAxisRangeOptions(effectiveOptions))}>Auto fit</Button>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div className="space-y-1">
                            <Label className="text-xs">X min</Label>
                            <Input type="number" step="any" className="text-sm" value={numericOptionValue(effectiveOptions.x_min)} onChange={(e) => setOptions(updateNumericOption(effectiveOptions, 'x_min', e.target.value))} placeholder="auto" />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">X max</Label>
                            <Input type="number" step="any" className="text-sm" value={numericOptionValue(effectiveOptions.x_max)} onChange={(e) => setOptions(updateNumericOption(effectiveOptions, 'x_max', e.target.value))} placeholder="auto" />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Y min</Label>
                            <Input type="number" step="any" className="text-sm" value={numericOptionValue(effectiveOptions.y_min)} onChange={(e) => setOptions(updateNumericOption(effectiveOptions, 'y_min', e.target.value))} placeholder="auto" />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Y max</Label>
                            <Input type="number" step="any" className="text-sm" value={numericOptionValue(effectiveOptions.y_max)} onChange={(e) => setOptions(updateNumericOption(effectiveOptions, 'y_max', e.target.value))} placeholder="auto" />
                          </div>
                        </div>
                      </div>
                      <div hidden={editorMode !== 'advanced'} className="space-y-2 rounded-md border bg-muted/20 p-2">
                        <div>
                          <Label className="text-xs">Broken axis</Label>
                          <p className="text-[11px] text-muted-foreground">A broken axis elides the [from, to] range. Both values are required and from must be less than to.</p>
                        </div>
                        <FigureAxisBreakControl
                          label="Break X axis"
                          value={effectiveOptions.axis_break_x}
                          onChange={(next) => setOptions(next ? { ...effectiveOptions, axis_break_x: next } : deleteOption(effectiveOptions, 'axis_break_x'))}
                        />
                        <FigureAxisBreakControl
                          label="Break Y axis"
                          value={effectiveOptions.axis_break_y}
                          onChange={(next) => setOptions(next ? { ...effectiveOptions, axis_break_y: next } : deleteOption(effectiveOptions, 'axis_break_y'))}
                        />
                      </div>
                      <div className="space-y-1"><Label htmlFor="figure-legend-title" className="text-xs">Legend title</Label><Input id="figure-legend-title" className="text-sm" value={scalarOptionValue(effectiveOptions.legend_title)} onChange={(e) => setOptions({ ...effectiveOptions, legend_title: e.target.value })} /></div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <Label htmlFor="figure-color-mode" className="text-xs">Color mode</Label>
                          <select id="figure-color-mode" className="w-full rounded-md border px-2 py-1.5 text-sm" value={scalarOptionValue(effectiveOptions.color_mode, 'color')} onChange={(e) => setOptions({ ...effectiveOptions, color_mode: e.target.value })}>
                            <option value="color">Color</option><option value="grayscale">Grayscale</option>
                          </select>
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="figure-style" className="text-xs">Style</Label>
                          <select id="figure-style" className="w-full rounded-md border px-2 py-1.5 text-sm" value={effectiveStyle} onChange={(e) => setStyle(e.target.value)}>{styles.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
                        </div>
                      </div>
                      {selectedStyle?.description && (
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {selectedStyle.description} Color palette overrides the style colors; manuscript styles use no gridlines by default.
                        </p>
                      )}
                      {/* Category order — reorder the data on the axis/legend. Shown for every
                          plot the renderer can reorder (box/violin/bar/grouped bar), including
                          plain bars with no per-category colouring. */}
                      {reorderColumnName && orderedLevels.length > 1 && (
                        <div hidden={editorMode !== 'advanced'} className="space-y-2 rounded-md border bg-muted/20 p-2">
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <Label className="text-xs">Category order</Label>
                              <p className="text-[11px] text-muted-foreground">Reorder the <span className="font-medium">{reorderColumnName}</span> levels shown on the axis and legend — move rows with the arrows, or use a quick sort.</p>
                            </div>
                            {hasLevelOrder && (
                              <Button type="button" variant="ghost" size="sm" onClick={() => setOptions(deleteOption(effectiveOptions, 'level_order'))}>Reset</Button>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-1">
                            <Button type="button" variant="outline" size="sm" onClick={() => setLevelOrder([...orderedLevels].reverse())}>Reverse</Button>
                            <Button type="button" variant="outline" size="sm" onClick={() => setLevelOrder(sortLevels(orderedLevels, 'asc'))}>A→Z</Button>
                            <Button type="button" variant="outline" size="sm" onClick={() => setLevelOrder(sortLevels(orderedLevels, 'desc'))}>Z→A</Button>
                          </div>
                          <div className="space-y-1">
                            {orderedLevels.map((level, index) => (
                              <div key={level} className="flex items-center gap-1">
                                <span className="w-5 shrink-0 text-center text-[11px] text-muted-foreground">{index + 1}</span>
                                <span className="min-w-0 flex-1 truncate text-xs" title={level}>{level}</span>
                                <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move ${level} up`} disabled={index === 0} onClick={() => moveLevel(index, -1)}><ArrowUp className="h-3.5 w-3.5" /></Button>
                                <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move ${level} down`} disabled={index === orderedLevels.length - 1} onClick={() => moveLevel(index, 1)}><ArrowDown className="h-3.5 w-3.5" /></Button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {/* color palette (discrete) — a no-op for continuous-fill charts, which use their own color scale */}
                      {continuousFill ? (
                        <div className="space-y-1 rounded-md border bg-muted/20 p-2">
                          <Label className="text-xs">Fill color scale</Label>
                          <p className="text-[11px] text-muted-foreground">This chart type uses a continuous color scale. Adjust it with the chart-specific color options above (e.g. palette / diverging midpoint); the discrete palette selector does not apply here.</p>
                        </div>
                      ) : (
                      <div className="space-y-1">
                        <Label htmlFor="figure-color-palette" className="text-xs">Color palette</Label>
                        <select id="figure-color-palette" className="w-full rounded-md border px-2 py-1.5 text-sm" value={selectedPaletteKey} onChange={(e) => setOptions({ ...effectiveOptions, palette_name: e.target.value })}>
                          {palettes.map((pl) => <option key={pl.key} value={pl.key}>{pl.label}{pl.colorblind_safe ? ' · colorblind-safe' : ''}</option>)}
                        </select>
                        <div className="mt-1 flex items-center gap-2">
                          {selectedPalette?.hex?.length ? (
                            <div className="flex gap-0.5">{selectedPalette.hex.map((h) => <span key={h} className="h-3 w-4 rounded-sm border" style={{ backgroundColor: h }} />)}</div>
                          ) : null}
                          {selectedPalette?.colorblind_safe && <Badge variant="outline" className="text-[10px]">Colorblind-safe</Badge>}
                        </div>
                        {categoryColorColumnName && (
                          <div hidden={editorMode !== 'advanced'}>
                          <div className="mt-2 space-y-2 rounded-md border bg-muted/20 p-2">
                            <div>
                              <Label className="text-xs">Category colors</Label>
                              <p className="text-[11px] text-muted-foreground">Override specific colors in <span className="font-medium">{categoryColorColumnName}</span>. Other groups keep the selected palette.</p>
                            </div>
                            {categoryColorLevels.length > 0 && (
                              <div className="space-y-1">
                                {categoryColorLevels.map((level) => {
                                  const color = categoryColors[level] ?? '';
                                  return (
                                    <div key={level} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(76px,92px)_auto] items-center gap-1">
                                      <span className="truncate text-xs" title={level}>{level}</span>
                                      <input
                                        type="color"
                                        value={HEX_COLOR_RE.test(color) ? color : '#4477AA'}
                                        onChange={(e) => setCategoryColor(level, e.target.value)}
                                        className="h-7 w-8 rounded border bg-background"
                                        aria-label={`Color for ${level}`}
                                      />
                                      <Input
                                        className="h-7 font-mono text-[11px]"
                                        value={color}
                                        placeholder="palette"
                                        onChange={(e) => {
                                          const next = normalizeHexColor(e.target.value);
                                          if (HEX_COLOR_RE.test(next)) setCategoryColor(level, next);
                                        }}
                                      />
                                      <Button type="button" variant="ghost" size="sm" disabled={!color} onClick={() => removeCategoryColor(level)}>Reset</Button>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                            <div className="flex gap-1">
                              <Input
                                className="h-8 text-xs"
                                value={newCategoryColorLevel}
                                onChange={(e) => setNewCategoryColorLevel(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') addCategoryColorLevel(); }}
                                placeholder="Add category label"
                              />
                              <Button type="button" variant="outline" size="sm" onClick={addCategoryColorLevel}>Add</Button>
                            </div>
                          </div>
                          </div>
                        )}
                        <div hidden={editorMode !== 'advanced'} className="space-y-2">
                        <div className="flex flex-wrap gap-2 pt-1">
                          <Button type="button" variant="outline" size="sm" onClick={openNewPalette}>New custom palette</Button>
                          {selectedPalette?.custom && (
                            <>
                              <Button type="button" variant="outline" size="sm" onClick={() => openEditPalette(selectedPalette)}>Edit palette</Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={removeCustomPalette.isPending}
                                onClick={() => {
                                  if (confirm(`Delete custom palette "${selectedPalette.name ?? selectedPalette.label}"?`)) {
                                    removeCustomPalette.mutate(selectedPalette);
                                  }
                                }}
                              >
                                <Trash2 className="mr-1 h-3 w-3" /> Delete
                              </Button>
                            </>
                          )}
                        </div>
                        {palettePanelOpen && (
                          <div className="mt-2 space-y-2 rounded-md border bg-muted/20 p-2">
                            <div className="space-y-1">
                              <Label className="text-xs">Palette name</Label>
                              <Input className="h-8 text-sm" value={paletteName} onChange={(e) => setPaletteName(e.target.value)} placeholder="e.g. AAV muted bars" maxLength={100} />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Representative colors</Label>
                              <div className="flex flex-wrap gap-1">
                                {REPRESENTATIVE_COLORS.map((color) => (
                                  <button
                                    key={color}
                                    type="button"
                                    title={color}
                                    className="h-6 w-6 rounded border shadow-sm"
                                    style={{ backgroundColor: color }}
                                    onClick={() => addRepresentativeColor(color)}
                                  />
                                ))}
                              </div>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Palette colors</Label>
                              {paletteColors.map((color, idx) => (
                                <div key={idx} className="flex items-center gap-1">
                                  <input
                                    type="color"
                                    value={HEX_COLOR_RE.test(color) ? color : '#4477AA'}
                                    onChange={(e) => updatePaletteColor(idx, e.target.value)}
                                    className="h-8 w-9 rounded border bg-background"
                                  />
                                  <Input className="h-8 flex-1 font-mono text-xs" value={color} onChange={(e) => updatePaletteColor(idx, e.target.value)} />
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-xs"
                                    disabled={paletteColors.length <= 1}
                                    onClick={() => setPaletteColors(paletteColors.filter((_, i) => i !== idx))}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Button type="button" variant="outline" size="sm" disabled={paletteColors.length >= 12} onClick={() => setPaletteColors([...paletteColors, '#666666'])}>Add color</Button>
                              <Button type="button" size="sm" disabled={saveCustomPalette.isPending} onClick={() => saveCustomPalette.mutate()}>
                                {saveCustomPalette.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                                {paletteEditingId ? 'Save palette' : 'Create and apply'}
                              </Button>
                              <Button type="button" variant="ghost" size="sm" onClick={() => setPalettePanelOpen(false)}>Cancel</Button>
                            </div>
                          </div>
                        )}
                        </div>
                      </div>
                      )}
                      <div id="advanced-appearance-options" hidden={editorMode !== 'advanced'} className="space-y-3">
                      {/* per-series styling (only when a group/color column is mapped) */}
                      {categoryColorColumnName && (
                        <FigureSeriesStyleEditor
                          value={seriesStyleMap(effectiveOptions.series_styles)}
                          onChange={setSeriesStyles}
                          seriesNames={distinctLevels}
                          columnName={categoryColorColumnName}
                        />
                      )}
                      {/* opacity (universal) */}
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <Label className="text-xs">Fill opacity</Label>
                            <span className="text-[11px] text-muted-foreground">{effectiveOptions.fill_alpha !== undefined ? Number(effectiveOptions.fill_alpha).toFixed(2) : 'default'}</span>
                          </div>
                          <Slider min={0.05} max={1} step={0.05} value={[alphaSliderValue(effectiveOptions.fill_alpha, 1)]} onValueChange={(v) => setOptions({ ...effectiveOptions, fill_alpha: sliderNumber(v) })} aria-label="Fill opacity" />
                        </div>
                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <Label className="text-xs">Point opacity</Label>
                            <span className="text-[11px] text-muted-foreground">{effectiveOptions.point_alpha !== undefined ? Number(effectiveOptions.point_alpha).toFixed(2) : 'default'}</span>
                          </div>
                          <Slider min={0.05} max={1} step={0.05} value={[alphaSliderValue(effectiveOptions.point_alpha, 1)]} onValueChange={(v) => setOptions({ ...effectiveOptions, point_alpha: sliderNumber(v) })} aria-label="Point opacity" />
                        </div>
                      </div>
                      {/* reference lines (universal) */}
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <Label htmlFor="hline-at" className="text-xs">Horizontal ref. line (y)</Label>
                          <Input id="hline-at" type="number" step="any" className="text-sm" value={numericOptionValue(effectiveOptions.hline_at)} onChange={(e) => setOptions(updateNumericOption(effectiveOptions, 'hline_at', e.target.value))} placeholder="none" />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="vline-at" className="text-xs">Vertical ref. line (x)</Label>
                          <Input id="vline-at" type="number" step="any" className="text-sm" value={numericOptionValue(effectiveOptions.vline_at)} onChange={(e) => setOptions(updateNumericOption(effectiveOptions, 'vline_at', e.target.value))} placeholder="none" />
                        </div>
                      </div>
                      {/* split into panels / faceting (universal) */}
                      <div className="space-y-2 rounded-md border bg-muted/20 p-2">
                        <Label htmlFor="facet-by" className="text-xs">Split into panels by…</Label>
                        <div className="grid grid-cols-2 gap-2">
                          <select id="facet-by" className="w-full rounded-md border px-2 py-1.5 text-sm" value={scalarOptionValue(effectiveOptions.facet_by)} onChange={(e) => setOptions(setStringOption(effectiveOptions, 'facet_by', e.target.value))}>
                            <option value="">No panels</option>
                            {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                          </select>
                          <select aria-label="Panel axis scales" className="w-full rounded-md border px-2 py-1.5 text-sm disabled:opacity-60" disabled={!effectiveOptions.facet_by} value={scalarOptionValue(effectiveOptions.facet_scales, 'fixed')} onChange={(e) => setOptions({ ...effectiveOptions, facet_scales: e.target.value })}>
                            {FACET_SCALE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                          </select>
                        </div>
                      </div>
                      {/* figure size */}
                      <div className="grid grid-cols-3 gap-2">
                        <div className="space-y-1">
                          <Label className="text-xs">Figure size</Label>
                          <select aria-label="Figure size preset" className="w-full rounded-md border px-2 py-1.5 text-sm" value={scalarOptionValue(effectiveOptions.size, 'wide')} onChange={(e) => setOptions({ ...effectiveOptions, size: e.target.value })}>
                            <option value="single_column">Single column</option>
                            <option value="wide">Wide (double)</option>
                            <option value="square">Square</option>
                            <option value="custom">Custom</option>
                          </select>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Width (in)</Label>
                          <Input aria-label="Custom figure width in inches" type="number" step="0.1" disabled={effectiveOptions.size !== 'custom'} value={numericOptionValue(effectiveOptions.width_in ?? 7)} onChange={(e) => setOptions(updateNumericOption(effectiveOptions, 'width_in', e.target.value))} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Height (in)</Label>
                          <Input aria-label="Custom figure height in inches" type="number" step="0.1" disabled={effectiveOptions.size !== 'custom'} value={numericOptionValue(effectiveOptions.height_in ?? 4.2)} onChange={(e) => setOptions(updateNumericOption(effectiveOptions, 'height_in', e.target.value))} />
                        </div>
                      </div>
                      {/* export DPI + typography (universal) */}
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <Label htmlFor="output-dpi" className="text-xs">Export DPI</Label>
                          <select id="output-dpi" className="w-full rounded-md border px-2 py-1.5 text-sm" value={numericOptionValue(effectiveOptions.dpi)} onChange={(e) => setOptions(e.target.value ? { ...effectiveOptions, dpi: Number(e.target.value) } : deleteOption(effectiveOptions, 'dpi'))}>
                            <option value="">Default (300)</option>
                            {DPI_OPTIONS.map((d) => <option key={d} value={d}>{d} dpi</option>)}
                          </select>
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="font-family" className="text-xs">Font family</Label>
                          <select id="font-family" className="w-full rounded-md border px-2 py-1.5 text-sm" value={scalarOptionValue(effectiveOptions.font_family)} onChange={(e) => setOptions(setStringOption(effectiveOptions, 'font_family', e.target.value))}>
                            {FONT_FAMILY_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                          </select>
                          {effectiveOptions.font_family === 'dejavu_sans' && (
                            <p className="text-xs text-muted-foreground">Exported R uses the installed Arial-compatible fallback: DejaVu Sans.</p>
                          )}
                        </div>
                      </div>
                      {/* legend layout + x tick angle (universal renderer options) */}
                      <div className="grid grid-cols-3 gap-2">
                        <div className="space-y-1">
                          <Label htmlFor="legend-position" className="text-xs">Legend position</Label>
                          <select id="legend-position" className="w-full rounded-md border px-2 py-1.5 text-sm" value={scalarOptionValue(effectiveOptions.legend_position)} onChange={(e) => setOptions(setStringOption(effectiveOptions, 'legend_position', e.target.value))}>
                            <option value="">Auto</option>
                            <option value="right">Right</option>
                            <option value="bottom">Bottom</option>
                            <option value="top">Top</option>
                            <option value="left">Left</option>
                            <option value="none">Hidden</option>
                          </select>
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="legend-direction" className="text-xs">Legend direction</Label>
                          <select id="legend-direction" className="w-full rounded-md border px-2 py-1.5 text-sm" value={scalarOptionValue(effectiveOptions.legend_direction)} onChange={(e) => setOptions(setStringOption(effectiveOptions, 'legend_direction', e.target.value))}>
                            <option value="">Auto</option>
                            <option value="vertical">Vertical</option>
                            <option value="horizontal">Horizontal</option>
                          </select>
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="x-tick-angle" className="text-xs">X tick angle</Label>
                          <select id="x-tick-angle" className="w-full rounded-md border px-2 py-1.5 text-sm" value={scalarOptionValue(effectiveOptions.x_text_angle)} onChange={(e) => setOptions(e.target.value === '' ? deleteOption(effectiveOptions, 'x_text_angle') : { ...effectiveOptions, x_text_angle: Number(e.target.value) })}>
                            <option value="">Auto</option>
                            <option value="0">0&deg;</option>
                            <option value="30">30&deg;</option>
                            <option value="45">45&deg;</option>
                            <option value="60">60&deg;</option>
                            <option value="90">90&deg;</option>
                          </select>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-3 text-xs">
                        <label className="flex items-center gap-1"><input type="checkbox" checked={Boolean(effectiveOptions.hide_legend)} onChange={(e) => setOptions({ ...effectiveOptions, hide_legend: e.target.checked })} /> Hide legend</label>
                        <label className="flex items-center gap-1"><input type="checkbox" checked={Boolean(effectiveOptions.log_y)} onChange={(e) => setOptions({ ...effectiveOptions, log_y: e.target.checked })} /> log Y</label>
                        <label className="flex items-center gap-1"><input type="checkbox" checked={Boolean(effectiveOptions.log_x)} onChange={(e) => setOptions({ ...effectiveOptions, log_x: e.target.checked })} /> log X</label>
                        <label className="flex items-center gap-1"><input type="checkbox" checked={Boolean(effectiveOptions.flip_coords)} onChange={(e) => setOptions({ ...effectiveOptions, flip_coords: e.target.checked })} /> flip</label>
                        <label className="flex items-center gap-1"><input type="checkbox" checked={Boolean(effectiveOptions.transparent_background)} onChange={(e) => setOptions({ ...effectiveOptions, transparent_background: e.target.checked })} /> Transparent background</label>
                      </div>
                      </div>
                    </div>
                    <Button className="w-full" onClick={() => apply.mutate()} disabled={apply.isPending}>
                      {apply.isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Applying…</> : 'Apply changes (new version)'}
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>

            {/* versions */}
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-base"><History className="h-4 w-4" /> Versions ({fig.versions.length})</CardTitle>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label="Compare versions"
                    disabled={fig.versions.length < 2}
                    onClick={() => setCompareOpen(true)}
                  >
                    <GitCompare className="mr-1 h-3.5 w-3.5" /> Compare
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-1">
                {fig.versions.slice().reverse().map((v) => (
                  <div key={v.id}
                    className={`flex w-full items-center gap-1 rounded px-2 py-1.5 text-xs ${v.id === effectiveSelectedVid ? 'bg-muted font-medium' : 'hover:bg-muted/50'}`}>
                    <button type="button" onClick={() => {
                      transitionToExistingVersion(v.id);
                    }}
                      className="min-w-0 flex-1 truncate text-left">
                      v{v.version_number} · {formatStylePreset(v.style_preset)} · {v.change_note || ''}
                    </button>
                    {v.id === fig.current_version_id && <Badge variant="secondary" className="text-[10px]">latest</Badge>}
                    {canEditFigure && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        title={fig.versions.length <= 1 ? 'Cannot delete the only version' : `Delete v${v.version_number}`}
                        disabled={fig.versions.length <= 1 || deleteVersion.isPending}
                        onClick={() => {
                          if (confirm(`Delete version ${v.version_number}? The archived R code will be kept for reuse.`)) {
                            deleteVersion.mutate(v.id);
                          }
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
            {/* Version compare slider (U11). Keyed by figure id so its
                base/compare selections and divider reset when the figure
                changes, matching the key={version?.id} pattern used above. */}
            <FigureVersionCompare
              key={id}
              open={compareOpen}
              onOpenChange={setCompareOpen}
              versions={fig.versions}
              defaultBaseId={compareDefaultBaseId}
              defaultCompareId={compareDefaultCompareId}
            />

            {/* AI review */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Star className="h-4 w-4 text-amber-500" /> AI Figure Review</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {canEditFigure ? (
                  <Button size="sm" variant="outline" className="w-full" onClick={() => runReview.mutate()} disabled={runReview.isPending || !effectiveSelectedVid}>
                    {runReview.isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Reviewing…</> : 'Review this figure'}
                  </Button>
                ) : (
                  <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">Editor access is required to run AI reviews.</p>
                )}
                {p && (
                  <div className="space-y-2 text-sm">
                    <div className="text-center"><span className={`text-3xl font-bold ${SCORE_COLOR(p.publication_score ?? 0)}`}>{p.publication_score}</span><span className="text-muted-foreground">/100</span></div>
                    {p.summary && <p className="text-xs text-muted-foreground">{p.summary}</p>}
                    {p.accessibility_checks && <AccessibilityReviewChecks checks={p.accessibility_checks} />}
                    {[
                      ['Visual', p.visual_quality],
                      ['Statistical', p.statistical],
                      ['Suitability', p.suitability],
                    ].map(([label, item]) => {
                      const entry = item as { score?: number; comments?: string[] } | undefined;
                      if (!entry?.score && !entry?.comments?.length) return null;
                      return (
                        <div key={label as string} className="rounded border p-2 text-xs">
                          <div className="mb-1 flex items-center justify-between">
                            <span className="font-medium">{label as string}</span>
                            {entry.score !== undefined && <span className={SCORE_COLOR(entry.score)}>{entry.score}/100</span>}
                          </div>
                          {entry.comments?.slice(0, 2).map((c, i) => <p key={i} className="text-muted-foreground">{c}</p>)}
                        </div>
                      );
                    })}
                    {p.issues?.length ? <div><p className="font-medium text-red-700">Issues</p><ul className="list-disc pl-4 text-xs text-muted-foreground">{p.issues.slice(0, 5).map((s, i) => <li key={i}>{s}</li>)}</ul></div> : null}
                    {reviewEvidence && (
                      <details className="rounded-md border bg-muted/20 text-xs">
                        <summary className="cursor-pointer px-3 py-2 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          Evidence used for this review
                        </summary>
                        <div className="space-y-3 border-t p-3">
                          <p className="text-muted-foreground">Shows the render, settings, and dataset structure supplied to the review. No dataset rows or sample values are included.</p>
                          <div className="flex flex-wrap gap-1.5">
                            {reviewEvidence.render?.version_number !== undefined && <Badge variant="secondary">Render v{reviewEvidence.render.version_number}</Badge>}
                            {reviewEvidence.plot_type && <Badge variant="outline">{reviewEvidence.plot_type}</Badge>}
                            {reviewEvidence.style_preset && <Badge variant="outline">{formatStylePreset(reviewEvidence.style_preset)}</Badge>}
                            {reviewEvidence.render?.image_available !== undefined && (
                              <Badge variant="outline">Image {reviewEvidence.render.image_available ? 'available' : 'unavailable'}</Badge>
                            )}
                          </div>
                          <div>
                            <h3 className="font-medium">Last user AI request</h3>
                            <p className="mt-1 whitespace-pre-wrap rounded bg-background p-2 text-muted-foreground">
                              {reviewEvidence.last_ai_request || 'No prior AI edit request was recorded for this version.'}
                            </p>
                          </div>
                          <div className="grid gap-2 sm:grid-cols-2">
                            {[
                              ['Mapping', reviewEvidence.mapping],
                              ['Options', reviewEvidence.options],
                            ].map(([label, values]) => (
                              <div key={label as string} className="rounded border bg-background p-2">
                                <h3 className="font-medium">{label as string}</h3>
                                {values && Object.keys(values as Record<string, unknown>).length ? (
                                  <dl className="mt-1 space-y-1">
                                    {Object.entries(values as Record<string, unknown>).slice(0, 12).map(([key, value]) => (
                                      <div key={key} className="grid grid-cols-[minmax(5rem,0.45fr)_minmax(0,1fr)] gap-2">
                                        <dt className="truncate font-medium" title={key}>{key}</dt>
                                        <dd className="break-words text-muted-foreground">{reviewEvidenceValue(value)}</dd>
                                      </div>
                                    ))}
                                  </dl>
                                ) : <p className="mt-1 text-muted-foreground">None recorded.</p>}
                              </div>
                            ))}
                          </div>
                          {reviewEvidence.dataset && (
                            <div>
                              <h3 className="font-medium">
                                Dataset structure{reviewEvidence.dataset.name ? ` · ${reviewEvidence.dataset.name}` : ''}
                              </h3>
                              <p className="mt-0.5 text-muted-foreground">
                                {reviewEvidence.dataset.column_count ?? reviewEvidence.dataset.columns?.length ?? 0} columns
                                {reviewEvidence.dataset.columns_truncated ? ' (list truncated)' : ''}
                              </p>
                              {(reviewEvidence.dataset.columns?.length ?? 0) > 0 && (
                                <div className="mt-2 max-h-48 overflow-auto rounded border bg-background">
                                  <table className="w-full text-left">
                                    <caption className="sr-only">Dataset columns supplied to AI review</caption>
                                    <thead className="sticky top-0 bg-muted">
                                      <tr><th scope="col" className="px-2 py-1">Column</th><th scope="col" className="px-2 py-1">Role</th><th scope="col" className="px-2 py-1">Type</th></tr>
                                    </thead>
                                    <tbody>
                                      {reviewEvidence.dataset.columns!.map((column, index) => (
                                        <tr key={`${column.name ?? 'column'}-${index}`} className="border-t">
                                          <th scope="row" className="px-2 py-1 font-medium">{column.name || '(unnamed)'}</th>
                                          <td className="px-2 py-1 text-muted-foreground">{column.role || '(unassigned)'}</td>
                                          <td className="px-2 py-1 text-muted-foreground">{column.dtype || '(unknown)'}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </details>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* comments / discussion */}
            <FigureComments figureId={id} />

          </div>
        </div>
      </main>
    </div>
  );
}
