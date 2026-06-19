'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { addProjectCollaborator, getProject, updateProject, listDatasets, listFigures, deleteDataset, deleteFigure, downloadProjectPack, enhancePrompt, removeProjectCollaborator, updateFigure, reorderFigures } from '@/lib/api';
import type { FigureListItem, ProjectInviteDraft } from '@/lib/types';
import { AppHeader } from '@/components/layout/AppHeader';
import { DatasetUploadWizard } from '@/components/datasets/DatasetUploadWizard';
import { ProjectCollaboratorPicker } from '@/components/projects/ProjectCollaboratorPicker';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Check, GripVertical, Loader2, FileSpreadsheet, Trash2, Images, Database, Package, FlaskConical, Pencil, Sparkles, Users, X } from 'lucide-react';
import { formatStylePreset } from '@/lib/style-presets';

function moveFigure(items: FigureListItem[], activeId: string, overId: string): FigureListItem[] {
  const from = items.findIndex((item) => item.id === activeId);
  const to = items.findIndex((item) => item.id === overId);
  if (from < 0 || to < 0 || from === to) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export default function ProjectWorkspace({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const qc = useQueryClient();
  const { data: project } = useQuery({ queryKey: ['project', id], queryFn: () => getProject(id) });
  const { data: datasets, isLoading: dsLoading } = useQuery({ queryKey: ['datasets', id], queryFn: () => listDatasets(id) });
  const { data: figures } = useQuery({ queryKey: ['figures', id], queryFn: () => listFigures(id) });
  const [uploadDesc, setUploadDesc] = useState('');
  const [newCollaborators, setNewCollaborators] = useState<ProjectInviteDraft[]>([]);
  const [editingFigureId, setEditingFigureId] = useState<string | null>(null);
  const [editingFigureName, setEditingFigureName] = useState('');
  const [draggingFigureId, setDraggingFigureId] = useState<string | null>(null);
  const canEditProject = project?.role === 'owner' || project?.role === 'editor';

  const delDs = useMutation({ mutationFn: deleteDataset, onSuccess: () => { toast.success('Dataset deleted'); qc.invalidateQueries({ queryKey: ['datasets', id] }); } });
  const delFig = useMutation({ mutationFn: deleteFigure, onSuccess: () => { toast.success('Figure deleted'); qc.invalidateQueries({ queryKey: ['figures', id] }); } });
  const renameFig = useMutation({
    mutationFn: ({ figureId, name }: { figureId: string; name: string }) => updateFigure(figureId, { name }),
    onSuccess: () => {
      toast.success('Figure renamed');
      setEditingFigureId(null);
      setEditingFigureName('');
      qc.invalidateQueries({ queryKey: ['figures', id] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Rename failed'),
  });
  const reorderFig = useMutation({
    mutationFn: (figureIds: string[]) => reorderFigures(figureIds),
    onSuccess: (updated) => {
      toast.success('Figure order saved');
      qc.setQueryData(['figures', id], updated);
      qc.invalidateQueries({ queryKey: ['figures', id] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Reorder failed'),
  });
  const addCollaborators = useMutation({
    mutationFn: async () => {
      for (const user of newCollaborators) await addProjectCollaborator(id, user.id, user.role);
    },
    onSuccess: () => {
      toast.success('Collaborators updated');
      setNewCollaborators([]);
      qc.invalidateQueries({ queryKey: ['project', id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Update failed'),
  });
  const removeCollaborator = useMutation({
    mutationFn: (collaboratorId: string) => removeProjectCollaborator(id, collaboratorId),
    onSuccess: () => {
      toast.success('Collaborator removed');
      qc.invalidateQueries({ queryKey: ['project', id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Remove failed'),
  });

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

  function beginFigureRename(figure: FigureListItem) {
    setEditingFigureId(figure.id);
    setEditingFigureName(figure.name);
  }

  function submitFigureRename(figure: FigureListItem) {
    const name = editingFigureName.trim();
    if (!name || name === figure.name) {
      setEditingFigureId(null);
      setEditingFigureName('');
      return;
    }
    renameFig.mutate({ figureId: figure.id, name });
  }

  function dropFigure(overId: string) {
    if (!draggingFigureId || draggingFigureId === overId || !figures?.length) return;
    const next = moveFigure(figures, draggingFigureId, overId);
    setDraggingFigureId(null);
    if (next === figures) return;
    qc.setQueryData(['figures', id], next);
    reorderFig.mutate(next.map((figure) => figure.id));
  }

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
            <Textarea value={desc} onChange={(e) => setDescDraft(e.target.value)} rows={3} readOnly={!canEditProject}
              placeholder="Describe the study (organism, design, treatments, hypothesis…). This context is given to the AI to improve chart recommendations, reviews and figure legends." />
            {canEditProject ? (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => enhanceDesc.mutate()} disabled={enhanceDesc.isPending}>
                  {enhanceDesc.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />} Enhance
                </Button>
                <Button size="sm" variant="secondary" onClick={() => saveDesc.mutate()} disabled={saveDesc.isPending}>
                  {saveDesc.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save description'}
                </Button>
              </div>
            ) : <p className="text-xs text-muted-foreground">Viewer access is read-only.</p>}
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4 text-primary" /> Collaborators
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {project?.role === 'owner' ? (
              <>
                <ProjectCollaboratorPicker
                  selected={newCollaborators}
                  onChange={setNewCollaborators}
                  helper="Invite approved users. They can access the project only after accepting the invitation."
                />
                <Button size="sm" onClick={() => addCollaborators.mutate()} disabled={!newCollaborators.length || addCollaborators.isPending}>
                  {addCollaborators.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                  Send invitation{newCollaborators.length > 1 ? 's' : ''}
                </Button>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">This project is shared with you as an {project?.role ?? 'editor'}.</p>
            )}
            <div className="space-y-2">
              {(project?.collaborators ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No collaborators yet.</p>
              ) : (project?.collaborators ?? []).map((member) => (
                <div key={member.id} className="flex items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{member.display_name}</p>
                    <p className="truncate text-xs text-muted-foreground">{member.email} · {member.role} · {member.status}</p>
                  </div>
                  {project?.role === 'owner' && (
                    <Button variant="ghost" size="icon-sm" onClick={() => removeCollaborator.mutate(member.id)} aria-label={`Remove ${member.display_name}`}>
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Tabs defaultValue="datasets">
          <TabsList>
            <TabsTrigger value="datasets">Datasets ({datasets?.length ?? 0})</TabsTrigger>
            <TabsTrigger value="figures">Figures ({figures?.length ?? 0})</TabsTrigger>
          </TabsList>

          <TabsContent value="datasets" className="space-y-6">
            {canEditProject ? (
              <DatasetUploadWizard
                projectId={id}
                description={uploadDesc}
                onDescriptionChange={setUploadDesc}
                descriptionAction={(
                  <Button size="sm" variant="outline" onClick={() => enhanceUpload.mutate()} disabled={enhanceUpload.isPending}>
                    {enhanceUpload.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />} Enhance with AI
                  </Button>
                )}
                title="Upload data to this project"
                helper="CSV, TSV, TXT, XLSX. Preview the table before it is saved."
                onUploaded={async (dataset) => {
                  setUploadDesc('');
                  await qc.invalidateQueries({ queryKey: ['datasets', id] });
                  await qc.invalidateQueries({ queryKey: ['project', id] });
                  router.push(`/datasets/${dataset.id}?setup=1`);
                }}
              />
            ) : (
              <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">Viewer access can inspect datasets and figures but cannot upload or edit project content.</div>
            )}

            {dsLoading ? <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
              : !datasets?.length ? <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground"><Database className="mx-auto mb-2 h-7 w-7" /> No datasets yet.</div>
              : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {datasets.map((d) => (
                    <Card key={d.id} className="transition hover:shadow-md">
                      <CardHeader className="pb-2">
                        <div className="flex items-start justify-between">
                          <CardTitle className="flex items-center gap-2 text-base"><FileSpreadsheet className="h-4 w-4 text-primary" /> {d.name}</CardTitle>
                          {canEditProject && <Button variant="ghost" size="sm" onClick={() => { if (confirm(`Delete ${d.name}?`)) delDs.mutate(d.id); }}><Trash2 className="h-4 w-4 text-muted-foreground" /></Button>}
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
                    <Card
                      key={f.id}
                      draggable={canEditProject}
                      onDragStart={() => setDraggingFigureId(f.id)}
                      onDragEnd={() => setDraggingFigureId(null)}
                      onDragOver={(event) => { if (canEditProject) event.preventDefault(); }}
                      onDrop={() => dropFigure(f.id)}
                      className={`group overflow-hidden transition hover:shadow-md ${draggingFigureId === f.id ? 'opacity-50' : ''}`}
                    >
                      <Link href={`/figures/${f.id}`}>
                        {f.thumb_url ? <img src={f.thumb_url} alt={f.name} loading="lazy" decoding="async" className="aspect-[4/3] w-full bg-white object-contain" />
                          : <div className="flex aspect-[4/3] items-center justify-center bg-muted text-muted-foreground"><Images className="h-7 w-7" /></div>}
                      </Link>
                      <CardContent className="p-3">
                        <div className="flex items-start justify-between gap-1">
                          {canEditProject && <GripVertical className="mt-1 h-4 w-4 shrink-0 cursor-grab text-muted-foreground" />}
                          <div className="min-w-0 flex-1">
                            {editingFigureId === f.id ? (
                              <div className="space-y-1">
                                <Input
                                  className="h-8 text-sm"
                                  value={editingFigureName}
                                  maxLength={255}
                                  autoFocus
                                  onChange={(event) => setEditingFigureName(event.target.value)}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter') submitFigureRename(f);
                                    if (event.key === 'Escape') {
                                      setEditingFigureId(null);
                                      setEditingFigureName('');
                                    }
                                  }}
                                />
                                <div className="flex gap-1">
                                  <Button type="button" size="icon-xs" variant="secondary" disabled={renameFig.isPending} onClick={() => submitFigureRename(f)}>
                                    {renameFig.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                                  </Button>
                                  <Button type="button" size="icon-xs" variant="ghost" onClick={() => { setEditingFigureId(null); setEditingFigureName(''); }}>
                                    <X className="h-3 w-3" />
                                  </Button>
                                </div>
                              </div>
                            ) : (
                              <Link href={`/figures/${f.id}`} className="block min-w-0">
                                <p className="truncate text-sm font-medium">{f.name}</p>
                                <p className="text-xs text-muted-foreground">{f.plot_type} · {formatStylePreset(f.style_preset)}</p>
                              </Link>
                            )}
                          </div>
                          {canEditProject && (
                            <>
                              <Button type="button" variant="ghost" size="sm" onClick={() => beginFigureRename(f)} aria-label={`Rename ${f.name}`}>
                                <Pencil className="h-4 w-4 text-muted-foreground" />
                              </Button>
                              <Button type="button" variant="ghost" size="sm" onClick={() => { if (confirm(`Delete ${f.name}?`)) delFig.mutate(f.id); }}>
                                <Trash2 className="h-4 w-4 text-muted-foreground" />
                              </Button>
                            </>
                          )}
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
