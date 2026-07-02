'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { acceptProjectInvitation, createProject, deleteProject, listProjectInvitations, listProjects, rejectProjectInvitation } from '@/lib/api';
import type { ProjectInviteDraft } from '@/lib/types';
import { AppHeader } from '@/components/layout/AppHeader';
import { ProjectCollaboratorPicker } from '@/components/projects/ProjectCollaboratorPicker';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertTriangle, Check, Loader2, FolderKanban, Plus, RotateCcw, Search, SearchX, Trash2, Database, Images, X } from 'lucide-react';

type SortKey = 'saved' | 'name' | 'newest' | 'oldest';
const SORT_LABELS: Record<SortKey, string> = {
  saved: 'Default',
  name: 'Name A–Z',
  newest: 'Newest',
  oldest: 'Oldest',
};

export default function ProjectsPage() {
  const qc = useQueryClient();
  const { data: projects, isLoading, isError, error, refetch } = useQuery({ queryKey: ['projects'], queryFn: listProjects });
  const { data: invitations } = useQuery({ queryKey: ['project-invitations'], queryFn: listProjectInvitations });
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [open, setOpen] = useState(false);
  const [collaborators, setCollaborators] = useState<ProjectInviteDraft[]>([]);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('saved');

  const visibleProjects = useMemo(() => {
    if (!projects) return [];
    const q = search.trim().toLowerCase();
    const filtered = q
      ? projects.filter((p) =>
          p.name.toLowerCase().includes(q) ||
          (p.description ?? '').toLowerCase().includes(q))
      : projects;
    if (sort === 'saved') return filtered;
    const sorted = [...filtered];
    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'newest') sorted.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    else if (sort === 'oldest') sorted.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    return sorted;
  }, [projects, search, sort]);

  const create = useMutation({
    mutationFn: () => createProject({
      name,
      description: desc || undefined,
      collaborators: collaborators.map((user) => ({ user_id: user.id, role: user.role })),
    }),
    onSuccess: () => {
      toast.success('Project created');
      setName('');
      setDesc('');
      setCollaborators([]);
      setOpen(false);
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Create failed'),
  });
  const del = useMutation({
    mutationFn: deleteProject,
    onSuccess: () => { toast.success('Project deleted'); qc.invalidateQueries({ queryKey: ['projects'] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Delete failed'),
  });
  const accept = useMutation({
    mutationFn: acceptProjectInvitation,
    onSuccess: () => {
      toast.success('Invitation accepted');
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['project-invitations'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Accept failed'),
  });
  const reject = useMutation({
    mutationFn: rejectProjectInvitation,
    onSuccess: () => {
      toast.success('Invitation declined');
      qc.invalidateQueries({ queryKey: ['project-invitations'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Decline failed'),
  });

  return (
    <div className="min-h-screen bg-muted/20">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Projects</h1>
            <p className="text-sm text-muted-foreground">Organize datasets and figures per study or manuscript.</p>
          </div>
          <Button onClick={() => setOpen((o) => !o)}><Plus className="mr-1 h-4 w-4" /> New project</Button>
        </div>

        {open && (
          <Card className="mb-6">
            <CardContent className="space-y-4 pt-6">
              <div className="grid items-end gap-3 md:grid-cols-4">
                <div className="space-y-1"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tumor RNA-seq 2026" /></div>
                <div className="space-y-1 md:col-span-2"><Label>Description</Label><Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Optional" /></div>
                <Button onClick={() => create.mutate()} disabled={create.isPending || !name}>
                  {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create'}
                </Button>
              </div>
              <ProjectCollaboratorPicker selected={collaborators} onChange={setCollaborators} />
            </CardContent>
          </Card>
        )}

        {!!invitations?.length && (
          <Card className="mb-6 border-primary/25">
            <CardHeader className="pb-2"><CardTitle className="text-base">Project invitations</CardTitle></CardHeader>
            <CardContent className="grid gap-3">
              {invitations.map((invite) => (
                <div key={invite.id} className="flex flex-col gap-3 rounded-lg border bg-background p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-medium">{invite.project_name}</p>
                    <p className="text-xs text-muted-foreground">
                      Invited by {invite.owner_name} ({invite.owner_email}) as {invite.role}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => accept.mutate(invite.id)} disabled={accept.isPending}>
                      <Check className="mr-1 h-4 w-4" /> Accept
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => reject.mutate(invite.id)} disabled={reject.isPending}>
                      <X className="mr-1 h-4 w-4" /> Decline
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {isLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : isError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-12 text-center">
            <AlertTriangle className="mx-auto mb-2 h-8 w-8 text-destructive" />
            <p className="mb-4 text-sm text-muted-foreground">{error instanceof Error ? error.message : 'Could not load projects.'}</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}><RotateCcw className="mr-1 h-4 w-4" /> Retry</Button>
          </div>
        ) : !projects?.length ? (
          <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
            <FolderKanban className="mx-auto mb-2 h-8 w-8" /> No projects yet. Create one to get started.
          </div>
        ) : (
          <>
            <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative w-full sm:max-w-xs">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Label htmlFor="projects-search" className="sr-only">Search projects</Label>
                <Input id="projects-search" type="search" placeholder="Search projects…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <Select value={sort} onValueChange={(value) => setSort(value as SortKey)}>
                <SelectTrigger id="projects-sort" size="sm" aria-label="Sort projects" className="w-[160px]">
                  <SelectValue>{(value) => SORT_LABELS[value as SortKey] ?? SORT_LABELS.saved}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="saved">Default</SelectItem>
                  <SelectItem value="name">Name A–Z</SelectItem>
                  <SelectItem value="newest">Newest</SelectItem>
                  <SelectItem value="oldest">Oldest</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {visibleProjects.length === 0 ? (
              <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
                <SearchX className="mx-auto mb-2 h-8 w-8" /> No projects match your search.
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {visibleProjects.map((p) => (
              <Card key={p.id} className="h-full transition hover:shadow-md">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between">
                    <CardTitle className="flex min-w-0 items-center gap-2 text-base">
                      <FolderKanban className="h-4 w-4 shrink-0 text-primary" />
                      <span className="break-words">{p.name}</span>
                    </CardTitle>
                    {p.role === 'owner' && (
                      <Button variant="ghost" size="sm" aria-label={`Delete project ${p.name}`} onClick={() => { if (confirm(`Delete project "${p.name}" and all its datasets/figures?`)) del.mutate(p.id); }}>
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    )}
                  </div>
                  {p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}
                </CardHeader>
                <CardContent className="mt-auto">
                  <div className="mb-3 flex gap-2">
                    <Badge variant="secondary"><Database className="mr-1 h-3 w-3" />{p.dataset_count}</Badge>
                    <Badge variant="secondary"><Images className="mr-1 h-3 w-3" />{p.figure_count}</Badge>
                    {p.collaborator_count > 0 && <Badge variant="outline">{p.collaborator_count} collaborator{p.collaborator_count > 1 ? 's' : ''}</Badge>}
                    {p.role !== 'owner' && <Badge variant="default">Shared</Badge>}
                  </div>
                  <Link href={`/projects/${p.id}`}><Button size="sm" className="w-full">Open project</Button></Link>
                </CardContent>
              </Card>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
