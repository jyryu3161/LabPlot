'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { use } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { AppHeader } from '@/components/layout/AppHeader';
import { generateCanvasLegend, getCanvas, getFigure, getPalettes, getProject, listFigures, saveSvgEditVersion, suggestCanvasStyle, updateCanvas } from '@/lib/api';
import type { CanvasItem, CanvasState } from '@/lib/types';

const FigureCanvasEditor = dynamic(
  () => import('@/components/canvases/FigureCanvasEditor').then((mod) => mod.FigureCanvasEditor),
  { ssr: false, loading: () => <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" /></div> },
);

export default function CanvasDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const { data: canvas, isLoading } = useQuery({ queryKey: ['canvas', id], queryFn: () => getCanvas(id) });
  const { data: project } = useQuery({
    queryKey: ['project', canvas?.project_id],
    queryFn: () => getProject(canvas!.project_id!),
    enabled: Boolean(canvas?.project_id),
  });
  const { data: figures } = useQuery({
    queryKey: ['figures', canvas?.project_id ?? 'all'],
    queryFn: () => listFigures(canvas?.project_id),
    enabled: Boolean(canvas),
  });
  const { data: palettesData } = useQuery({ queryKey: ['palettes'], queryFn: getPalettes });

  const saveCanvas = useMutation({
    mutationFn: ({ state, name }: { state: CanvasState; name: string }) => updateCanvas(id, {
      name,
      preset: state.preset,
      width_px: state.widthPx,
      height_px: state.heightPx,
      state,
    }),
    onSuccess: (updated) => {
      qc.setQueryData(['canvas', id], updated);
      qc.invalidateQueries({ queryKey: ['canvases'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Canvas save failed'),
  });

  async function saveFigureVersion(item: CanvasItem, svg: string) {
    const version = await saveSvgEditVersion(item.figureId, item.versionId, {
      svg,
      change_note: `Canvas edit from ${canvas?.name ?? 'canvas'} panel ${item.label}`,
    });
    qc.invalidateQueries({ queryKey: ['figure', item.figureId] });
    qc.invalidateQueries({ queryKey: ['figures'] });
    return version;
  }

  if (isLoading || !canvas) {
    return (
      <div className="min-h-screen bg-muted/20">
        <AppHeader />
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin" /></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted/20">
      <AppHeader />
      <main className="mx-auto max-w-[1600px] px-4 py-6">
        <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Link href="/canvases" className="hover:underline">Canvases</Link>
          {project && <> / <span>{project.name}</span></>}
          / {canvas.name}
        </div>
        <FigureCanvasEditor
          canvas={canvas}
          figures={figures ?? []}
          palettes={palettesData?.palettes ?? []}
          project={project}
          onLoadFigure={getFigure}
          onSaveCanvas={async (state, name) => { await saveCanvas.mutateAsync({ state, name }); }}
          onSaveFigureVersion={saveFigureVersion}
          onSuggestStyle={(selectedItemId) => suggestCanvasStyle(id, { selected_item_id: selectedItemId })}
          onGenerateLegend={() => generateCanvasLegend(id)}
        />
      </main>
    </div>
  );
}
