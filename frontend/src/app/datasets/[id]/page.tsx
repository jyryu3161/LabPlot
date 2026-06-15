'use client';

import { use, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  getDataset, getChartSuggestions, recommendCharts, getPlotTypes, getStyles,
  createFigure, getFigure, getProject, listFigures, updateDataset, recommendChartsFromImage,
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
import { CheckCircle2, Clipboard, Columns3, ImageIcon, Loader2, Sparkles, Wand2, ArrowRight, X } from 'lucide-react';

const ROLE_COLORS: Record<string, string> = {
  numeric: 'bg-blue-100 text-blue-700', group: 'bg-green-100 text-green-700',
  category: 'bg-green-100 text-green-700', time: 'bg-purple-100 text-purple-700',
  status: 'bg-orange-100 text-orange-700', log2fc: 'bg-red-100 text-red-700',
  pvalue: 'bg-pink-100 text-pink-700', gene: 'bg-amber-100 text-amber-700', text: 'bg-gray-100 text-gray-600',
};

function fieldMatchesColumn(field: { roles: string[] }, column: { role: string; dtype: string }) {
  return field.roles.includes(column.role) || field.roles.includes(column.dtype);
}

function plotFitsColumns(plot: PlotTypeDef, columns: { role: string; dtype: string }[]) {
  return plot.required.every((field) => columns.some((column) => fieldMatchesColumn(field, column)));
}

function defaultOptions(def: PlotTypeDef | undefined) {
  const options: Record<string, unknown> = {};
  def?.options.forEach((option) => {
    if (option.default !== undefined) options[option.key] = option.default;
  });
  return options;
}

function remapTemplateMapping(def: PlotTypeDef | undefined, sourceMapping: Record<string, unknown>, columns: { name: string; role: string; dtype: string }[]) {
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

  const { data: ds, isLoading } = useQuery({ queryKey: ['dataset', id], queryFn: () => getDataset(id) });
  const { data: ruleSug } = useQuery({ queryKey: ['suggest', id], queryFn: () => getChartSuggestions(id) });
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
  const { data: project } = useQuery({
    queryKey: ['project', ds?.project_id],
    queryFn: () => getProject(ds!.project_id!),
    enabled: !!ds?.project_id,
  });

  const [aiSug, setAiSug] = useState<ChartSuggestion[] | null>(null);
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const autoRecommendDatasetId = useRef<string | null>(null);
  const aiRecommend = useMutation<ChartSuggestion[], Error, { silent?: boolean } | undefined>({
    mutationFn: () => recommendCharts(id),
    onSuccess: (s, variables) => {
      setAiSug(s);
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

  const qc = useQueryClient();
  const [dsDesc, setDsDesc] = useState<string | null>(null);
  const [showColumnGuide, setShowColumnGuide] = useState(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('setup') === '1';
  });
  const [focusColumnsDraft, setFocusColumnsDraft] = useState<string[] | null>(null);
  const dsDescValue = dsDesc ?? ds?.description ?? '';
  const saveDsDesc = useMutation({
    mutationFn: () => updateDataset(id, { description: dsDescValue }),
    onSuccess: () => {
      toast.success('Description saved');
      setDsDesc(null);
      setAiSug(null);
      qc.invalidateQueries({ queryKey: ['dataset', id] });
      aiRecommend.mutate({ silent: true });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Save failed'),
  });

  const plotTypes = useMemo(() => plotTypesData?.plot_types ?? [], [plotTypesData?.plot_types]);
  const styles = useMemo(() => stylesData?.styles ?? [], [stylesData?.styles]);
  const columns = useMemo(() => ds?.column_profile ?? [], [ds?.column_profile]);
  const canEditDataset = ds?.project_id ? project?.role === 'owner' || project?.role === 'editor' : true;
  const compatiblePlotTypes = useMemo(() => plotTypes.filter((plot) => plotFitsColumns(plot, columns)), [columns, plotTypes]);
  const compatiblePlotTypeSet = useMemo(() => new Set(compatiblePlotTypes.map((plot) => plot.type)), [compatiblePlotTypes]);
  const savedFocusColumns = useMemo(() => ds?.focus_columns ?? [], [ds?.focus_columns]);
  const focusColumns = focusColumnsDraft ?? savedFocusColumns;
  const savedFocusSet = useMemo(() => new Set(savedFocusColumns), [savedFocusColumns]);
  const focusDraftSet = useMemo(() => new Set(focusColumns), [focusColumns]);
  const suggestedFocusColumns = useMemo(() => {
    const preferred = columns.filter((c) => c.role !== 'text').map((c) => c.name);
    return (preferred.length ? preferred : columns.map((c) => c.name)).slice(0, 8);
  }, [columns]);
  const suggestions = useMemo(() => aiSug ?? ruleSug?.suggestions ?? [], [aiSug, ruleSug?.suggestions]);
  const displayedSuggestions = useMemo(() => (
    suggestions
      .map((suggestion, index) => ({ suggestion, index }))
      .sort((a, b) => ((b.suggestion.score ?? 0) - (a.suggestion.score ?? 0)) || (a.index - b.index))
      .slice(0, 5)
  ), [suggestions]);
  const suggestionLabel = aiSug ? 'Top AI matches' : 'Top dataset matches';
  const referencePreviewUrl = useMemo(
    () => (referenceFile ? URL.createObjectURL(referenceFile) : null),
    [referenceFile],
  );

  useEffect(() => {
    return () => {
      if (referencePreviewUrl) URL.revokeObjectURL(referencePreviewUrl);
    };
  }, [referencePreviewUrl]);

  useEffect(() => {
    if (!ds || autoRecommendDatasetId.current === ds.id) return;
    autoRecommendDatasetId.current = ds.id;
    aiRecommend.mutate({ silent: true });
  }, [aiRecommend, ds]);

  const saveFocusColumns = useMutation({
    mutationFn: () => updateDataset(id, { focus_columns: focusColumns }),
    onSuccess: () => {
      toast.success('Column focus saved');
      setAiSug(null);
      setShowColumnGuide(false);
      qc.setQueryData(['dataset', id], (old: typeof ds | undefined) => old ? { ...old, focus_columns: focusColumns } : old);
      setFocusColumnsDraft(null);
      qc.invalidateQueries({ queryKey: ['dataset', id] });
      qc.invalidateQueries({ queryKey: ['suggest', id] });
      router.replace(`/datasets/${id}`);
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

  const currentDef: PlotTypeDef | undefined = useMemo(
    () => plotTypes.find((p) => p.type === plotType), [plotTypes, plotType]);
  const missingRequiredFields = useMemo(() => (currentDef?.required ?? []).filter((field) => {
    const value = mapping[field.key];
    return field.multi ? !Array.isArray(value) || value.length === 0 : !value;
  }), [currentDef?.required, mapping]);
  const formatCopyFigures = useMemo(() => (formatFigures ?? [])
    .filter((figure) => figure.status === 'ready')
    .slice(0, 80), [formatFigures]);

  const applyFigureFormat = useMutation({
    mutationFn: (figureId: string) => getFigure(figureId),
    onSuccess: (source: FigureDetail) => {
      const version = source.versions.find((item) => item.id === source.current_version_id) ?? source.versions[source.versions.length - 1];
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
      toast.success('Figure format copied');
      document.getElementById('builder')?.scrollIntoView({ behavior: 'smooth' });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not copy figure format'),
  });

  function selectPlotType(pt: string, presetMapping?: Record<string, unknown>) {
    const def = plotTypes.find((p) => p.type === pt);
    setPlotType(pt);
    setMapping(presetMapping ? { ...presetMapping } : {});
    setOptions(defaultOptions(def));
    if (!name) setName(`${ds?.name ?? 'figure'} - ${def?.label ?? pt}`);
    document.getElementById('builder')?.scrollIntoView({ behavior: 'smooth' });
  }

  function applySuggestion(s: ChartSuggestion) {
    selectPlotType(s.plot_type, (s.suggested_mapping as Record<string, unknown>) || {});
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
              <CardHeader><CardTitle className="text-base">Column profile</CardTitle></CardHeader>
              <CardContent>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {columns.map((c) => (
                    <div key={c.name} className="flex items-center justify-between rounded border p-2 text-sm">
                      <span className="font-medium">{c.name}</span>
                      <span className={`rounded px-2 py-0.5 text-xs ${ROLE_COLORS[c.role] ?? 'bg-gray-100 text-gray-600'}`}>{c.role}</span>
                    </div>
                  ))}
                </div>
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
            <Card className={showColumnGuide ? 'border-primary/30 shadow-sm' : ''}>
              <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Columns3 className="h-4 w-4 text-primary" /> Analysis focus
                  </CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {savedFocusColumns.length
                      ? `Recommendations are currently prioritizing ${savedFocusColumns.length} selected column(s).`
                      : 'Recommendations currently consider all detected columns.'}
                  </p>
                </div>
                <Button size="sm" variant={showColumnGuide ? 'secondary' : 'outline'} onClick={() => setShowColumnGuide((v) => !v)}>
                  {showColumnGuide ? 'Hide' : 'Choose columns'}
                </Button>
              </CardHeader>
              <CardContent className="space-y-4">
                {!showColumnGuide ? (
                  <div className="flex flex-wrap gap-2">
                    {(savedFocusColumns.length ? savedFocusColumns : columns.map((c) => c.name).slice(0, 10)).map((name) => (
                      <Badge key={name} variant={savedFocusSet.has(name) ? 'default' : 'secondary'}>{name}</Badge>
                    ))}
                    {!savedFocusColumns.length && columns.length > 10 && <Badge variant="outline">+{columns.length - 10} more</Badge>}
                  </div>
                ) : (
                  <>
                    <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
                      <CheckCircle2 className="mr-2 inline h-4 w-4 text-green-600" />
                      Start with treatment/group/time/value columns. Text-only ID columns can stay unchecked unless you need them in a plot.
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={() => setFocusColumnsDraft(suggestedFocusColumns)}>Suggested</Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => setFocusColumnsDraft(columns.map((c) => c.name))}>All</Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setFocusColumnsDraft([])}>Clear</Button>
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
                    <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                      <Button variant="outline" onClick={() => setFocusColumnsDraft(null)}>Reset</Button>
                      <Button onClick={() => saveFocusColumns.mutate()} disabled={saveFocusColumns.isPending || !canEditDataset}>
                        {saveFocusColumns.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        Save focus
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /> Recommended charts</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">Ask AI runs automatically after upload and uses the dataset purpose when provided.</p>
                </div>
                <Button size="lg" className="h-11 px-5 text-sm font-semibold shadow-sm" onClick={() => aiRecommend.mutate({ silent: false })} disabled={aiRecommend.isPending}>
                  {aiRecommend.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}
                  Ask AI for charts {aiSug ? '(refresh)' : ''}
                </Button>
              </CardHeader>
              <CardContent className="space-y-4">
                {aiRecommend.isPending && !aiSug && (
                  <div className="flex items-center rounded-lg border bg-primary/5 px-3 py-2 text-sm text-primary">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    AI is reading the dataset profile and purpose.
                  </div>
                )}
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
                    <p className="text-xs text-muted-foreground">Ranked by data-shape fit; unsupported chart structures are filtered out.</p>
                  </div>
                  <Badge variant="secondary">{displayedSuggestions.length} shown</Badge>
                </div>
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
                {displayedSuggestions.length === 0 && (
                  <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                    <ImageIcon className="mx-auto mb-2 h-5 w-5" />
                    No compatible chart recommendations for this dataset profile yet.
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ── Builder ── */}
            <Card id="builder">
              <CardHeader><CardTitle className="text-base">Chart builder</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
                  <div>
                    <p className="text-sm font-medium">Use one of my figures as a template</p>
                    <p className="text-xs text-muted-foreground">Copies chart type, style preset, and visual settings. Column mappings are remapped to this dataset.</p>
                  </div>
                  {formatCopyFigures.length === 0 ? (
                    <div className="rounded-lg border border-dashed bg-background p-4 text-sm text-muted-foreground">No saved figures available yet.</div>
                  ) : (
                    <div className="grid max-h-[28rem] gap-3 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
                      {formatCopyFigures.map((figure) => {
                        const compatible = compatiblePlotTypeSet.has(figure.plot_type);
                        const selected = formatFigureId === figure.id;
                        return (
                          <button
                            key={figure.id}
                            type="button"
                            data-testid="figure-format-card"
                            aria-label={`Use figure format ${figure.name}`}
                            disabled={!compatible || applyFigureFormat.isPending}
                            onClick={() => applyFigureFormat.mutate(figure.id)}
                            className={`overflow-hidden rounded-lg border bg-background text-left transition ${selected ? 'border-primary ring-2 ring-primary/20' : 'hover:border-primary hover:shadow-sm'} disabled:cursor-not-allowed disabled:opacity-55`}
                          >
                            {figure.thumb_url ? (
                              <img src={figure.thumb_url} alt={figure.name} className="aspect-[4/3] w-full bg-white object-contain" loading="lazy" decoding="async" />
                            ) : (
                              <div className="flex aspect-[4/3] w-full items-center justify-center bg-white text-muted-foreground">
                                <ImageIcon className="h-8 w-8" />
                              </div>
                            )}
                            <div className="space-y-1 p-3">
                              <p className="truncate text-sm font-medium">{figure.name}</p>
                              <div className="flex flex-wrap gap-1">
                                <Badge variant="secondary">{figure.plot_type.replace(/_/g, ' ')}</Badge>
                                <Badge variant="outline">{formatStylePreset(figure.style_preset)}</Badge>
                                {!compatible && <Badge variant="outline">needs different data</Badge>}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-1">
                    <Label>Chart type</Label>
                    <select data-testid="chart-type-select" className="w-full rounded-md border px-3 py-2 text-sm" value={plotType} onChange={(e) => selectPlotType(e.target.value)}>
                      <option value="">Select a chart type…</option>
                      {plotTypes.map((p) => {
                        const compatible = compatiblePlotTypeSet.has(p.type);
                        return <option key={p.type} value={p.type} disabled={!compatible}>{p.label}{compatible ? '' : ' (needs different data)'}</option>;
                      })}
                    </select>
                    <p className="text-xs text-muted-foreground">{compatiblePlotTypes.length} chart types match the detected columns.</p>
                  </div>
                  <div className="space-y-1">
                    <Label>Figure name</Label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My figure" />
                  </div>
                </div>

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
