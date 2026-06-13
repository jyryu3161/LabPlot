'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useDropzone } from 'react-dropzone';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { listDatasets, uploadDataset, deleteDataset } from '@/lib/api';
import { AppHeader } from '@/components/layout/AppHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { UploadCloud, Database, Trash2, Loader2, FileSpreadsheet } from 'lucide-react';

export default function DatasetsPage() {
  const qc = useQueryClient();
  const { data: datasets, isLoading } = useQuery({ queryKey: ['datasets'], queryFn: () => listDatasets() });
  const [uploading, setUploading] = useState(false);

  const onDrop = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    try {
      for (const f of files) await uploadDataset(f);
      toast.success(`${files.length} dataset(s) uploaded`);
      qc.invalidateQueries({ queryKey: ['datasets'] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally { setUploading(false); }
  }, [qc]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'text/csv': ['.csv'], 'text/tab-separated-values': ['.tsv'], 'text/plain': ['.txt'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] },
  });

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

        <div {...getRootProps()}
          className={`mb-8 flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-10 transition ${isDragActive ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-primary/50'}`}>
          <input {...getInputProps()} />
          {uploading ? <Loader2 className="h-8 w-8 animate-spin text-primary" /> : <UploadCloud className="h-8 w-8 text-muted-foreground" />}
          <p className="mt-3 text-sm font-medium">{isDragActive ? 'Drop files here' : 'Drag & drop or click to upload'}</p>
          <p className="text-xs text-muted-foreground">CSV, TSV, TXT, XLSX</p>
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
