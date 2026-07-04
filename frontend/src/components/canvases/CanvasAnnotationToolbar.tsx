'use client';

import { MousePointer2, Type, ArrowUpRight, Minus, Square, Circle } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ToolId = 'select' | 'text' | 'arrow' | 'line' | 'rect' | 'ellipse';

/** Single-key shortcut per tool (also the source of truth for CanvasEditor's
 * keydown handler -- keep these two in sync). */
export const TOOL_KEY_MAP: Record<string, ToolId> = {
  v: 'select', t: 'text', a: 'arrow', l: 'line', r: 'rect', o: 'ellipse',
};

const TOOLS: { id: ToolId; label: string; shortcut: string; Icon: typeof MousePointer2 }[] = [
  { id: 'select', label: 'Select', shortcut: 'V', Icon: MousePointer2 },
  { id: 'text', label: 'Text', shortcut: 'T', Icon: Type },
  { id: 'arrow', label: 'Arrow', shortcut: 'A', Icon: ArrowUpRight },
  { id: 'line', label: 'Line', shortcut: 'L', Icon: Minus },
  { id: 'rect', label: 'Rectangle', shortcut: 'R', Icon: Square },
  { id: 'ellipse', label: 'Ellipse', shortcut: 'O', Icon: Circle },
];

/**
 * U8: vertical mini toolbar pinned to the left edge of the stage area for
 * picking the active creation tool. Single-key shortcuts are handled by
 * CanvasEditor's window keydown listener (guarded against focused inputs/
 * controls there); this component is purely presentational + click handling.
 */
export function CanvasAnnotationToolbar({ active, onSelect }: { active: ToolId; onSelect: (tool: ToolId) => void }) {
  return (
    <div
      role="toolbar"
      aria-label="Annotation tools"
      aria-orientation="vertical"
      // U9: inset past the mm rulers (RULER_PX = 22px, CanvasRulers.tsx) so
      // the toolbar never sits under the ruler ink/corner swatch.
      className="absolute left-[30px] top-[30px] z-10 flex flex-col gap-0.5 rounded-lg border bg-background/95 p-1 shadow-md backdrop-blur-sm"
    >
      {TOOLS.map(({ id, label, shortcut, Icon }) => (
        <button
          key={id}
          type="button"
          data-testid={`canvas-tool-${id}`}
          aria-label={`${label} tool (${shortcut})`}
          aria-pressed={active === id}
          title={`${label} (${shortcut})`}
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
            active === id && 'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground',
          )}
          onClick={() => onSelect(id)}
        >
          <Icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}
