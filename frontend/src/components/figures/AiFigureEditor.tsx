'use client';

import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { ArrowRight, CheckCircle2, Eraser, Loader2, MessageSquareText, MousePointer2, ShieldCheck, SquareDashedMousePointer, Trash2, Wand2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { AppliedChangeItem, Improvement, UnsupportedRequestItem, VerificationResult } from '@/lib/types';

type AnnotationTool = 'select' | 'region' | 'arrow' | 'note';
type AnnotationType = Exclude<AnnotationTool, 'select'>;

// Persisted default-ON toggle (U10c): send verify + the original request text
// on apply so the backend runs the self-verify (+ single retry) loop.
const VERIFY_STORAGE_KEY = 'labplot.ai-editor.verify-enabled';

function loadVerifyPreference(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const raw = window.localStorage.getItem(VERIFY_STORAGE_KEY);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}

export interface AiEditPayload {
  prompt: string;
  annotated_image?: string;
  verify: boolean;
}

// Chips shown after an apply action (U10b applied_changes/unsupported/dropped
// + U10c verification outcome). Built by the page from the apply response and
// the improve response's `unsupported` field.
export interface AiEditOutcome {
  appliedChanges: AppliedChangeItem[];
  unsupported: UnsupportedRequestItem[];
  droppedKeys: string[];
  verification?: VerificationResult | null;
}

function formatDottedKey(key: string): string {
  const idx = key.lastIndexOf('.');
  return idx >= 0 ? key.slice(idx + 1) : key;
}

// Zero-patch rows (the U10b "Unsupported request" carrier) are informational
// only - the backend also rejects applying them (NOTHING_TO_APPLY).
function hasApplicablePatch(imp: Improvement): boolean {
  return Boolean(imp.param_patch && Object.keys(imp.param_patch).length > 0);
}

// What the verifier should judge for the suggestion-apply paths: the text of
// the suggestions actually being applied, NOT the whole prompt box - the user
// may deliberately apply only a subset of what they asked for.
function suggestionRequestText(items: Improvement[]): string {
  return items
    .map((imp) => (imp.recommended || imp.suggestion_type || '').trim())
    .filter(Boolean)
    .join('\n');
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(unset)';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

interface Annotation {
  id: string;
  type: AnnotationType;
  displayNumber?: number;
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
  versionId?: string;
  versionNumber?: number;
  prompt: string;
  improvements: Improvement[] | null;
  isSuggesting?: boolean;
  isApplyingPrompt?: boolean;
  isApplyingSuggestion?: boolean;
  canEdit?: boolean;
  // Chips for the most recent apply action on this version, or null before any
  // apply / after the version changes.
  lastOutcome?: AiEditOutcome | null;
  onPromptChange: (value: string) => void;
  onSuggest: (request: AiEditPayload) => void;
  onApplyPrompt: (request: AiEditPayload) => void;
  onApplySuggestion: (improvementId: string, verify: boolean, originalRequest: string) => void;
  onApplySuggestions: (improvementIds: string[], verify: boolean, originalRequest: string) => void;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function fmt(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

function annotationTargetPoint(annotation: Annotation): { x: number; y: number } {
  if (annotation.type === 'region') {
    return {
      x: clampPercent(annotation.x + ((annotation.w ?? 0) / 2)),
      y: clampPercent(annotation.y + ((annotation.h ?? 0) / 2)),
    };
  }
  if (annotation.type === 'arrow') {
    return {
      x: clampPercent(annotation.x2 ?? annotation.x),
      y: clampPercent(annotation.y2 ?? annotation.y),
    };
  }
  return { x: clampPercent(annotation.x), y: clampPercent(annotation.y) };
}

function annotationBadgePoint(annotation: Annotation): { x: number; y: number } {
  if (annotation.type === 'arrow') {
    return {
      x: Math.max(3, Math.min(97, clampPercent(annotation.x))),
      y: Math.max(3, Math.min(97, clampPercent(annotation.y))),
    };
  }
  const target = annotationTargetPoint(annotation);
  return {
    x: Math.max(3, Math.min(97, target.x)),
    y: Math.max(3, Math.min(97, target.y)),
  };
}

function annotationDisplayNumber(annotation: Annotation, index: number): number {
  return Number.isFinite(annotation.displayNumber) ? annotation.displayNumber! : index + 1;
}

function nextAnnotationNumber(annotations: Annotation[]): number {
  return annotations.reduce((max, annotation, index) => (
    Math.max(max, annotationDisplayNumber(annotation, index))
  ), 0) + 1;
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
  const target = annotationTargetPoint(annotation);
  const markNumber = annotationDisplayNumber(annotation, index);
  if (annotation.type === 'region') {
    return `Mark #${markNumber} [region]. Target interpretation: edit the visible plot component(s) inside or overlapping this rectangle; use the center only as an approximate anchor, not as data. Bounds: left ${fmt(annotation.x)}, top ${fmt(annotation.y)}, width ${fmt(annotation.w ?? 0)}, height ${fmt(annotation.h ?? 0)}; center ${fmt(target.x)}, ${fmt(target.y)}. User memo: ${label}`;
  }
  if (annotation.type === 'arrow') {
    return `Mark #${markNumber} [arrow]. Target interpretation: the arrow head is the exact component to edit; the tail is only context/direction. Tail ${fmt(annotation.x)}, ${fmt(annotation.y)}; head ${fmt(target.x)}, ${fmt(target.y)}. User memo: ${label}`;
  }
  return `Mark #${markNumber} [note]. Target interpretation: edit the nearest visible plot component at this point. Point ${fmt(target.x)}, ${fmt(target.y)}. User memo: ${label}`;
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
    'Mark interpretation protocol:',
    '- [region] means the selected rectangular area is the target. Identify the plot component inside or overlapping the rectangle, such as axis tick labels, axis title, legend, bars, points, line, panel area, title/subtitle, or margins.',
    '- [arrow] means the arrow head is the target component; the arrow tail is only context. Do not apply the edit to the tail unless the memo explicitly says so.',
    '- [note] means the nearest visible component at that point is the target.',
    '- Numbered marks in the image and the numbered summaries below refer to the same marks. Satisfy each marked memo unless it conflicts with another memo.',
    '- If a mark memo requests an axis range, return both minimum and maximum in one options patch. If it requests marker shape, line type, palette, legend, labels, or size, use the corresponding supported option keys.',
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
    const badge = annotationBadgePoint(annotation);
    const labelX = (badge.x / 100) * width;
    const labelY = (badge.y / 100) * height;
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
    ctx.arc(labelX, labelY, labelRadius, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = Math.max(1.5, 1.8 * scale);
    ctx.stroke();
    ctx.fillStyle = '#2563eb';
    ctx.font = `700 ${Math.max(13, 15 * scale)}px sans-serif`;
    ctx.fillText(String(annotationDisplayNumber(annotation, index)), labelX, labelY + 0.5);
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

function dragDistance(drag: DraftDrag): number {
  return Math.hypot(drag.x2 - drag.x, drag.y2 - drag.y);
}

function loadStoredAnnotations(key: string | null): Annotation[] {
  if (!key || typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is Annotation => (
      item
      && ['region', 'arrow', 'note'].includes(item.type)
      && typeof item.id === 'string'
      && typeof item.x === 'number'
      && typeof item.y === 'number'
      && typeof item.text === 'string'
      && (item.displayNumber === undefined || typeof item.displayNumber === 'number')
      && (item.type !== 'region' || (typeof item.w === 'number' && typeof item.h === 'number'))
      && (item.type !== 'arrow' || (typeof item.x2 === 'number' && typeof item.y2 === 'number'))
    )).map((item, index) => (
      item.displayNumber === undefined ? { ...item, displayNumber: index + 1 } : item
    ));
  } catch {
    return [];
  }
}

export function AiFigureEditor({
  imageUrl,
  versionId,
  versionNumber,
  prompt,
  improvements,
  isSuggesting = false,
  isApplyingPrompt = false,
  isApplyingSuggestion = false,
  canEdit = true,
  lastOutcome = null,
  onPromptChange,
  onSuggest,
  onApplyPrompt,
  onApplySuggestion,
  onApplySuggestions,
}: AiFigureEditorProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const annotationStorageKey = versionId ? `labplot.ai-editor.annotations.${versionId}` : null;
  const skipNextAnnotationPersistRef = useRef(false);
  const [tool, setTool] = useState<AnnotationTool>('select');
  const [annotations, setAnnotations] = useState<Annotation[]>(() => loadStoredAnnotations(annotationStorageKey));
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedImprovementIds, setSelectedImprovementIds] = useState<string[]>([]);
  const [isPreparingImage, setIsPreparingImage] = useState(false);
  const [drag, setDrag] = useState<DraftDrag | null>(null);
  const [verifyEnabled, setVerifyEnabled] = useState<boolean>(loadVerifyPreference);

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const hasAnnotations = annotations.length > 0;
  const hasMarkedInstructions = annotations.some((annotation) => annotation.text.trim());
  const selectableImprovementIds = useMemo(
    () => (improvements ?? []).filter((imp) => !imp.applied && hasApplicablePatch(imp)).map((imp) => imp.id),
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
  const draftAnnotations = drag && drag.type !== 'select' && dragDistance(drag) >= 0.5 ? [{
    id: drag.id,
    type: drag.type,
    x: drag.type === 'region' ? Math.min(drag.x, drag.x2) : drag.x,
    y: drag.type === 'region' ? Math.min(drag.y, drag.y2) : drag.y,
    w: Math.abs(drag.x2 - drag.x),
    h: Math.abs(drag.y2 - drag.y),
    x2: drag.x2,
    y2: drag.y2,
    text: '',
  } as Annotation] : [];
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

  useEffect(() => {
    skipNextAnnotationPersistRef.current = true;
    setAnnotations(loadStoredAnnotations(annotationStorageKey));
    setSelectedIds([]);
  }, [annotationStorageKey]);

  useEffect(() => {
    if (skipNextAnnotationPersistRef.current) {
      skipNextAnnotationPersistRef.current = false;
      return;
    }
    if (!annotationStorageKey || typeof window === 'undefined') return;
    if (annotations.length === 0) {
      window.localStorage.removeItem(annotationStorageKey);
      return;
    }
    window.localStorage.setItem(annotationStorageKey, JSON.stringify(annotations));
  }, [annotationStorageKey, annotations]);

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
    event.preventDefault();
    const point = pointerPercent(event, stageRef.current);
    if (!point) return;
    const id = crypto.randomUUID();
    const displayNumber = nextAnnotationNumber(annotations);
    if (tool === 'note') {
      const note = { id, displayNumber, type: 'note' as const, x: point.x, y: point.y, text: '' };
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
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
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
        ? {
          id: drag.id,
          displayNumber: nextAnnotationNumber(annotations),
          type: 'region',
          x: x1,
          y: y1,
          w: x2 - x1,
          h: y2 - y1,
          text: '',
        }
        : {
          id: drag.id,
          displayNumber: nextAnnotationNumber(annotations),
          type: 'arrow',
          x: drag.x,
          y: drag.y,
          x2: drag.x2,
          y2: drag.y2,
          text: '',
        };
      setAnnotations((items) => [...items, next]);
      setSelectedIds([next.id]);
    }
    setDrag(null);
  }

  function handlePointerCancel(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDrag(null);
  }

  function removeSelected() {
    removeAnnotations(selectedIds);
  }

  function toggleVerify(checked: boolean) {
    setVerifyEnabled(checked);
    try {
      window.localStorage.setItem(VERIFY_STORAGE_KEY, checked ? '1' : '0');
    } catch {
      // localStorage unavailable - the toggle still works for this session.
    }
  }

  async function buildEditPayload(): Promise<AiEditPayload> {
    const payload: AiEditPayload = { prompt: combinedPrompt, verify: verifyEnabled };
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
              className={`relative mx-auto min-h-64 max-w-full touch-none select-none overflow-hidden rounded-md border bg-white ${tool === 'select' ? 'cursor-default' : 'cursor-crosshair'}`}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
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
                {[...annotations, ...draftAnnotations].map((annotation) => (
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
              <div className="pointer-events-none absolute inset-0">
                {annotations.map((annotation) => {
                  const target = annotationBadgePoint(annotation);
                  const index = annotations.findIndex((item) => item.id === annotation.id);
                  const markNumber = annotationDisplayNumber(annotation, index);
                  const selected = selectedIdSet.has(annotation.id);
                  return (
                    <button
                      key={annotation.id}
                      type="button"
                      aria-label={`Select mark ${markNumber} ${annotation.type}`}
                      className={`pointer-events-auto absolute flex h-7 min-w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 px-1 text-[11px] font-bold shadow-sm transition focus:outline-none focus:ring-2 focus:ring-primary/40 ${
                        selected ? 'border-slate-900 bg-slate-900 text-white' : 'border-white bg-blue-600 text-white'
                      }`}
                      style={{ left: `${target.x}%`, top: `${target.y}%` }}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleAnnotationSelection(annotation.id, event.ctrlKey || event.metaKey || event.shiftKey);
                      }}
                    >
                      {markNumber}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-[minmax(220px,0.72fr)_minmax(0,1.28fr)]">
              <div className="space-y-1">
                <div className="flex h-6 items-center">
                  <Label htmlFor="ai-editor-prompt" className="text-xs">{hasAnnotations ? 'Additional edit request (optional)' : 'Edit request'}</Label>
                </div>
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
                <div className="flex h-6 items-center justify-between gap-2">
                  <Label className="text-xs">Mark memos</Label>
                  <div className="flex gap-1">
                    <Badge variant="secondary">{annotations.length} marks</Badge>
                    {selectedIds.length > 0 && <Badge variant="outline">{selectedIds.length} selected</Badge>}
                  </div>
                </div>
                <div className="min-h-56 max-h-72 space-y-2 overflow-y-auto rounded-md border bg-background p-2">
                  {annotations.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-muted-foreground">Draw a region, arrow, or note, then write what should change for each mark.</p>
                  ) : annotations.map((annotation, index) => {
                    const markNumber = annotationDisplayNumber(annotation, index);
                    return (
                      <div key={annotation.id} className={`rounded border p-2 ${selectedIdSet.has(annotation.id) ? 'border-primary bg-primary/5' : 'bg-muted/20'}`}>
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <button
                            type="button"
                            className="text-xs font-medium text-left"
                            onClick={(event) => toggleAnnotationSelection(annotation.id, event.ctrlKey || event.metaKey || event.shiftKey)}
                          >
                            Mark #{markNumber} <span className="font-normal text-muted-foreground">({annotation.type})</span>
                          </button>
                          <Button type="button" variant="ghost" size="icon-xs" onClick={() => removeAnnotations([annotation.id])} aria-label={`Delete mark ${markNumber}`}>
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
                    );
                  })}
                </div>
                {annotations.length > 3 && (
                  <p className="text-xs text-muted-foreground">{annotations.length} marks total. Scroll the memo list to review the remaining marks.</p>
                )}
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
              <div className="mt-3 flex items-center gap-2 border-t pt-3">
                <Switch
                  id="ai-editor-verify"
                  size="sm"
                  checked={verifyEnabled}
                  onCheckedChange={toggleVerify}
                  aria-label="Verify the applied result against the request with a second AI check"
                />
                <Label htmlFor="ai-editor-verify" className="cursor-pointer text-xs text-muted-foreground">
                  Verify result (AI): after applying, check the edit against this request and retry once if it does not match.
                </Label>
              </div>
            </div>

            {(lastOutcome && (lastOutcome.appliedChanges.length > 0 || lastOutcome.unsupported.length > 0
              || lastOutcome.droppedKeys.length > 0 || lastOutcome.verification)) && (
              <div className="flex flex-wrap gap-1.5">
                {lastOutcome.verification && (() => {
                  const v = lastOutcome.verification;
                  if (v.skipped) {
                    return (
                      <Badge variant="outline" className="text-muted-foreground">
                        Verification unavailable ({v.skipped === 'AI_QUOTA_EXCEEDED' ? 'monthly AI quota reached' : v.skipped})
                      </Badge>
                    );
                  }
                  if (!v.satisfied) {
                    return (
                      <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">
                        Not fully satisfied: {v.feedback || 'the AI edit did not fully match the request.'}
                      </Badge>
                    );
                  }
                  if (v.attempts >= 2) {
                    return (
                      <Badge variant="outline" className="border-green-300 bg-green-50 text-green-700">
                        Retried once — {v.feedback || 'now matches the request.'}
                      </Badge>
                    );
                  }
                  return (
                    <Badge variant="outline" className="border-green-300 bg-green-50 text-green-700">
                      <ShieldCheck className="h-3 w-3" /> Verified
                    </Badge>
                  );
                })()}
                {lastOutcome.appliedChanges.map((change, index) => (
                  <Badge key={`applied-${index}`} variant="outline" className="border-green-300 bg-green-50 text-green-700">
                    Applied: {formatDottedKey(change.key)} {formatValue(change.from)}→{formatValue(change.to)}
                  </Badge>
                ))}
                {lastOutcome.unsupported.map((item, index) => (
                  <Badge key={`unsupported-${index}`} variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">
                    Not applied: &ldquo;{item.request}&rdquo; — {item.reason}
                  </Badge>
                ))}
                {lastOutcome.droppedKeys.map((key, index) => (
                  <Badge key={`dropped-${index}`} variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">
                    Not applied: {formatDottedKey(key)} had no visible effect
                  </Badge>
                ))}
              </div>
            )}
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
                  onClick={() => onApplySuggestions(
                    validSelectedImprovementIds,
                    verifyEnabled,
                    suggestionRequestText((improvements ?? []).filter((imp) => selectedImprovementIdSet.has(imp.id))),
                  )}
                  disabled={!canEdit || !validSelectedImprovementIds.length || isApplyingSuggestion}
                >
                  {isApplyingSuggestion ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1 h-3.5 w-3.5" />}
                  Apply checked suggestions
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              {improvements.map((imp) => {
                const applicable = hasApplicablePatch(imp);
                return (
                  <div key={imp.id} className={`rounded border p-2 text-sm ${selectedImprovementIdSet.has(imp.id) ? 'border-primary bg-primary/5' : ''}`}>
                    <div className="grid gap-2 sm:grid-cols-[auto_1fr_auto] sm:items-start">
                      <Checkbox
                        checked={selectedImprovementIdSet.has(imp.id)}
                        onCheckedChange={(checked) => toggleSuggestion(imp.id, Boolean(checked))}
                        disabled={imp.applied || isApplyingSuggestion || !applicable}
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
                      {applicable ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onApplySuggestion(imp.id, verifyEnabled, suggestionRequestText([imp]))}
                          disabled={!canEdit || isApplyingSuggestion || imp.applied}
                        >
                          Apply only this
                        </Button>
                      ) : (
                        <Badge variant="outline" className="mt-1 text-xs text-muted-foreground">Informational</Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
