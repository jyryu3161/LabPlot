'use client';

import { use, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  getDataset, getSavedChartRecommendations, recommendCharts, getPlotTypes, getStyles,
  createFigure, getFigure, getProject, listFigures, updateDataset, recommendChartsFromImage,
  listFigureTemplateFavorites,
} from '@/lib/api';
import { Textarea } from '@/components/ui/textarea';
import type { ChartSuggestion, FigureDetail, PlotTypeDef } from '@/lib/types';
import { formatStylePreset } from '@/lib/style-presets';
import { AppHeader } from '@/components/layout/AppHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CheckCircle2, Clipboard, Columns3, ImageIcon, Loader2, Sparkles, Star, Wand2, ArrowRight, X } from 'lucide-react';

const ROLE_COLORS: Record<string, string> = {
  numeric: 'bg-blue-100 text-blue-700', group: 'bg-green-100 text-green-700',
  category: 'bg-green-100 text-green-700', time: 'bg-purple-100 text-purple-700',
  status: 'bg-orange-100 text-orange-700', log2fc: 'bg-red-100 text-red-700',
  pvalue: 'bg-pink-100 text-pink-700', gene: 'bg-amber-100 text-amber-700', text: 'bg-gray-100 text-gray-600',
};

type ColumnShape = { name: string; role: string; dtype: string; sample_values?: unknown[] };
type BuildEntryMode = 'manual' | 'recommendation' | 'template';

const COLUMN_ROLE_OPTIONS = [
  { value: 'numeric', label: 'Numeric' },
  { value: 'category', label: 'Category' },
  { value: 'group', label: 'Group' },
  { value: 'time', label: 'Time' },
  { value: 'status', label: 'Status' },
  { value: 'gene', label: 'Gene' },
  { value: 'log2fc', label: 'log2FC' },
  { value: 'pvalue', label: 'p-value' },
  { value: 'text', label: 'Text' },
];

const OBJECTIVE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'for', 'from', 'how', 'i', 'in', 'into',
  'is', 'it', 'of', 'on', 'or', 'our', 'plot', 'show', 'the', 'this', 'to', 'use', 'using', 'want',
  'with', 'vs', 'versus',
]);

const ROLE_OBJECTIVE_HINTS: Record<string, string[]> = {
  numeric: ['amount', 'continuous', 'intensity', 'level', 'measure', 'measurement', 'response', 'score', 'signal', 'value', 'y'],
  log2fc: ['effect', 'fc', 'fold', 'foldchange', 'log2fc', 'logfc'],
  pvalue: ['adjusted', 'fdr', 'p', 'padj', 'pvalue', 'qvalue', 'significance'],
  group: ['arm', 'category', 'class', 'cohort', 'compare', 'condition', 'group', 'stratify', 'subtype', 'treatment'],
  category: ['category', 'class', 'group', 'label', 'type'],
  time: ['date', 'day', 'month', 'ordered', 'survival', 'time', 'timeline', 'trend', 'week', 'year'],
  status: ['alive', 'censor', 'dead', 'event', 'status', 'survival'],
  gene: ['gene', 'genes', 'marker', 'symbol'],
  text: ['id', 'label', 'name', 'text'],
};

function objectiveTokens(value: string): string[] {
  return Array.from(new Set(
    value
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token && (token.length > 1 || ['x', 'y', 'z', 'p'].includes(token)) && !OBJECTIVE_STOP_WORDS.has(token)),
  ));
}

function columnTokens(column: ColumnShape): Set<string> {
  const sampleText = (column.sample_values ?? []).slice(0, 6).map((value) => String(value ?? '')).join(' ');
  return new Set(objectiveTokens(`${column.name} ${column.role} ${column.dtype} ${sampleText}`));
}

function explicitlyMentionsColumn(column: ColumnShape, tokens: string[], objectiveText: string): boolean {
  const name = column.name.trim().toLowerCase();
  if (!name) return false;
  const nameTokens = objectiveTokens(name);
  if (nameTokens.length === 1 && tokens.includes(nameTokens[0])) return true;
  if (nameTokens.length > 1 && nameTokens.every((token) => tokens.includes(token))) return true;

  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(objectiveText);
}

function scoreColumnForObjective(column: ColumnShape, tokens: string[], objectiveText: string): number {
  const haystack = columnTokens(column);
  const nameLower = column.name.toLowerCase();
  const nameCompact = nameLower.replace(/[^a-z0-9]/g, '');
  const objectiveCompact = objectiveText.replace(/[^a-z0-9]/g, '');
  let score = 0;

  if (objectiveText.includes(nameLower) || (nameCompact.length > 1 && objectiveCompact.includes(nameCompact))) score += 8;
  for (const token of tokens) {
    if (haystack.has(token)) score += 4;
    else if (nameLower.includes(token) && token.length > 2) score += 2;
  }

  const roleHints = ROLE_OBJECTIVE_HINTS[column.role] ?? [];
  for (const hint of roleHints) {
    if (tokens.includes(hint)) score += 2;
  }
  if (isNumericLikeColumn(column) && tokens.some((token) => ['correlation', 'regression', 'scatter', 'trend', 'x', 'y', 'z'].includes(token))) score += 1;
  if (['category', 'group', 'status'].includes(column.role) && tokens.some((token) => ['bar', 'box', 'compare', 'violin'].includes(token))) score += 1;
  return score;
}

function columnRoleSnapshot(columns: ColumnShape[]): Record<string, string> {
  return Object.fromEntries(columns.map((column) => [column.name, column.role]));
}

function changedColumnRoles(columns: ColumnShape[], roles: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    columns
      .filter((column) => roles[column.name] && roles[column.name] !== column.role)
      .map((column) => [column.name, roles[column.name]]),
  );
}

function isNumericLikeColumn(column: ColumnShape) {
  if (column.dtype === 'numeric' || ['numeric', 'log2fc', 'pvalue'].includes(column.role)) return true;
  const values = (column.sample_values ?? []).filter((value) => value !== null && value !== undefined && String(value).trim() !== '');
  return values.length > 0 && values.every((value) => {
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'string') return false;
    return Number.isFinite(Number(value.trim()));
  });
}

function fieldMatchesColumn(field: { roles: string[] }, column: ColumnShape) {
  if (field.roles.includes(column.role) || field.roles.includes(column.dtype)) return true;
  return field.roles.includes('numeric') && isNumericLikeColumn(column);
}

function plotFitsColumns(plot: PlotTypeDef, columns: ColumnShape[]) {
  return plot.required.every((field) => columns.some((column) => fieldMatchesColumn(field, column)));
}

function defaultOptions(def: PlotTypeDef | undefined) {
  const options: Record<string, unknown> = {};
  def?.options.forEach((option) => {
    if (option.default !== undefined) options[option.key] = option.default;
  });
  return options;
}

function remapTemplateMapping(def: PlotTypeDef | undefined, sourceMapping: Record<string, unknown>, columns: ColumnShape[]) {
  if (!def) return {};
  const used = new Set<string>();
  const mapping: Record<string, unknown> = {};
  const columnByName = new Map(columns.map((column) => [column.name, column]));

  for (const field of [...def.required, ...def.optional]) {
    const sourceValue = sourceMapping[field.key];
    const matches = columns.filter((column) => fieldMatchesColumn(field, column));
    if (field.multi) {
      const sourceValues = Array.isArray(sourceValue) ? sourceValue.filter((value): value is string => typeof value === 'string') : [];
      const kept = sourceValues.filter((name) => {
        const column = columnByName.get(name);
        return column && fieldMatchesColumn(field, column);
      });
      const values = kept.length ? kept : matches.map((column) => column.name).slice(0, 8);
      if (values.length) mapping[field.key] = values;
      continue;
    }

    if (typeof sourceValue === 'string') {
      const column = columnByName.get(sourceValue);
      if (column && fieldMatchesColumn(field, column)) {
        mapping[field.key] = sourceValue;
        used.add(sourceValue);
        continue;
      }
    }

    const match = matches.find((column) => !used.has(column.name));
    if (match) {
      mapping[field.key] = match.name;
      used.add(match.name);
    }
  }
  return mapping;
}

export default function DatasetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const qc = useQueryClient();

  const { data: ds, isLoading } = useQuery({ queryKey: ['dataset', id], queryFn: () => getDataset(id) });
  const { data: savedAiSug, isFetched: savedAiSugFetched } = useQuery({
    queryKey: ['ai-recommendations', id],
    queryFn: () => getSavedChartRecommendations(id),
    enabled: !!ds,
  });
  const { data: plotTypesData } = useQuery({ queryKey: ['plot-types'], queryFn: getPlotTypes });
  const { data: stylesData } = useQuery({ queryKey: ['styles'], queryFn: getStyles });
  const { data: figures } = useQuery({
    queryKey: ['figures', ds?.project_id ?? 'all'],
    queryFn: () => listFigures(ds?.project_id ?? undefined),
    enabled: !!ds,
  });
  const { data: formatFigures } = useQuery({
    queryKey: ['figures', 'format-copy'],
    queryFn: () => listFigures(),
    enabled: !!ds,
  });
  const { data: templateFavorites } = useQuery({
    queryKey: ['figure-template-favorites'],
    queryFn: listFigureTemplateFavorites,
    enabled: !!ds,
  });
  const { data: project } = useQuery({
    queryKey: ['project', ds?.project_id],
    queryFn: () => getProject(ds!.project_id!),
    enabled: !!ds?.project_id,
  });

  const [aiSug, setAiSug] = useState<ChartSuggestion[] | null>(null);
  const [columnObjective, setColumnObjective] = useState('');
  const [recommendPrompt, setRecommendPrompt] = useState('');
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [visualizeStep, setVisualizeStep] = useState<'columns' | 'recommend' | 'build'>('columns');
  const autoRecommendationKeyRef = useRef<string | null>(null);
  const aiRecommend = useMutation<ChartSuggestion[], Error, { silent?: boolean; refresh?: boolean; prompt?: string } | undefined>({
    mutationFn: (variables) => {
      const prompt = variables?.prompt?.trim();
      const payload = variables?.refresh || prompt ? { refresh: Boolean(variables?.refresh), prompt } : undefined;
      return recommendCharts(id, payload);
    },
    onSuccess: (s, variables) => {
      setAiSug(s);
      qc.setQueryData(['ai-recommendations', id], { cached: true, suggestions: s });
      if (!variables?.silent) toast.success('AI recommendations ready');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'AI recommend failed'),
  });
  const referenceRecommend = useMutation({
    mutationFn: () => {
      if (!referenceFile) throw new Error('Choose a reference image first');
      return recommendChartsFromImage(id, referenceFile);
    },
    onSuccess: (s) => { setAiSug(s); toast.success('Reference-based recommendations ready'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Reference recommendation failed'),
  });

  const [dsDesc, setDsDesc] = useState<string | null>(null);
  const [focusColumnsDraft, setFocusColumnsDraft] = useState<string[] | null>(null);
  const [columnRolesDraft, setColumnRolesDraft] = useState<Record<string, string> | null>(null);
  const dsDescValue = dsDesc ?? ds?.description ?? '';
  const saveDsDesc = useMutation({
    mutationFn: () => updateDataset(id, { description: dsDescValue }),
    onSuccess: () => {
      toast.success('Description saved');
      setDsDesc(null);
      setAiSug(null);
      qc.invalidateQueries({ queryKey: ['ai-recommendations', id] });
      qc.invalidateQueries({ queryKey: ['dataset', id] });
      setVisualizeStep('recommend');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Save failed'),
  });

  const plotTypes = useMemo(() => plotTypesData?.plot_types ?? [], [plotTypesData?.plot_types]);
  const styles = useMemo(() => stylesData?.styles ?? [], [stylesData?.styles]);
  const columns = useMemo(() => (ds?.column_profile ?? []) as ColumnShape[], [ds?.column_profile]);
  const savedColumnRoles = useMemo(() => columnRoleSnapshot(columns), [columns]);
  const columnRoles = columnRolesDraft ?? savedColumnRoles;
  const columnRoleOverrides = useMemo(() => changedColumnRoles(columns, columnRoles), [columns, columnRoles]);
  const columnRolesChanged = Object.keys(columnRoleOverrides).length > 0;
  const canEditDataset = ds?.project_id ? project?.role === 'owner' || project?.role === 'editor' : true;
  const savedFocusColumns = useMemo(() => ds?.focus_columns ?? [], [ds?.focus_columns]);
  const focusColumns = focusColumnsDraft ?? savedFocusColumns;
  const savedFocusSet = useMemo(() => new Set(savedFocusColumns), [savedFocusColumns]);
  const focusDraftSet = useMemo(() => new Set(focusColumns), [focusColumns]);
  const hasSelectedColumns = focusColumns.length > 0;
  const focusChanged = useMemo(() => (
    focusColumns.length !== savedFocusColumns.length
    || focusColumns.some((name, index) => name !== savedFocusColumns[index])
  ), [focusColumns, savedFocusColumns]);
  const focusedColumns = useMemo(() => {
    if (!focusColumns.length) return [];
    const focus = new Set(focusColumns);
    const picked = columns.filter((column) => focus.has(column.name));
    return picked;
  }, [columns, focusColumns]);
  const compatibilityColumns = focusedColumns.length ? focusedColumns : columns;
  const compatiblePlotTypes = useMemo(() => plotTypes.filter((plot) => plotFitsColumns(plot, compatibilityColumns)), [compatibilityColumns, plotTypes]);
  const compatiblePlotTypeSet = useMemo(() => new Set(compatiblePlotTypes.map((plot) => plot.type)), [compatiblePlotTypes]);
  const suggestedFocusColumns = useMemo(() => {
    const preferred = columns.filter((c) => c.role !== 'text').map((c) => c.name);
    return (preferred.length ? preferred : columns.map((c) => c.name)).slice(0, 8);
  }, [columns]);
  const cachedAiSuggestions = savedAiSug?.cached ? savedAiSug.suggestions : null;
  const activeAiSuggestions = aiSug ?? cachedAiSuggestions;
  const suggestions = useMemo(() => activeAiSuggestions ?? [], [activeAiSuggestions]);
  const displayedSuggestions = useMemo(() => (
    suggestions
      .map((suggestion, index) => ({ suggestion, index }))
      .sort((a, b) => ((b.suggestion.score ?? 0) - (a.suggestion.score ?? 0)) || (a.index - b.index))
      .slice(0, 5)
  ), [suggestions]);
  const suggestionLabel = activeAiSuggestions
    ? savedAiSug?.cached && !aiSug ? 'Saved AI matches' : 'Top AI matches'
    : 'No AI recommendations yet';
  const referencePreviewUrl = useMemo(
    () => (referenceFile ? URL.createObjectURL(referenceFile) : null),
    [referenceFile],
  );
  const recommendationScopeKey = useMemo(
    () => `${id}:${savedFocusColumns.join('\u0001')}:${ds?.description ?? ''}`,
    [id, savedFocusColumns, ds?.description],
  );

  useEffect(() => {
    autoRecommendationKeyRef.current = null;
  }, [recommendationScopeKey]);

  useEffect(() => {
    if (!ds || visualizeStep !== 'recommend' || !hasSelectedColumns || !savedAiSugFetched) return;
    if (savedAiSug?.cached || aiSug || aiRecommend.isPending || autoRecommendationKeyRef.current === recommendationScopeKey) return;
    autoRecommendationKeyRef.current = recommendationScopeKey;
    const prompt = recommendPrompt.trim();
    aiRecommend.mutate(prompt ? { silent: true, prompt } : { silent: true });
  }, [
    aiRecommend,
    aiSug,
    ds,
    hasSelectedColumns,
    recommendPrompt,
    recommendationScopeKey,
    savedAiSug?.cached,
    savedAiSugFetched,
    visualizeStep,
  ]);

  useEffect(() => {
    return () => {
      if (referencePreviewUrl) URL.revokeObjectURL(referencePreviewUrl);
    };
  }, [referencePreviewUrl]);

  const saveFocusColumns = useMutation({
    mutationFn: () => updateDataset(id, { focus_columns: focusColumns }),
    onSuccess: () => {
      toast.success('Column focus saved');
      setAiSug(null);
      qc.setQueryData(['dataset', id], (old: typeof ds | undefined) => old ? { ...old, focus_columns: focusColumns } : old);
      setFocusColumnsDraft(null);
      qc.invalidateQueries({ queryKey: ['dataset', id] });
      qc.invalidateQueries({ queryKey: ['ai-recommendations', id] });
      setVisualizeStep('recommend');
      router.replace(`/datasets/${id}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Save failed'),
  });

  const saveColumnRoles = useMutation({
    mutationFn: () => updateDataset(id, { column_roles: columnRoleOverrides }),
    onSuccess: (next) => {
      toast.success('Column roles saved');
      setAiSug(null);
      setColumnRolesDraft(null);
      qc.setQueryData(['dataset', id], next);
      qc.invalidateQueries({ queryKey: ['ai-recommendations', id] });
      qc.invalidateQueries({ queryKey: ['dataset', id] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Save failed'),
  });

  // ── builder state ──
  const [plotType, setPlotType] = useState('');
  const [mapping, setMapping] = useState<Record<string, unknown>>({});
  const [options, setOptions] = useState<Record<string, unknown>>({});
  const [style, setStyle] = useState('nature');
  const [name, setName] = useState('');
  const [formatFigureId, setFormatFigureId] = useState('');
  const [buildEntryMode, setBuildEntryMode] = useState<BuildEntryMode>('manual');
  const [showFormatTemplatePicker, setShowFormatTemplatePicker] = useState(false);

  const currentDef: PlotTypeDef | undefined = useMemo(
    () => plotTypes.find((p) => p.type === plotType), [plotTypes, plotType]);
  const missingRequiredFields = useMemo(() => (currentDef?.required ?? []).filter((field) => {
    const value = mapping[field.key];
    return field.multi ? !Array.isArray(value) || value.length === 0 : !value;
  }), [currentDef?.required, mapping]);
  const formatCopyFigures = useMemo(() => (formatFigures ?? [])
    .filter((figure) => figure.status === 'ready')
    .sort((a, b) => {
      const favoriteDelta = Number(b.is_favorite) - Number(a.is_favorite);
      if (favoriteDelta) return favoriteDelta;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    })
    .slice(0, 80), [formatFigures]);
  const favoriteFormatFigures = useMemo(() => (templateFavorites ?? []).slice(0, 10), [templateFavorites]);

  const applyFigureFormat = useMutation({
    mutationFn: async (variables: { figureId: string; versionId?: string | null; entryMode?: BuildEntryMode; showPicker?: boolean }) => ({
      source: await getFigure(variables.figureId),
      versionId: variables.versionId,
    }),
    onSuccess: ({ source, versionId }: { source: FigureDetail; versionId?: string | null }, variables) => {
      const version = source.versions.find((item) => item.id === versionId)
        ?? source.versions.find((item) => item.id === source.current_version_id)
        ?? source.versions[source.versions.length - 1];
      if (!version) {
        toast.error('Selected figure has no saved version');
        return;
      }
      const def = plotTypes.find((plot) => plot.type === source.plot_type);
      setPlotType(source.plot_type);
      setMapping(remapTemplateMapping(def, version.mapping ?? {}, columns));
      setOptions({ ...defaultOptions(def), ...(version.options ?? {}) });
      setStyle(version.style_preset);
      setName(`${ds?.name ?? 'figure'} - ${source.name} format`);
      setFormatFigureId(source.id);
      setBuildEntryMode(variables?.entryMode ?? 'manual');
      setShowFormatTemplatePicker(Boolean(variables?.showPicker));
      setVisualizeStep('build');
      toast.success('Figure format copied');
      document.getElementById('builder')?.scrollIntoView({ behavior: 'smooth' });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not copy figure format'),
  });

  function selectPlotType(
    pt: string,
    presetMapping?: Record<string, unknown>,
    entryMode: BuildEntryMode = buildEntryMode,
    showTemplates = showFormatTemplatePicker,
  ) {
    const def = plotTypes.find((p) => p.type === pt);
    setBuildEntryMode(entryMode);
    setShowFormatTemplatePicker(entryMode === 'manual' && showTemplates);
    setPlotType(pt);
    setMapping(presetMapping ? { ...presetMapping } : {});
    setOptions(defaultOptions(def));
    if (!name) setName(`${ds?.name ?? 'figure'} - ${def?.label ?? pt}`);
    setVisualizeStep('build');
    document.getElementById('builder')?.scrollIntoView({ behavior: 'smooth' });
  }

  function applySuggestion(s: ChartSuggestion) {
    setFormatFigureId('');
    selectPlotType(s.plot_type, (s.suggested_mapping as Record<string, unknown>) || {}, 'recommendation', false);
  }

  function openManualBuild() {
    setBuildEntryMode('manual');
    setShowFormatTemplatePicker(true);
    setVisualizeStep('build');
    window.requestAnimationFrame(() => document.getElementById('builder')?.scrollIntoView({ behavior: 'smooth' }));
  }

  function continueFromColumns() {
    if (!hasSelectedColumns) {
      toast.error('Choose at least one column first');
      return;
    }
    if (canEditDataset && focusChanged) {
      saveFocusColumns.mutate();
      return;
    }
    setVisualizeStep('recommend');
  }

  function selectColumnsFromObjective() {
    const objective = columnObjective.trim();
    if (!objective) {
      toast.error('Describe what you want to visualize first');
      return;
    }
    const tokens = objectiveTokens(objective);
    const objectiveText = objective.toLowerCase();
    const explicitPicks = columns.filter((column) => explicitlyMentionsColumn(column, tokens, objectiveText)).map((column) => column.name);
    if (explicitPicks.length > 0) {
      setFocusColumnsDraft(explicitPicks);
      setRecommendPrompt(objective);
      toast.success(`Selected ${explicitPicks.length} column${explicitPicks.length === 1 ? '' : 's'} from your objective`);
      return;
    }
    const ranked = columns
      .map((column) => ({ column, score: scoreColumnForObjective(column, tokens, objectiveText) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || columns.indexOf(a.column) - columns.indexOf(b.column));
    const picks = ranked.length ? ranked.slice(0, 8).map((item) => item.column.name) : suggestedFocusColumns;
    setFocusColumnsDraft(picks);
    setRecommendPrompt(objective);
    toast.success(`Selected ${picks.length} column${picks.length === 1 ? '' : 's'} from your objective`);
  }

  function chooseReferenceFile(file: File | null) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Reference must be an image file');
      return;
    }
    setReferenceFile(file);
  }

  function toggleFocusColumn(name: string, checked: boolean) {
    setFocusColumnsDraft((current) => {
      const base = current ?? savedFocusColumns;
      return checked
        ? [...base, name].filter((value, index, arr) => arr.indexOf(value) === index)
        : base.filter((value) => value !== name);
    });
  }

  function updateColumnRole(name: string, role: string) {
    setColumnRolesDraft((current) => ({ ...(current ?? savedColumnRoles), [name]: role }));
  }

  function handleReferencePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const imageItem = Array.from(e.clipboardData.items).find((item) => item.type.startsWith('image/'));
    const pasted = imageItem?.getAsFile();
    if (!pasted) return;
    const ext = pasted.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    chooseReferenceFile(new File([pasted], `pasted-reference-${Date.now()}.${ext}`, { type: pasted.type }));
    e.preventDefault();
    toast.success('Reference image pasted');
  }

  const create = useMutation({
    mutationFn: () => createFigure({ dataset_id: id, name: name || 'Untitled', plot_type: plotType, mapping, options, style_preset: style }),
    onSuccess: (fig) => { toast.success('Figure created'); router.push(`/figures/${fig.id}`); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Render failed'),
  });

  if (isLoading || !ds) {
    return (<div className="min-h-screen bg-muted/20"><AppHeader /><div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin" /></div></div>);
  }

  const datasetFigures = (figures ?? []).filter((f) => f.dataset_id === id);

  return (
    <div className="min-h-screen bg-muted/20">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-4 py-8">
        <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
          <Link href="/datasets" className="hover:underline">Datasets</Link> / {ds.name}
        </div>
        <h1 className="mb-6 text-2xl font-bold">{ds.name} <span className="text-base font-normal text-muted-foreground">({ds.n_rows}×{ds.n_cols})</span></h1>

        <Tabs defaultValue="visualize">
          <TabsList>
            <TabsTrigger value="preview">Preview</TabsTrigger>
            <TabsTrigger value="stats">Statistics</TabsTrigger>
            <TabsTrigger value="visualize">Visualize</TabsTrigger>
            <TabsTrigger value="figures">Figures ({datasetFigures.length})</TabsTrigger>
          </TabsList>

          {/* ── Statistics ── */}
          <TabsContent value="stats" className="space-y-6">
            <Card>
              <CardHeader><CardTitle className="text-base">Descriptive statistics</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b text-left text-muted-foreground">
                    {['Column', 'n', 'Mean', 'SD', 'Median', 'Min', 'Max', 'Q1', 'Q3'].map((h) => <th key={h} className="px-2 py-1">{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {(ds.statistics?.descriptive ?? []).map((s) => (
                      <tr key={s.column} className="border-b last:border-0">
                        <td className="px-2 py-1 font-medium">{s.column}</td>
                        <td className="px-2 py-1">{s.n}</td>
                        {[s.mean, s.sd, s.median, s.min, s.max, s.q1, s.q3].map((v, i) => <td key={i} className="px-2 py-1 text-muted-foreground">{v ?? '–'}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!(ds.statistics?.descriptive?.length) && <p className="py-2 text-sm text-muted-foreground">No numeric columns.</p>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Group comparisons</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {(ds.statistics?.comparisons ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No group comparisons (needs a grouping column with 2–8 levels).</p>
                ) : (ds.statistics?.comparisons ?? []).map((c, i) => (
                  <div key={i} className="rounded border p-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{c.value_column} by {c.group_column}</span>
                      <Badge variant={c.significant ? 'default' : 'secondary'}>
                        {c.test} · p = {c.p_value ?? '–'}{c.significant ? ' *' : ''}
                      </Badge>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                      {c.groups.map((g) => <span key={g.level}>{g.level}: {g.mean} ± {g.sd} (n={g.n})</span>)}
                    </div>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">Welch t-test (2 groups) or one-way ANOVA (&gt;2). Advisory summary — confirm with a full analysis. *p&lt;0.05.</p>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Preview ── */}
          <TabsContent value="preview" className="space-y-6">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Dataset description</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                <Textarea value={dsDescValue} onChange={(e) => setDsDesc(e.target.value)} rows={2} readOnly={!canEditDataset}
                  placeholder="Describe what this dataset contains. AI recommendations, reviews, and legends use this context." />
                {canEditDataset ? (
                  <Button size="sm" variant="secondary" onClick={() => saveDsDesc.mutate()} disabled={saveDsDesc.isPending}>Save description</Button>
                ) : <p className="text-xs text-muted-foreground">Viewer access is read-only.</p>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle className="text-base">Column profile</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">Detected automatically. Change roles when numeric codes are categories or text values should be treated as numeric.</p>
                </div>
                {canEditDataset ? (
                  <div className="flex shrink-0 gap-2">
                    {columnRolesChanged && (
                      <Button type="button" size="sm" variant="outline" onClick={() => setColumnRolesDraft(null)} disabled={saveColumnRoles.isPending}>
                        Reset
                      </Button>
                    )}
                    <Button type="button" size="sm" onClick={() => saveColumnRoles.mutate()} disabled={!columnRolesChanged || saveColumnRoles.isPending}>
                      {saveColumnRoles.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                      Save roles
                    </Button>
                  </div>
                ) : null}
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {columns.map((c) => (
                    <div key={c.name} className="space-y-2 rounded border p-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate font-medium">{c.name}</span>
                        <Badge variant="secondary" className="shrink-0">{c.dtype}</Badge>
                      </div>
                      <div className="flex items-center gap-2">
                        <select
                          aria-label={`Column role ${c.name}`}
                          className="h-9 w-full rounded-md border bg-background px-2 text-xs disabled:opacity-70"
                          value={columnRoles[c.name] ?? c.role}
                          onChange={(e) => updateColumnRole(c.name, e.target.value)}
                          disabled={!canEditDataset || saveColumnRoles.isPending}
                        >
                          {COLUMN_ROLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                        {(columnRoles[c.name] ?? c.role) !== c.role && <Badge variant="outline">changed</Badge>}
                      </div>
                      <span className={`inline-flex rounded px-2 py-0.5 text-xs ${ROLE_COLORS[columnRoles[c.name] ?? c.role] ?? 'bg-gray-100 text-gray-600'}`}>
                        {columnRoles[c.name] ?? c.role}
                      </span>
                    </div>
                  ))}
                </div>
                {!canEditDataset && <p className="text-xs text-muted-foreground">Viewer access is read-only.</p>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Data preview (first {ds.preview.length} rows)</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b">{columns.map((c) => <th key={c.name} className="px-2 py-1 text-left font-medium">{c.name}</th>)}</tr></thead>
                  <tbody>
                    {ds.preview.slice(0, 12).map((row, i) => (
                      <tr key={i} className="border-b last:border-0">
                        {columns.map((c) => <td key={c.name} className="px-2 py-1 text-muted-foreground">{String(row[c.name] ?? '')}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Visualize ── */}
          <TabsContent value="visualize" className="space-y-6">
            <div className="grid gap-2 md:grid-cols-3">
              {[
                { key: 'columns', label: '1. Choose columns', done: hasSelectedColumns },
                { key: 'recommend', label: '2. AI recommendations', done: Boolean(activeAiSuggestions?.length) },
                { key: 'build', label: '3. Build figure', done: Boolean(plotType) },
              ].map((step) => {
                const active = visualizeStep === step.key;
                const blocked = step.key !== 'columns' && !hasSelectedColumns;
                return (
                  <button
                    key={step.key}
                    type="button"
                    disabled={blocked}
                    onClick={() => {
                      if (step.key === 'build') {
                        setBuildEntryMode('manual');
                        setShowFormatTemplatePicker(false);
                      }
                      setVisualizeStep(step.key as 'columns' | 'recommend' | 'build');
                    }}
                    className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition ${active ? 'border-primary bg-primary/5 text-primary' : 'bg-background hover:border-primary'} disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    <span className="font-medium">{step.label}</span>
                    {step.done && <CheckCircle2 className="h-4 w-4" />}
                  </button>
                );
              })}
            </div>

            {visualizeStep === 'columns' && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Columns3 className="h-4 w-4 text-primary" /> 1. Choose columns
                  </CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Select the columns you want this figure workflow to use before generating chart recommendations.
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
                    <CheckCircle2 className="mr-2 inline h-4 w-4 text-green-600" />
                    Start with measurement, group, time, or value columns. ID-only text columns can stay unchecked unless they should appear in the plot.
                  </div>
                  <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                    <Label htmlFor="column-objective">Visualization objective</Label>
                    <div className="grid gap-2 md:grid-cols-[1fr_auto]">
                      <Textarea
                        id="column-objective"
                        value={columnObjective}
                        onChange={(e) => setColumnObjective(e.target.value)}
                        placeholder="Example: make a scatter plot of dose and response by treatment group."
                        className="min-h-20 bg-background"
                        maxLength={1000}
                      />
                      <Button type="button" variant="secondary" onClick={selectColumnsFromObjective} className="md:self-end">
                        <Wand2 className="mr-2 h-4 w-4" />
                        Select columns
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">This fills the column selection and carries the objective into AI recommendations.</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => setFocusColumnsDraft(suggestedFocusColumns)}>Suggested</Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => setFocusColumnsDraft(columns.map((c) => c.name))}>All</Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setFocusColumnsDraft([])}>Clear</Button>
                    {focusChanged && <Badge variant="outline">unsaved selection</Badge>}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {columns.map((column) => {
                      const checked = focusDraftSet.has(column.name);
                      return (
                        <label key={column.name} className="flex cursor-pointer items-center gap-2 rounded-lg border bg-background p-2 text-sm">
                          <Checkbox checked={checked} onCheckedChange={(next) => toggleFocusColumn(column.name, Boolean(next))} />
                          <span className="min-w-0 flex-1 truncate">{column.name}</span>
                          <Badge variant="secondary" className="shrink-0">{column.role}</Badge>
                        </label>
                      );
                    })}
                  </div>
                  {hasSelectedColumns ? (
                    <div className="flex flex-wrap gap-2">
                      {focusColumns.map((name) => <Badge key={name} variant={savedFocusSet.has(name) ? 'default' : 'secondary'}>{name}</Badge>)}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                      Choose at least one column to continue.
                    </div>
                  )}
                  <div className="flex justify-end">
                    <Button onClick={continueFromColumns} disabled={!hasSelectedColumns || saveFocusColumns.isPending}>
                      {saveFocusColumns.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                      Continue to AI recommendations
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {visualizeStep === 'recommend' && (
              <Card>
                <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <CardTitle className="text-base flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /> 2. AI recommendations</CardTitle>
                    <p className="mt-1 text-sm text-muted-foreground">Recommendations are saved after the first run and reused when you reopen this dataset.</p>
                  </div>
                  <Button size="lg" className="h-11 px-5 text-sm font-semibold shadow-sm" onClick={() => aiRecommend.mutate({ silent: false, refresh: true, prompt: recommendPrompt })} disabled={aiRecommend.isPending || !hasSelectedColumns}>
                    {aiRecommend.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}
                    {activeAiSuggestions ? 'Refresh AI recommendations' : 'Generate AI recommendations'}
                  </Button>
                </CardHeader>
                <CardContent className="space-y-4">
                  {aiRecommend.isPending && !activeAiSuggestions && (
                    <div className="flex items-center rounded-lg border bg-primary/5 px-3 py-2 text-sm text-primary">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      AI is reading the selected columns and dataset purpose.
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {focusColumns.map((name) => <Badge key={name} variant="secondary">{name}</Badge>)}
                  </div>
                  <div className="space-y-1 rounded-lg border bg-muted/30 p-3">
                    <Label htmlFor="chart-request">Optional chart direction</Label>
                    <Textarea
                      id="chart-request"
                      value={recommendPrompt}
                      onChange={(e) => setRecommendPrompt(e.target.value)}
                      placeholder="Example: show x and y as a scatter plot, or compare response by group."
                      className="min-h-20 bg-background"
                      maxLength={1500}
                    />
                    <p className="text-xs text-muted-foreground">Used when you refresh AI recommendations. Leave blank to let LabPlot choose from the selected columns.</p>
                  </div>
                  <div className="grid gap-3 rounded-lg border bg-muted/30 p-3 lg:grid-cols-[1fr_auto] lg:items-end">
                    <div className="grid min-w-0 gap-3 md:grid-cols-[1fr_1.2fr]">
                      <div className="space-y-1">
                        <Label>Reference figure image</Label>
                        <p className="text-xs text-muted-foreground">Optional screenshot of a figure style you want to imitate. This is not a data upload.</p>
                        <Input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          onChange={(e) => chooseReferenceFile(e.target.files?.[0] ?? null)}
                        />
                      </div>
                      <div
                        tabIndex={0}
                        aria-label="Paste reference figure image"
                        onPaste={handleReferencePaste}
                        className="flex min-h-24 items-center gap-3 rounded-lg border border-dashed bg-background px-4 py-3 text-left outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                      >
                        {referencePreviewUrl ? (
                          <>
                            <img src={referencePreviewUrl} alt="Reference preview" className="h-16 w-20 rounded border bg-white object-contain" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium">{referenceFile?.name}</p>
                              <p className="text-xs text-muted-foreground">Ready for reference matching</p>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={(e) => { e.stopPropagation(); setReferenceFile(null); }}
                              aria-label="Clear reference image"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </>
                        ) : (
                          <>
                            <Clipboard className="h-5 w-5 text-primary" />
                            <div>
                              <p className="text-sm font-medium">Paste screenshot here</p>
                              <p className="text-xs text-muted-foreground">Paste a copied graph screenshot; LabPlot will suggest similar chart types for your data.</p>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => referenceRecommend.mutate()}
                      disabled={!referenceFile || referenceRecommend.isPending}
                    >
                      {referenceRecommend.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}
                      Match reference
                    </Button>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">{suggestionLabel}</p>
                      <p className="text-xs text-muted-foreground">Choose one recommendation to prefill the builder, or continue and build manually.</p>
                    </div>
                    <Badge variant="secondary">{displayedSuggestions.length} shown</Badge>
                  </div>
                  {displayedSuggestions.length > 0 ? (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {displayedSuggestions.map(({ suggestion: s }, i) => (
                        <button key={`${s.plot_type}-${i}`} onClick={() => applySuggestion(s)}
                          className="rounded-lg border p-3 text-left transition hover:border-primary hover:shadow-sm">
                          <div className="flex items-start justify-between gap-2">
                            <span className="font-medium">{s.title ?? s.plot_type}</span>
                            <div className="flex shrink-0 items-center gap-1">
                              <Badge variant="secondary">#{s.rank ?? i + 1}</Badge>
                              <Badge variant={s.source === 'rule' ? 'outline' : 'default'}>{s.source === 'rule' ? 'rule' : 'AI'}</Badge>
                            </div>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            {typeof s.score === 'number' && <span>{Math.round(s.score * 100)}% fit</span>}
                            {s.fit && <span className="capitalize">{s.fit}</span>}
                          </div>
                          {s.rationale && <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{s.rationale}</p>}
                          <span className="mt-2 inline-flex items-center text-xs text-primary">Use this <ArrowRight className="ml-1 h-3 w-3" /></span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                      <ImageIcon className="mx-auto mb-2 h-5 w-5" />
                      Generate AI recommendations after selecting columns.
                    </div>
                  )}
                  <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">Saved figure templates</p>
                        <p className="text-xs text-muted-foreground">Copies chart type, style, size, labels, and visual options from your saved templates. Column mappings are remapped to this dataset.</p>
                      </div>
                      <Badge variant="secondary">{favoriteFormatFigures.length}</Badge>
                    </div>
                    {favoriteFormatFigures.length === 0 ? (
                      <div className="rounded-lg border border-dashed bg-background p-4 text-sm text-muted-foreground">
                        Save a finished figure as a template to reuse it here.
                      </div>
                    ) : (
                      <div className="grid max-h-64 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                        {favoriteFormatFigures.map((figure) => {
                          const compatible = compatiblePlotTypeSet.has(figure.plot_type);
                          const selected = formatFigureId === figure.figure_id;
                          return (
                            <button
                              key={figure.id}
                              type="button"
                              data-testid="favorite-template-card"
                              aria-label={`Use favorite figure template ${figure.name}`}
                              disabled={applyFigureFormat.isPending}
                              onClick={() => applyFigureFormat.mutate({ figureId: figure.figure_id, versionId: figure.source_version_id, entryMode: 'template', showPicker: false })}
                              className={`overflow-hidden rounded-lg border bg-background text-left transition ${selected ? 'border-primary ring-2 ring-primary/20' : 'hover:border-primary hover:shadow-sm'} disabled:cursor-not-allowed disabled:opacity-55`}
                            >
                              {figure.thumb_url ? (
                                <img src={figure.thumb_url} alt={figure.name} className="h-20 w-full bg-white object-contain" loading="lazy" decoding="async" />
                              ) : (
                                <div className="flex h-20 w-full items-center justify-center bg-white text-muted-foreground">
                                  <ImageIcon className="h-5 w-5" />
                                </div>
                              )}
                              <div className="space-y-1 p-2">
                                <p className="truncate text-xs font-medium">{figure.name}</p>
                                <div className="flex flex-wrap gap-1">
                                  <Badge variant="default"><Star className="mr-1 h-3 w-3 fill-current" />Saved</Badge>
                                  <Badge variant="secondary">{figure.plot_type.replace(/_/g, ' ')}</Badge>
                                  <Badge variant="outline">{formatStylePreset(figure.style_preset)}</Badge>
                                  {!compatible && <Badge variant="outline">check mappings</Badge>}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
                    <Button variant="outline" onClick={() => setVisualizeStep('columns')}>Back to columns</Button>
                    <Button variant="secondary" onClick={openManualBuild}>Build manually</Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {visualizeStep === 'build' && (
            <Card id="builder">
              <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle className="text-base">3. Build figure</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {buildEntryMode === 'recommendation'
                      ? 'Review the AI-filled chart type, mappings, and options before rendering.'
                      : buildEntryMode === 'template'
                        ? 'Review the copied chart type, mappings, size, and visual settings before rendering.'
                      : showFormatTemplatePicker
                        ? 'Choose a chart type manually, or copy visual settings from a saved figure.'
                        : 'Choose a chart type and mappings manually before rendering.'}
                  </p>
                </div>
                <Button variant="outline" onClick={() => setVisualizeStep('recommend')}>Back to recommendations</Button>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-1">
                    <Label>Chart type</Label>
                    <select data-testid="chart-type-select" className="w-full rounded-md border px-3 py-2 text-sm" value={plotType} onChange={(e) => selectPlotType(e.target.value, undefined, 'manual', showFormatTemplatePicker)}>
                      <option value="">Select a chart type…</option>
                      {plotTypes.map((p) => (
                        <option key={p.type} value={p.type}>{p.label}</option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">{compatiblePlotTypes.length} chart types match the detected columns. Other chart types remain selectable if you want to map columns manually.</p>
                  </div>
                  <div className="space-y-1">
                    <Label>Figure name</Label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My figure" />
                  </div>
                </div>

                {showFormatTemplatePicker && (
                  <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
                    <div>
                      <p className="text-sm font-medium">Use one of my figures as a template</p>
                      <p className="text-xs text-muted-foreground">Copies chart type, style preset, and visual settings. Column mappings are remapped to this dataset.</p>
                    </div>
                    {formatCopyFigures.length === 0 ? (
                      <div className="rounded-lg border border-dashed bg-background p-4 text-sm text-muted-foreground">No saved figures available yet.</div>
                    ) : (
                      <div className="grid max-h-64 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                        {formatCopyFigures.map((figure) => {
                          const compatible = compatiblePlotTypeSet.has(figure.plot_type);
                          const selected = formatFigureId === figure.id;
                          return (
                            <button
                              key={figure.id}
                              type="button"
                              data-testid="figure-format-card"
                              aria-label={`Use figure format ${figure.name}`}
                              disabled={applyFigureFormat.isPending}
                              onClick={() => applyFigureFormat.mutate({ figureId: figure.id, entryMode: 'manual', showPicker: true })}
                              className={`overflow-hidden rounded-lg border bg-background text-left transition ${selected ? 'border-primary ring-2 ring-primary/20' : 'hover:border-primary hover:shadow-sm'} disabled:cursor-not-allowed disabled:opacity-55`}
                            >
                              {figure.thumb_url ? (
                                <img src={figure.thumb_url} alt={figure.name} className="h-20 w-full bg-white object-contain" loading="lazy" decoding="async" />
                              ) : (
                                <div className="flex h-20 w-full items-center justify-center bg-white text-muted-foreground">
                                  <ImageIcon className="h-5 w-5" />
                                </div>
                              )}
                              <div className="space-y-1 p-2">
                                <p className="truncate text-xs font-medium">{figure.name}</p>
                                <div className="flex flex-wrap gap-1">
                                  <Badge variant="secondary">{figure.plot_type.replace(/_/g, ' ')}</Badge>
                                  <Badge variant="outline">{formatStylePreset(figure.style_preset)}</Badge>
                                  {figure.is_favorite && <Badge variant="default"><Star className="mr-1 h-3 w-3 fill-current" />Saved</Badge>}
                                  {!compatible && <Badge variant="outline">check mappings</Badge>}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {currentDef && (
                  <>
                    <div className="grid gap-4 md:grid-cols-2">
                      {[...currentDef.required.map((f) => ({ ...f, req: true })), ...currentDef.optional.map((f) => ({ ...f, req: false }))].map((f) => (
                        <div key={f.key} className="space-y-1">
                          <Label>{f.label}{f.req && <span className="text-red-500"> *</span>}</Label>
                          {f.multi ? (
                            <div className="max-h-32 overflow-y-auto rounded-md border p-2">
                              {columns.map((c) => {
                                const arr = (mapping[f.key] as string[]) || [];
                                const checked = arr.includes(c.name);
                                return (
                                  <label key={c.name} className="flex items-center gap-2 py-0.5 text-sm">
                                    <input type="checkbox" checked={checked} onChange={(e) => {
                                      const next = e.target.checked ? [...arr, c.name] : arr.filter((x) => x !== c.name);
                                      setMapping({ ...mapping, [f.key]: next });
                                    }} />
                                    {c.name} <span className="text-xs text-muted-foreground">({c.role})</span>
                                  </label>
                                );
                              })}
                            </div>
                          ) : (
                            <select className="w-full rounded-md border px-3 py-2 text-sm"
                              value={(mapping[f.key] as string) ?? ''}
                              onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value || null })}>
                              <option value="">{f.req ? 'Select…' : '(none)'}</option>
                              {columns.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.role})</option>)}
                            </select>
                          )}
                        </div>
                      ))}
                    </div>

                    {currentDef.options.length > 0 && (
                      <div className="grid gap-4 md:grid-cols-3">
                        {currentDef.options.map((o) => (
                          <div key={o.key} className="space-y-1">
                            <Label>{o.label}</Label>
                            {o.type === 'bool' ? (
                              <label className="flex items-center gap-2 text-sm">
                                <input type="checkbox" checked={Boolean(options[o.key])} onChange={(e) => setOptions({ ...options, [o.key]: e.target.checked })} /> enabled
                              </label>
                            ) : o.type === 'select' ? (
                              <select className="w-full rounded-md border px-3 py-2 text-sm" value={String(options[o.key] ?? o.default ?? '')} onChange={(e) => setOptions({ ...options, [o.key]: e.target.value })}>
                                {o.choices?.map((c) => <option key={c} value={c}>{c}</option>)}
                              </select>
                            ) : o.type === 'number' ? (
                              <Input type="number" value={String(options[o.key] ?? o.default ?? '')} onChange={(e) => setOptions({ ...options, [o.key]: parseFloat(e.target.value) })} />
                            ) : (
                              <Input value={String(options[o.key] ?? '')} onChange={(e) => setOptions({ ...options, [o.key]: e.target.value })} />
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-1">
                        <Label>In-plot title (usually blank)</Label>
                        <Input data-testid="in-plot-title" value={String(options.title ?? '')} onChange={(e) => setOptions({ ...options, title: e.target.value })} placeholder="Leave blank for manuscript-style figures" />
                      </div>
                      <div className="space-y-1">
                        <Label>Style preset</Label>
                        <select className="w-full rounded-md border px-3 py-2 text-sm" value={style} onChange={(e) => setStyle(e.target.value)}>
                          {styles.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                        </select>
                      </div>
                    </div>

                    {missingRequiredFields.length > 0 && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                        Select required columns for: {missingRequiredFields.map((field) => field.label).join(', ')}.
                      </div>
                    )}
                    {!canEditDataset && <p className="text-sm text-muted-foreground">Viewer access can inspect this dataset but cannot generate new figures.</p>}
                    <Button onClick={() => create.mutate()} disabled={create.isPending || !canEditDataset || missingRequiredFields.length > 0} className="w-full">
                      {create.isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Rendering…</> : 'Generate figure'}
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
            )}
          </TabsContent>

          {/* ── Figures ── */}
          <TabsContent value="figures">
            {datasetFigures.length === 0 ? (
              <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">No figures from this dataset yet.</div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {datasetFigures.map((f) => (
                  <Link key={f.id} href={`/figures/${f.id}`}>
                    <Card className="overflow-hidden transition hover:shadow-md">
                      {f.thumb_url && <img src={f.thumb_url} alt={f.name} loading="lazy" decoding="async" className="aspect-[4/3] w-full bg-white object-contain" />}
                      <CardContent className="p-3">
                        <p className="truncate text-sm font-medium">{f.name}</p>
                        <p className="text-xs text-muted-foreground">{f.plot_type} · {formatStylePreset(f.style_preset)}</p>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
