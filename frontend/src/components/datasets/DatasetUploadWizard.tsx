'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useDropzone } from 'react-dropzone';
import { toast } from 'sonner';
import { CheckCircle2, Columns3, FileSpreadsheet, Loader2, RefreshCw, Settings2, UploadCloud, X } from 'lucide-react';
import { previewDatasetUpload, uploadDataset } from '@/lib/api';
import type { ColumnProfile, DatasetDetail, DatasetIngestOptions, DatasetPreview } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';

type Props = {
  projectId?: string;
  description?: string;
  onDescriptionChange?: (value: string) => void;
  descriptionAction?: ReactNode;
  onUploaded: (dataset: DatasetDetail) => void | Promise<void>;
  title?: string;
  helper?: string;
};

const ACCEPT = {
  'text/csv': ['.csv'],
  'text/tab-separated-values': ['.tsv'],
  'text/plain': ['.txt'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.ms-excel': ['.xls'],
};

const COLUMN_ROLE_OPTIONS = [
  { value: 'numeric', label: 'Numeric' },
  { value: 'category', label: 'Category' },
  { value: 'group', label: 'Group' },
  { value: 'time', label: 'Time' },
  { value: 'status', label: 'Status' },
  { value: 'gene', label: 'Gene' },
  { value: 'log2fc', label: 'log2FC' },
  { value: 'pvalue', label: 'p-value' },
  { value: 'text', label: 'Text' },
];

function likelyFocusColumns(columns: ColumnProfile[]): string[] {
  const preferred = columns.filter((c) => c.role !== 'text').map((c) => c.name);
  return (preferred.length ? preferred : columns.map((c) => c.name)).slice(0, 8);
}

function initialColumnRoles(columns: ColumnProfile[]): Record<string, string> {
  return Object.fromEntries(columns.map((column) => [column.name, column.role]));
}

function changedColumnRoles(columns: ColumnProfile[], roles: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    columns
      .filter((column) => roles[column.name] && roles[column.name] !== column.role)
      .map((column) => [column.name, roles[column.name]]),
  );
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function numericValue(value: number | undefined): string {
  return value ? String(value) : '';
}

export function DatasetUploadWizard({
  projectId,
  description,
  onDescriptionChange,
  descriptionAction,
  onUploaded,
  title = 'Upload data',
  helper = 'CSV, TSV, TXT, XLSX',
}: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<DatasetPreview | null>(null);
  const [options, setOptions] = useState<DatasetIngestOptions>({});
  const [name, setName] = useState('');
  const [localDescription, setLocalDescription] = useState(description ?? '');
  const [focusColumns, setFocusColumns] = useState<string[]>([]);
  const [columnRoles, setColumnRoles] = useState<Record<string, string>>({});
  const [previewing, setPreviewing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [previewDirty, setPreviewDirty] = useState(false);
  const purposeValue = onDescriptionChange ? (description ?? '') : localDescription;

  const loadPreview = useCallback(async (nextFile: File, nextOptions?: DatasetIngestOptions) => {
    setPreviewing(true);
    try {
      const result = await previewDatasetUpload(nextFile, nextOptions);
      setPreview(result);
      setOptions(result.ingest_options);
      setFocusColumns(likelyFocusColumns(result.column_profile));
      setColumnRoles(initialColumnRoles(result.column_profile));
      setPreviewDirty(false);
      if (!name) setName(result.filename.replace(/\.[^.]+$/, ''));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  }, [name]);

  const onDrop = useCallback(async (files: File[]) => {
    const nextFile = files[0];
    if (!nextFile) return;
    setFile(nextFile);
    setPreview(null);
    setOptions({});
    setFocusColumns([]);
    setColumnRoles({});
    setName(nextFile.name.replace(/\.[^.]+$/, ''));
    await loadPreview(nextFile, {});
  }, [loadPreview]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: false,
    accept: ACCEPT,
  });

  const parsedColumns = preview?.column_profile ?? [];
  const parsedRows = preview?.parsed_preview.slice(0, 10) ?? [];
  const rawRows = preview?.raw_preview.slice(0, 12) ?? [];
  const focusSet = useMemo(() => new Set(focusColumns), [focusColumns]);

  function updateOption<K extends keyof DatasetIngestOptions>(key: K, value: DatasetIngestOptions[K] | undefined) {
    setOptions((current) => {
      const next = { ...current };
      if (value === undefined || value === null || value === '') delete next[key];
      else next[key] = value;
      return next;
    });
    setPreviewDirty(true);
  }

  async function refreshPreview(nextOptions = options) {
    if (!file) return;
    await loadPreview(file, nextOptions);
  }

  async function submit() {
    if (!file || !preview) return;
    const purpose = purposeValue.trim();
    setUploading(true);
    try {
      const dataset = await uploadDataset(
        file,
        projectId,
        purpose || undefined,
        name || undefined,
        preview.ingest_options,
        focusColumns,
        changedColumnRoles(preview.column_profile, columnRoles),
      );
      toast.success('Dataset uploaded');
      setFile(null);
      setPreview(null);
      setOptions({});
      setFocusColumns([]);
      setColumnRoles({});
      setName('');
      if (!onDescriptionChange) setLocalDescription('');
      await onUploaded(dataset);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  if (!file) {
    return (
      <div
        {...getRootProps()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition ${isDragActive ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-primary/50'}`}
      >
        <input {...getInputProps()} />
        <UploadCloud className="h-8 w-8 text-muted-foreground" />
        <p className="mt-3 text-sm font-medium">{isDragActive ? 'Drop file here' : title}</p>
        <p className="text-xs text-muted-foreground">{helper}</p>
      </div>
    );
  }

  return (
    <Card className="border-primary/25">
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileSpreadsheet className="h-4 w-4 text-primary" />
              Check dataset before upload
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">Confirm the sheet, table header, data range, and columns that matter for recommendations.</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => { setFile(null); setPreview(null); setColumnRoles({}); }} disabled={uploading || previewing}>
            <X className="mr-1 h-4 w-4" /> Cancel
          </Button>
        </div>
        <div className="grid gap-3 rounded-lg border bg-muted/30 p-3 md:grid-cols-3">
          <div className="space-y-1">
            <Label>Dataset name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>File</Label>
            <div className="flex h-9 items-center rounded-md border bg-background px-3 text-sm text-muted-foreground">{file.name}</div>
          </div>
          <div className="flex items-end gap-2">
            <Badge variant="secondary">{preview ? `${preview.n_rows} rows` : 'Reading'}</Badge>
            <Badge variant="secondary">{preview ? `${preview.n_cols} columns` : '...'}</Badge>
            {preview && <Badge variant="outline">{preview.format.toUpperCase()}</Badge>}
          </div>
        </div>
        <div className="space-y-2 rounded-lg border bg-background p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <Label htmlFor="dataset-purpose">Dataset purpose</Label>
              <p className="mt-1 text-xs text-muted-foreground">Used by AI recommendations to choose chart types, mappings, labels, and rationale.</p>
            </div>
            {descriptionAction}
          </div>
          <Textarea
            id="dataset-purpose"
            value={purposeValue}
            onChange={(e) => {
              if (onDescriptionChange) onDescriptionChange(e.target.value);
              else setLocalDescription(e.target.value);
            }}
            rows={3}
            placeholder="Example: Compare tumor cell viability after drug A/B/C treatment across dose groups."
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {previewing && !preview ? (
          <div className="flex items-center justify-center rounded-lg border border-dashed py-12 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Reading preview
          </div>
        ) : (
          <>
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="flex items-center gap-2 text-sm font-medium"><Settings2 className="h-4 w-4 text-primary" /> Table recognition</h3>
                  <p className="text-xs text-muted-foreground">Adjust these when the preview does not match the actual table.</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => refreshPreview()} disabled={previewing}>
                  {previewing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}
                  Refresh preview
                </Button>
              </div>
              {previewDirty && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Range settings changed. Refresh the preview before upload.
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
                {!!preview?.sheets.length && (
                  <div className="space-y-1 sm:col-span-2">
                    <Label>Excel sheet</Label>
                    <select
                      className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                      value={options.sheet_name ?? preview.selected_sheet ?? ''}
                      onChange={(e) => {
                        const next = { ...options, sheet_name: e.target.value };
                        setOptions(next);
                        refreshPreview(next);
                      }}
                    >
                      {preview.sheets.map((sheet) => <option key={sheet} value={sheet}>{sheet}</option>)}
                    </select>
                  </div>
                )}
                <div className="space-y-1">
                  <Label>Header row</Label>
                  <Input type="number" min={1} value={numericValue(options.header_row)} onChange={(e) => updateOption('header_row', Number(e.target.value) || undefined)} />
                </div>
                <div className="space-y-1">
                  <Label>Data starts</Label>
                  <Input type="number" min={1} value={numericValue(options.data_start_row)} onChange={(e) => updateOption('data_start_row', Number(e.target.value) || undefined)} />
                </div>
                <div className="space-y-1">
                  <Label>Start col</Label>
                  <Input type="number" min={1} value={numericValue(options.start_col)} onChange={(e) => updateOption('start_col', Number(e.target.value) || undefined)} />
                </div>
                <div className="space-y-1">
                  <Label>End col</Label>
                  <Input type="number" min={1} value={numericValue(options.end_col)} onChange={(e) => updateOption('end_col', Number(e.target.value) || undefined)} />
                </div>
                <div className="space-y-1">
                  <Label>End row</Label>
                  <Input type="number" min={1} value={numericValue(options.end_row)} onChange={(e) => updateOption('end_row', Number(e.target.value) || undefined)} placeholder="All" />
                </div>
              </div>
            </section>

            <section className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <h3 className="text-sm font-medium">Raw file preview</h3>
                <div className="max-h-72 overflow-auto rounded-lg border bg-background">
                  <table className="w-full text-xs">
                    <tbody>
                      {rawRows.map((row, r) => (
                        <tr key={r} className="border-b last:border-0">
                          <td className="sticky left-0 bg-muted px-2 py-1 text-right font-medium text-muted-foreground">{r + 1}</td>
                          {row.map((cell, c) => <td key={c} className="max-w-48 truncate border-l px-2 py-1">{cellText(cell)}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="space-y-2">
                <h3 className="flex items-center gap-2 text-sm font-medium"><CheckCircle2 className="h-4 w-4 text-green-600" /> Parsed table preview</h3>
                <div className="max-h-72 overflow-auto rounded-lg border bg-background">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b bg-muted/70">
                        {parsedColumns.map((column) => <th key={column.name} className="px-2 py-1 text-left font-medium">{column.name}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {parsedRows.map((row, r) => (
                        <tr key={r} className="border-b last:border-0">
                          {parsedColumns.map((column) => <td key={column.name} className="max-w-48 truncate px-2 py-1 text-muted-foreground">{cellText(row[column.name])}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="flex items-center gap-2 text-sm font-medium"><Columns3 className="h-4 w-4 text-primary" /> Focus columns</h3>
                  <p className="text-xs text-muted-foreground">Choose the columns to prioritize and correct any detected role before upload.</p>
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setFocusColumns(likelyFocusColumns(parsedColumns))}>Suggested</Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => setFocusColumns(parsedColumns.map((c) => c.name))}>All</Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setFocusColumns([])}>Clear</Button>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {parsedColumns.map((column) => {
                  const checked = focusSet.has(column.name);
                  return (
                    <div key={column.name} className="space-y-2 rounded-lg border bg-background p-2 text-sm">
                      <label className="flex cursor-pointer items-center gap-2">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(next) => {
                            setFocusColumns((current) => next
                              ? [...current, column.name].filter((value, index, arr) => arr.indexOf(value) === index)
                              : current.filter((value) => value !== column.name));
                          }}
                        />
                        <span className="min-w-0 flex-1 truncate font-medium">{column.name}</span>
                        <Badge variant="secondary" className="shrink-0">{column.dtype}</Badge>
                      </label>
                      <select
                        aria-label={`Column role ${column.name}`}
                        className="h-9 w-full rounded-md border bg-background px-2 text-xs"
                        value={columnRoles[column.name] ?? column.role}
                        onChange={(e) => setColumnRoles((current) => ({ ...current, [column.name]: e.target.value }))}
                      >
                        {COLUMN_ROLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </div>
                  );
                })}
              </div>
            </section>

            <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={() => { setFile(null); setPreview(null); setColumnRoles({}); }} disabled={uploading}>Choose another file</Button>
              <Button onClick={submit} disabled={!preview || uploading || previewing || previewDirty}>
                {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UploadCloud className="mr-2 h-4 w-4" />}
                Upload and continue
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
