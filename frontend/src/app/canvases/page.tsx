'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Layers3, Loader2, Plus, Trash2 } from 'lucide-react';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { createCanvas, deleteCanvas, listCanvases } from '@/lib/api';

export default function CanvasesPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { data: canvases, isLoading } = useQuery({ queryKey: ['canvases'], queryFn: () => listCanvases() });

  const create = useMutation({
    mutationFn: () => createCanvas({ name: 'Figure 1 canvas', preset: 'double_column', width_px: 720, height_px: 500 }),
    onSuccess: (canvas) => {
      toast.success('Canvas created');
      qc.invalidateQueries({ queryKey: ['canvases'] });
      router.push(`/canvases/${canvas.id}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Canvas create failed'),
  });

  const del = useMutation({
    mutationFn: deleteCanvas,
    onSuccess: () => {
      toast.success('Canvas deleted');
      qc.invalidateQueries({ queryKey: ['canvases'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Canvas delete failed'),
  });

  return (
    <div className="min-h-screen bg-muted/20">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-4 py-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold"><Layers3 className="h-6 w-6" /> Figure canvases</h1>
            <p className="mt-1 text-sm text-muted-foreground">Compose multi-panel manuscript figures from existing LabPlot figures.</p>
          </div>
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />} New canvas
          </Button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : !canvases?.length ? (
          <div className="rounded-lg border border-dashed bg-background p-12 text-center text-muted-foreground">
            <Layers3 className="mx-auto mb-2 h-8 w-8" />
            No canvases yet.
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {canvases.map((canvas) => (
              <Card key={canvas.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="min-w-0 truncate text-base">
                      <Link href={`/canvases/${canvas.id}`} className="hover:underline">{canvas.name}</Link>
                    </CardTitle>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => {
                        if (confirm(`Delete canvas "${canvas.name}"?`)) del.mutate(canvas.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="aspect-[7.2/5] rounded-md border bg-white p-3">
                    <div className="grid h-full grid-cols-2 gap-2">
                      {Array.from({ length: Math.max(1, Math.min(4, canvas.item_count || 1)) }).map((_, i) => (
                        <div key={i} className="rounded border bg-muted/30" />
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary">{canvas.item_count} panels</Badge>
                    <Badge variant="outline">{canvas.width_px} x {canvas.height_px}</Badge>
                    <Badge variant="outline">{canvas.preset.replaceAll('_', ' ')}</Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
