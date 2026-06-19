'use client';

import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { ArrowRight, CheckCircle2, Eraser, Loader2, MessageSquareText, MousePointer2, SquareDashedMousePointer, Trash2, Wand2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { Improvement } from '@/lib/types';

type AnnotationTool = 'select' | 'region' | 'arrow' | 'note';
type AnnotationType = Exclude<AnnotationTool, 'select'>;

interface AiEditPayload {
  prompt: string;
  annotated_image?: string;
}

interface Annotation {
  id: string;
  type: AnnotationType;
  x: number;
  y: number;
  w?: number;
  h?: number;
  x2?: number;
  y2?: number;
  text: string;
}

interface DraftDrag {
  id: string;
  type: 'select' | 'region' | 'arrow';
  x: number;
  y: number;
  x2: number;
  y2: number;
}

interface AiFigureEditorProps {
  imageUrl?: string | null;
  versionNumber?: number;
  prompt: string;
  improvements: Improvement[] | null;
  isSuggesting?: boolean;
  isApplyingPrompt?: boolean;
  isApplyingSuggestion?: boolean;
  canEdit?: boolean;
  onPromptChange: (value: string) => void;
  onSuggest: (request: AiEditPayload) => void;
  onApplyPrompt: (request: AiEditPayload) => void;
  onApplySuggestion: (improvementId: string) => void;
  onApplySuggestions: (improvementIds: string[]) => void;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function fmt(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

function pointerPercent(event: PointerEvent<HTMLElement>, element: HTMLElement | null) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: clampPercent(((event.clientX - rect.left) / rect.width) * 100),
    y: clampPercent(((event.clientY - rect.top) / rect.height) * 100),
  };
}

function annotationSummary(annotation: Annotation, index: number): string {
  const label = annotation.text.trim() || '(no memo)';
  if (annotation.type === 'region') {
    return `Mark #${index + 1} [region] bounds: left ${fmt(annotation.x)}, top ${fmt(annotation.y)}, width ${fmt(annotation.w ?? 0)}, height ${fmt(annotation.h ?? 0)}. User memo: ${label}`;
  }
  if (annotation.type === 'arrow') {
    return `Mark #${index + 1} [arrow] from ${fmt(annotation.x)}, ${fmt(annotation.y)} to ${fmt(annotation.x2 ?? annotation.x)}, ${fmt(annotation.y2 ?? annotation.y)}. User memo: ${label}`;
  }
  return `Mark #${index + 1} [note] at ${fmt(annotation.x)}, ${fmt(annotation.y)}. User memo: ${label}`;
}

function buildLocalizedPrompt(prompt: string, annotations: Annotation[]): string {
  const base = prompt.trim();
  const valid = annotations.filter((annotation) => annotation.text.trim() || base);
  if (!valid.length) return base;
  const annotationText = valid.map(annotationSummary).join('\n');
  return [
    base || 'Apply the localized edits marked on the figure preview.',
    '',
    'Localized image editing annotations for R-code regeneration:',
    'The user marked the rendered figure preview. Coordinates are percentages of displayed image width and height. Interpret each mark as visual evidence for the requested change, then produce only supported LabPlot R/ggplot parameter patches.',
    'Important constraints: preserve the data and statistics; do not perform pixel inpainting; do not invent findings; do not add unsupported annotations; translate localized requests into supported options such as axis labels, title/subtitle removal, legend placement, palette, color mode, size, width/height, x-axis text angle, point/bar/line options, or existing mapping changes only when an existing column name is available.',
    'If several marks are present, satisfy all non-conflicting memos. If a memo is ambiguous, choose the smallest conservative manuscript-style change that addresses the marked region.',
    annotationText,
  ].join('\n');
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (src.startsWith('http') && !src.startsWith(window.location.origin)) {
      image.crossOrigin = 'anonymous';
    }
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load figure preview for annotation export'));
    image.src = src;
  });
}

function drawArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, scale: number) {
  const head = Math.max(9, 12 * scale);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

async function renderAnnotatedImage(imageUrl: string | null | undefined, annotations: Annotation[]): Promise<string | undefined> {
  if (!imageUrl || annotations.length === 0 || typeof document === 'undefined') return undefined;
  const image = await loadImage(imageUrl);
  const width = Math.max(1, image.naturalWidth || image.width);
  const height = Math.max(1, image.naturalHeight || image.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);

  const scale = Math.max(0.75, Math.min(2.5, Math.min(width, height) / 700));
  ctx.lineWidth = Math.max(2, 2.2 * scale);
  ctx.strokeStyle = '#2563eb';
  ctx.fillStyle = 'rgba(37, 99, 235, 0.14)';
  ctx.font = `${Math.max(13, 15 * scale)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  annotations.forEach((annotation, index) => {
    const x = (annotation.x / 100) * width;
    const y = (annotation.y / 100) * height;
    ctx.strokeStyle = '#2563eb';
    ctx.fillStyle = 'rgba(37, 99, 235, 0.14)';
    if (annotation.type === 'region') {
      const w = ((annotation.w ?? 0) / 100) * width;
      const h = ((annotation.h ?? 0) / 100) * height;
      ctx.fillRect(x, y, w, h);
      ctx.setLineDash([8 * scale, 5 * scale]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    } else if (annotation.type === 'arrow') {
      ctx.fillStyle = '#2563eb';
      drawArrow(ctx, x, y, ((annotation.x2 ?? annotation.x) / 100) * width, ((annotation.y2 ?? annotation.y) / 100) * height, scale);
    } else {
      ctx.beginPath();
      ctx.arc(x, y, Math.max(8, 9 * scale), 0, Math.PI * 2);
      ctx.fillStyle = '#2563eb';
      ctx.fill();
    }

    const labelRadius = Math.max(11, 13 * scale);
    ctx.beginPath();
    ctx.arc(x, y, labelRadius, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = Math.max(1.5, 1.8 * scale);
    ctx.stroke();
    ctx.fillStyle = '#2563eb';
    ctx.font = `700 ${Math.max(13, 15 * scale)}px sans-serif`;
    ctx.fillText(String(index + 1), x, y + 0.5);
  });

  return canvas.toDataURL('image/png');
}

function annotationBounds(annotation: Annotation) {
  if (annotation.type === 'region') {
    return {
      left: annotation.x,
      top: annotation.y,
      right: annotation.x + (annotation.w ?? 0),
      bottom: annotation.y + (annotation.h ?? 0),
    };
  }
  if (annotation.type === 'arrow') {
    return {
      left: Math.min(annotation.x, annotation.x2 ?? annotation.x),
      top: Math.min(annotation.y, annotation.y2 ?? annotation.y),
      right: Math.max(annotation.x, annotation.x2 ?? annotation.x),
      bottom: Math.max(annotation.y, annotation.y2 ?? annotation.y),
    };
  }
  return {
    left: annotation.x - 1.5,
    top: annotation.y - 1.5,
    right: annotation.x + 1.5,
    bottom: annotation.y + 1.5,
  };
}

function intersects(a: ReturnType<typeof annotationBounds>, b: ReturnType<typeof annotationBounds>) {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

export function AiFigureEditor({
  imageUrl,
  versionNumber,
  prompt,
  improvements,
  isSuggesting = false,
  isApplyingPrompt = false,
  isApplyingSuggestion = false,
  canEdit = true,
  onPromptChange,
  onSuggest,
  onApplyPrompt,
  onApplySuggestion,
  onApplySuggestions,
}: AiFigureEditorProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<AnnotationTool>('select');
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedImprovementIds, setSelectedImprovementIds] = useState<string[]>([]);
  const [isPreparingImage, setIsPreparingImage] = useState(false);
  const [drag, setDrag] = useState<DraftDrag | null>(null);

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const hasAnnotations = annotations.length > 0;
  const hasMarkedInstructions = annotations.some((annotation) => annotation.text.trim());
  const selectableImprovementIds = useMemo(
    () => (improvements ?? []).filter((imp) => !imp.applied).map((imp) => imp.id),
    [improvements],
  );
  const validSelectedImprovementIds = useMemo(
    () => selectedImprovementIds.filter((id) => selectableImprovementIds.includes(id)),
    [selectableImprovementIds, selectedImprovementIds],
  );
  const selectedImprovementIdSet = useMemo(() => new Set(validSelectedImprovementIds), [validSelectedImprovementIds]);
  const allSelectableSuggestionsChecked = selectableImprovementIds.length > 0
    && selectableImprovementIds.every((id) => selectedImprovementIdSet.has(id));
  const combinedPrompt = useMemo(() => buildLocalizedPrompt(prompt, annotations), [annotations, prompt]);
  const canPreview = canEdit && Boolean(imageUrl);
  const canRun = canEdit && Boolean(imageUrl) && Boolean(prompt.trim() || hasMarkedInstructions);

  function updateAnnotationText(id: string, value: string) {
    setAnnotations((items) => items.map((item) => item.id === id ? { ...item, text: value } : item));
  }

  function removeAnnotations(ids: string[]) {
    if (!ids.length) return;
    const idSet = new Set(ids);
    setAnnotations((items) => items.filter((annotation) => !idSet.has(annotation.id)));
    setSelectedIds((current) => current.filter((id) => !idSet.has(id)));
  }

  function toggleAnnotationSelection(id: string, additive: boolean) {
    setSelectedIds((current) => {
      if (!additive) return [id];
      return current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
    });
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!selectedIds.length || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      if (tagName === 'input' || tagName === 'textarea' || target?.isContentEditable) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        const idSet = new Set(selectedIds);
        setAnnotations((items) => items.filter((annotation) => !idSet.has(annotation.id)));
        setSelectedIds([]);
      }
      if (event.key === 'Escape') {
        setSelectedIds([]);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds]);

  function toggleSuggestion(id: string, checked: boolean) {
    setSelectedImprovementIds((current) => {
      if (checked) return Array.from(new Set([...current, id]));
      return current.filter((item) => item !== id);
    });
  }

  function toggleAllSuggestions(checked: boolean) {
    setSelectedImprovementIds(checked ? selectableImprovementIds : []);
  }

  function selectByDrag(selection: DraftDrag, additive: boolean) {
    const bounds = annotationBounds({
      id: selection.id,
      type: 'region',
      x: Math.min(selection.x, selection.x2),
      y: Math.min(selection.y, selection.y2),
      w: Math.abs(selection.x2 - selection.x),
      h: Math.abs(selection.y2 - selection.y),
      text: '',
    });
    const hits = annotations.filter((annotation) => intersects(annotationBounds(annotation), bounds)).map((annotation) => annotation.id);
    setSelectedIds((current) => {
      if (!additive) return hits;
      return Array.from(new Set([...current, ...hits]));
    });
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!canEdit || !imageUrl) return;
    const point = pointerPercent(event, stageRef.current);
    if (!point) return;
    const id = crypto.randomUUID();
    if (tool === 'note') {
      const note = { id, type: 'note' as const, x: point.x, y: point.y, text: '' };
      setAnnotations((items) => [...items, note]);
      setSelectedIds([id]);
      return;
    }
    if (tool === 'select' && !(event.ctrlKey || event.metaKey || event.shiftKey)) {
      setSelectedIds([]);
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ id, type: tool, x: point.x, y: point.y, x2: point.x, y2: point.y });
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag) return;
    const point = pointerPercent(event, stageRef.current);
    if (!point) return;
    setDrag({ ...drag, x2: point.x, y2: point.y });
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!drag) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    if (drag.type === 'select') {
      selectByDrag(drag, additive);
      setDrag(null);
      return;
    }
    const x1 = Math.min(drag.x, drag.x2);
    const y1 = Math.min(drag.y, drag.y2);
    const x2 = Math.max(drag.x, drag.x2);
    const y2 = Math.max(drag.y, drag.y2);
    const tooSmall = Math.abs(drag.x2 - drag.x) < 1.5 && Math.abs(drag.y2 - drag.y) < 1.5;
    if (!tooSmall) {
      const next: Annotation = drag.type === 'region'
        ? { id: drag.id, type: 'region', x: x1, y: y1, w: x2 - x1, h: y2 - y1, text: '' }
        : { id: drag.id, type: 'arrow', x: drag.x, y: drag.y, x2: drag.x2, y2: drag.y2, text: '' };
      setAnnotations((items) => [...items, next]);
      setSelectedIds([next.id]);
    }
    setDrag(null);
  }

  function removeSelected() {
    removeAnnotations(selectedIds);
  }

  async function buildEditPayload(): Promise<AiEditPayload> {
    const payload: AiEditPayload = { prompt: combinedPrompt };
    if (hasAnnotations) {
      try {
        const annotatedImage = await renderAnnotatedImage(imageUrl, annotations);
        if (annotatedImage) payload.annotated_image = annotatedImage;
      } catch {
        // The backend will still attach the current rendered PNG and use the coordinate summaries.
      }
    }
    return payload;
  }

  async function handleApplyPrompt() {
    if (!canRun) return;
    setIsPreparingImage(true);
    try {
      onApplyPrompt(await buildEditPayload());
    } finally {
      setIsPreparingImage(false);
    }
  }

  async function handleSuggest() {
    if (!canPreview) return;
    setIsPreparingImage(true);
    try {
      onSuggest(await buildEditPayload());
    } finally {
      setIsPreparingImage(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Wand2 className="h-4 w-4 text-primary" />
          AI editor {versionNumber ? `(v${versionNumber})` : ''}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!canEdit ? (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">Editor access is required to create AI edits.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {[
                { key: 'select' as const, label: 'Select', icon: MousePointer2 },
                { key: 'region' as const, label: 'Region', icon: SquareDashedMousePointer },
                { key: 'arrow' as const, label: 'Arrow', icon: ArrowRight },
                { key: 'note' as const, label: 'Note', icon: MessageSquareText },
              ].map((item) => {
                const Icon = item.icon;
                return (
                  <Button key={item.key} type="button" size="sm" variant={tool === item.key ? 'default' : 'outline'} onClick={() => setTool(item.key)}>
                    <Icon className="mr-1 h-3.5 w-3.5" />
                    {item.label}
                  </Button>
                );
              })}
              <Button type="button" size="sm" variant="outline" onClick={removeSelected} disabled={!selectedIds.length}>
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                Delete selected
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => { setAnnotations([]); setSelectedIds([]); }} disabled={!annotations.length}>
                <Eraser className="mr-1 h-3.5 w-3.5" />
                Clear
              </Button>
            </div>

            <div
              ref={stageRef}
              className="relative mx-auto min-h-64 max-w-full touch-none overflow-hidden rounded-md border bg-white"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
            >
              {imageUrl ? (
                <img src={imageUrl} alt="Figure for AI editing" className="block max-h-[56vh] w-full object-contain" draggable={false} />
              ) : (
                <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">No rendered image available</div>
              )}
              <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                <defs>
                  <marker id="ai-editor-arrowhead" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto" markerUnits="strokeWidth">
                    <path d="M0,0 L5,2.5 L0,5 z" fill="#2563eb" />
                  </marker>
                </defs>
                {[...annotations, ...(drag && drag.type !== 'select' ? [{
                  id: drag.id,
                  type: drag.type,
                  x: drag.type === 'region' ? Math.min(drag.x, drag.x2) : drag.x,
                  y: drag.type === 'region' ? Math.min(drag.y, drag.y2) : drag.y,
                  w: Math.abs(drag.x2 - drag.x),
                  h: Math.abs(drag.y2 - drag.y),
                  x2: drag.x2,
                  y2: drag.y2,
                  text: '',
                } as Annotation] : [])].map((annotation, index) => (
                  <g key={annotation.id}>
                    {annotation.type === 'region' && (
                      <rect
                        x={annotation.x}
                        y={annotation.y}
                        width={annotation.w ?? 0}
                        height={annotation.h ?? 0}
                        fill="rgba(37, 99, 235, 0.10)"
                        stroke={selectedIdSet.has(annotation.id) ? '#0f172a' : '#2563eb'}
                        strokeWidth={selectedIdSet.has(annotation.id) ? 0.55 : 0.35}
                        strokeDasharray="1.2 0.8"
                      />
                    )}
                    {annotation.type === 'arrow' && (
                      <line
                        x1={annotation.x}
                        y1={annotation.y}
                        x2={annotation.x2 ?? annotation.x}
                        y2={annotation.y2 ?? annotation.y}
                        stroke={selectedIdSet.has(annotation.id) ? '#0f172a' : '#2563eb'}
                        strokeWidth={selectedIdSet.has(annotation.id) ? 0.65 : 0.45}
                        markerEnd="url(#ai-editor-arrowhead)"
                      />
                    )}
                    {annotation.type === 'note' && (
                      <circle
                        cx={annotation.x}
                        cy={annotation.y}
                        r={selectedIdSet.has(annotation.id) ? 1.75 : 1.45}
                        fill={selectedIdSet.has(annotation.id) ? '#0f172a' : '#2563eb'}
                      />
                    )}
                    <circle cx={annotation.x} cy={annotation.y} r={1.55} fill="#ffffff" stroke="#2563eb" strokeWidth={0.25} />
                    <text x={annotation.x} y={annotation.y + 0.55} textAnchor="middle" fontSize="2.5" fill="#2563eb" fontWeight="700">{index + 1}</text>
                  </g>
                ))}
                {drag?.type === 'select' && (
                  <rect
                    x={Math.min(drag.x, drag.x2)}
                    y={Math.min(drag.y, drag.y2)}
                    width={Math.abs(drag.x2 - drag.x)}
                    height={Math.abs(drag.y2 - drag.y)}
                    fill="rgba(15, 23, 42, 0.08)"
                    stroke="#0f172a"
                    strokeWidth={0.35}
                    strokeDasharray="1 0.8"
                  />
                )}
              </svg>
              <div className="absolute inset-0">
                {annotations.map((annotation) => (
                  <button
                    key={annotation.id}
                    type="button"
                    aria-label={`Select annotation ${annotation.type}`}
                    className="absolute h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full focus:outline-none focus:ring-2 focus:ring-primary/40"
                    style={{ left: `${annotation.x}%`, top: `${annotation.y}%` }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleAnnotationSelection(annotation.id, event.ctrlKey || event.metaKey || event.shiftKey);
                    }}
                  />
                ))}
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-[1fr_1fr]">
              <div className="space-y-1">
                <Label htmlFor="ai-editor-prompt" className="text-xs">{hasAnnotations ? 'Additional edit request (optional)' : 'Edit request'}</Label>
                <Textarea
                  id="ai-editor-prompt"
                  value={prompt}
                  onChange={(event) => onPromptChange(event.target.value)}
                  rows={4}
                  maxLength={2500}
                  placeholder={hasAnnotations
                    ? 'Optional: add instructions not covered by the mark memos.'
                    : 'Example: make the bars more restrained, move the legend to the bottom, and keep x-axis labels horizontal.'}
                />
                {hasAnnotations && <p className="text-xs text-muted-foreground">When marks have memos, this field can stay empty.</p>}
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs">Mark memos</Label>
                  <div className="flex gap-1">
                    <Badge variant="secondary">{annotations.length} marks</Badge>
                    {selectedIds.length > 0 && <Badge variant="outline">{selectedIds.length} selected</Badge>}
                  </div>
                </div>
                <div className="max-h-44 space-y-2 overflow-y-auto rounded-md border bg-background p-2">
                  {annotations.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-muted-foreground">Draw a region, arrow, or note, then write what should change for each mark.</p>
                  ) : annotations.map((annotation, index) => (
                    <div key={annotation.id} className={`rounded border p-2 ${selectedIdSet.has(annotation.id) ? 'border-primary bg-primary/5' : 'bg-muted/20'}`}>
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <button
                          type="button"
                          className="text-xs font-medium text-left"
                          onClick={(event) => toggleAnnotationSelection(annotation.id, event.ctrlKey || event.metaKey || event.shiftKey)}
                        >
                          Mark #{index + 1} <span className="font-normal text-muted-foreground">({annotation.type})</span>
                        </button>
                        <Button type="button" variant="ghost" size="icon-xs" onClick={() => removeAnnotations([annotation.id])} aria-label={`Delete mark ${index + 1}`}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <Input
                        value={annotation.text}
                        onChange={(event) => updateAnnotationText(annotation.id, event.target.value)}
                        placeholder="Describe what should change here"
                        className="h-8 text-xs"
                      />
                    </div>
                  ))}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Select mode supports drag selection. Use Ctrl or Command when clicking marks to select more than one. Delete or Backspace removes selected marks.
                </p>
                {hasAnnotations && !hasMarkedInstructions && !prompt.trim() && (
                  <p className="text-xs text-amber-700">Add a memo to at least one mark, or write an edit request.</p>
                )}
              </div>
            </div>

            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
                <div>
                  <p className="text-sm font-medium">Create a new AI-edited version</p>
                  <p className="text-xs text-muted-foreground">Recommended: apply the prompt and marks directly. Use suggestions first only when you want to review candidate changes before applying.</p>
                </div>
                <div className="grid gap-2 sm:min-w-56">
                  <Button type="button" onClick={() => { void handleApplyPrompt(); }} disabled={!canRun || isPreparingImage || isApplyingPrompt || isSuggesting || isApplyingSuggestion}>
                    {isPreparingImage || isApplyingPrompt ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}
                    Apply annotated edit
                  </Button>
                  <Button type="button" variant="outline" onClick={() => { void handleSuggest(); }} disabled={!canPreview || isPreparingImage || isSuggesting || isApplyingPrompt}>
                    {isPreparingImage || isSuggesting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <MousePointer2 className="mr-2 h-4 w-4" />}
                    Preview suggestions
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}

        {improvements && improvements.length > 0 && (
          <div className="rounded-lg border p-3">
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium">Previewed AI suggestions</p>
                <p className="text-xs text-muted-foreground">Check one or more edits, then apply them together as a single regenerated R version.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => toggleAllSuggestions(!allSelectableSuggestionsChecked)}
                  disabled={!selectableImprovementIds.length || isApplyingSuggestion}
                >
                  {allSelectableSuggestionsChecked ? 'Clear checked' : 'Check all'}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onApplySuggestions(validSelectedImprovementIds)}
                  disabled={!canEdit || !validSelectedImprovementIds.length || isApplyingSuggestion}
                >
                  {isApplyingSuggestion ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1 h-3.5 w-3.5" />}
                  Apply checked suggestions
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              {improvements.map((imp) => (
                <div key={imp.id} className={`rounded border p-2 text-sm ${selectedImprovementIdSet.has(imp.id) ? 'border-primary bg-primary/5' : ''}`}>
                  <div className="grid gap-2 sm:grid-cols-[auto_1fr_auto] sm:items-start">
                    <Checkbox
                      checked={selectedImprovementIdSet.has(imp.id)}
                      onCheckedChange={(checked) => toggleSuggestion(imp.id, Boolean(checked))}
                      disabled={imp.applied || isApplyingSuggestion}
                      aria-label={`Select suggestion ${imp.suggestion_type ?? 'AI edit'}`}
                      className="mt-0.5"
                    />
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{imp.suggestion_type || 'AI edit'}</span>
                        {imp.priority && <Badge variant="outline" className="text-xs">{imp.priority}</Badge>}
                        {imp.applied && <Badge variant="secondary" className="text-xs">Applied</Badge>}
                      </div>
                      {imp.recommended && <p className="mt-1 text-xs text-muted-foreground">{imp.recommended}</p>}
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onApplySuggestion(imp.id)}
                      disabled={!canEdit || isApplyingSuggestion || imp.applied}
                    >
                      Apply only this
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
