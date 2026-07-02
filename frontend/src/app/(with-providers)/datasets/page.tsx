'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { listDatasets, deleteDataset, uploadDataset } from '@/lib/api';
import { AppHeader } from '@/components/layout/AppHeader';
import { DatasetUploadWizard } from '@/components/datasets/DatasetUploadWizard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertTriangle, Database, Trash2, Loader2, FileSpreadsheet, RotateCcw, Search, SearchX, FlaskConical, Sparkles } from 'lucide-react';

type SampleSpec = { file: string; name: string; description: string };
const SAMPLES: Record<'dose' | 'gene', SampleSpec> = {
  dose: {
    file: 'dose_response.csv',
    name: 'Sample: dose–response',
    description: 'Example cell-viability dose–response data (2 compounds × 5 doses × 4 replicates). Try a scatter or line plot of dose vs viability by compound.',
  },
  gene: {
    file: 'gene_expression.csv',
    name: 'Sample: gene expression',
    description: 'Example gene-expression data (5 genes × 3 conditions). Try a grouped bar or box plot of expression by condition.',
  },
};

type SortKey = 'saved' | 'name' | 'newest' | 'oldest';
const SORT_LABELS: Record<SortKey, string> = {
  saved: 'Saved order',
  name: 'Name A–Z',
  newest: 'Newest',
  oldest: 'Oldest',
};

export default function DatasetsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('saved');
  const { data: datasets, isLoading, isError, error, refetch } = useQuery({ queryKey: ['datasets'], queryFn: () => listDatasets() });

  const visibleDatasets = useMemo(() => {
    if (!datasets) return [];
    const q = search.trim().toLowerCase();
    const filtered = q
      ? datasets.filter((d) =>
          d.name.toLowerCase().includes(q) ||
          (d.description ?? '').toLowerCase().includes(q) ||
          d.original_filename.toLowerCase().includes(q))
      : datasets;
    if (sort === 'saved') return filtered;
    const sorted = [...filtered];
    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'newest') sorted.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    else if (sort === 'oldest') sorted.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    return sorted;
  }, [datasets, search, sort]);

  const del = useMutation({
    mutationFn: deleteDataset,
    onSuccess: () => { toast.success('Dataset deleted'); qc.invalidateQueries({ queryKey: ['datasets'] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Delete failed'),
  });

  const loadSample = useMutation({
    mutationFn: async (key: 'dose' | 'gene') => {
      const spec = SAMPLES[key];
      const res = await fetch(`/samples/${spec.file}`);
      if (!res.ok) throw new Error('Could not load the sample file.');
      const blob = await res.blob();
      const file = new File([blob], spec.file, { type: 'text/csv' });
      return uploadDataset(file, undefined, spec.description, spec.name);
    },
    onSuccess: async (dataset) => {
      toast.success('Sample dataset added');
      await qc.invalidateQueries({ queryKey: ['datasets'] });
      router.push(`/datasets/${dataset.id}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not add sample dataset'),
  });

  return (
    <div className="min-h-screen bg-muted/20">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-4 py-8">
        <h1 className="mb-1 text-2xl font-bold">Datasets</h1>
        <p className="mb-6 text-sm text-muted-foreground">Upload data, then let AI recommend the right figure.</p>

        <div className="mb-8">
          <DatasetUploadWizard
            title="Drag & drop or click to upload"
            helper="CSV, TSV, TXT, XLSX. Preview and column selection happen before upload."
            onUploaded={async (dataset) => {
              await qc.invalidateQueries({ queryKey: ['datasets'] });
              router.push(`/datasets/${dataset.id}?setup=1`);
            }}
          />
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : isError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-12 text-center">
            <AlertTriangle className="mx-auto mb-2 h-8 w-8 text-destructive" />
            <p className="mb-4 text-sm text-muted-foreground">{error instanceof Error ? error.message : 'Could not load datasets.'}</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}><RotateCcw className="mr-1 h-4 w-4" /> Retry</Button>
          </div>
        ) : !datasets?.length ? (
          <div className="space-y-6">
            <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
              <Database className="mx-auto mb-2 h-8 w-8" /> No datasets yet. Upload one above.
            </div>
            <Card className="border-primary/30 bg-primary/5">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Sparkles className="h-4 w-4 text-primary" /> New here? Start with sample data
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Load a small example dataset to explore the AI figure workflow without uploading your own file first.
                </p>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <Button onClick={() => loadSample.mutate('dose')} disabled={loadSample.isPending}>
                    {loadSample.isPending && loadSample.variables === 'dose'
                      ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      : <FlaskConical className="mr-2 h-4 w-4" />}
                    Start with sample data
                  </Button>
                  <button
                    type="button"
                    onClick={() => loadSample.mutate('gene')}
                    disabled={loadSample.isPending}
                    className="inline-flex items-center text-sm text-primary underline-offset-4 hover:underline disabled:opacity-60"
                  >
                    {loadSample.isPending && loadSample.variables === 'gene'
                      ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      : null}
                    Or try the gene-expression sample
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">Dose–response: cell viability across compounds and doses.</p>
              </CardContent>
            </Card>
          </div>
        ) : (
          <>
            <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative w-full sm:max-w-xs">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Label htmlFor="datasets-search" className="sr-only">Search datasets</Label>
                <Input id="datasets-search" type="search" placeholder="Search datasets…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <Select value={sort} onValueChange={(value) => setSort(value as SortKey)}>
                <SelectTrigger id="datasets-sort" size="sm" aria-label="Sort datasets" className="w-[160px]">
                  <SelectValue>{(value) => SORT_LABELS[value as SortKey] ?? SORT_LABELS.saved}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="saved">Saved order</SelectItem>
                  <SelectItem value="name">Name A–Z</SelectItem>
                  <SelectItem value="newest">Newest</SelectItem>
                  <SelectItem value="oldest">Oldest</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {visibleDatasets.length === 0 ? (
              <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
                <SearchX className="mx-auto mb-2 h-8 w-8" /> No datasets match your search.
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {visibleDatasets.map((d) => (
              <Card key={d.id} className="transition hover:shadow-md">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <FileSpreadsheet className="h-4 w-4 text-primary" /> {d.name}
                    </CardTitle>
                    <Button variant="ghost" size="sm" aria-label={`Delete ${d.name}`} onClick={() => { if (confirm(`Delete ${d.name}?`)) del.mutate(d.id); }}>
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="mb-3 flex gap-2">
                    <Badge variant="secondary">{d.n_rows} rows</Badge>
                    <Badge variant="secondary">{d.n_cols} cols</Badge>
                    <Badge variant="outline">{d.format.toUpperCase()}</Badge>
                  </div>
                  <Link href={`/datasets/${d.id}`}>
                    <Button size="sm" className="w-full">Open & visualize</Button>
                  </Link>
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
