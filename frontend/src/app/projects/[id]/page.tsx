'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { getProject, updateProject, listDatasets, listFigures, deleteDataset, deleteFigure, downloadProjectPack, enhancePrompt } from '@/lib/api';
import { AppHeader } from '@/components/layout/AppHeader';
import { DatasetUploadWizard } from '@/components/datasets/DatasetUploadWizard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, FileSpreadsheet, Trash2, Images, Database, Package, FlaskConical, Sparkles } from 'lucide-react';
import { formatStylePreset } from '@/lib/style-presets';

export default function ProjectWorkspace({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const qc = useQueryClient();
  const { data: project } = useQuery({ queryKey: ['project', id], queryFn: () => getProject(id) });
  const { data: datasets, isLoading: dsLoading } = useQuery({ queryKey: ['datasets', id], queryFn: () => listDatasets(id) });
  const { data: figures } = useQuery({ queryKey: ['figures', id], queryFn: () => listFigures(id) });
  const [uploadDesc, setUploadDesc] = useState('');

  const delDs = useMutation({ mutationFn: deleteDataset, onSuccess: () => { toast.success('Dataset deleted'); qc.invalidateQueries({ queryKey: ['datasets', id] }); } });
  const delFig = useMutation({ mutationFn: deleteFigure, onSuccess: () => { toast.success('Figure deleted'); qc.invalidateQueries({ queryKey: ['figures', id] }); } });

  const [descDraft, setDescDraft] = useState<string | null>(null);
  const desc = descDraft ?? project?.description ?? '';
  const saveDesc = useMutation({
    mutationFn: () => updateProject(id, { description: desc }),
    onSuccess: () => { toast.success('Research description saved'); setDescDraft(null); qc.invalidateQueries({ queryKey: ['project', id] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Save failed'),
  });
  const enhanceDesc = useMutation({
    mutationFn: () => enhancePrompt(desc, 'project'),
    onSuccess: (r) => { setDescDraft(r.enhanced); toast.success('Enhanced'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Enhance failed'),
  });
  const enhanceUpload = useMutation({
    mutationFn: () => enhancePrompt(uploadDesc, 'dataset_description', desc),
    onSuccess: (r) => { setUploadDesc(r.enhanced); toast.success('Enhanced'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Enhance failed'),
  });

  return (
    <div className="min-h-screen bg-muted/20">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-4 py-8">
        <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
          <Link href="/projects" className="hover:underline">Projects</Link> / {project?.name ?? '…'}
        </div>
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold">{project?.name ?? 'Project'}</h1>
          <Button variant="outline" size="sm" disabled={!figures?.length}
            onClick={() => downloadProjectPack(id, project?.name ?? 'project').catch(() => toast.error('Export failed'))}>
            <Package className="mr-2 h-4 w-4" /> Download figure pack
          </Button>
        </div>

        <Card className="mb-6">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><FlaskConical className="h-4 w-4 text-primary" /> Research description</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <Textarea value={desc} onChange={(e) => setDescDraft(e.target.value)} rows={3}
              placeholder="Describe the study (organism, design, treatments, hypothesis…). This context is given to the AI to improve chart recommendations, reviews and figure legends." />
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => enhanceDesc.mutate()} disabled={enhanceDesc.isPending}>
                {enhanceDesc.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />} Enhance
              </Button>
              <Button size="sm" variant="secondary" onClick={() => saveDesc.mutate()} disabled={saveDesc.isPending}>
                {saveDesc.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save description'}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Tabs defaultValue="datasets">
          <TabsList>
            <TabsTrigger value="datasets">Datasets ({datasets?.length ?? 0})</TabsTrigger>
            <TabsTrigger value="figures">Figures ({figures?.length ?? 0})</TabsTrigger>
          </TabsList>

          <TabsContent value="datasets" className="space-y-6">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Dataset description (optional). Add it before upload so AI recommendations, reviews, and legends can use the context.</Label>
              <Textarea value={uploadDesc} onChange={(e) => setUploadDesc(e.target.value)} rows={2}
                placeholder="Example: target gene expression and viability measured after drug A/B/C treatment in tumor cell lines" />
              <Button size="sm" variant="outline" onClick={() => enhanceUpload.mutate()} disabled={enhanceUpload.isPending}>
                {enhanceUpload.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />} Enhance with AI
              </Button>
            </div>
            <DatasetUploadWizard
              projectId={id}
              description={uploadDesc}
              title="Upload data to this project"
              helper="CSV, TSV, TXT, XLSX. Preview the table before it is saved."
              onUploaded={async (dataset) => {
                setUploadDesc('');
                await qc.invalidateQueries({ queryKey: ['datasets', id] });
                await qc.invalidateQueries({ queryKey: ['project', id] });
                router.push(`/datasets/${dataset.id}?setup=1`);
              }}
            />

            {dsLoading ? <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
              : !datasets?.length ? <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground"><Database className="mx-auto mb-2 h-7 w-7" /> No datasets yet.</div>
              : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {datasets.map((d) => (
                    <Card key={d.id} className="transition hover:shadow-md">
                      <CardHeader className="pb-2">
                        <div className="flex items-start justify-between">
                          <CardTitle className="flex items-center gap-2 text-base"><FileSpreadsheet className="h-4 w-4 text-primary" /> {d.name}</CardTitle>
                          <Button variant="ghost" size="sm" onClick={() => { if (confirm(`Delete ${d.name}?`)) delDs.mutate(d.id); }}><Trash2 className="h-4 w-4 text-muted-foreground" /></Button>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <div className="mb-3 flex gap-2">
                          <Badge variant="secondary">{d.n_rows} rows</Badge>
                          <Badge variant="secondary">{d.n_cols} cols</Badge>
                        </div>
                        <Link href={`/datasets/${d.id}`}><Button size="sm" className="w-full">Open &amp; visualize</Button></Link>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
          </TabsContent>

          <TabsContent value="figures">
            {!figures?.length ? <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground"><Images className="mx-auto mb-2 h-7 w-7" /> No figures yet. Open a dataset to build one.</div>
              : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {figures.map((f) => (
                    <Card key={f.id} className="group overflow-hidden transition hover:shadow-md">
                      <Link href={`/figures/${f.id}`}>
                        {f.thumb_url ? <img src={f.thumb_url} alt={f.name} loading="lazy" decoding="async" className="aspect-[4/3] w-full bg-white object-contain" />
                          : <div className="flex aspect-[4/3] items-center justify-center bg-muted text-muted-foreground"><Images className="h-7 w-7" /></div>}
                      </Link>
                      <CardContent className="p-3">
                        <div className="flex items-start justify-between gap-2">
                          <Link href={`/figures/${f.id}`} className="min-w-0"><p className="truncate text-sm font-medium">{f.name}</p><p className="text-xs text-muted-foreground">{f.plot_type} · {formatStylePreset(f.style_preset)}</p></Link>
                          <Button variant="ghost" size="sm" onClick={() => { if (confirm(`Delete ${f.name}?`)) delFig.mutate(f.id); }}><Trash2 className="h-4 w-4 text-muted-foreground" /></Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
