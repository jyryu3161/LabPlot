'use client';

import { use } from 'react';
import dynamic from 'next/dynamic';
import { AppHeader } from '@/components/layout/AppHeader';
import { Loader2 } from 'lucide-react';

// react-konva is client-only (it touches the DOM/canvas), so the whole editor is
// loaded with ssr:false — same pattern as FigureAnnotationOverlay.
const CanvasEditor = dynamic(
  () => import('@/components/canvases/CanvasEditor').then((m) => m.CanvasEditor),
  {
    ssr: false,
    loading: () => (
      <div className="flex flex-1 items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    ),
  },
);

export default function CanvasEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <div className="flex min-h-screen flex-col bg-muted/20">
      <AppHeader />
      <CanvasEditor canvasId={id} />
    </div>
  );
}
