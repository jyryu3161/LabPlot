'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  getFigure, getDataset, getPlotTypes, getStyles, getPalettes, rerenderFigure, reviewVersion,
  improveVersion, applyImprovement, applyImprovements, updateFigure, generateLegend, downloadExport, enhancePrompt,
  deleteFigureVersion, getProject, saveFigureTemplateFavorite, deleteFigureTemplateFavorite,
  createCustomPalette, updateCustomPalette, deleteCustomPalette,
} from '@/lib/api';
import type { ImproveVersionRequest } from '@/lib/api';
import type { FigureVersion, Review, Improvement, PlotTypeDef, ColumnProfile, PaletteDef } from '@/lib/types';
import { formatStylePreset } from '@/lib/style-presets';
import { AiFigureEditor } from '@/components/figures/AiFigureEditor';
import { AppHeader } from '@/components/layout/AppHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Star, Download, History, Pencil, FileText, Sparkles, Trash2 } from 'lucide-react';

const SCORE_COLOR = (s: number) => (s >= 80 ? 'text-green-600' : s >= 60 ? 'text-amber-600' : 'text-red-600');
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const DEFAULT_CUSTOM_COLORS = ['#4477AA', '#EE6677', '#228833', '#CCBB44'];
const REPRESENTATIVE_COLORS = [
  '#4477AA', '#EE6677', '#228833', '#CCBB44', '#66CCEE', '#AA3377',
  '#332288', '#88CCEE', '#44AA99', '#117733', '#DDCC77', '#CC6677',
  '#882255', '#999933', '#000000', '#666666',
];

function normalizeHexColor(value: string): string {
  const clean = value.trim();
  return HEX_COLOR_RE.test(clean) ? clean.toUpperCase() : clean;
}

export default function FigureDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const { data: fig, isLoading } = useQuery({ queryKey: ['figure', id], queryFn: () => getFigure(id) });
  const { data: stylesData } = useQuery({ queryKey: ['styles'], queryFn: getStyles });
  const { data: plotTypesData } = useQuery({ queryKey: ['plot-types'], queryFn: getPlotTypes });
  const { data: palettesData } = useQuery({ queryKey: ['palettes'], queryFn: getPalettes });
  const { data: dataset } = useQuery({ queryKey: ['dataset', fig?.dataset_id], queryFn: () => getDataset(fig!.dataset_id), enabled: !!fig?.dataset_id });
  const { data: project } = useQuery({ queryKey: ['project', fig?.project_id], queryFn: () => getProject(fig!.project_id!), enabled: !!fig?.project_id });

  const [selectedVid, setSelectedVid] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [improvements, setImprovements] = useState<Improvement[] | null>(null);

  // edit panel
  const [plotType, setPlotType] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Record<string, unknown> | null>(null);
  const [options, setOptions] = useState<Record<string, unknown> | null>(null);
  const [style, setStyle] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [legend, setLegend] = useState<string | null>(null);
  const [improvePrompt, setImprovePrompt] = useState('');
  const [legendPrompt, setLegendPrompt] = useState('');
  const [palettePanelOpen, setPalettePanelOpen] = useState(false);
  const [paletteEditingId, setPaletteEditingId] = useState<string | null>(null);
  const [paletteName, setPaletteName] = useState('');
  const [paletteColors, setPaletteColors] = useState<string[]>(DEFAULT_CUSTOM_COLORS);

  const plotTypes = plotTypesData?.plot_types ?? [];
  const styles = stylesData?.styles ?? [];
  const palettes = palettesData?.palettes ?? [];
  const columns: ColumnProfile[] = dataset?.column_profile ?? [];
  const effectiveSelectedVid = selectedVid ?? fig?.current_version_id ?? fig?.versions[fig.versions.length - 1]?.id ?? null;
  const version: FigureVersion | undefined = fig?.versions.find((v) => v.id === effectiveSelectedVid);
  const effectivePlotType = plotType ?? fig?.plot_type ?? '';
  const effectiveStyle = style ?? fig?.style_preset ?? '';
  const effectiveMapping = mapping ?? version?.mapping ?? {};
  const effectiveOptions = options ?? version?.options ?? {};
  const selectedPaletteKey = String(effectiveOptions.palette_name ?? 'preset');
  const selectedPalette = palettes.find((pl) => pl.key === selectedPaletteKey);
  const selectedStyle = styles.find((s) => s.key === effectiveStyle);
  const descriptionValue = description ?? fig?.description ?? '';
  const legendValue = legend ?? fig?.legend ?? '';
  const currentDef: PlotTypeDef | undefined = plotTypes.find((p) => p.type === effectivePlotType);
  const canEditFigure = !fig?.project_id || project?.role === 'owner' || project?.role === 'editor';
  const isViewerOnly = Boolean(fig?.project_id && project?.role === 'viewer');

  const apply = useMutation({
    mutationFn: () => rerenderFigure(id, { plot_type: effectivePlotType, mapping: effectiveMapping, options: effectiveOptions, style_preset: effectiveStyle, change_note: 'Edited in figure editor' }),
    onSuccess: (v) => { toast.success(`Re-rendered (v${v.version_number})`); setSelectedVid(v.id); setReview(null); setImprovements(null); qc.invalidateQueries({ queryKey: ['figure', id] }); qc.invalidateQueries({ queryKey: ['figures'] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Render failed'),
  });
  const runReview = useMutation({
    mutationFn: () => reviewVersion(id, effectiveSelectedVid!),
    onSuccess: (r) => { setReview(r); toast.success('Review complete'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Review failed'),
  });
  const runImprove = useMutation({
    mutationFn: (request?: ImproveVersionRequest) => improveVersion(
      id,
      effectiveSelectedVid!,
      request ?? { prompt: improvePrompt },
    ),
    onSuccess: (l) => { setImprovements(l); toast.success(`${l.length} suggestions`); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Improve failed'),
  });
  const applyImp = useMutation({
    mutationFn: (impId: string) => applyImprovement(id, impId),
    onSuccess: (v) => { toast.success(`Applied as v${v.version_number}; R script regenerated`); setSelectedVid(v.id); setReview(null); setImprovements(null); qc.invalidateQueries({ queryKey: ['figure', id] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Apply failed'),
  });
  const applyImps = useMutation({
    mutationFn: (impIds: string[]) => applyImprovements(id, impIds),
    onSuccess: (v) => { toast.success(`Applied checked suggestions as v${v.version_number}; R script regenerated`); setSelectedVid(v.id); setReview(null); setImprovements(null); qc.invalidateQueries({ queryKey: ['figure', id] }); qc.invalidateQueries({ queryKey: ['figures'] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Apply failed'),
  });
  const directAiEdit = useMutation({
    mutationFn: async (request?: ImproveVersionRequest) => {
      const prompt = (request?.prompt ?? improvePrompt).trim();
      if (!prompt) throw new Error('Describe the edit you want first');
      if (!effectiveSelectedVid) throw new Error('No figure version selected');
      const suggestions = await improveVersion(id, effectiveSelectedVid, {
        prompt,
        annotated_image: request?.annotated_image,
      });
      const applicable = suggestions.filter((item) => item.param_patch && Object.keys(item.param_patch).length > 0);
      if (!applicable.length) throw new Error('AI did not return an applicable visual edit');
      const appliedIds = applicable.map((item) => item.id);
      const version = appliedIds.length === 1
        ? await applyImprovement(id, appliedIds[0])
        : await applyImprovements(id, appliedIds);
      return { suggestions, appliedIds, version };
    },
    onSuccess: ({ suggestions, appliedIds, version }) => {
      toast.success(`AI edit applied as v${version.version_number}; R script regenerated`);
      const applied = new Set(appliedIds);
      setImprovements(suggestions.map((item) => applied.has(item.id) ? { ...item, applied: true } : item));
      setSelectedVid(version.id);
      setReview(null);
      qc.invalidateQueries({ queryKey: ['figure', id] });
      qc.invalidateQueries({ queryKey: ['figures'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'AI edit failed'),
  });
  const saveDesc = useMutation({
    mutationFn: () => updateFigure(id, { description: descriptionValue }),
    onSuccess: () => { toast.success('Interpretation saved'); qc.invalidateQueries({ queryKey: ['figure', id] }); },
  });
  const enhanceNotes = useMutation({
    mutationFn: () => enhancePrompt(descriptionValue, 'interpretation', fig ? `${fig.plot_type} figure: ${fig.name}` : undefined),
    onSuccess: (r) => { setDescription(r.enhanced); toast.success('Enhanced'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Enhance failed'),
  });
  const saveLegend = useMutation({
    mutationFn: () => updateFigure(id, { legend: legendValue }),
    onSuccess: () => { toast.success('Legend saved'); qc.invalidateQueries({ queryKey: ['figure', id] }); },
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
    mutationFn: (versionId: string) => deleteFigureVersion(id, versionId),
    onSuccess: (updated, deletedVersionId) => {
      toast.success('Version deleted');
      qc.setQueryData(['figure', id], updated);
      qc.invalidateQueries({ queryKey: ['figure', id] });
      qc.invalidateQueries({ queryKey: ['figures'] });
      if (selectedVid === deletedVersionId || fig?.current_version_id === deletedVersionId) {
        setSelectedVid(updated.current_version_id ?? updated.versions[updated.versions.length - 1]?.id ?? null);
        setReview(null);
        setImprovements(null);
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
    { fmt: 'r', label: 'R script', available: Boolean(version?.r_url) },
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

  if (isLoading || !fig) {
    return (<div className="min-h-screen bg-muted/20"><AppHeader /><div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin" /></div></div>);
  }
  const p = review?.payload;

  return (
    <div className="min-h-screen bg-muted/20">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-4 py-8">
        <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
          <Link href="/figures" className="hover:underline">Figures</Link>
          {fig.project_id && <>/ <Link href={`/projects/${fig.project_id}`} className="hover:underline">project</Link></>}
          / {fig.name}
        </div>
        <div className="mb-6 flex items-center gap-3">
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
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* left: image + paper-writing */}
          <div className="space-y-4 lg:col-span-2">
            <Card><CardContent className="p-4">
              {previewUrl ? <img src={previewUrl} alt={fig.name} decoding="async" className="mx-auto max-h-[58vh] w-auto rounded bg-white object-contain" />
                : <div className="py-20 text-center text-muted-foreground">No image</div>}
              {previewIsSvg && <p className="mt-2 text-center text-xs text-muted-foreground">SVG preview</p>}
            </CardContent></Card>

            <AiFigureEditor
              key={version?.id ?? 'no-version'}
              imageUrl={version?.png_url ?? version?.svg_url}
              versionNumber={version?.version_number}
              prompt={improvePrompt}
              improvements={improvements}
              canEdit={canEditFigure}
              isSuggesting={runImprove.isPending}
              isApplyingPrompt={directAiEdit.isPending}
              isApplyingSuggestion={applyImp.isPending || applyImps.isPending}
              onPromptChange={setImprovePrompt}
              onSuggest={(request) => runImprove.mutate(request)}
              onApplyPrompt={(request) => directAiEdit.mutate(request)}
              onApplySuggestion={(improvementId) => applyImp.mutate(improvementId)}
              onApplySuggestions={(improvementIds) => applyImps.mutate(improvementIds)}
            />

            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Download className="h-4 w-4" /> Export {version && `(v${version.version_number})`}</CardTitle></CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {exportFormats.map((f) => <Button key={f.fmt} variant="outline" size="sm" onClick={() => doExport(f.fmt)}>{f.label}</Button>)}
                {exportFormats.length === 0 && <p className="text-sm text-muted-foreground">No export files available for this version.</p>}
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
          </div>

          {/* right: editor + versions + AI */}
          <div className="space-y-4">
            {/* EDIT panel */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Pencil className="h-4 w-4" /> Edit figure</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {!canEditFigure ? (
                  <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">Viewer access is read-only. You can download existing exports, but changing mappings, options, or versions requires editor access.</p>
                ) : (
                  <>
                    <div className="space-y-1">
                      <Label>Chart type</Label>
                      <select className="w-full rounded-md border px-3 py-2 text-sm" value={effectivePlotType} onChange={(e) => selectPlotType(e.target.value)}>
                        {plotTypes.map((pt) => <option key={pt.type} value={pt.type}>{pt.label}</option>)}
                      </select>
                    </div>
                    {currentDef && [...currentDef.required.map((f) => ({ ...f, req: true })), ...currentDef.optional.map((f) => ({ ...f, req: false }))].map((f) => (
                      <div key={f.key} className="space-y-1">
                        <Label className="text-xs">{f.label}{f.req && <span className="text-red-500"> *</span>}</Label>
                        {f.multi ? (
                          <div className="max-h-28 overflow-y-auto rounded-md border p-2">
                            {columns.map((c) => {
                              const arr = (effectiveMapping[f.key] as string[]) || [];
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
                          <select className="w-full rounded-md border px-2 py-1.5 text-sm" value={(effectiveMapping[f.key] as string) ?? ''} onChange={(e) => setMapping({ ...effectiveMapping, [f.key]: e.target.value || null })}>
                            <option value="">{f.req ? 'Select…' : '(none)'}</option>
                            {columns.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.role})</option>)}
                          </select>
                        )}
                      </div>
                    ))}

                    {/* plot-specific options */}
                    {currentDef?.options.map((o) => (
                      <div key={o.key} className="space-y-1">
                        <Label className="text-xs">{o.label}</Label>
                        {o.type === 'bool' ? (
                          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={Boolean(effectiveOptions[o.key])} onChange={(e) => setOptions({ ...effectiveOptions, [o.key]: e.target.checked })} /> enabled</label>
                        ) : o.type === 'select' ? (
                          <select className="w-full rounded-md border px-2 py-1.5 text-sm" value={String(effectiveOptions[o.key] ?? o.default ?? '')} onChange={(e) => setOptions({ ...effectiveOptions, [o.key]: e.target.value })}>{o.choices?.map((c) => <option key={c} value={c}>{c}</option>)}</select>
                        ) : o.type === 'number' ? (
                          <Input type="number" value={String(effectiveOptions[o.key] ?? o.default ?? '')} onChange={(e) => setOptions({ ...effectiveOptions, [o.key]: parseFloat(e.target.value) })} />
                        ) : <Input value={String(effectiveOptions[o.key] ?? '')} onChange={(e) => setOptions({ ...effectiveOptions, [o.key]: e.target.value })} />}
                      </div>
                    ))}

                    {/* universal label/axis/appearance controls */}
                    <div className="grid grid-cols-1 gap-2 border-t pt-2">
                      <div className="space-y-1"><Label className="text-xs">In-plot title (usually blank)</Label><Input className="text-sm" value={String(effectiveOptions.title ?? '')} onChange={(e) => setOptions({ ...effectiveOptions, title: e.target.value })} placeholder="Leave blank for manuscript-style figures" /></div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1"><Label className="text-xs">X label</Label><Input className="text-sm" value={String(effectiveOptions.x_label ?? '')} onChange={(e) => setOptions({ ...effectiveOptions, x_label: e.target.value })} /></div>
                        <div className="space-y-1"><Label className="text-xs">Y label</Label><Input className="text-sm" value={String(effectiveOptions.y_label ?? '')} onChange={(e) => setOptions({ ...effectiveOptions, y_label: e.target.value })} /></div>
                      </div>
                      <div className="space-y-1"><Label className="text-xs">Legend title</Label><Input className="text-sm" value={String(effectiveOptions.legend_title ?? '')} onChange={(e) => setOptions({ ...effectiveOptions, legend_title: e.target.value })} /></div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <Label className="text-xs">Color mode</Label>
                          <select className="w-full rounded-md border px-2 py-1.5 text-sm" value={String(effectiveOptions.color_mode ?? 'color')} onChange={(e) => setOptions({ ...effectiveOptions, color_mode: e.target.value })}>
                            <option value="color">Color</option><option value="grayscale">Grayscale</option>
                          </select>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Style</Label>
                          <select className="w-full rounded-md border px-2 py-1.5 text-sm" value={effectiveStyle} onChange={(e) => setStyle(e.target.value)}>{styles.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
                        </div>
                      </div>
                      {selectedStyle?.description && (
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {selectedStyle.description} Color palette overrides the style colors; manuscript styles use no gridlines by default.
                        </p>
                      )}
                      {/* color palette */}
                      <div className="space-y-1">
                        <Label className="text-xs">Color palette</Label>
                        <select className="w-full rounded-md border px-2 py-1.5 text-sm" value={selectedPaletteKey} onChange={(e) => setOptions({ ...effectiveOptions, palette_name: e.target.value })}>
                          {palettes.map((pl) => <option key={pl.key} value={pl.key}>{pl.label}</option>)}
                        </select>
                        {selectedPalette?.hex?.length ? (
                          <div className="mt-1 flex gap-0.5">{selectedPalette.hex.map((h) => <span key={h} className="h-3 w-4 rounded-sm border" style={{ backgroundColor: h }} />)}</div>
                        ) : null}
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
                      {/* figure size */}
                      <div className="grid grid-cols-3 gap-2">
                        <div className="space-y-1">
                          <Label className="text-xs">Figure size</Label>
                          <select className="w-full rounded-md border px-2 py-1.5 text-sm" value={String(effectiveOptions.size ?? 'wide')} onChange={(e) => setOptions({ ...effectiveOptions, size: e.target.value })}>
                            <option value="single_column">Single column</option>
                            <option value="wide">Wide (double)</option>
                            <option value="square">Square</option>
                            <option value="custom">Custom</option>
                          </select>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Width (in)</Label>
                          <Input type="number" step="0.1" disabled={effectiveOptions.size !== 'custom'} value={String(effectiveOptions.width_in ?? 7)} onChange={(e) => setOptions({ ...effectiveOptions, width_in: parseFloat(e.target.value) })} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Height (in)</Label>
                          <Input type="number" step="0.1" disabled={effectiveOptions.size !== 'custom'} value={String(effectiveOptions.height_in ?? 4.2)} onChange={(e) => setOptions({ ...effectiveOptions, height_in: parseFloat(e.target.value) })} />
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-3 text-xs">
                        <label className="flex items-center gap-1"><input type="checkbox" checked={Boolean(effectiveOptions.hide_legend)} onChange={(e) => setOptions({ ...effectiveOptions, hide_legend: e.target.checked })} /> Hide legend</label>
                        <label className="flex items-center gap-1"><input type="checkbox" checked={Boolean(effectiveOptions.log_y)} onChange={(e) => setOptions({ ...effectiveOptions, log_y: e.target.checked })} /> log Y</label>
                        <label className="flex items-center gap-1"><input type="checkbox" checked={Boolean(effectiveOptions.log_x)} onChange={(e) => setOptions({ ...effectiveOptions, log_x: e.target.checked })} /> log X</label>
                        <label className="flex items-center gap-1"><input type="checkbox" checked={Boolean(effectiveOptions.flip_coords)} onChange={(e) => setOptions({ ...effectiveOptions, flip_coords: e.target.checked })} /> flip</label>
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
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><History className="h-4 w-4" /> Versions ({fig.versions.length})</CardTitle></CardHeader>
              <CardContent className="space-y-1">
                {fig.versions.slice().reverse().map((v) => (
                  <div key={v.id}
                    className={`flex w-full items-center gap-1 rounded px-2 py-1.5 text-xs ${v.id === effectiveSelectedVid ? 'bg-muted font-medium' : 'hover:bg-muted/50'}`}>
                    <button type="button" onClick={() => { setSelectedVid(v.id); setReview(null); setImprovements(null); }}
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
                  </div>
                )}
              </CardContent>
            </Card>

          </div>
        </div>
      </main>
    </div>
  );
}
