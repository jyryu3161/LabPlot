'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Download, Loader2, Maximize2, MousePointer2, RefreshCw, Ruler, Save, SlidersHorizontal, Type } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const EDITABLE_SELECTOR = 'path,line,polyline,polygon,rect,circle,ellipse,text,tspan';
const EDITOR_OVERLAY_SELECTOR = '[data-labplot-editor-overlay="true"]';
const HEAVY_SVG_ELEMENT_LIMIT = 1500;
const HANDLE_SIZE = 7;
const PT_PER_MM = 72 / 25.4;
const PX_PER_MM = 96 / 25.4;
const LENGTH_RE = /^(-?\d*\.?\d+(?:e[-+]?\d+)?)([a-zA-Z%]*)$/i;

const RESIZE_PRESETS = [
  { label: 'Single column', targetMm: 85, fontScale: 0.85, strokeScale: 0.75, markerScale: 0.75 },
  { label: 'Double column', targetMm: 170, fontScale: 1, strokeScale: 1, markerScale: 1 },
  { label: 'Compact panel', targetMm: 55, fontScale: 0.75, strokeScale: 0.65, markerScale: 0.65 },
];

interface TextItem {
  index: string;
  label: string;
}

interface SvgLength {
  value: number;
  unit: string;
}

interface SvgDimensions {
  width: number;
  height: number;
  unit: string;
}

interface SvgPoint {
  x: number;
  y: number;
}

interface SvgBox extends SvgPoint {
  width: number;
  height: number;
}

type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

interface MoveDragState {
  kind: 'move';
  el: SVGElement;
  pointerId: number;
  start: SvgPoint;
  baseTransform: string;
  moved: boolean;
}

interface ResizeDragState {
  kind: 'resize';
  el: SVGElement;
  pointerId: number;
  handle: ResizeHandle;
  start: SvgPoint;
  box: SvgBox;
  baseTransform: string;
  moved: boolean;
}

type DragState = MoveDragState | ResizeDragState;

interface SvgVectorEditorProps {
  svgUrl?: string | null;
  filenameBase: string;
  versionNumber?: number;
  isSaving?: boolean;
  onSaveVersion?: (svg: string) => void;
}

function sanitizeSvg(raw: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(raw, 'image/svg+xml');
  const svg = doc.querySelector('svg');
  const parserError = doc.querySelector('parsererror');
  if (!svg || parserError) throw new Error('Invalid SVG');

  doc.querySelectorAll('script,foreignObject,iframe,object,embed,link').forEach((el) => el.remove());
  doc.querySelectorAll('*').forEach((el) => {
    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith('on') || value.startsWith('javascript:')) el.removeAttribute(attr.name);
    });
  });

  svg.setAttribute('role', 'img');
  svg.setAttribute('tabindex', '0');
  svg.setAttribute('data-labplot-svg-editor-root', 'true');
  svg.style.maxWidth = '100%';
  svg.style.height = 'auto';
  svg.style.display = 'block';

  doc.querySelectorAll(EDITABLE_SELECTOR).forEach((el, index) => {
    el.setAttribute('data-labplot-editable', 'true');
    el.setAttribute('data-labplot-edit-index', String(index));
  });

  return new XMLSerializer().serializeToString(svg);
}

function colorValue(value: string | null | undefined, fallback: string): string {
  const raw = (value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
  if (/^#[0-9a-f]{3}$/i.test(raw)) {
    const chars = raw.slice(1).split('');
    return `#${chars.map((c) => c + c).join('')}`;
  }
  const rgb = raw.match(/^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/i);
  if (rgb) {
    return `#${rgb.slice(1).map((v) => Math.max(0, Math.min(255, Number(v))).toString(16).padStart(2, '0')).join('')}`;
  }
  return fallback;
}

function styleValue(el: SVGElement, prop: string): string {
  return el.style.getPropertyValue(prop) || el.getAttribute(prop) || '';
}

function roundLength(value: number): number {
  return Number(value.toFixed(2));
}

function formatLengthNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function parseSvgLength(value: string | null | undefined): SvgLength | null {
  if (!value) return null;
  const match = value.trim().match(LENGTH_RE);
  if (!match) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return { value: parsed, unit: match[2] || 'px' };
}

function svgDimensions(svg: SVGSVGElement): SvgDimensions {
  const attrWidth = parseSvgLength(svg.getAttribute('width'));
  const attrHeight = parseSvgLength(svg.getAttribute('height'));
  if (attrWidth && attrHeight) return { width: attrWidth.value, height: attrHeight.value, unit: attrWidth.unit || attrHeight.unit || 'px' };
  const viewBox = svg.getAttribute('viewBox')?.trim().split(/\s+/).map(Number);
  if (viewBox && viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    return { width: viewBox[2], height: viewBox[3], unit: attrWidth?.unit || attrHeight?.unit || 'px' };
  }
  return { width: 720, height: 500, unit: 'px' };
}

function unitToMm(value: number, unit: string): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  switch (unit) {
    case 'mm':
      return value;
    case 'cm':
      return value * 10;
    case 'in':
      return value * 25.4;
    case 'pt':
      return value / PT_PER_MM;
    case 'px':
    default:
      return value / PX_PER_MM;
  }
}

function mmToUnit(value: number, unit: string): number {
  switch (unit) {
    case 'mm':
      return value;
    case 'cm':
      return value / 10;
    case 'in':
      return value / 25.4;
    case 'pt':
      return value * PT_PER_MM;
    case 'px':
    default:
      return value * PX_PER_MM;
  }
}

function formatSvgLength(value: number, unit: string): string {
  return `${formatLengthNumber(value)}${unit || 'px'}`;
}

function scaleNumericValue(value: string | null | undefined, scale: number, allowPercent = false): string | null {
  if (!value || !Number.isFinite(scale) || scale <= 0) return null;
  const match = value.trim().match(LENGTH_RE);
  if (!match) return null;
  const unit = match[2] || '';
  if (unit === '%' && !allowPercent) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) return null;
  return `${formatLengthNumber(parsed * scale)}${unit}`;
}

function scaleNumericList(value: string | null | undefined, scale: number): string | null {
  if (!value) return null;
  let changed = false;
  const next = value.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?[a-zA-Z%]*/gi, (token) => {
    const scaled = scaleNumericValue(token, scale);
    if (!scaled) return token;
    changed = true;
    return scaled;
  });
  return changed ? next : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scaleStyleProperty(style: string, prop: string, scale: number, list = false): string {
  const pattern = new RegExp(`(${escapeRegExp(prop)}\\s*:\\s*)([^;]+)`, 'gi');
  return style.replace(pattern, (full, prefix: string, raw: string) => {
    const scaled = list ? scaleNumericList(raw, scale) : scaleNumericValue(raw, scale);
    return scaled ? `${prefix}${scaled}` : full;
  });
}

function scaleAttribute(el: Element, attr: string, scale: number, list = false): void {
  const raw = el.getAttribute(attr);
  const scaled = list ? scaleNumericList(raw, scale) : scaleNumericValue(raw, scale);
  if (scaled) el.setAttribute(attr, scaled);
}

function scaleSvgPresentation(svg: SVGSVGElement, scales: { font: number; stroke: number; marker: number }): void {
  const fontScale = Number.isFinite(scales.font) && scales.font > 0 ? scales.font : 1;
  const strokeScale = Number.isFinite(scales.stroke) && scales.stroke > 0 ? scales.stroke : 1;
  const markerScale = Number.isFinite(scales.marker) && scales.marker > 0 ? scales.marker : 1;

  svg.querySelectorAll('*').forEach((el) => {
    if (el.closest(EDITOR_OVERLAY_SELECTOR)) return;

    if (fontScale !== 1) {
      scaleAttribute(el, 'font-size', fontScale);
      scaleAttribute(el, 'textLength', fontScale);
      scaleAttribute(el, 'letter-spacing', fontScale);
      scaleAttribute(el, 'word-spacing', fontScale);
    }

    if (strokeScale !== 1) {
      scaleAttribute(el, 'stroke-width', strokeScale);
      scaleAttribute(el, 'stroke-dashoffset', strokeScale);
      scaleAttribute(el, 'stroke-dasharray', strokeScale, true);
    }

    if (markerScale !== 1) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'circle') scaleAttribute(el, 'r', markerScale);
      if (tag === 'ellipse') {
        scaleAttribute(el, 'rx', markerScale);
        scaleAttribute(el, 'ry', markerScale);
      }
      if (tag === 'marker') {
        scaleAttribute(el, 'markerWidth', markerScale);
        scaleAttribute(el, 'markerHeight', markerScale);
      }
    }

    const style = el.getAttribute('style');
    if (!style) return;
    let nextStyle = style;
    if (fontScale !== 1) {
      nextStyle = scaleStyleProperty(nextStyle, 'font-size', fontScale);
      nextStyle = scaleStyleProperty(nextStyle, 'letter-spacing', fontScale);
      nextStyle = scaleStyleProperty(nextStyle, 'word-spacing', fontScale);
    }
    if (strokeScale !== 1) {
      nextStyle = scaleStyleProperty(nextStyle, 'stroke-width', strokeScale);
      nextStyle = scaleStyleProperty(nextStyle, 'stroke-dashoffset', strokeScale);
      nextStyle = scaleStyleProperty(nextStyle, 'stroke-dasharray', strokeScale, true);
    }
    if (nextStyle !== style) el.setAttribute('style', nextStyle);
  });
}

function pointFromMatrix(x: number, y: number, matrix: DOMMatrix | SVGMatrix): SvgPoint {
  return {
    x: matrix.a * x + matrix.c * y + matrix.e,
    y: matrix.b * x + matrix.d * y + matrix.f,
  };
}

function boxFromPoints(points: SvgPoint[]): SvgBox {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(1, Math.max(...xs) - x),
    height: Math.max(1, Math.max(...ys) - y),
  };
}

function elementBoxInSpace(el: SVGElement, target: SVGGraphicsElement): SvgBox | null {
  const graphics = el as SVGGraphicsElement;
  if (typeof graphics.getBBox !== 'function' || typeof graphics.getCTM !== 'function') return null;
  try {
    const bbox = graphics.getBBox();
    const elCtm = graphics.getCTM();
    const targetCtm = target.getCTM();
    if (!elCtm || !targetCtm) return null;
    const matrix = targetCtm.inverse().multiply(elCtm);
    return boxFromPoints([
      pointFromMatrix(bbox.x, bbox.y, matrix),
      pointFromMatrix(bbox.x + bbox.width, bbox.y, matrix),
      pointFromMatrix(bbox.x + bbox.width, bbox.y + bbox.height, matrix),
      pointFromMatrix(bbox.x, bbox.y + bbox.height, matrix),
    ]);
  } catch {
    return null;
  }
}

function parentGraphicsElement(el: SVGElement): SVGGraphicsElement | null {
  const parent = el.parentElement as SVGGraphicsElement | null;
  if (parent && typeof parent.getCTM === 'function') return parent;
  return el.ownerSVGElement;
}

function resizeHandlePoints(box: SvgBox): Array<{ handle: ResizeHandle; x: number; y: number; cursor: string }> {
  const midX = box.x + box.width / 2;
  const midY = box.y + box.height / 2;
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  return [
    { handle: 'nw', x: box.x, y: box.y, cursor: 'nwse-resize' },
    { handle: 'n', x: midX, y: box.y, cursor: 'ns-resize' },
    { handle: 'ne', x: right, y: box.y, cursor: 'nesw-resize' },
    { handle: 'e', x: right, y: midY, cursor: 'ew-resize' },
    { handle: 'se', x: right, y: bottom, cursor: 'nwse-resize' },
    { handle: 's', x: midX, y: bottom, cursor: 'ns-resize' },
    { handle: 'sw', x: box.x, y: bottom, cursor: 'nesw-resize' },
    { handle: 'w', x: box.x, y: midY, cursor: 'ew-resize' },
  ];
}

function removeSelectionOverlay(svg: SVGSVGElement | null): void {
  svg?.querySelectorAll(EDITOR_OVERLAY_SELECTOR).forEach((el) => el.remove());
}

function renderSelectionOverlay(el: SVGElement | null): void {
  const svg = el?.ownerSVGElement ?? null;
  if (!svg || !el) {
    removeSelectionOverlay(svg);
    return;
  }
  removeSelectionOverlay(svg);
  const box = elementBoxInSpace(el, svg);
  if (!box) return;

  const ns = 'http://www.w3.org/2000/svg';
  const overlay = document.createElementNS(ns, 'g');
  overlay.setAttribute('data-labplot-editor-overlay', 'true');

  const rect = document.createElementNS(ns, 'rect');
  rect.setAttribute('x', formatLengthNumber(box.x));
  rect.setAttribute('y', formatLengthNumber(box.y));
  rect.setAttribute('width', formatLengthNumber(box.width));
  rect.setAttribute('height', formatLengthNumber(box.height));
  rect.setAttribute('fill', 'none');
  rect.setAttribute('stroke', '#2563eb');
  rect.setAttribute('stroke-width', '1.5');
  rect.setAttribute('stroke-dasharray', '4 3');
  rect.setAttribute('vector-effect', 'non-scaling-stroke');
  rect.setAttribute('pointer-events', 'none');
  overlay.appendChild(rect);

  resizeHandlePoints(box).forEach((point) => {
    const handle = document.createElementNS(ns, 'rect');
    handle.setAttribute('x', formatLengthNumber(point.x - HANDLE_SIZE / 2));
    handle.setAttribute('y', formatLengthNumber(point.y - HANDLE_SIZE / 2));
    handle.setAttribute('width', String(HANDLE_SIZE));
    handle.setAttribute('height', String(HANDLE_SIZE));
    handle.setAttribute('rx', '1.5');
    handle.setAttribute('fill', '#ffffff');
    handle.setAttribute('stroke', '#2563eb');
    handle.setAttribute('stroke-width', '1.25');
    handle.setAttribute('vector-effect', 'non-scaling-stroke');
    handle.setAttribute('data-labplot-resize-handle', point.handle);
    handle.style.cursor = point.cursor;
    overlay.appendChild(handle);
  });

  svg.appendChild(overlay);
}

function editableFromTarget(target: Element | null, host: HTMLDivElement | null): SVGElement | null {
  if (!target || !host) return null;
  const editable = target.closest('[data-labplot-editable="true"]') as SVGElement | null;
  if (!editable || !host.contains(editable)) return null;
  if (editable.tagName.toLowerCase() === 'tspan') {
    const parentText = editable.closest('text') as SVGElement | null;
    if (parentText && host.contains(parentText)) return parentText;
  }
  return editable;
}

function pointerToLocalPoint(el: SVGElement, clientX: number, clientY: number): SvgPoint | null {
  const svg = el.ownerSVGElement;
  if (!svg) return null;
  const point = svg.createSVGPoint();
  point.x = clientX;
  point.y = clientY;
  const parent = el.parentElement as SVGGraphicsElement | null;
  const ctm = typeof parent?.getScreenCTM === 'function' ? parent.getScreenCTM() : svg.getScreenCTM();
  if (!ctm) return null;
  const local = point.matrixTransform(ctm.inverse());
  return { x: local.x, y: local.y };
}

function translatedTransform(baseTransform: string, dx: number, dy: number): string {
  const translate = `translate(${formatLengthNumber(dx)} ${formatLengthNumber(dy)})`;
  const base = baseTransform.trim();
  return base ? `${base} ${translate}` : translate;
}

function scaledTransform(baseTransform: string, box: SvgBox, handle: ResizeHandle, dx: number, dy: number, keepAspect: boolean): string {
  let left = box.x;
  let right = box.x + box.width;
  let top = box.y;
  let bottom = box.y + box.height;

  if (handle.includes('e')) right += dx;
  if (handle.includes('w')) left += dx;
  if (handle.includes('s')) bottom += dy;
  if (handle.includes('n')) top += dy;

  const horizontal = handle.includes('e') || handle.includes('w');
  const vertical = handle.includes('n') || handle.includes('s');
  let sx = horizontal ? Math.max(0.05, (right - left) / Math.max(1, box.width)) : 1;
  let sy = vertical ? Math.max(0.05, (bottom - top) / Math.max(1, box.height)) : 1;

  if (keepAspect && horizontal && vertical) {
    const scale = Math.max(sx, sy);
    sx = scale;
    sy = scale;
  }

  const anchorX = handle.includes('e') ? box.x : handle.includes('w') ? box.x + box.width : box.x + box.width / 2;
  const anchorY = handle.includes('s') ? box.y : handle.includes('n') ? box.y + box.height : box.y + box.height / 2;
  const scale = `translate(${formatLengthNumber(anchorX)} ${formatLengthNumber(anchorY)}) scale(${formatLengthNumber(sx)} ${formatLengthNumber(sy)}) translate(${formatLengthNumber(-anchorX)} ${formatLengthNumber(-anchorY)})`;
  const base = baseTransform.trim();
  return base ? `${base} ${scale}` : scale;
}

function resizeHandleFromTarget(target: Element | null): ResizeHandle | null {
  const handle = target?.closest('[data-labplot-resize-handle]')?.getAttribute('data-labplot-resize-handle');
  return handle && ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'].includes(handle) ? handle as ResizeHandle : null;
}

function selectedEditable(host: HTMLDivElement | null): SVGElement | null {
  return host?.querySelector('[data-labplot-selected="true"]') as SVGElement | null;
}

function cleanEditorAttributes(svg: SVGSVGElement): void {
  removeSelectionOverlay(svg);
  svg.querySelectorAll('[data-labplot-editable],[data-labplot-edit-index],[data-labplot-selected]').forEach((el) => {
    el.removeAttribute('data-labplot-editable');
    el.removeAttribute('data-labplot-edit-index');
    el.removeAttribute('data-labplot-selected');
  });
  svg.removeAttribute('data-labplot-svg-editor-root');
}

function safeFilename(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'figure';
}

export function SvgVectorEditor({ svgUrl, filenameBase, versionNumber, isSaving = false, onSaveVersion }: SvgVectorEditorProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const presentationScaleRef = useRef({ font: 1, stroke: 1, marker: 1 });
  const baselineWidthMmRef = useRef<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressNextClickRef = useRef(false);
  const suppressClickTimerRef = useRef<number | null>(null);
  const [svgMarkup, setSvgMarkup] = useState('');
  const [originalMarkup, setOriginalMarkup] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedLabel, setSelectedLabel] = useState('No element selected');
  const [selectedTag, setSelectedTag] = useState('');
  const [elementCount, setElementCount] = useState(0);
  const [textItems, setTextItems] = useState<TextItem[]>([]);
  const [fillColor, setFillColor] = useState('#000000');
  const [strokeColor, setStrokeColor] = useState('#000000');
  const [strokeWidth, setStrokeWidth] = useState('0.75');
  const [textValue, setTextValue] = useState('');
  const [svgWidth, setSvgWidth] = useState(720);
  const [svgHeight, setSvgHeight] = useState(500);
  const [svgUnit, setSvgUnit] = useState('px');
  const [lockAspect, setLockAspect] = useState(true);
  const [targetWidthMm, setTargetWidthMm] = useState(85);
  const [fontScale, setFontScale] = useState(0.85);
  const [strokeScaleResize, setStrokeScaleResize] = useState(0.75);
  const [markerScale, setMarkerScale] = useState(0.75);

  const refreshTextItems = useCallback(() => {
    const host = stageRef.current;
    if (!host) return;
    const items = Array.from(host.querySelectorAll('text,tspan'))
      .map((el) => {
        const label = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const index = el.getAttribute('data-labplot-edit-index');
        return index && label ? { index, label: label.slice(0, 80) } : null;
      })
      .filter((item): item is TextItem => Boolean(item));
    setTextItems(items.slice(0, 300));
  }, []);

  const syncControls = useCallback((el: SVGElement | null) => {
    if (!el) {
      setSelectedLabel('No element selected');
      setSelectedTag('');
      setTextValue('');
      return;
    }
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    setSelectedTag(tag);
    setSelectedLabel(text ? `${tag}: ${text.slice(0, 48)}` : tag);
    setFillColor(colorValue(styleValue(el, 'fill'), '#000000'));
    setStrokeColor(colorValue(styleValue(el, 'stroke'), '#000000'));
    const parsedStrokeWidth = parseFloat(styleValue(el, 'stroke-width'));
    setStrokeWidth(String(Number.isFinite(parsedStrokeWidth) ? parsedStrokeWidth : 0.75));
    setTextValue(tag === 'text' || tag === 'tspan' ? (el.textContent || '') : '');
  }, []);

  const selectElement = useCallback((el: SVGElement | null) => {
    const host = stageRef.current;
    if (!host) return;
    selectedEditable(host)?.removeAttribute('data-labplot-selected');
    if (!el) {
      removeSelectionOverlay(host.querySelector('svg') as SVGSVGElement | null);
      syncControls(null);
      return;
    }
    el.setAttribute('data-labplot-selected', 'true');
    renderSelectionOverlay(el);
    syncControls(el);
  }, [syncControls]);

  const suppressNextStageClick = useCallback(() => {
    suppressNextClickRef.current = true;
    if (suppressClickTimerRef.current !== null) window.clearTimeout(suppressClickTimerRef.current);
    suppressClickTimerRef.current = window.setTimeout(() => {
      suppressNextClickRef.current = false;
      suppressClickTimerRef.current = null;
    }, 350);
  }, []);

  const syncSvgSize = useCallback((resetBaseline = false) => {
    const svg = stageRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svg) return;
    const dims = svgDimensions(svg);
    const widthMm = unitToMm(dims.width, dims.unit);
    setSvgWidth(roundLength(dims.width));
    setSvgHeight(roundLength(dims.height));
    setSvgUnit(dims.unit);
    if (widthMm) {
      if (resetBaseline || baselineWidthMmRef.current === null) baselineWidthMmRef.current = widthMm;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadSvg() {
      if (stageRef.current) stageRef.current.innerHTML = '';
      presentationScaleRef.current = { font: 1, stroke: 1, marker: 1 };
      baselineWidthMmRef.current = null;
      setSvgMarkup('');
      setOriginalMarkup('');
      setError(null);
      setElementCount(0);
      setTextItems([]);
      syncControls(null);

      if (!svgUrl) return;

      setLoading(true);
      try {
        const res = await fetch(svgUrl, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`SVG load failed (${res.status})`);
        const raw = await res.text();
        if (cancelled) return;
        const cleaned = sanitizeSvg(raw);
        setSvgMarkup(cleaned);
        setOriginalMarkup(cleaned);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'SVG load failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadSvg();

    return () => {
      cancelled = true;
      if (suppressClickTimerRef.current !== null) window.clearTimeout(suppressClickTimerRef.current);
    };
  }, [svgUrl, syncControls]);

  useEffect(() => {
    const host = stageRef.current;
    if (!host || !svgMarkup) return;
    host.innerHTML = svgMarkup;
    setElementCount(host.querySelectorAll(EDITABLE_SELECTOR).length);
    syncSvgSize(true);
    refreshTextItems();
  }, [svgMarkup, refreshTextItems, syncSvgSize]);

  function handleStageClick(event: MouseEvent<HTMLDivElement>) {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (resizeHandleFromTarget(event.target as Element | null)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = event.target as Element | null;
    const host = stageRef.current;
    if (!target || !host) return;
    const editable = editableFromTarget(target, host);
    if (!editable) {
      selectElement(null);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    selectElement(editable);
  }

  function handleStagePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const host = stageRef.current;
    host?.focus();
    const handle = resizeHandleFromTarget(event.target as Element | null);
    if (handle) {
      suppressNextStageClick();
      const selected = selectedEditable(host);
      const parent = selected ? parentGraphicsElement(selected) : null;
      if (!selected || !parent) return;
      const start = pointerToLocalPoint(selected, event.clientX, event.clientY);
      const box = elementBoxInSpace(selected, parent);
      if (!start || !box) return;
      dragRef.current = {
        kind: 'resize',
        el: selected,
        pointerId: event.pointerId,
        handle,
        start,
        box,
        baseTransform: selected.getAttribute('transform') || '',
        moved: false,
      };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture can fail if the browser has already cancelled the pointer.
      }
      event.preventDefault();
      return;
    }

    const editable = editableFromTarget(event.target as Element | null, host);
    if (!editable) return;
    suppressNextStageClick();
    const start = pointerToLocalPoint(editable, event.clientX, event.clientY);
    if (!start) return;
    selectElement(editable);
    dragRef.current = {
      kind: 'move',
      el: editable,
      pointerId: event.pointerId,
      start,
      baseTransform: editable.getAttribute('transform') || '',
      moved: false,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can fail if the browser has already cancelled the pointer.
    }
    event.preventDefault();
  }

  function handleStagePointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = pointerToLocalPoint(drag.el, event.clientX, event.clientY);
    if (!point) return;
    const dx = point.x - drag.start.x;
    const dy = point.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < 0.5) return;
    drag.moved = true;
    if (drag.kind === 'resize') {
      drag.el.setAttribute('transform', scaledTransform(drag.baseTransform, drag.box, drag.handle, dx, dy, event.shiftKey));
    } else {
      drag.el.setAttribute('transform', translatedTransform(drag.baseTransform, dx, dy));
    }
    renderSelectionOverlay(drag.el);
    event.preventDefault();
  }

  function finishStageDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.moved) syncControls(drag.el);
    renderSelectionOverlay(drag.el);
    dragRef.current = null;
  }

  function nudgeSelected(dx: number, dy: number) {
    const el = selectedEditable(stageRef.current);
    if (!el) return;
    el.setAttribute('transform', translatedTransform(el.getAttribute('transform') || '', dx, dy));
    renderSelectionOverlay(el);
    syncControls(el);
  }

  function handleStageKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 10 : 1;
    if (event.key === 'ArrowLeft') {
      nudgeSelected(-step, 0);
    } else if (event.key === 'ArrowRight') {
      nudgeSelected(step, 0);
    } else if (event.key === 'ArrowUp') {
      nudgeSelected(0, -step);
    } else if (event.key === 'ArrowDown') {
      nudgeSelected(0, step);
    } else {
      return;
    }
    event.preventDefault();
  }

  function applyStyle(prop: string, value: string) {
    const el = selectedEditable(stageRef.current);
    if (!el) return;
    el.style.setProperty(prop, value);
    renderSelectionOverlay(el);
    syncControls(el);
  }

  function applyText(value: string) {
    const el = selectedEditable(stageRef.current);
    if (!el) return;
    const tag = el.tagName.toLowerCase();
    if (tag !== 'text' && tag !== 'tspan') return;
    el.textContent = value;
    setTextValue(value);
    renderSelectionOverlay(el);
    syncControls(el);
    refreshTextItems();
  }

  function applySvgSize(width: number, height: number, unit = svgUnit) {
    const svg = stageRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svg) return false;
    const nextWidth = Math.max(24, Math.min(4800, roundLength(width)));
    const nextHeight = Math.max(24, Math.min(4800, roundLength(height)));
    const widthAttr = formatSvgLength(nextWidth, unit);
    const heightAttr = formatSvgLength(nextHeight, unit);
    svg.setAttribute('width', widthAttr);
    svg.setAttribute('height', heightAttr);
    svg.style.width = widthAttr;
    svg.style.height = heightAttr;
    svg.style.maxWidth = 'none';
    setSvgWidth(nextWidth);
    setSvgHeight(nextHeight);
    setSvgUnit(unit || 'px');
    return true;
  }

  function updateSvgWidth(value: number) {
    if (lockAspect) {
      const ratio = svgHeight / Math.max(1, svgWidth);
      applySvgSize(value, value * ratio);
    } else {
      applySvgSize(value, svgHeight);
    }
  }

  function updateSvgHeight(value: number) {
    if (lockAspect) {
      const ratio = svgWidth / Math.max(1, svgHeight);
      applySvgSize(value * ratio, value);
    } else {
      applySvgSize(svgWidth, value);
    }
  }

  function applySmartResize(targetMm = targetWidthMm, font = fontScale, stroke = strokeScaleResize, marker = markerScale) {
    const svg = stageRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svg) return;
    const dims = svgDimensions(svg);
    const unit = dims.unit || svgUnit || 'px';
    const ratio = dims.height / Math.max(1, dims.width);
    const nextTargetMm = Math.max(10, Math.min(300, targetMm));
    const nextWidth = mmToUnit(nextTargetMm, unit);
    const changed = applySvgSize(nextWidth, nextWidth * ratio, unit);
    if (!changed) return;
    const currentWidthMm = unitToMm(dims.width, unit);
    const baselineWidthMm = baselineWidthMmRef.current || currentWidthMm || nextTargetMm;
    const canvasScale = Math.max(0.01, nextTargetMm / baselineWidthMm);
    const nextScale = {
      font: (Number.isFinite(font) && font > 0 ? font : 1) / canvasScale,
      stroke: (Number.isFinite(stroke) && stroke > 0 ? stroke : 1) / canvasScale,
      marker: (Number.isFinite(marker) && marker > 0 ? marker : 1) / canvasScale,
    };
    const currentScale = presentationScaleRef.current;
    scaleSvgPresentation(svg, {
      font: nextScale.font / Math.max(0.01, currentScale.font),
      stroke: nextScale.stroke / Math.max(0.01, currentScale.stroke),
      marker: nextScale.marker / Math.max(0.01, currentScale.marker),
    });
    presentationScaleRef.current = nextScale;
    const selected = selectedEditable(stageRef.current);
    renderSelectionOverlay(selected);
    syncControls(selected);
    refreshTextItems();
    toast.success('SVG resize applied');
  }

  function applyResizePreset(preset: typeof RESIZE_PRESETS[number]) {
    setTargetWidthMm(preset.targetMm);
    setFontScale(preset.fontScale);
    setStrokeScaleResize(preset.strokeScale);
    setMarkerScale(preset.markerScale);
    applySmartResize(preset.targetMm, preset.fontScale, preset.strokeScale, preset.markerScale);
  }

  function selectTextIndex(index: string) {
    const el = stageRef.current?.querySelector(`[data-labplot-edit-index="${index}"]`) as SVGElement | null;
    selectElement(el);
  }

  function serializeEditedSvg(): string | null {
    const svg = stageRef.current?.querySelector('svg');
    if (!svg) return null;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    cleanEditorAttributes(clone);
    if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    return new XMLSerializer().serializeToString(clone);
  }

  function downloadEditedSvg() {
    const serialized = serializeEditedSvg();
    if (!serialized) return;
    const blob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeFilename(filenameBase)}${versionNumber ? `_v${versionNumber}` : ''}_edited.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success('Edited SVG downloaded');
  }

  function saveEditedVersion() {
    const serialized = serializeEditedSvg();
    if (!serialized) return;
    onSaveVersion?.(serialized);
  }

  function resetSvg() {
    const host = stageRef.current;
    if (host) {
      host.innerHTML = originalMarkup;
      presentationScaleRef.current = { font: 1, stroke: 1, marker: 1 };
      baselineWidthMmRef.current = null;
      setElementCount(host.querySelectorAll(EDITABLE_SELECTOR).length);
      syncSvgSize(true);
    }
    window.requestAnimationFrame(() => {
      syncControls(null);
      refreshTextItems();
    });
  }

  const selectedIsText = selectedTag === 'text' || selectedTag === 'tspan';

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base"><MousePointer2 className="h-4 w-4" /> Vector SVG editor</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline">local</Badge>
            {elementCount > 0 && <Badge variant="secondary">{elementCount} elements</Badge>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!svgUrl ? (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No SVG available for this version.</div>
        ) : loading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>
        ) : (
          <>
            {elementCount > HEAVY_SVG_ELEMENT_LIMIT && (
              <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>This SVG has many editable elements. Selection may feel slower on this device.</span>
              </div>
            )}

            <div
              ref={stageRef}
              tabIndex={0}
              onClick={handleStageClick}
              onPointerDown={handleStagePointerDown}
              onPointerMove={handleStagePointerMove}
              onPointerUp={finishStageDrag}
              onPointerCancel={finishStageDrag}
              onKeyDown={handleStageKeyDown}
              data-testid="svg-editor-stage"
              className="svg-vector-editor-stage max-h-[70vh] overflow-auto rounded-md border bg-white p-3"
            />

            <div className="grid gap-3 rounded-md border bg-muted/20 p-3 md:grid-cols-[1fr_1fr_auto]">
              <div className="space-y-1">
                <Label className="flex items-center gap-1 text-xs"><Maximize2 className="h-3 w-3" /> Canvas width ({svgUnit})</Label>
                <Input data-testid="svg-figure-width" type="number" min="24" max="4800" step="0.1" value={svgWidth} onChange={(e) => updateSvgWidth(Number(e.target.value || svgWidth))} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Canvas height ({svgUnit})</Label>
                <Input data-testid="svg-figure-height" type="number" min="24" max="4800" step="0.1" value={svgHeight} onChange={(e) => updateSvgHeight(Number(e.target.value || svgHeight))} />
              </div>
              <label className="flex items-end gap-2 pb-2 text-xs">
                <input type="checkbox" checked={lockAspect} onChange={(e) => setLockAspect(e.target.checked)} />
                Lock ratio
              </label>
            </div>

            <div className="space-y-3 rounded-md border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label className="flex items-center gap-1 text-xs"><Ruler className="h-3 w-3" /> Smart resize</Label>
                <div className="flex flex-wrap gap-1">
                  {RESIZE_PRESETS.map((preset) => (
                    <Button key={preset.label} type="button" variant="outline" size="sm" onClick={() => applyResizePreset(preset)}>
                      {preset.label}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_1fr_auto]">
                <div className="space-y-1">
                  <Label className="text-xs">Target width (mm)</Label>
                  <Input data-testid="svg-target-width-mm" type="number" min="10" max="300" step="1" value={targetWidthMm} onChange={(e) => setTargetWidthMm(Number(e.target.value || targetWidthMm))} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Font scale</Label>
                  <Input data-testid="svg-font-scale" type="number" min="0.2" max="2" step="0.05" value={fontScale} onChange={(e) => setFontScale(Number(e.target.value || fontScale))} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Line scale</Label>
                  <Input data-testid="svg-line-scale" type="number" min="0.2" max="2" step="0.05" value={strokeScaleResize} onChange={(e) => setStrokeScaleResize(Number(e.target.value || strokeScaleResize))} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Marker scale</Label>
                  <Input data-testid="svg-marker-scale" type="number" min="0.2" max="2" step="0.05" value={markerScale} onChange={(e) => setMarkerScale(Number(e.target.value || markerScale))} />
                </div>
                <div className="flex items-end">
                  <Button data-testid="svg-apply-smart-resize" type="button" variant="secondary" onClick={() => applySmartResize()}>
                    <SlidersHorizontal className="mr-2 h-4 w-4" /> Apply
                  </Button>
                </div>
              </div>
            </div>

            <div className="grid gap-3 rounded-md border bg-muted/20 p-3 md:grid-cols-4">
              <div className="space-y-1 md:col-span-2">
                <Label className="text-xs">Selected element</Label>
                <div data-testid="svg-selected-element" className="truncate rounded-md border bg-background px-2 py-2 text-xs">{selectedLabel}</div>
              </div>
              <div className="space-y-1 md:col-span-2">
                <Label className="flex items-center gap-1 text-xs"><Type className="h-3 w-3" /> Text labels</Label>
                <select className="w-full rounded-md border bg-background px-2 py-2 text-xs" onChange={(e) => e.target.value && selectTextIndex(e.target.value)} value="">
                  <option value="">Select label text...</option>
                  {textItems.map((item) => <option key={item.index} value={item.index}>{item.label}</option>)}
                </select>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Fill</Label>
                <div className="flex gap-1">
                  <Input data-testid="svg-fill-color" type="color" value={fillColor} onChange={(e) => { setFillColor(e.target.value); applyStyle('fill', e.target.value); }} className="h-9 w-12 p-1" />
                  <Button type="button" variant="outline" size="sm" onClick={() => applyStyle('fill', 'none')}>None</Button>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Stroke</Label>
                <div className="flex gap-1">
                  <Input data-testid="svg-stroke-color" type="color" value={strokeColor} onChange={(e) => { setStrokeColor(e.target.value); applyStyle('stroke', e.target.value); }} className="h-9 w-12 p-1" />
                  <Button type="button" variant="outline" size="sm" onClick={() => applyStyle('stroke', 'none')}>None</Button>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Stroke width</Label>
                <Input data-testid="svg-stroke-width" type="number" min="0" step="0.05" value={strokeWidth} onChange={(e) => { setStrokeWidth(e.target.value); applyStyle('stroke-width', e.target.value || '0'); }} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Text content</Label>
                <Input data-testid="svg-text-content" value={textValue} disabled={!selectedIsText} onChange={(e) => applyText(e.target.value)} />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {onSaveVersion && (
                <Button data-testid="svg-save-version" type="button" onClick={saveEditedVersion} disabled={isSaving}>
                  {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />} Save as version
                </Button>
              )}
              <Button data-testid="svg-download-edited" type="button" variant="secondary" onClick={downloadEditedSvg}><Download className="mr-2 h-4 w-4" /> Download edited SVG</Button>
              <Button data-testid="svg-reset-local" type="button" variant="outline" onClick={resetSvg}><RefreshCw className="mr-2 h-4 w-4" /> Reset local edits</Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
