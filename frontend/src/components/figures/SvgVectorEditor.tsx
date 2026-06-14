'use client';

import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Download, Loader2, Maximize2, MousePointer2, RefreshCw, Save, Type } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const EDITABLE_SELECTOR = 'path,line,polyline,polygon,rect,circle,ellipse,text,tspan';
const HEAVY_SVG_ELEMENT_LIMIT = 1500;

interface TextItem {
  index: string;
  label: string;
}

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

function numericSvgLength(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function svgDimensions(svg: SVGSVGElement): { width: number; height: number } {
  const attrWidth = numericSvgLength(svg.getAttribute('width'));
  const attrHeight = numericSvgLength(svg.getAttribute('height'));
  if (attrWidth && attrHeight) return { width: attrWidth, height: attrHeight };
  const viewBox = svg.getAttribute('viewBox')?.trim().split(/\s+/).map(Number);
  if (viewBox && viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    return { width: viewBox[2], height: viewBox[3] };
  }
  return { width: 720, height: 500 };
}

function selectedEditable(host: HTMLDivElement | null): SVGElement | null {
  return host?.querySelector('[data-labplot-selected="true"]') as SVGElement | null;
}

function cleanEditorAttributes(svg: SVGSVGElement): void {
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
  const [lockAspect, setLockAspect] = useState(true);

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
      syncControls(null);
      return;
    }
    el.setAttribute('data-labplot-selected', 'true');
    syncControls(el);
  }, [syncControls]);

  const syncSvgSize = useCallback(() => {
    const svg = stageRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svg) return;
    const dims = svgDimensions(svg);
    setSvgWidth(Math.round(dims.width));
    setSvgHeight(Math.round(dims.height));
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadSvg() {
      if (stageRef.current) stageRef.current.innerHTML = '';
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

    return () => { cancelled = true; };
  }, [svgUrl, syncControls]);

  useEffect(() => {
    const host = stageRef.current;
    if (!host || !svgMarkup) return;
    host.innerHTML = svgMarkup;
    setElementCount(host.querySelectorAll(EDITABLE_SELECTOR).length);
    syncSvgSize();
    refreshTextItems();
  }, [svgMarkup, refreshTextItems, syncSvgSize]);

  function handleStageClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as Element | null;
    const host = stageRef.current;
    if (!target || !host || target === host) return;
    const editable = target.closest('[data-labplot-editable="true"]') as SVGElement | null;
    if (!editable || !host.contains(editable)) return;
    event.preventDefault();
    event.stopPropagation();
    selectElement(editable);
  }

  function applyStyle(prop: string, value: string) {
    const el = selectedEditable(stageRef.current);
    if (!el) return;
    el.style.setProperty(prop, value);
    syncControls(el);
  }

  function applyText(value: string) {
    const el = selectedEditable(stageRef.current);
    if (!el) return;
    const tag = el.tagName.toLowerCase();
    if (tag !== 'text' && tag !== 'tspan') return;
    el.textContent = value;
    setTextValue(value);
    syncControls(el);
    refreshTextItems();
  }

  function applySvgSize(width: number, height: number) {
    const svg = stageRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svg) return;
    const nextWidth = Math.max(72, Math.min(2400, Math.round(width)));
    const nextHeight = Math.max(72, Math.min(2400, Math.round(height)));
    svg.setAttribute('width', String(nextWidth));
    svg.setAttribute('height', String(nextHeight));
    svg.style.width = `${nextWidth}px`;
    svg.style.height = `${nextHeight}px`;
    svg.style.maxWidth = 'none';
    setSvgWidth(nextWidth);
    setSvgHeight(nextHeight);
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
      setElementCount(host.querySelectorAll(EDITABLE_SELECTOR).length);
      syncSvgSize();
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
              onClick={handleStageClick}
              data-testid="svg-editor-stage"
              className="svg-vector-editor-stage max-h-[70vh] overflow-auto rounded-md border bg-white p-3"
            />

            <div className="grid gap-3 rounded-md border bg-muted/20 p-3 md:grid-cols-[1fr_1fr_auto_auto]">
              <div className="space-y-1">
                <Label className="flex items-center gap-1 text-xs"><Maximize2 className="h-3 w-3" /> Figure width (px)</Label>
                <Input data-testid="svg-figure-width" type="number" min="72" max="2400" value={svgWidth} onChange={(e) => updateSvgWidth(Number(e.target.value || svgWidth))} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Figure height (px)</Label>
                <Input data-testid="svg-figure-height" type="number" min="72" max="2400" value={svgHeight} onChange={(e) => updateSvgHeight(Number(e.target.value || svgHeight))} />
              </div>
              <label className="flex items-end gap-2 pb-2 text-xs">
                <input type="checkbox" checked={lockAspect} onChange={(e) => setLockAspect(e.target.checked)} />
                Lock ratio
              </label>
              <div className="flex items-end gap-1">
                <Button type="button" variant="outline" size="sm" onClick={() => applySvgSize(720, 500)}>Double</Button>
                <Button type="button" variant="outline" size="sm" onClick={() => applySvgSize(360, 500)}>Single</Button>
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
