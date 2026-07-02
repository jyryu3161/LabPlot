'use client';

import { useState } from 'react';
import type { SeriesStyle } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const LINETYPES: SeriesStyle['linetype'][] = ['solid', 'dashed', 'dotted', 'dotdash', 'longdash'];
const SHAPES: SeriesStyle['shape'][] = ['circle', 'square', 'triangle', 'diamond'];
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const SELECT_CLASS = 'w-full rounded-md border px-2 py-1 text-xs';

function normalizeStyles(value: unknown): Record<string, SeriesStyle> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, SeriesStyle>;
}

export function FigureSeriesStyleEditor({
  value,
  onChange,
  seriesNames,
  columnName,
}: {
  value: Record<string, SeriesStyle> | undefined;
  onChange: (next: Record<string, SeriesStyle>) => void;
  seriesNames: string[];
  columnName: string;
}) {
  const styles = normalizeStyles(value);
  const [newName, setNewName] = useState('');

  // Merge the mapped column's distinct levels with any custom names already saved.
  const names = [
    ...seriesNames,
    ...Object.keys(styles).filter((name) => !seriesNames.includes(name)),
  ].slice(0, 60);

  function patch(name: string, changes: Partial<SeriesStyle>) {
    const nextStyle = { ...(styles[name] ?? {}), ...changes };
    // Drop empty keys so we never persist blank overrides.
    (Object.keys(nextStyle) as (keyof SeriesStyle)[]).forEach((k) => {
      if (nextStyle[k] === undefined || nextStyle[k] === '') delete nextStyle[k];
    });
    const next = { ...styles };
    if (Object.keys(nextStyle).length) next[name] = nextStyle;
    else delete next[name];
    onChange(next);
  }

  function reset(name: string) {
    const next = { ...styles };
    delete next[name];
    onChange(next);
  }

  function addName() {
    const name = newName.trim();
    if (!name) return;
    if (!names.includes(name)) patch(name, { color: '#4477AA' });
    setNewName('');
  }

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-2">
      <div>
        <Label className="text-xs">Per-series styling</Label>
        <p className="text-[11px] text-muted-foreground">
          Override color, line type, and point shape per level of <span className="font-medium">{columnName}</span>.
        </p>
      </div>

      {names.length > 0 && (
        <div className="space-y-1">
          {names.map((name) => {
            const style = styles[name] ?? {};
            const color = typeof style.color === 'string' && HEX_RE.test(style.color) ? style.color : '#4477AA';
            const hasOverride = Boolean(styles[name] && Object.keys(styles[name]).length);
            return (
              <div key={name} className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] items-center gap-1">
                <span className="truncate text-xs" title={name}>{name}</span>
                <input
                  type="color"
                  value={color}
                  onChange={(e) => patch(name, { color: e.target.value })}
                  className="h-7 w-8 rounded border bg-background"
                  aria-label={`Color for ${name}`}
                />
                <select
                  className={SELECT_CLASS}
                  aria-label={`Line type for ${name}`}
                  value={style.linetype ?? ''}
                  onChange={(e) => patch(name, { linetype: (e.target.value || undefined) as SeriesStyle['linetype'] })}
                >
                  <option value="">line…</option>
                  {LINETYPES.map((lt) => <option key={lt} value={lt}>{lt}</option>)}
                </select>
                <select
                  className={SELECT_CLASS}
                  aria-label={`Shape for ${name}`}
                  value={style.shape ?? ''}
                  onChange={(e) => patch(name, { shape: (e.target.value || undefined) as SeriesStyle['shape'] })}
                >
                  <option value="">shape…</option>
                  {SHAPES.map((sh) => <option key={sh} value={sh}>{sh}</option>)}
                </select>
                <Button type="button" variant="ghost" size="sm" disabled={!hasOverride} onClick={() => reset(name)}>Reset</Button>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex gap-1">
        <Input
          className="h-8 text-xs"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addName(); } }}
          placeholder="Add series name"
        />
        <Button type="button" variant="outline" size="sm" onClick={addName}>Add</Button>
      </div>
    </div>
  );
}
