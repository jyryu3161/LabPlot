'use client';

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, ImageIcon, Loader2, Wand2 } from 'lucide-react';
import { createFigure, getPlotTypes, getPublicGalleryTemplate, listProjects } from '@/lib/api';
import type { ColumnProfile, DatasetDetail, PlotTypeDef } from '@/lib/types';
import { AppHeader } from '@/components/layout/AppHeader';
import { DatasetUploadWizard } from '@/components/datasets/DatasetUploadWizard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function fieldMatchesColumn(field: { roles: string[] }, column: ColumnProfile) {
  return field.roles.includes(column.role) || field.roles.includes(column.dtype);
}

function suggestedMapping(def: PlotTypeDef | undefined, columns: ColumnProfile[]): Record<string, unknown> {
  if (!def) return {};
  const used = new Set<string>();
  const next: Record<string, unknown> = {};
  const fields = [...def.required, ...def.optional];
  for (const field of fields) {
    const matches = columns.filter((column) => fieldMatchesColumn(field, column));
    if (field.multi) {
      const values = matches.map((column) => column.name).slice(0, 8);
      if (values.length) next[field.key] = values;
      continue;
    }
    const match = matches.find((column) => !used.has(column.name));
    if (match) {
      next[field.key] = match.name;
      used.add(match.name);
    }
  }
  return next;
}

export default function GalleryTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const qc = useQueryClient();
  const { data: template, isLoading: templateLoading } = useQuery({ queryKey: ['gallery-template', id], queryFn: () => getPublicGalleryTemplate(id) });
  const { data: projects, isLoading: projectsLoading } = useQuery({ queryKey: ['projects'], queryFn: listProjects });
  const { data: plotTypesData } = useQuery({ queryKey: ['plot-types'], queryFn: getPlotTypes });
  const [projectId, setProjectId] = useState('');
  const [dataset, setDataset] = useState<DatasetDetail | null>(null);
  const [mapping, setMapping] = useState<Record<string, unknown>>({});
  const [figureName, setFigureName] = useState('');
  const editableProjects = useMemo(() => (projects ?? []).filter((project) => project.role === 'owner' || project.role === 'editor'), [projects]);
  const activeProjectId = projectId || editableProjects?.[0]?.id || '';
  const plotDef = useMemo(
    () => plotTypesData?.plot_types.find((plot) => plot.type === template?.plot_type),
    [plotTypesData?.plot_types, template?.plot_type],
  );
  const columns = dataset?.column_profile ?? [];
  const missingRequiredFields = useMemo(() => (plotDef?.required ?? []).filter((field) => {
    const value = mapping[field.key];
    return field.multi ? !Array.isArray(value) || value.length === 0 : !value;
  }), [mapping, plotDef?.required]);

  const create = useMutation({
    mutationFn: () => {
      if (!dataset || !template) throw new Error('Upload a dataset first');
      return createFigure({
        dataset_id: dataset.id,
        name: figureName || `${dataset.name} - ${template.name}`,
        plot_type: template.plot_type,
        mapping,
        options: template.options ?? {},
        style_preset: template.style_preset,
      });
    },
    onSuccess: (figure) => {
      toast.success('Figure created from template');
      qc.invalidateQueries({ queryKey: ['figures', activeProjectId] });
      router.push(`/figures/${figure.id}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Figure creation failed'),
  });

  function handleUploaded(nextDataset: DatasetDetail) {
    setDataset(nextDataset);
    setFigureName(`${nextDataset.name} - ${template?.name ?? 'template figure'}`);
    setMapping(suggestedMapping(plotDef, nextDataset.column_profile));
    qc.invalidateQueries({ queryKey: ['datasets', activeProjectId] });
  }

  if (templateLoading || projectsLoading) {
    return <div className="min-h-screen bg-muted/20"><AppHeader /><div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin" /></div></div>;
  }

  return (
    <div className="min-h-screen bg-muted/20">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-4 py-8">
        <Link href="/gallery" className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to gallery
        </Link>

        {!template ? (
          <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">Template not found.</div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
            <aside className="space-y-4">
              <Card>
                <CardHeader><CardTitle className="text-base">Selected template</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  {template.thumb_url ? (
                    <img src={template.thumb_url} alt={template.name} className="aspect-[4/3] w-full rounded-lg border bg-white object-contain" />
                  ) : (
                    <div className="flex aspect-[4/3] items-center justify-center rounded-lg border bg-white text-muted-foreground"><ImageIcon className="h-8 w-8" /></div>
                  )}
                  <div>
                    <h1 className="text-lg font-semibold">{template.name}</h1>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Badge variant="secondary">{template.plot_type.replace(/_/g, ' ')}</Badge>
                      <Badge variant="outline">{template.style_preset}</Badge>
                      {template.domain_label && <Badge variant="outline">{template.domain_label}</Badge>}
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">This copies the figure format and style. You will map your own dataset columns before rendering.</p>
                </CardContent>
              </Card>
            </aside>

            <section className="space-y-6">
              <Card>
                <CardHeader><CardTitle className="text-base">1. Choose project</CardTitle></CardHeader>
                <CardContent>
                  {!editableProjects?.length ? (
                    <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                      Create a project or ask for editor access before using this template.
                      <Link href="/projects"><Button className="ml-3" size="sm">Go to projects</Button></Link>
                    </div>
                  ) : (
                    <select className="h-9 w-full max-w-md rounded-md border bg-background px-3 text-sm" value={activeProjectId} onChange={(e) => setProjectId(e.target.value)}>
                      {editableProjects.map((project) => (
                        <option key={project.id} value={project.id}>{project.name}{project.role !== 'owner' ? ' (shared)' : ''}</option>
                      ))}
                    </select>
                  )}
                </CardContent>
              </Card>

              {activeProjectId && (
                <Card>
                  <CardHeader><CardTitle className="text-base">2. Upload data for this template</CardTitle></CardHeader>
                  <CardContent>
                    <DatasetUploadWizard
                      projectId={activeProjectId}
                      title="Upload data for this template"
                      helper="Preview the sheet and select focus columns before mapping."
                      onUploaded={handleUploaded}
                    />
                  </CardContent>
                </Card>
              )}

              {dataset && plotDef && (
                <Card>
                  <CardHeader><CardTitle className="text-base">3. Map your columns</CardTitle></CardHeader>
                  <CardContent className="space-y-4">
                    <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
                      This template needs {plotDef.required.map((field) => field.label).join(', ')}. If a required field is empty, the uploaded data does not contain a matching column type yet.
                    </div>
                    <div className="space-y-1">
                      <Label>Figure name</Label>
                      <Input value={figureName} onChange={(e) => setFigureName(e.target.value)} />
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      {[...plotDef.required.map((field) => ({ ...field, required: true })), ...plotDef.optional.map((field) => ({ ...field, required: false }))].map((field) => (
                        <div key={field.key} className="space-y-1">
                          <Label>{field.label}{field.required && <span className="text-red-500"> *</span>}</Label>
                          {field.multi ? (
                            <div className="max-h-36 overflow-y-auto rounded-md border bg-background p-2">
                              {columns.map((column) => {
                                const values = (mapping[field.key] as string[]) || [];
                                const checked = values.includes(column.name);
                                return (
                                  <label key={column.name} className="flex items-center gap-2 py-1 text-sm">
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={(e) => {
                                        const next = e.target.checked ? [...values, column.name] : values.filter((name) => name !== column.name);
                                        setMapping({ ...mapping, [field.key]: next });
                                      }}
                                    />
                                    <span className="min-w-0 truncate">{column.name}</span>
                                    <span className="text-xs text-muted-foreground">({column.role})</span>
                                  </label>
                                );
                              })}
                            </div>
                          ) : (
                            <select
                              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                              value={(mapping[field.key] as string) ?? ''}
                              onChange={(e) => setMapping({ ...mapping, [field.key]: e.target.value || null })}
                            >
                              <option value="">{field.required ? 'Select...' : '(none)'}</option>
                              {columns.map((column) => {
                                const compatible = fieldMatchesColumn(field, column);
                                return <option key={column.name} value={column.name}>{column.name} ({column.role}{compatible ? '' : ', role mismatch'})</option>;
                              })}
                            </select>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:justify-end">
                      <Button variant="outline" onClick={() => setMapping(suggestedMapping(plotDef, columns))}>Suggest mapping</Button>
                      <Button onClick={() => create.mutate()} disabled={create.isPending || missingRequiredFields.length > 0}>
                        {create.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}
                        Create figure
                      </Button>
                    </div>
                    {missingRequiredFields.length > 0 && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                        Missing required mapping: {missingRequiredFields.map((field) => field.label).join(', ')}.
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
