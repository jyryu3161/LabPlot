'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { ArrowRight, CheckCircle2, Eraser, ListChecks, Loader2, MessageSquareText, MousePointer2, ShieldCheck, SquareDashedMousePointer, Trash2, Undo2, Wand2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type {
  AiEditMark,
  AiResolvedMarkTarget,
  AppliedChangeItem,
  FigureLayout,
  FigurePixelBox,
  Improvement,
  UnsupportedRequestItem,
  VerificationResult,
} from '@/lib/types';

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
  // Exact user-authored text/memos for provenance. `prompt` may additionally
  // contain the coordinate interpretation protocol used by the model.
  original_request?: string;
  // Structured edit scope for deterministic mark-to-plan traceability. The
  // localized prompt remains the backwards-compatible source of truth.
  marks?: AiEditMark[];
  verify: boolean;
}

export interface AiSuggestionApplyOptions {
  verify: boolean;
  original_request?: string;
  verification_request?: string;
  expected_base_version_id?: string;
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

function humanizeKey(key: string): string {
  return key
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatSettingName(path: string): string {
  if (path === 'style_preset') return 'Style preset';
  const [section, ...rest] = path.split('.');
  const key = rest.join('.') || section;
  if (section === 'mapping') return `Data mapping · ${humanizeKey(key)}`;
  return humanizeKey(key);
}

// Zero-patch rows (the U10b "Unsupported request" carrier) are informational
// only - the backend also rejects applying them (NOTHING_TO_APPLY).
function hasApplicablePatch(imp: Improvement): boolean {
  return Boolean(imp.param_patch && Object.keys(imp.param_patch).length > 0);
}

// Selected-plan audit context for suggestion-apply paths. The server keeps the
// exact original request authoritative; this summary must never redefine or
// broaden what the user asked for.
function suggestionRequestText(items: Improvement[]): string {
  return items
    .map((imp) => (imp.recommended || imp.suggestion_type || '').trim())
    .filter(Boolean)
    .join('\n');
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(unset)';
  if (typeof value === 'object') {
    const serialized = JSON.stringify(value);
    return serialized.length > 180 ? `${serialized.slice(0, 177)}…` : serialized;
  }
  return String(value);
}

interface PlannedSetting {
  path: string;
  value: unknown;
}

function plannedSettings(patch: Record<string, unknown>): PlannedSetting[] {
  const rows: PlannedSetting[] = [];
  if (patch.style_preset !== undefined) {
    rows.push({ path: 'style_preset', value: patch.style_preset });
  }
  for (const section of ['mapping', 'options'] as const) {
    const values = patch[section];
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    for (const [key, value] of Object.entries(values)) {
      if (section === 'options' && key === 'element_overrides' && value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [elementId, override] of Object.entries(value)) {
          if (!override || typeof override !== 'object' || Array.isArray(override)) continue;
          for (const [field, fieldValue] of Object.entries(override)) {
            rows.push({ path: `options.element_overrides.${elementId}.${field}`, value: fieldValue });
          }
        }
        continue;
      }
      rows.push({ path: `${section}.${key}`, value });
    }
  }
  return rows;
}

function plannedAuthorizationPaths(patch: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (patch.style_preset !== undefined) paths.push('style_preset');
  const mapping = patch.mapping;
  if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) {
    for (const key of Object.keys(mapping)) paths.push(`mapping.${key}`);
  }
  const options = patch.options;
  if (!options || typeof options !== 'object' || Array.isArray(options)) return paths;
  for (const [key, value] of Object.entries(options)) {
    if (key === 'category_colors' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const label of Object.keys(value)) paths.push(`options.category_colors.${label}`);
      continue;
    }
    if (key === 'series_styles' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [series, style] of Object.entries(value)) {
        if (!style || typeof style !== 'object' || Array.isArray(style)) continue;
        for (const field of Object.keys(style)) paths.push(`options.series_styles.${series}.${field}`);
      }
      continue;
    }
    if (key === 'element_overrides' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [elementId, override] of Object.entries(value)) {
        if (!override || typeof override !== 'object' || Array.isArray(override)) continue;
        for (const field of Object.keys(override)) paths.push(`options.element_overrides.${elementId}.${field}`);
      }
      continue;
    }
    paths.push(`options.${key}`);
  }
  return paths;
}

function plannedSettingsForImprovements(improvements: Improvement[]): PlannedSetting[] {
  const byPath = new Map<string, PlannedSetting>();
  for (const improvement of improvements) {
    for (const row of plannedSettings(improvement.param_patch ?? {})) byPath.set(row.path, row);
  }
  return Array.from(byPath.values());
}

function currentSettingValue(
  path: string,
  mapping: Record<string, unknown>,
  options: Record<string, unknown>,
  stylePreset?: string,
): unknown {
  if (path === 'style_preset') return stylePreset;
  if (path.startsWith('mapping.')) return mapping[path.slice('mapping.'.length)];
  if (!path.startsWith('options.')) return undefined;
  const key = path.slice('options.'.length);
  if (key.startsWith('element_overrides.')) {
    const nested = key.slice('element_overrides.'.length);
    const leafAt = nested.lastIndexOf('.');
    if (leafAt < 1) return undefined;
    const elementId = nested.slice(0, leafAt);
    const leaf = nested.slice(leafAt + 1);
    const overrides = options.element_overrides;
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return undefined;
    const override = (overrides as Record<string, unknown>)[elementId];
    return override && typeof override === 'object' && !Array.isArray(override)
      ? (override as Record<string, unknown>)[leaf]
      : undefined;
  }
  if (key.startsWith('category_colors.')) {
    const values = options.category_colors;
    return values && typeof values === 'object' && !Array.isArray(values)
      ? (values as Record<string, unknown>)[key.slice('category_colors.'.length)]
      : undefined;
  }
  if (key.startsWith('series_styles.')) {
    const nested = key.slice('series_styles.'.length);
    const leafAt = nested.lastIndexOf('.');
    if (leafAt < 1) return undefined;
    const series = nested.slice(0, leafAt);
    const leaf = nested.slice(leafAt + 1);
    const styles = options.series_styles;
    if (!styles || typeof styles !== 'object' || Array.isArray(styles)) return undefined;
    const style = (styles as Record<string, unknown>)[series];
    return style && typeof style === 'object' && !Array.isArray(style)
      ? (style as Record<string, unknown>)[leaf]
      : undefined;
  }
  return options[key];
}

// Renderer-effective defaults for settings the R engine fills in when the
// option is unset. Mirrors backend DEFAULT_X_TEXT_ANGLE (templates.py) and
// labplot_theme()'s legend defaults so the plan table's "Before" column
// matches what is actually drawn instead of showing "(unset)".
const TEMPLATE_X_TEXT_ANGLE: Record<string, number> = {
  heatmap: 45,
  correlation_heatmap: 45,
  parallel_coordinates: 35,
};

function effectiveSettingDefault(
  path: string,
  options: Record<string, unknown>,
  plotType?: string,
): string | null {
  if (path === 'options.x_text_angle') {
    return String(TEMPLATE_X_TEXT_ANGLE[plotType ?? ''] ?? 0);
  }
  if (path === 'options.legend_position') {
    return options.hide_legend ? 'none' : 'right';
  }
  if (path === 'options.legend_direction') {
    const position = typeof options.legend_position === 'string' && options.legend_position
      ? options.legend_position
      : (options.hide_legend ? 'none' : 'right');
    if (position === 'none') return null;
    return position === 'top' || position === 'bottom' ? 'horizontal' : 'vertical';
  }
  return null;
}

function beforeValueDisplay(
  path: string,
  mapping: Record<string, unknown>,
  options: Record<string, unknown>,
  stylePreset?: string,
  plotType?: string,
): string {
  const stored = currentSettingValue(path, mapping, options, stylePreset);
  if (stored !== null && stored !== undefined && stored !== '') return formatValue(stored);
  const fallback = effectiveSettingDefault(path, options, plotType);
  return fallback === null ? formatValue(stored) : `${fallback} (default)`;
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
  targetOverride?: AiResolvedMarkTarget;
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
  plotType?: string;
  currentMapping?: Record<string, unknown>;
  currentOptions?: Record<string, unknown>;
  currentStylePreset?: string;
  layout?: FigureLayout | null;
  isSuggesting?: boolean;
  isApplyingPrompt?: boolean;
  isApplyingSuggestion?: boolean;
  isUndoingLastEdit?: boolean;
  canUndoLastEdit?: boolean;
  canEdit?: boolean;
  // Durable receipt for the latest successfully created AI version. This is
  // intentionally independent from the current draft plan/coverage.
  appliedOutcome?: AiEditOutcome | null;
  // Unsupported coverage for the current, unapplied plan only.
  planOutcome?: AiEditOutcome | null;
  onPromptChange: (value: string) => void;
  onSuggest: (request: AiEditPayload) => void;
  onApplyPrompt: (request: AiEditPayload) => void;
  onApplySuggestion: (improvementId: string, options: AiSuggestionApplyOptions) => void;
  onApplySuggestions: (improvementIds: string[], options: AiSuggestionApplyOptions) => void;
  onUndoLastEdit?: () => void;
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

function markLabelFromNumber(value: number): string {
  let current = Math.max(1, Math.floor(value));
  let label = '';
  while (current > 0) {
    current -= 1;
    label = String.fromCharCode(65 + (current % 26)) + label;
    current = Math.floor(current / 26);
  }
  return label;
}

function annotationMarkLabel(annotation: Annotation, index: number): string {
  return markLabelFromNumber(annotationDisplayNumber(annotation, index));
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

interface MarkTargetDefinition {
  layoutKey: keyof FigureLayout;
  target: AiResolvedMarkTarget;
}

const MARK_TARGET_DEFINITIONS: MarkTargetDefinition[] = [
  { layoutKey: 'title_px', target: { type: 'title', label: 'Title', setting_path: 'options.title' } },
  { layoutKey: 'subtitle_px', target: { type: 'subtitle', label: 'Subtitle', setting_path: 'options.subtitle' } },
  { layoutKey: 'xlab_px', target: { type: 'x_label', label: 'X-axis label', setting_path: 'options.x_label' } },
  { layoutKey: 'ylab_px', target: { type: 'y_label', label: 'Y-axis label', setting_path: 'options.y_label' } },
  { layoutKey: 'x_axis_px', target: { type: 'x_axis', label: 'X axis', setting_path: 'options' } },
  { layoutKey: 'y_axis_px', target: { type: 'y_axis', label: 'Y axis', setting_path: 'options' } },
];

interface PercentBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function pixelBoxToPercentBounds(box: FigurePixelBox, layout: FigureLayout): PercentBounds | null {
  const width = layout.img_px?.w;
  const height = layout.img_px?.h;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const x0 = Math.min(box.x0, box.x1);
  const x1 = Math.max(box.x0, box.x1);
  const y0 = Math.min(box.y0, box.y1);
  const y1 = Math.max(box.y0, box.y1);
  if (![x0, x1, y0, y1].every(Number.isFinite)) return null;
  // Degenerate sidecar bands (notably an unset title) still describe the
  // deterministic edit scope. Inflate them by the same visual-sized minimum
  // used by the direct figure overlay hit regions.
  const minWidth = 14;
  const minHeight = 14;
  const paddedX0 = x1 - x0 < minWidth ? ((x0 + x1) / 2) - (minWidth / 2) : x0;
  const paddedX1 = x1 - x0 < minWidth ? ((x0 + x1) / 2) + (minWidth / 2) : x1;
  const paddedY0 = y1 - y0 < minHeight ? ((y0 + y1) / 2) - (minHeight / 2) : y0;
  const paddedY1 = y1 - y0 < minHeight ? ((y0 + y1) / 2) + (minHeight / 2) : y1;
  return {
    left: clampPercent((paddedX0 / width) * 100),
    top: clampPercent((paddedY0 / height) * 100),
    right: clampPercent((paddedX1 / width) * 100),
    bottom: clampPercent((paddedY1 / height) * 100),
  };
}

function boundsIntersectionArea(a: PercentBounds, b: PercentBounds): number {
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return width * height;
}

function pointInBounds(point: { x: number; y: number }, bounds: PercentBounds): boolean {
  return point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom;
}

const EDITABLE_TEXT_TARGET_TYPES = new Set<AiResolvedMarkTarget['type']>([
  'title',
  'subtitle',
  'x_label',
  'y_label',
]);

// Mirrors the server's _TEXT_TIER_ROLES: tick-label strips are ranked in the
// label-content tier of hit-testing so a box around crowded tick text never
// loses to the empty axis-label band right beneath it.
const TEXT_TIER_TARGET_TYPES = new Set<AiResolvedMarkTarget['type']>([
  ...EDITABLE_TEXT_TARGET_TYPES,
  'x_tick_labels',
  'y_tick_labels',
]);

function boundsArea(bounds: PercentBounds): number {
  return Math.max(0, bounds.right - bounds.left) * Math.max(0, bounds.bottom - bounds.top);
}

function textHitTolerance(layout?: FigureLayout | null): { x: number; y: number } {
  const width = layout?.img_px?.w;
  const height = layout?.img_px?.h;
  if (!Number.isFinite(width) || !Number.isFinite(height) || !width || !height) return { x: 1.2, y: 1.2 };
  return {
    x: (Math.max(8, Math.min(24, width * 0.012)) / width) * 100,
    y: (Math.max(8, Math.min(24, height * 0.012)) / height) * 100,
  };
}

function expandTextBounds(bounds: PercentBounds, layout?: FigureLayout | null): PercentBounds {
  const tolerance = textHitTolerance(layout);
  return {
    left: clampPercent(bounds.left - tolerance.x),
    top: clampPercent(bounds.top - tolerance.y),
    right: clampPercent(bounds.right + tolerance.x),
    bottom: clampPercent(bounds.bottom + tolerance.y),
  };
}

interface MarkTargetCandidate {
  target: AiResolvedMarkTarget;
  bounds: PercentBounds;
  isEditableText: boolean;
}

function markTargetCandidates(layout?: FigureLayout | null): MarkTargetCandidate[] {
  if (!layout) return [];
  const sceneCandidates = (layout.scene_elements ?? []).flatMap((element) => {
    const bounds = pixelBoxToPercentBounds(element.bbox_px, layout);
    if (!bounds) return [];
    const knownType = [
      'title', 'subtitle', 'x_label', 'y_label', 'x_axis', 'y_axis', 'bar', 'point', 'cell',
      'x_tick_labels', 'y_tick_labels', 'colorbar', 'legend',
    ].includes(element.role)
      ? element.role as AiResolvedMarkTarget['type']
      : 'scene_element';
    const semanticLabel: Partial<Record<AiResolvedMarkTarget['type'], string>> = {
      title: 'Title',
      subtitle: 'Subtitle',
      x_label: 'X-axis label',
      y_label: 'Y-axis label',
      x_axis: 'X axis',
      y_axis: 'Y axis',
      x_tick_labels: 'X-axis tick labels',
      y_tick_labels: 'Y-axis tick labels',
      colorbar: 'Continuous colorbar',
      legend: 'Legend',
      scene_element: 'Scene element',
    };
    const fallbackLabel = semanticLabel[knownType] ?? humanizeKey(element.role || 'scene element');
    const markTypeLabel = knownType === 'bar' ? 'Bar' : knownType === 'point' ? 'Point' : knownType === 'cell' ? 'Cell' : null;
    const label = markTypeLabel && (element.category || element.series)
      ? `${markTypeLabel}${element.category ? ` · ${element.category}` : ''}${element.series ? ` · ${element.series}` : ''}`
      : fallbackLabel;
    const target = {
      type: knownType,
      label,
      setting_path: element.setting_path ?? null,
      element_id: element.id,
      role: element.role,
      category: element.category,
      series: element.series,
      editable: element.editable,
      unsupported_reason: element.unsupported_reason,
      ...(element.placeholder ? { placeholder: true } : {}),
    } satisfies AiResolvedMarkTarget;
    return [{ target, bounds, isEditableText: TEXT_TIER_TARGET_TYPES.has(knownType) }];
  });
  const fallbackCandidates = MARK_TARGET_DEFINITIONS.flatMap((definition) => {
    const box = layout[definition.layoutKey];
    if (!box || typeof box !== 'object' || !('x0' in box)) return [];
    const raw = box as FigurePixelBox;
    const bounds = pixelBoxToPercentBounds(raw, layout);
    if (!bounds) return [];
    // A zero-size gtable cell means the element is not rendered (mirrors the
    // server's placeholder rule, judged on the RAW box because bounds are
    // inflated for hit tolerance). Never mutate the shared definition target.
    const degenerate = Math.abs(raw.x1 - raw.x0) <= 1 || Math.abs(raw.y1 - raw.y0) <= 1;
    return [{
      target: degenerate ? { ...definition.target, placeholder: true } : definition.target,
      bounds,
      isEditableText: TEXT_TIER_TARGET_TYPES.has(definition.target.type),
    }];
  });
  // Layouts rendered before the tick-label scene contract: synthesize the
  // same editable targets from the raw axis strips (mirrors the server's
  // legacy fallback) so old figure versions label and resolve tick-label
  // marks correctly without a re-render.
  const sceneRoles = new Set((layout.scene_elements ?? []).map((element) => element.role));
  const legacyTickCandidates = ([
    ['x_axis_px', 'x_tick_labels', 'X-axis tick labels', 'options.x_text_angle'],
    ['y_axis_px', 'y_tick_labels', 'Y-axis tick labels', 'options.y_tick_format'],
  ] as const).flatMap(([layoutKey, type, label, settingPath]) => {
    if (sceneRoles.has(type)) return [];
    const box = layout[layoutKey];
    if (!box || typeof box !== 'object' || !('x0' in box)) return [];
    const raw = box as FigurePixelBox;
    if (Math.abs(raw.x1 - raw.x0) <= 1 || Math.abs(raw.y1 - raw.y0) <= 1) return [];
    const bounds = pixelBoxToPercentBounds(raw, layout);
    return bounds ? [{
      target: { type, label, setting_path: settingPath, role: type, editable: true } satisfies AiResolvedMarkTarget,
      bounds,
      isEditableText: true,
    }] : [];
  });
  return [...sceneCandidates, ...legacyTickCandidates, ...fallbackCandidates];
}

function annotationHitsTextCandidate(
  annotation: Annotation,
  candidate: MarkTargetCandidate,
  layout?: FigureLayout | null,
): boolean {
  const expanded = expandTextBounds(candidate.bounds, layout);
  if (annotation.type === 'region') {
    const markBounds: PercentBounds = {
      left: annotation.x,
      top: annotation.y,
      right: annotation.x + (annotation.w ?? 0),
      bottom: annotation.y + (annotation.h ?? 0),
    };
    return boundsIntersectionArea(markBounds, expanded) > 0;
  }
  return pointInBounds(annotationTargetPoint(annotation), expanded);
}

function targetSelectionKey(target: AiResolvedMarkTarget): string {
  // Renderer text elements and their conservative layout fallbacks point to
  // the same setting path. Treat them as one correction target while keeping
  // individual mark overrides distinct by stable scene element id.
  if (target.setting_path && !target.setting_path.startsWith('options.element_overrides.')) {
    return `setting:${target.setting_path}:${target.type}`;
  }
  return target.element_id
    ? `element:${target.element_id}`
    : `setting:${target.setting_path ?? target.type}:${target.type}`;
}

function annotationHitsCandidate(
  annotation: Annotation,
  candidate: MarkTargetCandidate,
  layout?: FigureLayout | null,
): boolean {
  if (candidate.isEditableText) return annotationHitsTextCandidate(annotation, candidate, layout);
  if (annotation.type === 'region') {
    const markBounds: PercentBounds = {
      left: annotation.x,
      top: annotation.y,
      right: annotation.x + (annotation.w ?? 0),
      bottom: annotation.y + (annotation.h ?? 0),
    };
    return boundsIntersectionArea(markBounds, candidate.bounds) > 0;
  }
  return pointInBounds(annotationTargetPoint(annotation), candidate.bounds);
}

// The correction dropdown shows only the nearest few hit candidates: a full
// list of every overlapping band reads as indistinguishable noise.
const MAX_CORRECTION_TARGETS = 4;

function editableTargets(annotation: Annotation, layout?: FigureLayout | null): AiResolvedMarkTarget[] {
  interface ScoredTarget { target: AiResolvedMarkTarget; overlap: number; distance: number }
  const point = annotationTargetPoint(annotation);
  const markBounds: PercentBounds | null = annotation.type === 'region' ? {
    left: annotation.x,
    top: annotation.y,
    right: annotation.x + (annotation.w ?? 0),
    bottom: annotation.y + (annotation.h ?? 0),
  } : null;
  const byTarget = new Map<string, ScoredTarget>();
  for (const candidate of markTargetCandidates(layout)) {
    const { target } = candidate;
    if (
      !target.setting_path
      || target.editable === false
      || !annotationHitsCandidate(annotation, candidate, layout)
    ) continue;
    const overlap = markBounds ? boundsIntersectionArea(markBounds, candidate.bounds) : 0;
    const centerX = (candidate.bounds.left + candidate.bounds.right) / 2;
    const centerY = (candidate.bounds.top + candidate.bounds.bottom) / 2;
    const distance = Math.hypot(centerX - point.x, centerY - point.y);
    const key = targetSelectionKey(target);
    const previous = byTarget.get(key);
    // Prefer a renderer scene element with a stable id over a fallback band;
    // otherwise keep the better-scoring duplicate.
    if (
      !previous
      || (!previous.target.element_id && target.element_id)
      || (Boolean(previous.target.element_id) === Boolean(target.element_id)
        && (overlap > previous.overlap || (overlap === previous.overlap && distance < previous.distance)))
    ) {
      byTarget.set(key, { target, overlap, distance });
    }
  }
  return Array.from(byTarget.values())
    .sort((a, b) => b.overlap - a.overlap || a.distance - b.distance)
    .slice(0, MAX_CORRECTION_TARGETS)
    .map((entry) => entry.target);
}

export function resolveAnnotationTarget(annotation: Annotation, layout?: FigureLayout | null): AiResolvedMarkTarget | undefined {
  const candidates = markTargetCandidates(layout);
  if (!candidates.length) return undefined;

  if (annotation.type === 'region') {
    const markBounds: PercentBounds = {
      left: annotation.x,
      top: annotation.y,
      right: annotation.x + (annotation.w ?? 0),
      bottom: annotation.y + (annotation.h ?? 0),
    };
    const markArea = Math.max(boundsArea(markBounds), 0.0001);
    const tolerance = textHitTolerance(layout);
    const textHits = candidates.flatMap((candidate, index) => {
      if (!candidate.isEditableText || candidate.target.placeholder) return [];
      const expanded = expandTextBounds(candidate.bounds, layout);
      const rawOverlap = boundsIntersectionArea(markBounds, candidate.bounds);
      const tolerantOverlap = boundsIntersectionArea(markBounds, expanded);
      if (tolerantOverlap <= 0) return [];
      if (rawOverlap <= 0) {
        const xOverlap = Math.max(0, Math.min(markBounds.right, candidate.bounds.right) - Math.max(markBounds.left, candidate.bounds.left));
        const yOverlap = Math.max(0, Math.min(markBounds.bottom, candidate.bounds.bottom) - Math.max(markBounds.top, candidate.bounds.top));
        const xAlignment = xOverlap / Math.max(0.0001, Math.min(markBounds.right - markBounds.left, candidate.bounds.right - candidate.bounds.left));
        const yAlignment = yOverlap / Math.max(0.0001, Math.min(markBounds.bottom - markBounds.top, candidate.bounds.bottom - candidate.bounds.top));
        const xGap = Math.max(0, candidate.bounds.left - markBounds.right, markBounds.left - candidate.bounds.right);
        const yGap = Math.max(0, candidate.bounds.top - markBounds.bottom, markBounds.top - candidate.bounds.bottom);
        if (!(
          (xGap <= tolerance.x && yAlignment >= 0.25)
          || (yGap <= tolerance.y && xAlignment >= 0.25)
        )) return [];
      }
      const coverage = rawOverlap / Math.max(boundsArea(candidate.bounds), 0.0001);
      const markCoverage = rawOverlap / markArea;
      const labelCenterX = (candidate.bounds.left + candidate.bounds.right) / 2;
      const labelCenterY = (candidate.bounds.top + candidate.bounds.bottom) / 2;
      const markCenterX = (markBounds.left + markBounds.right) / 2;
      const markCenterY = (markBounds.top + markBounds.bottom) / 2;
      const distance = Math.hypot((labelCenterX - markCenterX) / 100, (labelCenterY - markCenterY) / 100);
      return [{ candidate, index, coverage, markCoverage, tolerantOverlap, distance }];
    });
    if (textHits.length) {
      textHits.sort((a, b) => (
        b.coverage - a.coverage
        || b.markCoverage - a.markCoverage
        || b.tolerantOverlap - a.tolerantOverlap
        || a.distance - b.distance
        || a.index - b.index
      ));
      return textHits[0].candidate.target;
    }

    const rawHits = candidates
      .map((candidate, index) => ({ candidate, index, overlap: boundsIntersectionArea(markBounds, candidate.bounds) }))
      .filter(({ candidate, overlap }) => overlap > 0 && !candidate.target.placeholder)
      .sort((a, b) => b.overlap - a.overlap || a.index - b.index);
    return rawHits[0]?.candidate.target;
  }

  const point = annotationTargetPoint(annotation);
  const textContaining = candidates
    .map((candidate, index) => ({
      candidate,
      index,
      raw: pointInBounds(point, candidate.bounds),
      tolerant: candidate.isEditableText && !candidate.target.placeholder
        && pointInBounds(point, expandTextBounds(candidate.bounds, layout)),
    }))
    .filter(({ tolerant }) => tolerant)
    .sort((a, b) => Number(b.raw) - Number(a.raw) || boundsArea(a.candidate.bounds) - boundsArea(b.candidate.bounds) || a.index - b.index);
  if (textContaining.length) return textContaining[0].candidate.target;
  const containing = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => !candidate.target.placeholder && pointInBounds(point, candidate.bounds))
    .sort((a, b) => boundsArea(a.candidate.bounds) - boundsArea(b.candidate.bounds) || a.index - b.index);
  return containing[0]?.candidate.target;
}

function buildEditMarks(annotations: Annotation[], layout?: FigureLayout | null, basePrompt = ''): AiEditMark[] {
  const hasGlobalRequest = Boolean(basePrompt.trim());
  return annotations.map((annotation, index) => ({ annotation, index, memo: annotation.text.trim() }))
    .filter(({ memo }) => Boolean(memo) || hasGlobalRequest)
    .slice(0, 20)
    .map(({ annotation, index, memo }) => {
      const displayNumber = annotationDisplayNumber(annotation, index);
      const target = annotationTargetPoint(annotation);
      return {
        id: annotation.id,
        label: annotationMarkLabel(annotation, index),
        display_number: displayNumber,
        type: annotation.type,
        memo,
        ...(annotation.type === 'region' ? {
          bbox_normalized: {
            x: annotation.x / 100,
            y: annotation.y / 100,
            width: (annotation.w ?? 0) / 100,
            height: (annotation.h ?? 0) / 100,
          },
        } : {
          point_normalized: { x: target.x / 100, y: target.y / 100 },
        }),
        resolved_target: resolveAnnotationTarget(annotation, layout),
        ...(annotation.targetOverride ? { target_override: annotation.targetOverride } : {}),
      };
    });
}

function annotationSummary(annotation: Annotation, index: number, layout?: FigureLayout | null): string {
  const label = annotation.text.trim() || '(no memo)';
  const target = annotationTargetPoint(annotation);
  const markNumber = annotationDisplayNumber(annotation, index);
  const markLabel = annotationMarkLabel(annotation, index);
  const inferredTarget = resolveAnnotationTarget(annotation, layout);
  const resolvedTarget = annotation.targetOverride ?? inferredTarget;
  const corrected = annotation.targetOverride
    ? ` User corrected the automatic target${inferredTarget ? ` from ${inferredTarget.label}` : ''} to ${annotation.targetOverride.label}; validate this correction against the renderer scene graph.`
    : '';
  const resolved = resolvedTarget
    ? ` Resolved edit scope: ${resolvedTarget.label} (${resolvedTarget.type}); ${resolvedTarget.setting_path ? `supported setting path ${resolvedTarget.setting_path}` : `no directly editable setting path${resolvedTarget.unsupported_reason ? ` — ${resolvedTarget.unsupported_reason}` : ''}`}.${corrected}`
    : ' Resolved edit scope: unknown; infer conservatively from the rendered image and memo.';
  if (annotation.type === 'region') {
    return `Mark ${markLabel} (#${markNumber}) [region]. Target interpretation: edit the visible plot component(s) inside or overlapping this rectangle; use the center only as an approximate anchor, not as data.${resolved} Bounds: left ${fmt(annotation.x)}, top ${fmt(annotation.y)}, width ${fmt(annotation.w ?? 0)}, height ${fmt(annotation.h ?? 0)}; center ${fmt(target.x)}, ${fmt(target.y)}. User memo: ${label}`;
  }
  if (annotation.type === 'arrow') {
    return `Mark ${markLabel} (#${markNumber}) [arrow]. Target interpretation: the arrow head is the exact component to edit; the tail is only context/direction.${resolved} Tail ${fmt(annotation.x)}, ${fmt(annotation.y)}; head ${fmt(target.x)}, ${fmt(target.y)}. User memo: ${label}`;
  }
  return `Mark ${markLabel} (#${markNumber}) [note]. Target interpretation: edit the nearest visible plot component at this point.${resolved} Point ${fmt(target.x)}, ${fmt(target.y)}. User memo: ${label}`;
}

function buildLocalizedPrompt(prompt: string, annotations: Annotation[], layout?: FigureLayout | null): string {
  const base = prompt.trim();
  const valid = annotations.filter((annotation) => annotation.text.trim() || base);
  if (!valid.length) return base;
  const annotationText = valid.map((annotation, index) => annotationSummary(annotation, index, layout)).join('\n');
  return [
    base || 'Apply the localized edits marked on the figure preview.',
    '',
    'Localized image editing annotations for R-code regeneration:',
    'The user marked the rendered figure preview. Coordinates are percentages of displayed image width and height. Interpret each mark as visual evidence for the requested change, then produce only supported LabPlot R/ggplot parameter patches.',
    'Mark interpretation protocol:',
    '- [region] means the selected rectangular area is the target. Identify the plot component inside or overlapping the rectangle, such as axis tick labels, axis title, legend, bars, points, line, panel area, title/subtitle, or margins.',
    '- [arrow] means the arrow head is the target component; the arrow tail is only context. Do not apply the edit to the tail unless the memo explicitly says so.',
    '- [note] means the nearest visible component at that point is the target.',
    '- Lettered marks in the image and the summaries below refer to the same marks. Satisfy each marked memo unless it conflicts with another memo.',
    '- When a deterministic resolved edit scope is present, keep the proposal within its supported setting path. Do not substitute a visually nearby component.',
    '- If a mark memo requests an axis range, return both minimum and maximum in one options patch. If it requests marker shape, line type, palette, legend, labels, or size, use the corresponding supported option keys.',
    'Important constraints: preserve the data and statistics; do not perform pixel inpainting; do not invent findings; do not add unsupported annotations; translate localized requests into supported options such as axis labels, title/subtitle removal, legend placement, palette, color mode, size, width/height, x-axis text angle, point/bar/line options, or existing mapping changes only when an existing column name is available.',
    'If several marks are present, satisfy all non-conflicting memos. If a memo is ambiguous, choose the smallest conservative manuscript-style change that addresses the marked region.',
    annotationText,
  ].join('\n');
}

function exactUserRequest(prompt: string, annotations: Annotation[]): string {
  const rows: string[] = [];
  if (prompt.trim()) rows.push(prompt.trim());
  annotations.forEach((annotation, index) => {
    if (!annotation.text.trim()) return;
    rows.push(`Mark ${annotationMarkLabel(annotation, index)}: ${annotation.text.trim()}`);
  });
  return rows.join('\n');
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
    ctx.fillText(annotationMarkLabel(annotation, index), labelX, labelY + 0.5);
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

function normalizedMarkLabel(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const direct = value.trim().match(/^#?\s*([a-z]+|\d+)$/i);
  const embedded = value.match(/\bmark\s*(?:#\s*)?([a-z]+|\d+)\b/i);
  const token = (direct?.[1] ?? embedded?.[1])?.toUpperCase();
  if (!token) return null;
  if (/^\d+$/.test(token)) return markLabelFromNumber(Number(token));
  return token;
}

function improvementMarkLabel(improvement: Improvement, marks: AiEditMark[]): string | null {
  const scopedMarkId = improvement.edit_scope?.mark_id ?? improvement.mark_id;
  const idMatch = marks.find((mark) => scopedMarkId && mark.id === scopedMarkId);
  if (idMatch) return idMatch.label;
  const explicit = normalizedMarkLabel(improvement.edit_scope?.mark_label ?? improvement.mark_label);
  if (explicit) return explicit;
  // Compatibility only for older servers that explicitly wrote "Mark A" or
  // "Mark #1" into a suggestion row. No response-order inference follows.
  return normalizedMarkLabel([
    improvement.suggestion_type,
    improvement.current_state,
    improvement.recommended,
  ].filter(Boolean).join(' '));
}

function improvementSupportStatus(improvement: Improvement): string | undefined {
  return improvement.edit_scope?.status ?? improvement.support_status;
}

function improvementUnsupportedReason(improvement: Improvement): string | undefined {
  return improvement.edit_scope?.reason ?? improvement.unsupported_reason;
}

function improvementConfidence(improvement: Improvement): number | undefined {
  const value = improvement.edit_scope?.confidence ?? improvement.confidence;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function dedupeUnsupported(items: UnsupportedRequestItem[]): UnsupportedRequestItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.mark_id?.trim() || 'request'}::${item.request.trim()}::${item.reason.trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unsupportedScopeKey(item: UnsupportedRequestItem, index: number): string {
  if (item.mark_id?.trim()) return `mark:${item.mark_id.trim()}`;
  const referencedLabel = normalizedMarkLabel(item.request);
  if (referencedLabel) return `mark-label:${referencedLabel}`;
  const request = normalizedWords(item.request);
  return request ? `request:${request}` : `unsupported:${index}`;
}

function uniqueNotAppliedCount(
  unsupported: UnsupportedRequestItem[],
  droppedKeys: string[],
): number {
  const scopes = new Set(unsupported.map(unsupportedScopeKey));
  for (const path of droppedKeys) {
    const normalized = path.trim();
    if (normalized) scopes.add(`dropped:${normalized}`);
  }
  return scopes.size;
}

function normalizedWords(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function unsupportedForMark(mark: AiEditMark, items: UnsupportedRequestItem[]): UnsupportedRequestItem | undefined {
  const memo = normalizedWords(mark.memo);
  return items.find((item) => {
    if (item.mark_id) return item.mark_id === mark.id;
    const referencedLabel = normalizedMarkLabel(item.request);
    if (referencedLabel) return referencedLabel === mark.label;
    const request = normalizedWords(item.request);
    return Boolean(memo.length >= 4 && request.length >= 4 && (request.includes(memo) || memo.includes(request)));
  });
}

interface MarkPlanRow {
  mark: AiEditMark;
  improvements: Improvement[];
  status: 'supported' | 'unsupported' | 'unresolved';
  reason?: string;
  confidence?: number;
}

interface SafetyBlockedChange {
  key: string;
  title: string;
  paths: string[];
  reason: string;
}

interface MarkedChangePlan {
  rows: MarkPlanRow[];
  generalImprovements: Improvement[];
  blockedChanges: SafetyBlockedChange[];
  selectableIds: string[];
  unsupportedCount: number;
}

function uniquePaths(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim()))));
}

function improvementPaths(improvement: Improvement): string[] {
  return uniquePaths([
    ...plannedAuthorizationPaths(improvement.param_patch ?? {}),
    ...(improvement.unrequested_changes ?? []),
  ]);
}

function outOfScopePaths(improvement: Improvement): string[] {
  const scope = improvement.edit_scope;
  if (!scope || !Array.isArray(scope.allowed_patch_keys)) return [];
  const allowed = new Set(scope.allowed_patch_keys);
  return plannedAuthorizationPaths(improvement.param_patch ?? {})
    .filter((path) => !allowed.has(path));
}

function buildMarkedChangePlan(
  marks: AiEditMark[],
  improvements: Improvement[],
  outcomeUnsupported: UnsupportedRequestItem[],
): MarkedChangePlan {
  const assignments = new Map(marks.map((mark) => [mark.label, [] as Improvement[]]));
  const generalImprovements: Improvement[] = [];
  const blockedImprovements: Array<{ improvement: Improvement; reason: string; paths?: string[] }> = [];
  const validLabels = new Set(marks.map((mark) => mark.label));

  for (const improvement of improvements) {
    const label = improvementMarkLabel(improvement, marks);
    const unsafePaths = outOfScopePaths(improvement);
    if (improvement.requested === false) {
      blockedImprovements.push({ improvement, reason: 'No submitted mark or general request authorized this patch.' });
      continue;
    }
    if (unsafePaths.length > 0) {
      blockedImprovements.push({
        improvement,
        reason: 'The patch contains settings outside its server-approved edit scope.',
        paths: unsafePaths,
      });
      continue;
    }
    if (improvement.edit_scope?.scope_id === 'request' && !improvement.edit_scope.mark_id) {
      generalImprovements.push(improvement);
      continue;
    }
    if (label && validLabels.has(label)) {
      assignments.get(label)!.push(improvement);
      continue;
    }
    if (label && !validLabels.has(label)) {
      blockedImprovements.push({ improvement, reason: `The response references Mark ${label}, which was not submitted.` });
      continue;
    }
    blockedImprovements.push({ improvement, reason: 'The patch has no server-proven link to a submitted mark or general request.' });
  }

  const allUnsupported = dedupeUnsupported([
    ...outcomeUnsupported,
    ...improvements.flatMap((improvement) => improvement.unsupported ?? []),
  ]);
  const rows = marks.map((mark): MarkPlanRow => {
    const items = assignments.get(mark.label) ?? [];
    const applicable = items.filter((item) => (
      hasApplicablePatch(item)
      && improvementSupportStatus(item) !== 'unsupported'
      && improvementSupportStatus(item) !== 'blocked'
    ));
    const unsupported = unsupportedForMark(mark, allUnsupported);
    const explicitReason = items.map(improvementUnsupportedReason).find(Boolean);
    const explicitUnsupported = items.some((item) => (
      improvementSupportStatus(item) === 'unsupported'
      || improvementSupportStatus(item) === 'blocked'
    ));
    const confidence = items.map(improvementConfidence).find((value): value is number => value !== undefined);
    const hasServerScope = items.some((item) => Boolean(item.edit_scope));
    if (applicable.length > 0) {
      return { mark, improvements: items, status: 'supported', confidence };
    }
    if (!hasServerScope && mark.resolved_target?.editable === false) {
      return {
        mark,
        improvements: items,
        status: 'unsupported',
        confidence,
        reason: mark.resolved_target.unsupported_reason ?? 'This rendered element is not directly editable.',
      };
    }
    if (items.length > 0 || unsupported || explicitUnsupported) {
      return {
        mark,
        improvements: items,
        status: 'unsupported',
        confidence,
        reason: explicitReason ?? unsupported?.reason ?? 'No supported setting patch was returned for this mark.',
      };
    }
    return {
      mark,
      improvements: [],
      status: 'unresolved',
      reason: 'No plan item was returned for this mark. It cannot be applied.',
    };
  });

  const blockedChanges: SafetyBlockedChange[] = blockedImprovements
    .map(({ improvement, reason, paths }) => ({
      key: `unrequested-${improvement.id}`,
      title: improvement.suggestion_type || 'Unrequested AI patch',
      paths: paths ?? improvementPaths(improvement),
      reason,
    }));

  // `skipped` is the backend's authoritative record that a proposed path did
  // not survive supported-settings validation. Keep it out of selection and
  // make the safety block visible even when the same row has another valid
  // setting that remains applicable.
  for (const improvement of improvements) {
    const skipped = uniquePaths(improvement.skipped ?? []);
    if (skipped.length) {
      blockedChanges.push({
        key: `validation-${improvement.id}`,
        title: improvement.suggestion_type || 'AI proposal',
        paths: skipped,
        reason: 'Backend supported-settings validation dropped these proposed paths.',
      });
    }
    if ((improvement.unrequested_changes?.length ?? 0) > 0 && improvement.requested !== false) {
      blockedChanges.push({
        key: `reported-unrequested-${improvement.id}`,
        title: improvement.suggestion_type || 'AI proposal',
        paths: uniquePaths(improvement.unrequested_changes ?? []),
        reason: 'The response identified these paths as outside the original request.',
      });
    }
  }

  const selectableIds = uniquePaths([
    ...rows.flatMap((row) => row.status === 'supported'
      ? row.improvements
        .filter((improvement) => !improvement.applied && hasApplicablePatch(improvement))
        .map((improvement) => improvement.id)
      : []),
    ...generalImprovements
      .filter((improvement) => (
        !improvement.applied
        && hasApplicablePatch(improvement)
        && improvementSupportStatus(improvement) !== 'unsupported'
        && improvementSupportStatus(improvement) !== 'blocked'
      ))
      .map((improvement) => improvement.id),
  ]);
  const unsupportedScopes = new Set(
    rows
      .filter((row) => row.status !== 'supported')
      .map((row) => `mark:${row.mark.id}`),
  );
  for (const improvement of generalImprovements) {
    if (
      hasApplicablePatch(improvement)
      && improvementSupportStatus(improvement) !== 'unsupported'
      && improvementSupportStatus(improvement) !== 'blocked'
    ) continue;
    const scopeId = improvement.edit_scope?.scope_id?.trim();
    const request = normalizedWords(improvement.edit_scope?.request ?? improvement.recommended ?? '');
    unsupportedScopes.add(scopeId ? `scope:${scopeId}` : `request:${request || improvement.id}`);
  }
  allUnsupported.forEach((item, index) => {
    if (marks.some((mark) => unsupportedForMark(mark, [item]))) return;
    unsupportedScopes.add(unsupportedScopeKey(item, index));
  });
  return {
    rows,
    generalImprovements,
    blockedChanges,
    selectableIds,
    unsupportedCount: unsupportedScopes.size,
  };
}

function confidenceLabel(value: number | undefined): string {
  if (value === undefined) return 'Confidence not provided';
  const percent = value <= 1 ? value * 100 : value;
  return `Confidence ${Math.max(0, Math.min(100, Math.round(percent)))}%`;
}

export function AiFigureEditor({
  imageUrl,
  versionId,
  versionNumber,
  prompt,
  improvements,
  plotType,
  currentMapping = {},
  currentOptions = {},
  currentStylePreset,
  layout,
  isSuggesting = false,
  isApplyingPrompt = false,
  isApplyingSuggestion = false,
  isUndoingLastEdit = false,
  canUndoLastEdit = false,
  canEdit = true,
  appliedOutcome = null,
  planOutcome = null,
  onPromptChange,
  onSuggest,
  onApplyPrompt,
  onApplySuggestion,
  onApplySuggestions,
  onUndoLastEdit,
}: AiFigureEditorProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const annotationStorageKey = versionId ? `labplot.ai-editor.annotations.${versionId}` : null;
  const skipNextAnnotationPersistRef = useRef(false);
  const [tool, setTool] = useState<AnnotationTool>('select');
  const [annotations, setAnnotations] = useState<Annotation[]>(() => loadStoredAnnotations(annotationStorageKey));
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedImprovementIds, setSelectedImprovementIds] = useState<string[]>([]);
  // undefined = legacy/no local planning snapshot; null = a plan deliberately
  // requested without user-authored text (general review).
  const [lastSubmittedRequest, setLastSubmittedRequest] = useState<string | null | undefined>(undefined);
  const [lastSubmittedMarks, setLastSubmittedMarks] = useState<AiEditMark[] | undefined>(undefined);
  const [isPlanStale, setIsPlanStale] = useState(false);
  const [isAwaitingPlan, setIsAwaitingPlan] = useState(false);
  const [areReceiptDetailsStale, setAreReceiptDetailsStale] = useState(false);
  const [isPreparingImage, setIsPreparingImage] = useState(false);
  const [drag, setDrag] = useState<DraftDrag | null>(null);
  const [verifyEnabled, setVerifyEnabled] = useState<boolean>(loadVerifyPreference);
  const planRequestSourceRef = useRef<Improvement[] | null>(null);
  const sawPlanRequestPendingRef = useRef(false);

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  // Server-confirmed canonical target per mark id from the latest plan. Once
  // the server has resolved a mark, the Auto-detect row displays that label
  // instead of the client's provisional inference so UI and plan agree.
  const serverTargetByMarkId = useMemo(() => {
    const map = new Map<string, AiResolvedMarkTarget>();
    for (const improvement of improvements ?? []) {
      const scope = improvement.edit_scope;
      const target = scope?.resolved_target;
      if (scope?.mark_id && target && typeof target === 'object') {
        map.set(String(scope.mark_id), target);
      }
    }
    return map;
  }, [improvements]);
  const hasAnnotations = annotations.length > 0;
  const hasMarkedInstructions = annotations.some((annotation) => annotation.text.trim());
  const currentEditMarks = useMemo(() => buildEditMarks(annotations, layout, prompt), [annotations, layout, prompt]);
  const planIsCurrent = !isPlanStale && !isAwaitingPlan;
  const activeImprovements = planIsCurrent ? improvements : null;
  const displayedPlanOutcome = planIsCurrent ? planOutcome : null;
  // Applied setting/verification evidence stays visible while the user starts
  // another draft. Unsupported/dropped details describe the old request and
  // are removed as soon as the new draft diverges.
  const displayedAppliedOutcome = useMemo(() => {
    if (!appliedOutcome || !areReceiptDetailsStale) return appliedOutcome;
    return {
      ...appliedOutcome,
      unsupported: [],
      droppedKeys: [],
    };
  }, [appliedOutcome, areReceiptDetailsStale]);
  const markedChangePlan = useMemo(() => (
    lastSubmittedMarks?.length && activeImprovements
      ? buildMarkedChangePlan(lastSubmittedMarks, activeImprovements, displayedPlanOutcome?.unsupported ?? [])
      : null
  ), [activeImprovements, displayedPlanOutcome?.unsupported, lastSubmittedMarks]);
  const selectableImprovementIds = useMemo(
    () => markedChangePlan?.selectableIds ?? (activeImprovements ?? [])
      .filter((imp) => (
        !imp.applied
        && hasApplicablePatch(imp)
        && imp.requested !== false
        && outOfScopePaths(imp).length === 0
        && improvementSupportStatus(imp) !== 'unsupported'
        && improvementSupportStatus(imp) !== 'blocked'
      ))
      .map((imp) => imp.id),
    [activeImprovements, markedChangePlan],
  );
  const validSelectedImprovementIds = useMemo(
    () => selectedImprovementIds.filter((id) => selectableImprovementIds.includes(id)),
    [selectableImprovementIds, selectedImprovementIds],
  );
  const selectedImprovementIdSet = useMemo(() => new Set(validSelectedImprovementIds), [validSelectedImprovementIds]);
  const allSelectableSuggestionsChecked = selectableImprovementIds.length > 0
    && selectableImprovementIds.every((id) => selectedImprovementIdSet.has(id));
  const combinedPrompt = useMemo(() => buildLocalizedPrompt(prompt, annotations, layout), [annotations, layout, prompt]);
  const previewAspectRatio = useMemo(() => {
    const width = Number(layout?.img_px?.w);
    const height = Number(layout?.img_px?.h);
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? width / height
      : null;
  }, [layout?.img_px?.h, layout?.img_px?.w]);
  const previewStageStyle = imageUrl && previewAspectRatio
    ? {
      aspectRatio: String(previewAspectRatio),
      // The annotation coordinate space must be the rendered bitmap itself.
      // Capping the width by the equivalent 56vh keeps the former height limit
      // without creating an object-fit letterbox inside the pointer surface.
      width: `min(100%, ${(56 * previewAspectRatio).toFixed(4)}vh)`,
    }
    : undefined;
  const skippedPlanKeys = useMemo(
    () => Array.from(new Set((activeImprovements ?? []).flatMap((improvement) => improvement.skipped ?? []))),
    [activeImprovements],
  );
  const hasAppliedResult = Boolean(displayedAppliedOutcome?.appliedChanges.length);
  const hasAppliedSuggestions = Boolean(activeImprovements?.some((improvement) => improvement.applied));
  const hasApplicationOutcome = Boolean(displayedAppliedOutcome && (
    displayedAppliedOutcome.appliedChanges.length || displayedAppliedOutcome.droppedKeys.length || displayedAppliedOutcome.verification
  ));
  const appliedNotAppliedCount = uniqueNotAppliedCount(
    displayedAppliedOutcome?.unsupported ?? [],
    displayedAppliedOutcome?.droppedKeys ?? [],
  );
  // The summary is user-request scoped: one failed Mark counts once even when
  // the plan row and provider payload carry several reasons for that Mark.
  // Prefer the response provenance here; markedChangePlan intentionally folds
  // provider reasons into per-row detail and may therefore have a lower count.
  const unsupportedCoverageCount = displayedPlanOutcome
    ? uniqueNotAppliedCount(displayedPlanOutcome.unsupported, displayedPlanOutcome.droppedKeys)
    : (markedChangePlan?.unsupportedCount ?? 0);
  const hasAppliedOutcome = Boolean(displayedAppliedOutcome && (
    displayedAppliedOutcome.appliedChanges.length
    || displayedAppliedOutcome.unsupported.length
    || displayedAppliedOutcome.droppedKeys.length
    || displayedAppliedOutcome.verification
  ));
  const hasPlanOutcome = Boolean(displayedPlanOutcome && (
    displayedPlanOutcome.unsupported.length || displayedPlanOutcome.droppedKeys.length
  ));
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

  const invalidateDraftPlan = useCallback(() => {
    const hasPlanDerivedState = Boolean(
      improvements
      || lastSubmittedRequest !== undefined
      || lastSubmittedMarks
      || planOutcome,
    );
    if (hasPlanDerivedState) setIsPlanStale(true);
    if (appliedOutcome) setAreReceiptDetailsStale(true);
    setIsAwaitingPlan(false);
    sawPlanRequestPendingRef.current = false;
    setLastSubmittedRequest(undefined);
    setLastSubmittedMarks(undefined);
    setSelectedImprovementIds([]);
  }, [appliedOutcome, improvements, lastSubmittedMarks, lastSubmittedRequest, planOutcome]);

  function updateAnnotationText(id: string, value: string) {
    invalidateDraftPlan();
    setAnnotations((items) => items.map((item) => item.id === id ? { ...item, text: value } : item));
  }

  function updateAnnotationTargetOverride(id: string, targetKey: string) {
    invalidateDraftPlan();
    const annotation = annotations.find((item) => item.id === id);
    const target = annotation
      ? editableTargets(annotation, layout).find((candidate) => targetSelectionKey(candidate) === targetKey)
      : undefined;
    setAnnotations((items) => items.map((item) => (
      item.id === id ? { ...item, targetOverride: target } : item
    )));
  }

  function removeAnnotations(ids: string[]) {
    if (!ids.length) return;
    invalidateDraftPlan();
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
      if (tagName === 'input' || tagName === 'textarea' || tagName === 'select' || tagName === 'button' || target?.isContentEditable) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        invalidateDraftPlan();
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
  }, [invalidateDraftPlan, selectedIds]);

  useEffect(() => {
    skipNextAnnotationPersistRef.current = true;
    setAnnotations(loadStoredAnnotations(annotationStorageKey));
    setSelectedIds([]);
    setSelectedImprovementIds([]);
    setLastSubmittedRequest(undefined);
    setLastSubmittedMarks(undefined);
    setIsPlanStale(false);
    setIsAwaitingPlan(false);
    setAreReceiptDetailsStale(false);
    sawPlanRequestPendingRef.current = false;
    planRequestSourceRef.current = null;
  }, [annotationStorageKey]);

  useEffect(() => {
    if (!isAwaitingPlan) return;
    if (improvements !== planRequestSourceRef.current) {
      setIsAwaitingPlan(false);
      sawPlanRequestPendingRef.current = false;
      return;
    }
    if (isSuggesting) {
      sawPlanRequestPendingRef.current = true;
      return;
    }
    if (sawPlanRequestPendingRef.current) {
      // The request settled without installing a new response (for example a
      // network/provider error). Keep the old plan invalid and hidden.
      setIsAwaitingPlan(false);
      setIsPlanStale(true);
      setLastSubmittedRequest(undefined);
      setLastSubmittedMarks(undefined);
      sawPlanRequestPendingRef.current = false;
    }
  }, [improvements, isAwaitingPlan, isSuggesting]);

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

  function toggleSuggestions(ids: string[], checked: boolean) {
    setSelectedImprovementIds((current) => {
      const idSet = new Set(ids);
      return checked
        ? Array.from(new Set([...current, ...ids]))
        : current.filter((item) => !idSet.has(item));
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
      invalidateDraftPlan();
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
      invalidateDraftPlan();
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
    const originalRequest = exactUserRequest(prompt, annotations);
    const payload: AiEditPayload = {
      prompt: combinedPrompt,
      original_request: originalRequest || undefined,
      marks: currentEditMarks.length ? currentEditMarks : undefined,
      verify: verifyEnabled,
    };
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
    setLastSubmittedRequest(exactUserRequest(prompt, annotations) || null);
    setLastSubmittedMarks(currentEditMarks);
    setIsPreparingImage(true);
    try {
      onApplyPrompt(await buildEditPayload());
    } finally {
      setIsPreparingImage(false);
    }
  }

  async function handleSuggest() {
    if (!canPreview) return;
    planRequestSourceRef.current = improvements;
    sawPlanRequestPendingRef.current = false;
    setIsPlanStale(false);
    setIsAwaitingPlan(true);
    setSelectedImprovementIds([]);
    setLastSubmittedRequest(exactUserRequest(prompt, annotations) || null);
    setLastSubmittedMarks(currentEditMarks);
    setIsPreparingImage(true);
    try {
      onSuggest(await buildEditPayload());
    } finally {
      setIsPreparingImage(false);
    }
  }

  function suggestionApplyOptions(items: Improvement[]): AiSuggestionApplyOptions {
    // Keep provenance tied to the request that produced this plan. If a legacy
    // improvement was loaded without that local snapshot, use only actual user
    // text still present in the editor; never label AI suggestion prose as the
    // user's original request.
    const originalRequest = lastSubmittedRequest === undefined
      ? exactUserRequest(prompt, annotations)
      : (lastSubmittedRequest ?? '');
    const verificationRequest = suggestionRequestText(items) || originalRequest;
    const baseVersionId = items[0]?.figure_version_id || versionId;
    return {
      verify: verifyEnabled,
      original_request: originalRequest || undefined,
      verification_request: verificationRequest || undefined,
      expected_base_version_id: baseVersionId,
    };
  }

  function handlePromptChange(value: string) {
    if (value !== prompt) invalidateDraftPlan();
    onPromptChange(value);
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>
          <h2 className="flex items-center gap-2 text-base">
            <Wand2 className="h-4 w-4 text-primary" aria-hidden="true" />
            AI editor {versionNumber ? `(v${versionNumber})` : ''}
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!canEdit ? (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">Editor access is required to create AI edits.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2" role="toolbar" aria-label="Figure marking tools">
              {[
                { key: 'select' as const, label: 'Select', icon: MousePointer2 },
                { key: 'region' as const, label: 'Region', icon: SquareDashedMousePointer },
                { key: 'arrow' as const, label: 'Arrow', icon: ArrowRight },
                { key: 'note' as const, label: 'Note', icon: MessageSquareText },
              ].map((item) => {
                const Icon = item.icon;
                return (
                  <Button
                    key={item.key}
                    type="button"
                    size="sm"
                    variant={tool === item.key ? 'default' : 'outline'}
                    aria-pressed={tool === item.key}
                    onClick={() => setTool(item.key)}
                  >
                    <Icon className="mr-1 h-3.5 w-3.5" />
                    {item.label}
                  </Button>
                );
              })}
              <Button type="button" size="sm" variant="outline" onClick={removeSelected} disabled={!selectedIds.length}>
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                Delete selected
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => { invalidateDraftPlan(); setAnnotations([]); setSelectedIds([]); }} disabled={!annotations.length}>
                <Eraser className="mr-1 h-3.5 w-3.5" />
                Clear
              </Button>
            </div>

            <div
              ref={stageRef}
              className={`relative mx-auto max-w-full touch-none select-none overflow-hidden rounded-md border bg-white ${imageUrl ? (previewAspectRatio ? '' : 'w-fit') : 'min-h-64 w-full'} ${tool === 'select' ? 'cursor-default' : 'cursor-crosshair'}`}
              style={previewStageStyle}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
            >
              {imageUrl ? (
                <img
                  src={imageUrl}
                  alt="Figure for AI editing"
                  className={previewAspectRatio ? 'block h-full w-full' : 'block h-auto max-h-[56vh] max-w-full w-auto'}
                  draggable={false}
                />
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
                  const markLabel = annotationMarkLabel(annotation, index);
                  const selected = selectedIdSet.has(annotation.id);
                  return (
                    <button
                      key={annotation.id}
                      type="button"
                      aria-label={`Select Mark ${markLabel} ${annotation.type}`}
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
                      {markLabel}
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
                  onChange={(event) => handlePromptChange(event.target.value)}
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
                    const markLabel = annotationMarkLabel(annotation, index);
                    const inferredTarget = resolveAnnotationTarget(annotation, layout);
                    const serverTarget = serverTargetByMarkId.get(annotation.id);
                    const autoDetectLabel = serverTarget?.label ?? inferredTarget?.label ?? 'Unknown target';
                    const correctionTargets = editableTargets(annotation, layout);
                    const targetSelectId = `ai-mark-target-${annotation.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
                    return (
                      <div key={annotation.id} className={`rounded border p-2 ${selectedIdSet.has(annotation.id) ? 'border-primary bg-primary/5' : 'bg-muted/20'}`}>
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <button
                            type="button"
                            className="text-xs font-medium text-left"
                            onClick={(event) => toggleAnnotationSelection(annotation.id, event.ctrlKey || event.metaKey || event.shiftKey)}
                          >
                            Mark {markLabel} <span className="font-normal text-muted-foreground">({annotation.type})</span>
                          </button>
                          <Button type="button" variant="ghost" size="icon-xs" onClick={() => removeAnnotations([annotation.id])} aria-label={`Delete Mark ${markLabel}`}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        <Input
                          value={annotation.text}
                          onChange={(event) => updateAnnotationText(annotation.id, event.target.value)}
                          placeholder="Describe what should change here"
                          className="h-8 text-xs"
                          aria-label={`Instructions for Mark ${markLabel}`}
                        />
                        <div className="mt-2 space-y-1">
                          <Label htmlFor={targetSelectId} className="text-[11px] text-muted-foreground">
                            Target for Mark {markLabel}
                          </Label>
                          <select
                            id={targetSelectId}
                            value={annotation.targetOverride ? targetSelectionKey(annotation.targetOverride) : ''}
                            onChange={(event) => updateAnnotationTargetOverride(annotation.id, event.target.value)}
                            className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                          >
                            <option value="">Auto-detect · {autoDetectLabel}{serverTarget ? ' (plan-confirmed)' : ''}</option>
                            {correctionTargets.map((target) => (
                              <option key={targetSelectionKey(target)} value={targetSelectionKey(target)}>
                                {target.label}
                              </option>
                            ))}
                          </select>
                          {annotation.targetOverride && (
                            <p className="text-[11px] text-muted-foreground">
                              User correction; the server will validate it against the rendered layout.
                            </p>
                          )}
                        </div>
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

            <section aria-label="AI editing workflow" className="rounded-lg border bg-muted/20 p-3">
              <div className="mb-3">
                <p className="text-sm font-medium">Review the change plan before applying</p>
                <ol className="mt-2 grid gap-2 text-xs sm:grid-cols-4">
                  {[
                    ['1', 'Describe', 'Write a request or mark the figure'],
                    ['2', 'Review plan', 'Check supported setting changes'],
                    ['3', 'Apply', 'Create one new R-rendered version'],
                    ['4', 'Verify', 'Compare the result with the request'],
                  ].map(([number, title, description]) => (
                    <li key={number} className="flex gap-2 rounded-md border bg-background p-2">
                      <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground" aria-hidden="true">{number}</span>
                      <span><strong className="block font-medium">{title}</strong><span className="text-muted-foreground">{description}</span></span>
                    </li>
                  ))}
                </ol>
              </div>
              <div className="grid gap-2 border-t pt-3 sm:grid-cols-[1fr_auto] sm:items-center">
                <div>
                  <p className="text-sm font-medium">Next: inspect the proposed settings</p>
                  <p className="text-xs text-muted-foreground">
                    This is a settings-only plan, not a rendered image preview. The rendered result is created only after you apply a new version.
                  </p>
                </div>
                <div className="grid gap-2 sm:min-w-60">
                  <Button type="button" onClick={() => { void handleSuggest(); }} disabled={!canPreview || isPreparingImage || isSuggesting || isAwaitingPlan || isApplyingPrompt}>
                    {isPreparingImage || isSuggesting || isAwaitingPlan ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ListChecks className="mr-2 h-4 w-4" />}
                    {isPlanStale || improvements ? 'Refresh change plan' : 'Review change plan'}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => { void handleApplyPrompt(); }} disabled={!canRun || isPreparingImage || isApplyingPrompt || isSuggesting || isAwaitingPlan || isApplyingSuggestion}>
                    {isPreparingImage || isApplyingPrompt ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}
                    Apply now (skip plan)
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
                  Verify result (AI): check the render against the request. Apply now may retry once; reviewed-plan applies report a mismatch without changing unselected settings.
                </Label>
              </div>
            </section>

            {isPlanStale && (
              <p role="status" aria-label="Change plan status" aria-live="polite" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                Marks changed. Refresh plan.
              </p>
            )}

            {hasPlanOutcome && displayedPlanOutcome && (
              <section aria-labelledby="ai-plan-coverage-heading" className="space-y-3 rounded-lg border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2" role="status" aria-live="polite">
                  <div>
                    <h3 id="ai-plan-coverage-heading" className="flex items-center gap-2 text-sm font-medium">
                      <ListChecks className="h-4 w-4 text-amber-700" aria-hidden="true" />
                      Request coverage
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Some parts of the current request cannot be represented by the supported figure settings.
                    </p>
                  </div>
                  {unsupportedCoverageCount > 0 && (
                    <Badge variant="outline" className="border-amber-400 text-amber-800 dark:text-amber-300">
                      {unsupportedCoverageCount} not applied
                    </Badge>
                  )}
                </div>
                <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                  <h4 className="font-medium">Not applied</h4>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    {displayedPlanOutcome.unsupported.map((item, index) => (
                      <li key={`plan-unsupported-${index}`}><q>{item.request}</q> — {item.reason}</li>
                    ))}
                    {displayedPlanOutcome.droppedKeys.map((key, index) => (
                      <li key={`plan-dropped-${index}`}>{formatSettingName(key)} — the proposed value had no visible effect.</li>
                    ))}
                  </ul>
                </div>
              </section>
            )}

            {hasAppliedOutcome && displayedAppliedOutcome && (
              <section aria-labelledby="ai-edit-result-heading" className="space-y-3 rounded-lg border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2" role="status" aria-live="polite">
                  <div>
                    <h3 id="ai-edit-result-heading" className="flex items-center gap-2 text-sm font-medium">
                      <CheckCircle2 className="h-4 w-4 text-green-700" aria-hidden="true" />
                      AI edit result {versionNumber ? `· v${versionNumber}` : ''}
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {hasAppliedResult
                        ? `${displayedAppliedOutcome.appliedChanges.length} setting${displayedAppliedOutcome.appliedChanges.length === 1 ? '' : 's'} changed${appliedNotAppliedCount ? `; ${appliedNotAppliedCount} request part${appliedNotAppliedCount === 1 ? '' : 's'} not applied` : ''}.`
                        : hasApplicationOutcome
                          ? 'No supported setting was applied. Review the reasons below.'
                          : 'Some parts of the request cannot be represented by the supported figure settings.'}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5" aria-label="AI edit result summary">
                    {hasAppliedResult && <Badge variant="secondary">{displayedAppliedOutcome.appliedChanges.length} applied</Badge>}
                    {appliedNotAppliedCount > 0 && <Badge variant="outline" className="border-amber-400 text-amber-800 dark:text-amber-300">{appliedNotAppliedCount} not applied</Badge>}
                  </div>
                </div>

                {displayedAppliedOutcome.appliedChanges.length > 0 && (
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full min-w-[32rem] text-left text-xs">
                      <caption className="sr-only">Settings changed by the most recent AI edit</caption>
                      <thead className="bg-muted/60">
                        <tr>
                          <th scope="col" className="px-3 py-2 font-medium">Setting</th>
                          <th scope="col" className="px-3 py-2 font-medium">Before</th>
                          <th scope="col" className="px-3 py-2 font-medium">After</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayedAppliedOutcome.appliedChanges.map((change, index) => (
                          <tr key={`${change.key}-${index}`} className="border-t align-top">
                            <th scope="row" className="px-3 py-2 font-medium">{formatSettingName(change.key)}</th>
                            <td className="max-w-52 break-words px-3 py-2 text-foreground">
                              {formatValue(change.from)}{change.from_is_default ? ' (default)' : ''}
                            </td>
                            <td className="max-w-52 break-words px-3 py-2 font-medium">{formatValue(change.to)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {displayedAppliedOutcome.verification && (() => {
                  const verification = displayedAppliedOutcome.verification;
                  const unavailable = verification.skipped
                    ? (verification.skipped === 'AI_QUOTA_EXCEEDED' ? 'Monthly AI quota reached.' : verification.skipped)
                    : null;
                  return (
                    <div className={`rounded-md border p-2 text-xs ${verification.satisfied && !unavailable ? 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/30 dark:text-green-200' : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200'}`}>
                      <p className="flex items-center gap-1.5 font-medium">
                        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> Rendered-result verification
                      </p>
                      <p className="mt-1">
                        {unavailable
                          ? `AI verification was not run: ${unavailable}`
                          : verification.satisfied
                            ? `AI verification passed${verification.attempts >= 2 ? ' after one automatic retry' : ''}. ${verification.feedback || ''}`
                            : `Needs review: ${verification.feedback || 'the rendered result did not fully match the request.'}`}
                      </p>
                    </div>
                  );
                })()}

                {(displayedAppliedOutcome.unsupported.length > 0 || displayedAppliedOutcome.droppedKeys.length > 0) && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                    <h4 className="font-medium">Not applied</h4>
                    <ul className="mt-1 list-disc space-y-1 pl-5">
                      {displayedAppliedOutcome.unsupported.map((item, index) => (
                        <li key={`unsupported-${index}`}><q>{item.request}</q> — {item.reason}</li>
                      ))}
                      {displayedAppliedOutcome.droppedKeys.map((key, index) => (
                        <li key={`dropped-${index}`}>{formatSettingName(key)} — the proposed value had no visible effect.</li>
                      ))}
                    </ul>
                  </div>
                )}

                {hasAppliedResult && canUndoLastEdit && onUndoLastEdit && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 p-2 text-xs">
                    <div className="flex min-w-0 gap-2">
                      <Undo2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <div>
                        <p className="font-medium">Undo the whole AI edit</p>
                        <p className="text-muted-foreground">Restores the exact pre-AI settings as one new version, without deleting history.</p>
                      </div>
                    </div>
                    <Button type="button" size="sm" variant="outline" onClick={onUndoLastEdit} disabled={isUndoingLastEdit}>
                      {isUndoingLastEdit ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />}
                      {isUndoingLastEdit ? 'Restoring…' : 'Undo AI edit'}
                    </Button>
                  </div>
                )}
              </section>
            )}
          </>
        )}

        {activeImprovements && activeImprovements.length > 0 && (
          <section aria-labelledby="ai-change-plan-heading" className="rounded-lg border p-3">
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 id="ai-change-plan-heading" className="text-sm font-medium">AI interpretation and settings plan</h3>
                <p className="text-xs text-muted-foreground">
                  {hasAppliedSuggestions
                    ? 'These settings were used for the applied AI version. The exact applied-settings diff is shown above.'
                    : 'Review what the AI understood and the exact supported values it proposes. No figure has been rendered or changed yet.'}
                </p>
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
                  onClick={() => {
                    const selected = activeImprovements.filter((imp) => selectedImprovementIdSet.has(imp.id));
                    onApplySuggestions(validSelectedImprovementIds, suggestionApplyOptions(selected));
                  }}
                  disabled={!canEdit || !validSelectedImprovementIds.length || isApplyingSuggestion}
                >
                  {isApplyingSuggestion ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1 h-3.5 w-3.5" />}
                  Apply selected ({validSelectedImprovementIds.length})
                </Button>
              </div>
            </div>
            <div className="mb-3 rounded-md bg-muted/40 p-2 text-xs">
              <p className="font-medium">Submitted request</p>
              <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-muted-foreground">
                {lastSubmittedRequest || 'No specific request was submitted; this is a general figure-quality plan.'}
              </p>
            </div>
            <div className="mb-3 flex flex-wrap gap-1.5" aria-label="Change plan coverage">
              <Badge variant="secondary">{selectableImprovementIds.length} applicable</Badge>
              {unsupportedCoverageCount > 0 && (
                <Badge variant="outline" className="border-amber-400 text-amber-800 dark:text-amber-300">
                  {unsupportedCoverageCount} unsupported
                </Badge>
              )}
              {skippedPlanKeys.length > 0 && (
                <Badge variant="outline" className="border-amber-400 text-amber-800 dark:text-amber-300">{skippedPlanKeys.length} excluded by validation</Badge>
              )}
            </div>
            <div className="space-y-3">
              {markedChangePlan ? (
                <>
                  <div className="space-y-3" aria-label="Marked request changes">
                    {markedChangePlan.rows.map((row) => {
                      const rowSelectableIds = row.improvements
                        .map((improvement) => improvement.id)
                        .filter((id) => selectableImprovementIds.includes(id));
                      const rowSelected = rowSelectableIds.length > 0
                        && rowSelectableIds.every((id) => selectedImprovementIdSet.has(id));
                      const rowApplied = row.improvements.length > 0
                        && row.improvements.every((improvement) => improvement.applied);
                      const settingRows = plannedSettingsForImprovements(row.improvements);
                      const headingId = `ai-mark-plan-${row.mark.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
                      const primaryScope = row.improvements.map((improvement) => improvement.edit_scope).find(Boolean);
                      const scopedTarget = primaryScope?.resolved_target
                        ?? primaryScope?.accepted_target_override
                        ?? row.mark.target_override
                        ?? row.mark.resolved_target;
                      const targetLabel = typeof scopedTarget === 'string'
                        ? scopedTarget
                        : scopedTarget?.label;
                      const settingPath = typeof scopedTarget === 'object' && scopedTarget
                        ? scopedTarget.setting_path
                        : undefined;
                      const allowedPaths = uniquePaths(row.improvements.flatMap((improvement) => (
                        improvement.edit_scope?.allowed_patch_keys ?? []
                      )));
                      const primary = row.improvements[0];
                      const typeLabel = humanizeKey(row.mark.type);
                      return (
                        <article
                          key={row.mark.id}
                          aria-labelledby={headingId}
                          className={`rounded border p-3 text-sm ${rowSelected ? 'border-primary bg-primary/5' : ''}`}
                        >
                          <div className="grid gap-2 sm:grid-cols-[auto_1fr_auto] sm:items-start">
                            <Checkbox
                              checked={rowSelected}
                              onCheckedChange={(checked) => toggleSuggestions(rowSelectableIds, Boolean(checked))}
                              disabled={row.status !== 'supported' || rowApplied || !rowSelectableIds.length || isApplyingSuggestion}
                              aria-label={`Select Mark ${row.mark.label} changes`}
                              className="mt-0.5"
                            />
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <h4 id={headingId} className="font-medium">Mark {row.mark.label} · {typeLabel}</h4>
                                <Badge
                                  variant={row.status === 'supported' ? 'secondary' : 'outline'}
                                  className={row.status === 'supported' ? 'text-xs' : 'border-amber-400 text-xs text-amber-800 dark:text-amber-300'}
                                >
                                  {row.status === 'supported' ? 'Supported' : row.status === 'unsupported' ? 'Unsupported' : 'Unresolved'}
                                </Badge>
                                <Badge variant="outline" className="text-xs">{confidenceLabel(row.confidence)}</Badge>
                                {rowApplied && <Badge variant="secondary" className="text-xs">Applied</Badge>}
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">Requested: {row.mark.memo || '(no mark memo)'}</p>
                              <p className="mt-1 text-xs">
                                <span className="font-medium">Resolved target:</span>{' '}
                                {targetLabel || 'Not resolved'}
                                {settingPath ? <span className="text-muted-foreground"> · {settingPath}</span> : null}
                              </p>
                              {row.mark.target_override && (
                                <p className="mt-1 text-xs text-muted-foreground">
                                  Requested target correction: {row.mark.target_override.label}
                                  {primaryScope?.target_override_status ? ` · ${humanizeKey(primaryScope.target_override_status)}` : ''}
                                </p>
                              )}
                              {typeof scopedTarget === 'object' && scopedTarget?.element_id && (
                                <p className="mt-1 text-xs text-muted-foreground">
                                  Element {scopedTarget.element_id}
                                  {scopedTarget.category ? ` · category ${scopedTarget.category}` : ''}
                                  {scopedTarget.series ? ` · series ${scopedTarget.series}` : ''}
                                </p>
                              )}
                              {allowedPaths.length > 0 && (
                                <p className="mt-1 text-xs text-muted-foreground">Server-approved scope: {allowedPaths.join(', ')}</p>
                              )}
                            </div>
                            {row.status === 'supported' && rowSelectableIds.length > 0 ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  const items = row.improvements.filter((improvement) => rowSelectableIds.includes(improvement.id));
                                  if (items.length === 1) onApplySuggestion(items[0].id, suggestionApplyOptions(items));
                                  else onApplySuggestions(rowSelectableIds, suggestionApplyOptions(items));
                                }}
                                disabled={!canEdit || isApplyingSuggestion || rowApplied}
                              >
                                Apply Mark {row.mark.label} only
                              </Button>
                            ) : <span />}
                          </div>

                          {row.reason && (
                            <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                              Cannot apply: {row.reason}
                            </p>
                          )}

                          {(primary?.current_state || primary?.recommended) && (
                            <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                              <div className="rounded-md bg-muted/40 p-2">
                                <dt className="font-medium">Current assessment</dt>
                                <dd className="mt-1 text-foreground">{primary.current_state || 'No current-state note was returned.'}</dd>
                              </div>
                              <div className="rounded-md bg-muted/40 p-2">
                                <dt className="font-medium">Proposed change</dt>
                                <dd className="mt-1 text-foreground">{primary.recommended || 'No explanation was returned.'}</dd>
                              </div>
                            </dl>
                          )}

                          {settingRows.length > 0 && (
                            <div className="mt-3 overflow-x-auto rounded-md border">
                              <table className="w-full min-w-80 text-left text-xs">
                                <caption className="sr-only">Before and after values for Mark {row.mark.label}</caption>
                                <thead className="bg-muted/60">
                                  <tr>
                                    <th scope="col" className="px-3 py-2 font-medium">Setting</th>
                                    <th scope="col" className="px-3 py-2 font-medium">Before</th>
                                    <th scope="col" className="px-3 py-2 font-medium">After</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {settingRows.map((setting) => (
                                    <tr key={setting.path} className="border-t align-top">
                                      <th scope="row" className="px-3 py-2 font-medium">{formatSettingName(setting.path)}</th>
                                      <td className="max-w-72 break-words px-3 py-2 text-foreground">
                                        {beforeValueDisplay(setting.path, currentMapping, currentOptions, currentStylePreset, plotType)}
                                      </td>
                                      <td className="max-w-72 break-words px-3 py-2">{formatValue(setting.value)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>

                  {markedChangePlan.generalImprovements.length > 0 && (
                    <section aria-labelledby="ai-general-request-plan-heading" className="space-y-2 rounded-md border p-2">
                      <h4 id="ai-general-request-plan-heading" className="text-sm font-medium">General request changes</h4>
                      {markedChangePlan.generalImprovements.map((improvement) => {
                        const selectable = selectableImprovementIds.includes(improvement.id);
                        const selected = selectedImprovementIdSet.has(improvement.id);
                        return (
                          <article key={improvement.id} aria-label={improvement.suggestion_type || 'General AI edit'} className="rounded border p-2 text-xs">
                            <div className="flex items-start gap-2">
                              <Checkbox
                                checked={selected}
                                onCheckedChange={(checked) => toggleSuggestion(improvement.id, Boolean(checked))}
                                disabled={!selectable || isApplyingSuggestion}
                                aria-label={`Select general request change: ${improvement.suggestion_type || 'AI edit'}`}
                              />
                              <div>
                                <p className="font-medium">{improvement.suggestion_type || 'General AI edit'}</p>
                                <p className="mt-1 text-muted-foreground">{improvement.recommended || improvement.current_state || 'No explanation was returned.'}</p>
                              </div>
                            </div>
                          </article>
                        );
                      })}
                    </section>
                  )}

                  <section aria-labelledby="ai-unrequested-plan-heading" className="rounded-md border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 id="ai-unrequested-plan-heading" className="text-sm font-medium">Unrequested changes</h4>
                      {markedChangePlan.blockedChanges.length > 0 && (
                        <Badge variant="outline" className="border-amber-400 text-xs text-amber-800 dark:text-amber-300">Blocked for safety</Badge>
                      )}
                    </div>
                    {markedChangePlan.blockedChanges.length === 0 ? (
                      <p className="mt-2 text-xs text-muted-foreground">None</p>
                    ) : (
                      <ul className="mt-2 space-y-2 text-xs">
                        {markedChangePlan.blockedChanges.map((change) => (
                          <li key={change.key} className="rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                            <p className="font-medium">{change.title}</p>
                            <p className="mt-1">
                              {change.paths.length > 0
                                ? change.paths.map(formatSettingName).join(', ')
                                : 'No supported setting path was supplied.'}
                            </p>
                            <p className="mt-1">{change.reason} Blocked for safety and excluded from Apply.</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </>
              ) : activeImprovements.map((imp) => {
                const applicable = hasApplicablePatch(imp)
                  && imp.requested !== false
                  && outOfScopePaths(imp).length === 0
                  && improvementSupportStatus(imp) !== 'unsupported'
                  && improvementSupportStatus(imp) !== 'blocked';
                const settingRows = plannedSettings(imp.param_patch);
                const headingId = `ai-suggestion-${imp.id}`;
                return (
                  <article key={imp.id} aria-labelledby={headingId} className={`rounded border p-3 text-sm ${selectedImprovementIdSet.has(imp.id) ? 'border-primary bg-primary/5' : ''}`}>
                    <div className="grid gap-2 sm:grid-cols-[auto_1fr_auto] sm:items-start">
                      <Checkbox
                        checked={selectedImprovementIdSet.has(imp.id)}
                        onCheckedChange={(checked) => toggleSuggestion(imp.id, Boolean(checked))}
                        disabled={imp.applied || isApplyingSuggestion || !applicable}
                        aria-label={`Select proposed change: ${imp.suggestion_type ?? 'AI edit'}`}
                        className="mt-0.5"
                      />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 id={headingId} className="font-medium">{imp.suggestion_type || 'AI edit'}</h4>
                          {imp.priority && <Badge variant="outline" className="text-xs">{imp.priority}</Badge>}
                          {imp.applied && <Badge variant="secondary" className="text-xs">Applied</Badge>}
                          {!applicable && <Badge variant="outline" className="border-amber-400 text-xs text-amber-800 dark:text-amber-300">Cannot apply</Badge>}
                        </div>
                      </div>
                      {applicable ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onApplySuggestion(imp.id, suggestionApplyOptions([imp]))}
                          disabled={!canEdit || isApplyingSuggestion || imp.applied}
                        >
                          Apply only this
                        </Button>
                      ) : <span />}
                    </div>

                    {(imp.current_state || imp.recommended) && (
                      <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                        <div className="rounded-md bg-muted/40 p-2">
                          <dt className="font-medium">Current assessment</dt>
                          <dd className="mt-1 text-foreground">{imp.current_state || 'No current-state note was returned.'}</dd>
                        </div>
                        <div className="rounded-md bg-muted/40 p-2">
                          <dt className="font-medium">Proposed change</dt>
                          <dd className="mt-1 text-foreground">{imp.recommended || 'No explanation was returned.'}</dd>
                        </div>
                      </dl>
                    )}

                    {settingRows.length > 0 && (
                      <div className="mt-3 overflow-x-auto rounded-md border">
                        <table className="w-full min-w-80 text-left text-xs">
                          <caption className="sr-only">Current and proposed setting values for {imp.suggestion_type || 'AI edit'}</caption>
                          <thead className="bg-muted/60">
                            <tr>
                              <th scope="col" className="px-3 py-2 font-medium">Setting</th>
                              <th scope="col" className="px-3 py-2 font-medium">Before</th>
                              <th scope="col" className="px-3 py-2 font-medium">Proposed value</th>
                            </tr>
                          </thead>
                          <tbody>
                            {settingRows.map((row) => (
                              <tr key={row.path} className="border-t align-top">
                                <th scope="row" className="px-3 py-2 font-medium">{formatSettingName(row.path)}</th>
                                <td className="max-w-72 break-words px-3 py-2 text-foreground">
                                  {beforeValueDisplay(row.path, currentMapping, currentOptions, currentStylePreset, plotType)}
                                </td>
                                <td className="max-w-72 break-words px-3 py-2">{formatValue(row.value)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {(imp.skipped?.length ?? 0) > 0 && (
                      <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
                        Not included by supported-settings validation: {imp.skipped!.map(formatSettingName).join(', ')}.
                      </p>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        )}
      </CardContent>
    </Card>
  );
}
