'use client';

import Link from 'next/link';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { listFigures, deleteFigure } from '@/lib/api';
import { AppHeader } from '@/components/layout/AppHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Images, Trash2 } from 'lucide-react';

export default function FiguresPage() {
  const qc = useQueryClient();
  const { data: figures, isLoading } = useQuery({ queryKey: ['figures'], queryFn: () => listFigures() });
  const del = useMutation({
    mutationFn: deleteFigure,
    onSuccess: () => { toast.success('Figure deleted'); qc.invalidateQueries({ queryKey: ['figures'] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Delete failed'),
  });

  return (
    <div className="min-h-screen bg-muted/20">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold">Figures</h1>
        {isLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : !figures?.length ? (
          <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
            <Images className="mx-auto mb-2 h-8 w-8" /> No figures yet. Open a dataset to create one.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {figures.map((f) => (
              <Card key={f.id} className="group overflow-hidden transition hover:shadow-md">
                <Link href={`/figures/${f.id}`}>
                  {f.thumb_url
                    ? <img src={f.thumb_url} alt={f.name} className="aspect-[4/3] w-full bg-white object-contain" />
                    : <div className="flex aspect-[4/3] items-center justify-center bg-muted text-muted-foreground"><Images className="h-8 w-8" /></div>}
                </Link>
                <CardContent className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <Link href={`/figures/${f.id}`} className="min-w-0">
                      <p className="truncate text-sm font-medium">{f.name}</p>
                      <p className="text-xs text-muted-foreground">{f.plot_type}</p>
                    </Link>
                    <Button variant="ghost" size="sm" onClick={() => { if (confirm(`Delete ${f.name}?`)) del.mutate(f.id); }}>
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                  <Badge variant="outline" className="mt-2">{f.style_preset}</Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
