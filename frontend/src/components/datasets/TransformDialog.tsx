'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { transformDataset, previewDatasetTransform } from '@/lib/api';
import type { TransformOperation, TransformPreview } from '@/lib/types';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Plus, Table2, Trash2, Wand2 } from 'lucide-react';

const MAX_OPERATIONS = 20;

type OpType = TransformOperation['op'];

// Editable draft — operations carry a stable id so the list can be reordered/removed by identity.
type OpDraft = { id: string } & TransformOperation;

const OP_TYPE_OPTIONS: { value: OpType; label: string; help: string }[] = [
  { value: 'filter', label: 'Filter rows', help: 'Keep rows matching a condition' },
  { value: 'derive', label: 'Derive column', help: 'Compute a new column from existing ones' },
  { value: 'select', label: 'Select columns', help: 'Keep only chosen columns' },
  { value: 'rename', label: 'Rename columns', help: 'Change column names' },
  { value: 'melt', label: 'Melt (wide → long)', help: 'Reshape wide columns into rows' },
];

const FILTER_OPERATORS: { value: string; label: string }[] = [
  { value: '==', label: '= equals' },
  { value: '!=', label: '≠ not equal' },
  { value: '>', label: '> greater than' },
  { value: '>=', label: '≥ at least' },
  { value: '<', label: '< less than' },
  { value: '<=', label: '≤ at most' },
  { value: 'contains', label: 'contains text' },
  { value: 'not_null', label: 'is not empty' },
];

const DERIVE_FUNCTIONS: { value: string; label: string; twoArg: boolean }[] = [
  { value: 'add', label: 'Add (a + b)', twoArg: true },
  { value: 'subtract', label: 'Subtract (a − b)', twoArg: true },
  { value: 'multiply', label: 'Multiply (a × b)', twoArg: true },
  { value: 'divide', label: 'Divide (a ÷ b)', twoArg: true },
  { value: 'log', label: 'Natural log', twoArg: false },
  { value: 'log2', label: 'Log2', twoArg: false },
  { value: 'log10', label: 'Log10', twoArg: false },
  { value: 'sqrt', label: 'Square root', twoArg: false },
  { value: 'zscore', label: 'Z-score', twoArg: false },
  { value: 'abs', label: 'Absolute value', twoArg: false },
];

function isTwoArg(fn: string): boolean {
  return DERIVE_FUNCTIONS.find((f) => f.value === fn)?.twoArg ?? false;
}

function makeId(): string {
  return `op-${Math.random().toString(36).slice(2, 10)}`;
}

function blankOp(op: OpType): OpDraft {
  const id = makeId();
  switch (op) {
    case 'filter': return { id, op, column: '', operator: '==', value: '' };
    case 'derive': return { id, op, new_column: '', function: 'add', columns: [] };
    case 'select': return { id, op, columns: [] };
    case 'rename': return { id, op, mapping: {} };
    case 'melt': return { id, op, id_columns: [], value_columns: [], names_to: 'variable', values_to: 'value' };
  }
}

// Strip the draft id and empty fields before sending to the API.
function toOperation(draft: OpDraft): TransformOperation {
  switch (draft.op) {
    case 'filter': {
      const base: TransformOperation = { op: 'filter', column: draft.column, operator: draft.operator };
      if (draft.operator !== 'not_null') base.value = draft.value ?? '';
      return base;
    }
    case 'derive': {
      const base: TransformOperation = { op: 'derive', new_column: draft.new_column, function: draft.function, columns: draft.columns };
      if (draft.constant !== undefined && !Number.isNaN(draft.constant)) base.constant = draft.constant;
      return base;
    }
    case 'select': return { op: 'select', columns: draft.columns };
    case 'rename': return { op: 'rename', mapping: draft.mapping };
    case 'melt': return {
      op: 'melt',
      id_columns: draft.id_columns,
      value_columns: draft.value_columns,
      names_to: draft.names_to || 'variable',
      values_to: draft.values_to || 'value',
    };
  }
}

function CheckboxColumnList({
  columns, selected, onToggle, emptyHint,
}: { columns: string[]; selected: string[]; onToggle: (name: string, checked: boolean) => void; emptyHint?: string }) {
  if (columns.length === 0) {
    return <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">{emptyHint ?? 'No columns available.'}</p>;
  }
  return (
    <div className="max-h-32 space-y-0.5 overflow-y-auto rounded-md border p-2">
      {columns.map((name) => (
        <label key={name} className="flex items-center gap-2 py-0.5 text-sm">
          <input
            type="checkbox"
            checked={selected.includes(name)}
            onChange={(e) => onToggle(name, e.target.checked)}
          />
          <span className="min-w-0 truncate">{name}</span>
        </label>
      ))}
    </div>
  );
}

export function TransformDialog({
  datasetId, datasetName, columns, disabled,
}: { datasetId: string; datasetName: string; columns: string[]; disabled?: boolean }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [ops, setOps] = useState<OpDraft[]>([]);
  const [addType, setAddType] = useState<OpType>('filter');
  const [name, setName] = useState('');
  const [preview, setPreview] = useState<TransformPreview | null>(null);

  const operations = useMemo(() => ops.map(toOperation), [ops]);

  function resetState() {
    setOps([]);
    setAddType('filter');
    setName('');
    setPreview(null);
  }

  function updateOp(id: string, patch: Partial<OpDraft>) {
    setOps((current) => current.map((op) => (op.id === id ? ({ ...op, ...patch } as OpDraft) : op)));
    setPreview(null);
  }

  function addOp() {
    if (ops.length >= MAX_OPERATIONS) {
      toast.error(`Up to ${MAX_OPERATIONS} operations per transform.`);
      return;
    }
    setOps((current) => [...current, blankOp(addType)]);
    setPreview(null);
  }

  function removeOp(id: string) {
    setOps((current) => current.filter((op) => op.id !== id));
    setPreview(null);
  }

  const previewMut = useMutation({
    mutationFn: () => previewDatasetTransform(datasetId, { operations }),
    onSuccess: (result) => setPreview(result),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Preview failed'),
  });

  const createMut = useMutation({
    mutationFn: () => transformDataset(datasetId, { name: name.trim() || undefined, operations }),
    onSuccess: async (dataset) => {
      toast.success('Transformed dataset created');
      await qc.invalidateQueries({ queryKey: ['datasets'] });
      setOpen(false);
      resetState();
      router.push(`/datasets/${dataset.id}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Transform failed'),
  });

  const noOps = ops.length === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) resetState();
      }}
    >
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        <Wand2 className="mr-2 h-4 w-4" /> Transform
      </Button>
      <DialogContent className="max-h-[90vh] w-[95vw] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Transform &amp; reshape dataset</DialogTitle>
          <DialogDescription>
            Build an ordered list of operations, preview the result, then save it as a new dataset. The original stays unchanged.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Add operation */}
          <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-muted/30 p-3">
            <div className="min-w-[12rem] flex-1 space-y-1">
              <Label htmlFor="transform-op-type">Add an operation</Label>
              <select
                id="transform-op-type"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={addType}
                onChange={(e) => setAddType(e.target.value as OpType)}
              >
                {OP_TYPE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
              </select>
              <p className="text-xs text-muted-foreground">{OP_TYPE_OPTIONS.find((o) => o.value === addType)?.help}</p>
            </div>
            <Button type="button" variant="secondary" size="sm" onClick={addOp} disabled={ops.length >= MAX_OPERATIONS}>
              <Plus className="mr-1 h-4 w-4" /> Add
            </Button>
          </div>

          {/* Operation list */}
          {noOps ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No operations yet. Add one above to start reshaping the data.
            </div>
          ) : (
            <ol className="space-y-3">
              {ops.map((op, index) => (
                <li key={op.id} className="rounded-lg border p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{index + 1}</Badge>
                      <span className="text-sm font-medium">{OP_TYPE_OPTIONS.find((o) => o.value === op.op)?.label}</span>
                    </div>
                    <Button type="button" variant="ghost" size="icon" aria-label="Remove operation" onClick={() => removeOp(op.id)}>
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                  <OperationForm op={op} columns={columns} onChange={(patch) => updateOp(op.id, patch)} />
                </li>
              ))}
            </ol>
          )}

          {/* Preview */}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => previewMut.mutate()} disabled={noOps || previewMut.isPending}>
              {previewMut.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Table2 className="mr-2 h-4 w-4" />}
              Preview
            </Button>
            {preview && <span className="text-sm text-muted-foreground">{preview.total_rows} rows × {preview.columns.length} cols (showing first {Math.min(20, preview.rows.length)})</span>}
          </div>

          {preview && (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left">
                    {preview.columns.map((c) => <th key={c} className="px-2 py-1 font-medium">{c}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 20).map((row, ri) => (
                    <tr key={ri} className="border-b last:border-0">
                      {row.map((cell, ci) => <td key={ci} className="px-2 py-1 text-muted-foreground">{cell === null ? '' : String(cell)}</td>)}
                    </tr>
                  ))}
                  {preview.rows.length === 0 && (
                    <tr><td colSpan={Math.max(1, preview.columns.length)} className="px-2 py-4 text-center text-muted-foreground">No rows match these operations.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* Create */}
          <div className="space-y-2 border-t pt-3">
            <div className="space-y-1">
              <Label htmlFor="transform-name">New dataset name (optional)</Label>
              <Input
                id="transform-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`${datasetName} (transformed)`}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => { setOpen(false); resetState(); }}>Cancel</Button>
              <Button type="button" onClick={() => createMut.mutate()} disabled={noOps || createMut.isPending}>
                {createMut.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Create dataset
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OperationForm({ op, columns, onChange }: { op: OpDraft; columns: string[]; onChange: (patch: Partial<OpDraft>) => void }) {
  if (op.op === 'filter') {
    return (
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="space-y-1">
          <Label className="text-xs">Column</Label>
          <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={op.column} onChange={(e) => onChange({ column: e.target.value } as Partial<OpDraft>)}>
            <option value="">Select…</option>
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Condition</Label>
          <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={op.operator} onChange={(e) => onChange({ operator: e.target.value } as Partial<OpDraft>)}>
            {FILTER_OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        {op.operator !== 'not_null' && (
          <div className="space-y-1">
            <Label className="text-xs">Value</Label>
            <Input value={String(op.value ?? '')} onChange={(e) => onChange({ value: e.target.value } as Partial<OpDraft>)} placeholder="Value" />
          </div>
        )}
      </div>
    );
  }

  if (op.op === 'derive') {
    const twoArg = isTwoArg(op.function);
    const cols = op.columns;
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">New column name</Label>
          <Input value={op.new_column} onChange={(e) => onChange({ new_column: e.target.value } as Partial<OpDraft>)} placeholder="e.g. log_dose" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Function</Label>
          <select
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            value={op.function}
            onChange={(e) => {
              const nextTwo = isTwoArg(e.target.value);
              const trimmed = nextTwo ? cols.slice(0, 2) : cols.slice(0, 1);
              onChange({ function: e.target.value, columns: trimmed } as Partial<OpDraft>);
            }}
          >
            {DERIVE_FUNCTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{twoArg ? 'First column (a)' : 'Column'}</Label>
          <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={cols[0] ?? ''} onChange={(e) => onChange({ columns: [e.target.value, ...(twoArg ? [cols[1] ?? ''] : [])].filter(Boolean) } as Partial<OpDraft>)}>
            <option value="">Select…</option>
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        {twoArg && (
          <div className="space-y-1">
            <Label className="text-xs">Second column (b)</Label>
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={cols[1] ?? ''} onChange={(e) => onChange({ columns: [cols[0] ?? '', e.target.value].filter(Boolean) } as Partial<OpDraft>)}>
              <option value="">Select…</option>
              {columns.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        )}
        <div className="space-y-1">
          <Label className="text-xs">Constant (optional)</Label>
          <Input
            type="number"
            step="any"
            value={op.constant === undefined ? '' : String(op.constant)}
            onChange={(e) => {
              const raw = e.target.value.trim();
              onChange({ constant: raw === '' ? undefined : Number(raw) } as Partial<OpDraft>);
            }}
            placeholder="e.g. add offset before log"
          />
        </div>
      </div>
    );
  }

  if (op.op === 'select') {
    return (
      <div className="space-y-1">
        <Label className="text-xs">Columns to keep</Label>
        <CheckboxColumnList
          columns={columns}
          selected={op.columns}
          onToggle={(nameCol, checked) => onChange({ columns: checked ? [...op.columns, nameCol] : op.columns.filter((c) => c !== nameCol) } as Partial<OpDraft>)}
        />
      </div>
    );
  }

  if (op.op === 'rename') {
    return (
      <div className="space-y-2">
        <Label className="text-xs">Rename columns (leave new name blank to keep original)</Label>
        <div className="space-y-1">
          {columns.map((c) => (
            <div key={c} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <span className="truncate text-sm">{c}</span>
              <span className="text-muted-foreground">→</span>
              <Input
                value={op.mapping[c] ?? ''}
                onChange={(e) => {
                  const next = { ...op.mapping };
                  if (e.target.value.trim()) next[c] = e.target.value;
                  else delete next[c];
                  onChange({ mapping: next } as Partial<OpDraft>);
                }}
                placeholder="new name"
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // melt
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label className="text-xs">ID columns (kept as-is)</Label>
        <CheckboxColumnList
          columns={columns}
          selected={op.id_columns}
          onToggle={(nameCol, checked) => onChange({ id_columns: checked ? [...op.id_columns, nameCol] : op.id_columns.filter((c) => c !== nameCol) } as Partial<OpDraft>)}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Value columns (unpivoted)</Label>
        <CheckboxColumnList
          columns={columns}
          selected={op.value_columns}
          onToggle={(nameCol, checked) => onChange({ value_columns: checked ? [...op.value_columns, nameCol] : op.value_columns.filter((c) => c !== nameCol) } as Partial<OpDraft>)}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Name of the &quot;variable&quot; column</Label>
        <Input value={op.names_to ?? ''} onChange={(e) => onChange({ names_to: e.target.value } as Partial<OpDraft>)} placeholder="variable" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Name of the &quot;value&quot; column</Label>
        <Input value={op.values_to ?? ''} onChange={(e) => onChange({ values_to: e.target.value } as Partial<OpDraft>)} placeholder="value" />
      </div>
    </div>
  );
}
