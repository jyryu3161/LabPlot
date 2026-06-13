'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  getFigure, getDataset, getPlotTypes, getStyles, getPalettes, rerenderFigure, reviewVersion,
  improveVersion, applyImprovement, updateFigure, generateLegend, downloadExport, enhancePrompt,
} from '@/lib/api';
import type { FigureVersion, Review, Improvement, PlotTypeDef, ColumnProfile } from '@/lib/types';
import { formatStylePreset } from '@/lib/style-presets';
import { SvgVectorEditor } from '@/components/figures/SvgVectorEditor';
import { AppHeader } from '@/components/layout/AppHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Star, Wand2, Download, CheckCircle2, History, Pencil, FileText, Sparkles } from 'lucide-react';

const SCORE_COLOR = (s: number) => (s >= 80 ? 'text-green-600' : s >= 60 ? 'text-amber-600' : 'text-red-600');

export default function FigureDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const { data: fig, isLoading } = useQuery({ queryKey: ['figure', id], queryFn: () => getFigure(id) });
  const { data: stylesData } = useQuery({ queryKey: ['styles'], queryFn: getStyles });
  const { data: plotTypesData } = useQuery({ queryKey: ['plot-types'], queryFn: getPlotTypes });
  const { data: palettesData } = useQuery({ queryKey: ['palettes'], queryFn: getPalettes });
  const { data: dataset } = useQuery({ queryKey: ['dataset', fig?.dataset_id], queryFn: () => getDataset(fig!.dataset_id), enabled: !!fig?.dataset_id });

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
  const descriptionValue = description ?? fig?.description ?? '';
  const legendValue = legend ?? fig?.legend ?? '';
  const currentDef: PlotTypeDef | undefined = plotTypes.find((p) => p.type === effectivePlotType);

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
    mutationFn: () => improveVersion(id, effectiveSelectedVid!),
    onSuccess: (l) => { setImprovements(l); toast.success(`${l.length} suggestions`); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Improve failed'),
  });
  const applyImp = useMutation({
    mutationFn: (impId: string) => applyImprovement(id, impId),
    onSuccess: (v) => { toast.success(`Applied (v${v.version_number})`); setSelectedVid(v.id); setReview(null); setImprovements(null); qc.invalidateQueries({ queryKey: ['figure', id] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Apply failed'),
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
    mutationFn: () => generateLegend(id, effectiveSelectedVid!),
    onSuccess: (r) => { setLegend(r.legend); toast.success('AI legend generated'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Legend failed'),
  });

  async function doExport(fmt: string) {
    if (!version) return;
    try { await downloadExport(id, version.id, fmt, `${fig?.name ?? 'figure'}_v${version.version_number}.${fmt === 'r' ? 'R' : fmt}`); }
    catch { toast.error('Export failed'); }
  }

  function selectPlotType(pt: string) {
    setPlotType(pt);
    const def = plotTypes.find((p) => p.type === pt);
    const opt = { ...effectiveOptions };
    def?.options.forEach((o) => { if (opt[o.key] === undefined && o.default !== undefined) opt[o.key] = o.default; });
    setOptions(opt);
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
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* left: image + paper-writing */}
          <div className="space-y-4 lg:col-span-2">
            <Card><CardContent className="p-4">
              {version?.png_url ? <img src={version.png_url} alt={fig.name} decoding="async" className="mx-auto max-h-[58vh] w-auto rounded bg-white object-contain" />
                : <div className="py-20 text-center text-muted-foreground">No image</div>}
            </CardContent></Card>

            <SvgVectorEditor svgUrl={version?.svg_url} filenameBase={fig.name} versionNumber={version?.version_number} />

            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Download className="h-4 w-4" /> Export {version && `(v${version.version_number})`}</CardTitle></CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {['png', 'svg', 'tiff', 'pdf', 'r'].map((f) => <Button key={f} variant="outline" size="sm" onClick={() => doExport(f)}>{f === 'r' ? 'R script' : f.toUpperCase()}</Button>)}
              </CardContent>
            </Card>

            {/* AI figure legend (for the manuscript) */}
            <Card>
              <CardHeader className="pb-2 flex flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base"><FileText className="h-4 w-4" /> Figure legend</CardTitle>
                <Button size="sm" variant="outline" onClick={() => aiLegend.mutate()} disabled={aiLegend.isPending || !effectiveSelectedVid}>
                  {aiLegend.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />} AI generate
                </Button>
              </CardHeader>
              <CardContent className="space-y-2">
                <Textarea value={legendValue} onChange={(e) => setLegend(e.target.value)} rows={4} placeholder="AI-generated or hand-written figure legend for your manuscript…" />
                <Button size="sm" variant="secondary" onClick={() => saveLegend.mutate()} disabled={saveLegend.isPending}>Save legend</Button>
              </CardContent>
            </Card>

            {/* interpretation / notes */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Pencil className="h-4 w-4" /> Interpretation / notes</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                <Textarea value={descriptionValue} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Your interpretation of this figure (results, takeaways) for the paper…" />
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => enhanceNotes.mutate()} disabled={enhanceNotes.isPending}>
                    {enhanceNotes.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />} Enhance
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => saveDesc.mutate()} disabled={saveDesc.isPending}>Save notes</Button>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* right: editor + versions + AI */}
          <div className="space-y-4">
            {/* EDIT panel */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Pencil className="h-4 w-4" /> Edit figure</CardTitle></CardHeader>
              <CardContent className="space-y-3">
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
                  {/* color palette */}
                  <div className="space-y-1">
                    <Label className="text-xs">Color palette</Label>
                    <select className="w-full rounded-md border px-2 py-1.5 text-sm" value={String(effectiveOptions.palette_name ?? 'preset')} onChange={(e) => setOptions({ ...effectiveOptions, palette_name: e.target.value })}>
                      {palettes.map((pl) => <option key={pl.key} value={pl.key}>{pl.label}</option>)}
                    </select>
                    {(() => {
                      const sel = palettes.find((pl) => pl.key === (effectiveOptions.palette_name ?? 'preset'));
                      return sel?.hex?.length ? (
                        <div className="mt-1 flex gap-0.5">{sel.hex.map((h) => <span key={h} className="h-3 w-4 rounded-sm border" style={{ backgroundColor: h }} />)}</div>
                      ) : null;
                    })()}
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
              </CardContent>
            </Card>

            {/* versions */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><History className="h-4 w-4" /> Versions ({fig.versions.length})</CardTitle></CardHeader>
              <CardContent className="space-y-1">
                {fig.versions.slice().reverse().map((v) => (
                  <button key={v.id} onClick={() => { setSelectedVid(v.id); setReview(null); setImprovements(null); }}
                    className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs ${v.id === effectiveSelectedVid ? 'bg-muted font-medium' : 'hover:bg-muted/50'}`}>
                    <span>v{v.version_number} · {formatStylePreset(v.style_preset)} · {v.change_note || ''}</span>
                    {v.id === fig.current_version_id && <Badge variant="secondary" className="text-[10px]">latest</Badge>}
                  </button>
                ))}
              </CardContent>
            </Card>

            {/* AI review */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Star className="h-4 w-4 text-amber-500" /> AI Figure Review</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <Button size="sm" variant="outline" className="w-full" onClick={() => runReview.mutate()} disabled={runReview.isPending || !effectiveSelectedVid}>
                  {runReview.isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Reviewing…</> : 'Review this figure'}
                </Button>
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

            {/* AI improve */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Wand2 className="h-4 w-4 text-primary" /> AI Improve</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <Button size="sm" variant="outline" className="w-full" onClick={() => runImprove.mutate()} disabled={runImprove.isPending || !effectiveSelectedVid}>
                  {runImprove.isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Thinking…</> : 'Suggest improvements'}
                </Button>
                {improvements?.map((imp) => (
                  <div key={imp.id} className="rounded border p-2 text-sm">
                    <div className="flex items-center justify-between"><span className="font-medium">{imp.suggestion_type}</span>{imp.priority && <Badge variant="outline" className="text-xs">{imp.priority}</Badge>}</div>
                    {imp.recommended && <p className="mt-1 text-xs text-muted-foreground">{imp.recommended}</p>}
                    <Button size="sm" variant="secondary" className="mt-2 w-full" onClick={() => applyImp.mutate(imp.id)} disabled={applyImp.isPending || imp.applied}>
                      {imp.applied ? <><CheckCircle2 className="mr-1 h-3 w-3" /> Applied</> : 'Apply'}
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
