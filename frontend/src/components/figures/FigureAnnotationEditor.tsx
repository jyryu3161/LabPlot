'use client';

import type { FigureAnnotation } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Trash2, Plus } from 'lucide-react';

type Kind = FigureAnnotation['kind'];

const KIND_LABEL: Record<Kind, string> = {
  text: 'Text',
  arrow: 'Arrow',
  rect: 'Rect',
  bracket: 'Bracket',
};

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

function makeAnnotation(kind: Kind): FigureAnnotation {
  switch (kind) {
    case 'text':
      return { kind: 'text', x: 0, y: 0, text: 'Label', size: 4, color: '#000000' };
    case 'arrow':
      return { kind: 'arrow', x: 0, y: 0, x2: 1, y2: 1, color: '#000000' };
    case 'rect':
      return { kind: 'rect', x: 0, y: 0, x2: 1, y2: 1, color: '#EE6677' };
    case 'bracket':
      return { kind: 'bracket', x: 0, x2: 1, y: 1, label: '*', color: '#000000' };
  }
}

function numValue(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

export function FigureAnnotationEditor({
  value,
  onChange,
}: {
  value: FigureAnnotation[];
  onChange: (next: FigureAnnotation[]) => void;
}) {
  const items = Array.isArray(value) ? value : [];

  function add(kind: Kind) {
    onChange([...items, makeAnnotation(kind)]);
  }
  function remove(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }
  function patch(index: number, changes: Record<string, unknown>) {
    onChange(items.map((item, i) => (i === index ? ({ ...item, ...changes } as FigureAnnotation) : item)));
  }
  function setNum(index: number, key: string, raw: string) {
    const parsed = Number(raw);
    patch(index, { [key]: raw.trim() === '' ? 0 : (Number.isFinite(parsed) ? parsed : 0) });
  }

  function NumField({ index, k, label, val }: { index: number; k: string; label: string; val: unknown }) {
    return (
      <div className="space-y-0.5">
        <Label className="text-[10px] text-muted-foreground">{label}</Label>
        <Input
          type="number"
          step="any"
          className="h-7 text-xs"
          value={numValue(val)}
          onChange={(e) => setNum(index, k, e.target.value)}
        />
      </div>
    );
  }

  function ColorField({ index, val }: { index: number; val: unknown }) {
    const color = typeof val === 'string' && HEX_RE.test(val) ? val : '#000000';
    return (
      <div className="space-y-0.5">
        <Label className="text-[10px] text-muted-foreground">Color</Label>
        <input
          type="color"
          value={color}
          onChange={(e) => patch(index, { color: e.target.value })}
          className="h-7 w-full rounded border bg-background"
          aria-label="Annotation color"
        />
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-2">
      <div>
        <Label className="text-xs">Annotations</Label>
        <p className="text-[11px] text-muted-foreground">Coordinates are in data units. Applied on the next re-render.</p>
      </div>

      {items.length > 0 && (
        <div className="space-y-2">
          {items.map((item, index) => (
            <div key={index} className="space-y-1 rounded-md border bg-background p-2">
              <div className="flex items-center justify-between gap-2">
                <Badge variant="secondary" className="text-[10px]">{KIND_LABEL[item.kind]}</Badge>
                <Button type="button" variant="ghost" size="icon-xs" aria-label="Delete annotation" onClick={() => remove(index)}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
              {item.kind === 'text' && (
                <>
                  <div className="grid grid-cols-3 gap-1">
                    <NumField index={index} k="x" label="x" val={item.x} />
                    <NumField index={index} k="y" label="y" val={item.y} />
                    <NumField index={index} k="size" label="size" val={item.size} />
                  </div>
                  <div className="grid grid-cols-[1fr_auto] items-end gap-1">
                    <div className="space-y-0.5">
                      <Label className="text-[10px] text-muted-foreground">Text</Label>
                      <Input className="h-7 text-xs" value={item.text ?? ''} onChange={(e) => patch(index, { text: e.target.value })} />
                    </div>
                    <div className="w-16"><ColorField index={index} val={item.color} /></div>
                  </div>
                </>
              )}
              {(item.kind === 'arrow' || item.kind === 'rect') && (
                <>
                  <div className="grid grid-cols-4 gap-1">
                    <NumField index={index} k="x" label="x" val={item.x} />
                    <NumField index={index} k="y" label="y" val={item.y} />
                    <NumField index={index} k="x2" label="x2" val={item.x2} />
                    <NumField index={index} k="y2" label="y2" val={item.y2} />
                  </div>
                  <div className="w-16"><ColorField index={index} val={item.color} /></div>
                </>
              )}
              {item.kind === 'bracket' && (
                <>
                  <div className="grid grid-cols-3 gap-1">
                    <NumField index={index} k="x" label="x" val={item.x} />
                    <NumField index={index} k="x2" label="x2" val={item.x2} />
                    <NumField index={index} k="y" label="y" val={item.y} />
                  </div>
                  <div className="grid grid-cols-[1fr_auto] items-end gap-1">
                    <div className="space-y-0.5">
                      <Label className="text-[10px] text-muted-foreground">Label</Label>
                      <Input className="h-7 text-xs" value={item.label ?? ''} onChange={(e) => patch(index, { label: e.target.value })} />
                    </div>
                    <div className="w-16"><ColorField index={index} val={item.color} /></div>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1">
        {(['text', 'arrow', 'rect', 'bracket'] as Kind[]).map((kind) => (
          <Button key={kind} type="button" variant="outline" size="xs" onClick={() => add(kind)}>
            <Plus className="mr-0.5 h-3 w-3" /> {KIND_LABEL[kind]}
          </Button>
        ))}
      </div>
    </div>
  );
}
