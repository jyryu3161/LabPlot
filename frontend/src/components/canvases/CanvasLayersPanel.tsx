'use client';

import { useMemo } from 'react';
import type { CanvasAnnotation, CanvasPanel } from '@/lib/types';
import { ANNOTATION_TYPE_LABEL } from './annotations';

type CanvasLayer = {
  id: string;
  kind: 'annotation' | 'panel';
  title: string;
  detail: string;
};

function frontFirst(aId: string, aZ: number, bId: string, bZ: number): number {
  if (aZ !== bZ) return bZ - aZ;
  // Same tie-break as paint order, reversed: the codepoint-later id is
  // painted later and therefore appears closer to the front.
  return aId > bId ? -1 : aId < bId ? 1 : 0;
}

function shortenedText(value: string | undefined): string {
  const clean = (value ?? '').trim();
  if (!clean) return 'Text annotation';
  return `Text: “${clean.length > 34 ? `${clean.slice(0, 33)}…` : clean}”`;
}

function panelTitle(panel: CanvasPanel): string {
  const label = panel.label?.trim();
  const type = panel.image_key ? 'Image' : 'Figure panel';
  return label ? `${type} ${label}` : `Unlabeled ${type.toLowerCase()}`;
}

function annotationTitle(annotation: CanvasAnnotation): string {
  if (annotation.type === 'text') return shortenedText(annotation.text);
  return `${ANNOTATION_TYPE_LABEL[annotation.type]} annotation`;
}

/**
 * DOM-based object picker for objects that are difficult or impossible to hit
 * directly on the Konva stage because another object covers them. The order
 * mirrors canvas paint order: annotations are always above panels, and higher
 * z values (then later ids) are painted last within each group.
 */
export function CanvasLayersPanel({
  panels,
  annotations,
  selectedIds,
  onSelect,
}: {
  panels: CanvasPanel[];
  annotations: CanvasAnnotation[];
  selectedIds: string[];
  onSelect: (id: string, additive: boolean) => void;
}) {
  const layers = useMemo<CanvasLayer[]>(() => [
    ...annotations
      .slice()
      .sort((a, b) => frontFirst(a.id, a.z, b.id, b.z))
      .map((annotation) => ({
        id: annotation.id,
        kind: 'annotation' as const,
        title: annotationTitle(annotation),
        detail: `Annotation · ${ANNOTATION_TYPE_LABEL[annotation.type]} · z ${annotation.z}`,
      })),
    ...panels
      .slice()
      .sort((a, b) => frontFirst(a.id, a.z_order, b.id, b.z_order))
      .map((panel) => ({
        id: panel.id,
        kind: 'panel' as const,
        title: panelTitle(panel),
        detail: `Panel · ${panel.image_key ? 'Image' : 'Figure'} · z ${panel.z_order}`,
      })),
  ], [annotations, panels]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  return (
    <aside
      className="flex w-56 shrink-0 flex-col border-r bg-background"
      aria-labelledby="canvas-layers-heading"
    >
      <div className="border-b px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 id="canvas-layers-heading" className="text-sm font-semibold">Layers</h2>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
            {layers.length}
          </span>
        </div>
        <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
          Front to back. Select covered objects here; Shift, Ctrl, or Cmd adds to the selection.
        </p>
      </div>

      {layers.length === 0 ? (
        <p className="px-3 py-4 text-xs text-muted-foreground">No objects on this canvas yet.</p>
      ) : (
        <ol
          className="min-h-0 flex-1 overflow-y-auto p-2"
          aria-label="Canvas layers, front to back"
        >
          {layers.map((layer, index) => {
            const isSelected = selected.has(layer.id);
            const isCurrent = selectedIds.length === 1 && isSelected;
            return (
              <li key={`${layer.kind}-${layer.id}`} className="mb-1 last:mb-0">
                <button
                  type="button"
                  className={`w-full rounded-md border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${
                    isSelected
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-transparent hover:border-border hover:bg-muted/60'
                  }`}
                  aria-label={`Layer ${index + 1} of ${layers.length}: ${layer.title}. ${layer.detail}.`}
                  aria-pressed={isSelected}
                  aria-current={isCurrent ? 'true' : undefined}
                  onClick={(event) => onSelect(
                    layer.id,
                    event.shiftKey || event.ctrlKey || event.metaKey,
                  )}
                >
                  <span className="flex min-w-0 items-start gap-2">
                    <span
                      className={`mt-0.5 w-5 shrink-0 text-center text-[10px] tabular-nums ${
                        isSelected ? 'text-foreground' : 'text-muted-foreground'
                      }`}
                      aria-hidden="true"
                    >
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">{layer.title}</span>
                        {isSelected && (
                          <span className="shrink-0 rounded bg-primary px-1.5 py-0.5 text-[9px] font-medium text-primary-foreground">
                            Selected
                          </span>
                        )}
                      </span>
                      <span className={`mt-0.5 block truncate text-[10px] ${
                        isSelected ? 'text-foreground' : 'text-muted-foreground'
                      }`}>
                        {layer.detail}
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {annotations.length > 0 && panels.length > 0 && (
        <p className="border-t px-3 py-2 text-[10px] leading-4 text-muted-foreground">
          Annotations are always above figure and image panels.
        </p>
      )}
    </aside>
  );
}
