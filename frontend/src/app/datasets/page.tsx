'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { listDatasets, deleteDataset } from '@/lib/api';
import { AppHeader } from '@/components/layout/AppHeader';
import { DatasetUploadWizard } from '@/components/datasets/DatasetUploadWizard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Database, Trash2, Loader2, FileSpreadsheet } from 'lucide-react';

export default function DatasetsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { data: datasets, isLoading } = useQuery({ queryKey: ['datasets'], queryFn: () => listDatasets() });

  const del = useMutation({
    mutationFn: deleteDataset,
    onSuccess: () => { toast.success('Dataset deleted'); qc.invalidateQueries({ queryKey: ['datasets'] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Delete failed'),
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
        ) : !datasets?.length ? (
          <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
            <Database className="mx-auto mb-2 h-8 w-8" /> No datasets yet. Upload one above.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {datasets.map((d) => (
              <Card key={d.id} className="transition hover:shadow-md">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <FileSpreadsheet className="h-4 w-4 text-primary" /> {d.name}
                    </CardTitle>
                    <Button variant="ghost" size="sm" onClick={() => { if (confirm(`Delete ${d.name}?`)) del.mutate(d.id); }}>
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
      </main>
    </div>
  );
}
