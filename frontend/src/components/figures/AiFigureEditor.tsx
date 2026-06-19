'use client';

import { useMemo, useRef, useState, type PointerEvent } from 'react';
import { ArrowRight, CheckCircle2, Eraser, Loader2, MessageSquareText, MousePointer2, SquareDashedMousePointer, Wand2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { Improvement } from '@/lib/types';

type AnnotationTool = 'region' | 'arrow' | 'note';
type AnnotationType = AnnotationTool;

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
  type: 'region' | 'arrow';
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
  onSuggest: (prompt: string) => void;
  onApplyPrompt: (prompt: string) => void;
  onApplySuggestion: (improvementId: string) => void;
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
    return `${index + 1}. Region x=${fmt(annotation.x)}, y=${fmt(annotation.y)}, width=${fmt(annotation.w ?? 0)}, height=${fmt(annotation.h ?? 0)}: ${label}`;
  }
  if (annotation.type === 'arrow') {
    return `${index + 1}. Arrow from x=${fmt(annotation.x)}, y=${fmt(annotation.y)} to x=${fmt(annotation.x2 ?? annotation.x)}, y=${fmt(annotation.y2 ?? annotation.y)}: ${label}`;
  }
  return `${index + 1}. Note at x=${fmt(annotation.x)}, y=${fmt(annotation.y)}: ${label}`;
}

function buildLocalizedPrompt(prompt: string, annotations: Annotation[]): string {
  const base = prompt.trim();
  const valid = annotations.filter((annotation) => annotation.text.trim() || annotation.type !== 'note');
  if (!valid.length) return base;
  const annotationText = valid.map(annotationSummary).join('\n');
  return [
    base || 'Apply the localized edits marked on the figure preview.',
    '',
    'Localized image editing annotations:',
    'The user marked the rendered figure preview. Coordinates are percentages of the displayed image width and height. Use these annotations only to infer supported LabPlot R/ggplot parameter changes, labels, legend placement, palette, size, axis text, and existing visual options.',
    annotationText,
  ].join('\n');
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
}: AiFigureEditorProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<AnnotationTool>('region');
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DraftDrag | null>(null);

  const selected = annotations.find((annotation) => annotation.id === selectedId) ?? null;
  const combinedPrompt = useMemo(() => buildLocalizedPrompt(prompt, annotations), [annotations, prompt]);
  const canRun = canEdit && Boolean(imageUrl) && Boolean(combinedPrompt.trim());

  function updateSelectedText(value: string) {
    if (!selectedId) return;
    setAnnotations((items) => items.map((item) => item.id === selectedId ? { ...item, text: value } : item));
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!canEdit || !imageUrl) return;
    const point = pointerPercent(event, stageRef.current);
    if (!point) return;
    const id = crypto.randomUUID();
    if (tool === 'note') {
      const note = { id, type: 'note' as const, x: point.x, y: point.y, text: '' };
      setAnnotations((items) => [...items, note]);
      setSelectedId(id);
      return;
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
      setSelectedId(next.id);
    }
    setDrag(null);
  }

  function removeSelected() {
    if (!selectedId) return;
    setAnnotations((items) => items.filter((annotation) => annotation.id !== selectedId));
    setSelectedId(null);
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
              <Button type="button" size="sm" variant="ghost" onClick={() => { setAnnotations([]); setSelectedId(null); }} disabled={!annotations.length}>
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
                {[...annotations, ...(drag ? [{
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
                        stroke={selectedId === annotation.id ? '#0f172a' : '#2563eb'}
                        strokeWidth={selectedId === annotation.id ? 0.55 : 0.35}
                        strokeDasharray="1.2 0.8"
                      />
                    )}
                    {annotation.type === 'arrow' && (
                      <line
                        x1={annotation.x}
                        y1={annotation.y}
                        x2={annotation.x2 ?? annotation.x}
                        y2={annotation.y2 ?? annotation.y}
                        stroke={selectedId === annotation.id ? '#0f172a' : '#2563eb'}
                        strokeWidth={selectedId === annotation.id ? 0.65 : 0.45}
                        markerEnd="url(#ai-editor-arrowhead)"
                      />
                    )}
                    {annotation.type === 'note' && (
                      <circle
                        cx={annotation.x}
                        cy={annotation.y}
                        r={selectedId === annotation.id ? 1.75 : 1.45}
                        fill={selectedId === annotation.id ? '#0f172a' : '#2563eb'}
                      />
                    )}
                    <circle cx={annotation.x} cy={annotation.y} r={1.55} fill="#ffffff" stroke="#2563eb" strokeWidth={0.25} />
                    <text x={annotation.x} y={annotation.y + 0.55} textAnchor="middle" fontSize="2.5" fill="#2563eb" fontWeight="700">{index + 1}</text>
                  </g>
                ))}
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
                    onClick={(event) => { event.stopPropagation(); setSelectedId(annotation.id); }}
                  />
                ))}
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-[1fr_0.8fr]">
              <div className="space-y-1">
                <Label htmlFor="ai-editor-prompt" className="text-xs">Edit request</Label>
                <Textarea
                  id="ai-editor-prompt"
                  value={prompt}
                  onChange={(event) => onPromptChange(event.target.value)}
                  rows={4}
                  maxLength={2500}
                  placeholder="Example: make the bars more restrained, move the legend to the bottom, and keep x-axis labels horizontal."
                />
              </div>
              <div className="space-y-2">
                <div className="space-y-1">
                  <Label className="text-xs">Selected annotation memo</Label>
                  <Input
                    value={selected?.text ?? ''}
                    onChange={(event) => updateSelectedText(event.target.value)}
                    disabled={!selected}
                    placeholder={selected ? 'Describe what to change here' : 'Select or draw a mark'}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={removeSelected} disabled={!selected}>
                    Delete mark
                  </Button>
                  <Badge variant="secondary">{annotations.length} marks</Badge>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  This is region-based AI editing for reproducible R figures. Marks guide the AI; the result is a new R-rendered version, not a pixel-only inpaint.
                </p>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <Button type="button" onClick={() => onApplyPrompt(combinedPrompt)} disabled={!canRun || isApplyingPrompt || isSuggesting || isApplyingSuggestion}>
                {isApplyingPrompt ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}
                Apply AI edit
              </Button>
              <Button type="button" variant="outline" onClick={() => onSuggest(combinedPrompt)} disabled={!canEdit || !imageUrl || isSuggesting || isApplyingPrompt}>
                {isSuggesting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <MousePointer2 className="mr-2 h-4 w-4" />}
                Suggest edits
              </Button>
            </div>
          </>
        )}

        {improvements?.map((imp) => (
          <div key={imp.id} className="rounded border p-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{imp.suggestion_type}</span>
              {imp.priority && <Badge variant="outline" className="text-xs">{imp.priority}</Badge>}
            </div>
            {imp.recommended && <p className="mt-1 text-xs text-muted-foreground">{imp.recommended}</p>}
            <Button size="sm" variant="secondary" className="mt-2 w-full" onClick={() => onApplySuggestion(imp.id)} disabled={!canEdit || isApplyingSuggestion || imp.applied}>
              {imp.applied ? <><CheckCircle2 className="mr-1 h-3 w-3" /> Applied</> : 'Apply suggestion'}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
