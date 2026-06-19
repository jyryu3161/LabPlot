'use client';

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Download, ImageIcon, Loader2, TableProperties, Wand2 } from 'lucide-react';
import { createFigure, getDataset, getPlotTypes, getPublicGalleryTemplate, listDatasets, listProjects, publicGalleryExampleDataUrl } from '@/lib/api';
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

function formatMappingValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'string') return value;
  return '';
}

function ExampleDataGuide({ template, plotDef }: {
  template: NonNullable<Awaited<ReturnType<typeof getPublicGalleryTemplate>>>;
  plotDef?: PlotTypeDef;
}) {
  const example = template.example_data;
  const preview = example?.preview ?? [];
  const previewColumns = preview.length ? Object.keys(preview[0]).slice(0, 8) : [];
  const hiddenColumnCount = preview.length ? Math.max(0, Object.keys(preview[0]).length - previewColumns.length) : 0;
  const fields = plotDef ? [...plotDef.required.map((field) => ({ ...field, required: true })), ...plotDef.optional.map((field) => ({ ...field, required: false }))] : [];

  if (!example) return null;

  return (
    <div className="mt-6 space-y-4 border-t pt-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <TableProperties className="h-4 w-4" />
            Example data for this template
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Use this as a column layout reference before uploading your own file.
          </p>
        </div>
        <a href={publicGalleryExampleDataUrl(template.id)} download={example.filename}>
          <Button type="button" variant="outline" size="sm">
            <Download className="mr-2 h-4 w-4" />
            Download CSV
          </Button>
        </a>
      </div>

      {fields.length > 0 && (
        <div className="rounded-lg border bg-muted/25 p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Template mapping</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {fields.map((field) => {
              const value = formatMappingValue(template.source_mapping[field.key]);
              if (!field.required && !value) return null;
              return (
                <div key={field.key} className="rounded-md bg-background px-3 py-2 text-sm">
                  <div className="font-medium">
                    {field.label}{field.required && <span className="text-red-500"> *</span>}
                  </div>
                  <div className="mt-0.5 text-muted-foreground">
                    {value || 'Optional'} <span className="text-xs">({field.roles.join(' / ')})</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="rounded-lg border bg-white">
        <div className="flex flex-col gap-2 border-b px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm font-medium">{example.filename}</div>
          <div className="text-xs text-muted-foreground">{example.n_rows} rows x {example.n_cols} columns</div>
        </div>
        <div className="flex flex-wrap gap-2 border-b px-3 py-2">
          {example.columns.slice(0, 12).map((column) => (
            <span key={column.name} className="rounded-md border bg-muted/30 px-2 py-1 text-xs">
              <span className="font-medium">{column.name}</span>
              <span className="ml-1 text-muted-foreground">{column.role}</span>
            </span>
          ))}
          {example.columns.length > 12 && <span className="px-2 py-1 text-xs text-muted-foreground">+{example.columns.length - 12} more</span>}
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-muted/30 text-muted-foreground">
              <tr>
                {previewColumns.map((column) => <th key={column} className="whitespace-nowrap px-3 py-2 font-medium">{column}</th>)}
                {hiddenColumnCount > 0 && <th className="whitespace-nowrap px-3 py-2 font-medium">+{hiddenColumnCount} more</th>}
              </tr>
            </thead>
            <tbody>
              {preview.slice(0, 5).map((row, idx) => (
                <tr key={idx} className="border-t">
                  {previewColumns.map((column) => (
                    <td key={column} className="max-w-[180px] truncate px-3 py-2 text-muted-foreground">
                      {row[column] == null ? '' : String(row[column])}
                    </td>
                  ))}
                  {hiddenColumnCount > 0 && <td className="px-3 py-2 text-muted-foreground">...</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function GalleryTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const qc = useQueryClient();
  const { data: template, isLoading: templateLoading } = useQuery({ queryKey: ['gallery-template', id], queryFn: () => getPublicGalleryTemplate(id) });
  const { data: projects, isLoading: projectsLoading } = useQuery({ queryKey: ['projects'], queryFn: listProjects });
  const { data: plotTypesData } = useQuery({ queryKey: ['plot-types'], queryFn: getPlotTypes });
  const [projectId, setProjectId] = useState('');
  const [selectedDatasetId, setSelectedDatasetId] = useState('');
  const [dataset, setDataset] = useState<DatasetDetail | null>(null);
  const [mapping, setMapping] = useState<Record<string, unknown>>({});
  const [figureName, setFigureName] = useState('');
  const editableProjects = useMemo(() => (projects ?? []).filter((project) => project.role === 'owner' || project.role === 'editor'), [projects]);
  const activeProjectId = projectId || editableProjects?.[0]?.id || '';
  const { data: projectDatasets, isLoading: projectDatasetsLoading } = useQuery({
    queryKey: ['datasets', activeProjectId],
    queryFn: () => listDatasets(activeProjectId),
    enabled: Boolean(activeProjectId),
  });
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
      if (!dataset || !template) throw new Error('Choose or upload a dataset first');
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

  const loadExistingDataset = useMutation({
    mutationFn: (datasetId: string) => getDataset(datasetId),
    onSuccess: (nextDataset) => {
      applyDataset(nextDataset);
      toast.success('Dataset loaded from project');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Dataset load failed'),
  });

  function applyDataset(nextDataset: DatasetDetail) {
    setDataset(nextDataset);
    setSelectedDatasetId(nextDataset.id);
    setFigureName(`${nextDataset.name} - ${template?.name ?? 'template figure'}`);
    setMapping(suggestedMapping(plotDef, nextDataset.column_profile));
  }

  function handleUploaded(nextDataset: DatasetDetail) {
    applyDataset(nextDataset);
    qc.invalidateQueries({ queryKey: ['datasets', activeProjectId] });
  }

  function clearDatasetSelection() {
    setDataset(null);
    setSelectedDatasetId('');
    setMapping({});
    setFigureName('');
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
                    <select
                      className="h-9 w-full max-w-md rounded-md border bg-background px-3 text-sm"
                      value={activeProjectId}
                      onChange={(e) => {
                        setProjectId(e.target.value);
                        clearDatasetSelection();
                      }}
                    >
                      {editableProjects.map((project) => (
                        <option key={project.id} value={project.id}>{project.name}{project.role !== 'owner' ? ' (shared)' : ''}</option>
                      ))}
                    </select>
                  )}
                </CardContent>
              </Card>

              {activeProjectId && (
                <Card>
                  <CardHeader><CardTitle className="text-base">2. Choose data for this template</CardTitle></CardHeader>
                  <CardContent className="space-y-6">
                    <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
                      <div>
                        <h3 className="text-sm font-medium">Use an existing project dataset</h3>
                        <p className="text-xs text-muted-foreground">Avoid duplicate uploads by selecting data already stored in this project.</p>
                      </div>
                      {projectDatasetsLoading ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Loading project datasets...
                        </div>
                      ) : !projectDatasets?.length ? (
                        <div className="rounded-md border border-dashed bg-background p-3 text-sm text-muted-foreground">
                          No datasets have been uploaded to this project yet.
                        </div>
                      ) : (
                        <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
                          <div className="space-y-1">
                            <Label htmlFor="existing-dataset">Project dataset</Label>
                            <select
                              id="existing-dataset"
                              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                              value={selectedDatasetId}
                              onChange={(event) => setSelectedDatasetId(event.target.value)}
                            >
                              <option value="">Select an existing dataset...</option>
                              {projectDatasets.map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.name} ({item.n_rows} x {item.n_cols})
                                </option>
                              ))}
                            </select>
                          </div>
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => loadExistingDataset.mutate(selectedDatasetId)}
                            disabled={!selectedDatasetId || loadExistingDataset.isPending}
                          >
                            {loadExistingDataset.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <TableProperties className="mr-2 h-4 w-4" />}
                            Use dataset
                          </Button>
                        </div>
                      )}
                      {dataset && (
                        <div className="rounded-md border bg-background px-3 py-2 text-sm">
                          <span className="font-medium">Selected:</span> {dataset.name}
                          <span className="ml-2 text-muted-foreground">{dataset.n_rows} rows x {dataset.n_cols} columns</span>
                        </div>
                      )}
                    </div>

                    <div className="space-y-3">
                      <div>
                        <h3 className="text-sm font-medium">Or upload a new dataset</h3>
                        <p className="text-xs text-muted-foreground">Upload only when this project does not already contain the data you need.</p>
                      </div>
                    <DatasetUploadWizard
                      projectId={activeProjectId}
                      title="Upload data for this template"
                      helper="Preview the sheet and select focus columns before mapping."
                      onUploaded={handleUploaded}
                    />
                    </div>
                    <ExampleDataGuide template={template} plotDef={plotDef} />
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
