'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function toText(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}
function readPair(value: unknown): [string, string] {
  if (Array.isArray(value) && value.length === 2) return [toText(value[0]), toText(value[1])];
  return ['', ''];
}

/**
 * Two number inputs (from, to) + clear button that emit a `[from, to]` axis-break
 * array only when both are valid numbers with from < to. Local text state keeps
 * partial typing intact; it resyncs from the option on external changes
 * (undo/redo, version switch) without clobbering the field mid-edit.
 */
export function FigureAxisBreakControl({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: unknown;
  onChange: (next: [number, number] | null) => void;
  disabled?: boolean;
}) {
  const initial = readPair(value);
  const [from, setFrom] = useState(initial[0]);
  const [to, setTo] = useState(initial[1]);
  const valueKey = Array.isArray(value) && value.length === 2 ? `${value[0]}|${value[1]}` : '';
  const emittedKeyRef = useRef(valueKey);

  useEffect(() => {
    if (valueKey === emittedKeyRef.current) return;
    const pair = readPair(value);
    setFrom(pair[0]);
    setTo(pair[1]);
    emittedKeyRef.current = valueKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKey]);

  function commit(f: string, t: string) {
    const nf = Number(f);
    const nt = Number(t);
    if (f.trim() && t.trim() && Number.isFinite(nf) && Number.isFinite(nt) && nf < nt) {
      emittedKeyRef.current = `${nf}|${nt}`;
      onChange([nf, nt]);
    } else {
      emittedKeyRef.current = '';
      onChange(null);
    }
  }
  function clear() {
    setFrom('');
    setTo('');
    emittedKeyRef.current = '';
    onChange(null);
  }
  const active = Array.isArray(value) && value.length === 2;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={disabled || (!active && !from.trim() && !to.trim())}
          onClick={clear}
        >
          Clear
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Input
          type="number"
          step="any"
          className="text-sm"
          placeholder="from"
          disabled={disabled}
          value={from}
          onChange={(e) => { setFrom(e.target.value); commit(e.target.value, to); }}
          aria-label={`${label} start`}
        />
        <Input
          type="number"
          step="any"
          className="text-sm"
          placeholder="to"
          disabled={disabled}
          value={to}
          onChange={(e) => { setTo(e.target.value); commit(from, e.target.value); }}
          aria-label={`${label} end`}
        />
      </div>
    </div>
  );
}
