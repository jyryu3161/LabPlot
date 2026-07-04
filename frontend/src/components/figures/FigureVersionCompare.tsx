'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronsLeftRight, ImageOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import type { FigureVersion } from '@/lib/types';

// Normalized width unit used to derive a shared letterboxed container height
// from each image's own natural aspect ratio. Both images are displayed at
// 100% of the container's actual (unknown-in-advance) pixel width, so working
// in these unit-less "per 1000 width" numbers lets us size the container via
// a plain CSS `aspect-ratio` without ever measuring rendered pixels.
const ASPECT_UNIT = 1000;
// Landscape placeholder ratio (~5:3, close to the app's default 7x4.2in
// figure size) used before either image has loaded and reported its
// intrinsic size, so the dialog doesn't collapse to zero height.
const FALLBACK_SCALED_HEIGHT = ASPECT_UNIT * 0.6;
const DIVIDER_STEP = 5;

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function versionOptionLabel(v: FigureVersion): string {
  const note = (v.change_note ?? '').trim();
  if (!note) return `v${v.version_number}`;
  const snippet = note.length > 44 ? `${note.slice(0, 44)}…` : note;
  return `v${v.version_number} · ${snippet}`;
}

interface ImageDims { w: number; h: number }

function scaledHeight(dims: ImageDims | null): number | null {
  return dims && dims.w > 0 ? (dims.h / dims.w) * ASPECT_UNIT : null;
}

function MissingImage({ versionNumber }: { versionNumber: number }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-muted/40 text-center text-xs text-muted-foreground">
      <ImageOff className="h-5 w-5" />
      No rendered image for v{versionNumber}
    </div>
  );
}

interface FigureVersionCompareProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** All versions of the figure, oldest first (matches `fig.versions` order). */
  versions: FigureVersion[];
  /** Initial "Base" selection - typically the version before the one currently open. */
  defaultBaseId: string | null;
  /** Initial "Compare" selection - typically the currently viewed version. */
  defaultCompareId: string | null;
}

/**
 * Before/after slider for two figure versions (U11). Both renders are shown
 * stacked at the same displayed width; the Compare version sits on top and is
 * clipped to the left of a draggable divider, revealing the Base version on
 * the right. Mount a fresh instance per figure (e.g. `key={figureId}`) so
 * selections and the divider position reset when the figure changes.
 */
export function FigureVersionCompare({ open, onOpenChange, versions, defaultBaseId, defaultCompareId }: FigureVersionCompareProps) {
  const [baseId, setBaseId] = useState<string | null>(defaultBaseId);
  const [compareId, setCompareId] = useState<string | null>(defaultCompareId);
  const [dividerPct, setDividerPct] = useState(50);
  const [baseDims, setBaseDims] = useState<ImageDims | null>(null);
  const [compareDims, setCompareDims] = useState<ImageDims | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const baseVersion = versions.find((v) => v.id === baseId) ?? null;
  const compareVersion = versions.find((v) => v.id === compareId) ?? null;

  // Re-seed selections from the page-computed defaults each time the dialog
  // opens, so Compare always reflects the version currently viewed. The
  // component stays mounted (open=false) between uses, so without this a
  // version created / deleted / clicked after first mount would be ignored,
  // and a deleted default would leave a dangling id (blank select +
  // placeholder). Modal, so the defaults can't change while it's open.
  useEffect(() => {
    if (!open) return;
    setBaseId(defaultBaseId);
    setCompareId(defaultCompareId);
  }, [open, defaultBaseId, defaultCompareId]);

  // A newly picked pair starts from a fresh 50/50 split.
  useEffect(() => {
    setDividerPct(50);
  }, [baseId, compareId]);
  // Measured dims reset PER SIDE, not per pair: changing only one select
  // reuses the other side's <img> DOM node with an unchanged src, so its
  // onLoad never refires — nulling its dims on every pair change would
  // permanently drop its aspect from the letterbox and silently crop it. The
  // changed side gets a new src, which always refires onLoad (even from
  // cache), so resetting only that side is correct.
  useEffect(() => { setBaseDims(null); }, [baseId]);
  useEffect(() => { setCompareDims(null); }, [compareId]);

  // Window-level pointermove/up (not element pointer capture) so the drag
  // keeps tracking even if the pointer leaves the ~44px handle mid-drag, and
  // reliably ends on release anywhere on the page.
  useEffect(() => {
    function handleMove(event: PointerEvent) {
      if (!draggingRef.current) return;
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (!rect.width) return;
      setDividerPct(clampPercent(((event.clientX - rect.left) / rect.width) * 100));
    }
    function stopDragging() { draggingRef.current = false; }
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', stopDragging);
    window.addEventListener('pointercancel', stopDragging);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', stopDragging);
      window.removeEventListener('pointercancel', stopDragging);
    };
  }, []);

  function handleDividerPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    draggingRef.current = true;
  }

  function handleDividerKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft') { event.preventDefault(); setDividerPct((p) => clampPercent(p - DIVIDER_STEP)); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); setDividerPct((p) => clampPercent(p + DIVIDER_STEP)); }
    else if (event.key === 'Home') { event.preventDefault(); setDividerPct(0); }
    else if (event.key === 'End') { event.preventDefault(); setDividerPct(100); }
  }

  const maxScaledHeight = Math.max(scaledHeight(baseDims) ?? 0, scaledHeight(compareDims) ?? 0) || FALLBACK_SCALED_HEIGHT;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[95vw] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Compare versions</DialogTitle>
          <DialogDescription>
            Drag the divider (or focus it and press Arrow Left / Arrow Right) to reveal the Compare version over the Base version.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="compare-base-select" className="text-xs">Base</Label>
            <select
              id="compare-base-select"
              className="w-full rounded-md border px-2 py-1.5 text-sm"
              value={baseId ?? ''}
              onChange={(e) => setBaseId(e.target.value || null)}
            >
              {versions.map((v) => <option key={v.id} value={v.id}>{versionOptionLabel(v)}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="compare-compare-select" className="text-xs">Compare</Label>
            <select
              id="compare-compare-select"
              className="w-full rounded-md border px-2 py-1.5 text-sm"
              value={compareId ?? ''}
              onChange={(e) => setCompareId(e.target.value || null)}
            >
              {versions.map((v) => <option key={v.id} value={v.id}>{versionOptionLabel(v)}</option>)}
            </select>
          </div>
        </div>

        {baseVersion && compareVersion ? (
          <div
            ref={containerRef}
            className="relative w-full touch-none overflow-hidden rounded-md border bg-muted/20"
            style={{ aspectRatio: `${ASPECT_UNIT} / ${maxScaledHeight}` }}
          >
            {/* Base — bottom layer, always fully visible (shows through on the right of the divider). */}
            {baseVersion.png_url ? (
              <img
                src={baseVersion.png_url}
                alt={`Base: v${baseVersion.version_number}`}
                draggable={false}
                onLoad={(e) => setBaseDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                className="pointer-events-none absolute top-1/2 left-0 w-full -translate-y-1/2 bg-white select-none"
              />
            ) : (
              <MissingImage versionNumber={baseVersion.version_number} />
            )}

            {/* Compare — top layer, clipped to the left of the divider. */}
            <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - dividerPct}% 0 0)` }}>
              {compareVersion.png_url ? (
                <img
                  src={compareVersion.png_url}
                  alt={`Compare: v${compareVersion.version_number}`}
                  draggable={false}
                  onLoad={(e) => setCompareDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                  className="pointer-events-none absolute top-1/2 left-0 w-full -translate-y-1/2 bg-white select-none"
                />
              ) : (
                <MissingImage versionNumber={compareVersion.version_number} />
              )}
            </div>

            {/* Pinned side badges - always visible regardless of divider position. */}
            <Badge variant="secondary" className="pointer-events-none absolute top-2 left-2 z-10 shadow">v{compareVersion.version_number}</Badge>
            <Badge variant="secondary" className="pointer-events-none absolute top-2 right-2 z-10 shadow">v{baseVersion.version_number}</Badge>

            {/* Draggable divider - ~44px hit area, keyboard-accessible slider. */}
            <div
              role="slider"
              tabIndex={0}
              aria-label="Comparison divider"
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(dividerPct)}
              aria-valuetext={`${Math.round(dividerPct)}% — showing v${compareVersion.version_number} on the left`}
              className="absolute top-0 z-20 flex h-full w-11 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              style={{ left: `${dividerPct}%` }}
              onPointerDown={handleDividerPointerDown}
              onKeyDown={handleDividerKeyDown}
            >
              <div className="pointer-events-none h-full w-0.5 bg-primary" />
              <div className="pointer-events-none absolute flex h-7 w-7 items-center justify-center rounded-full border-2 border-primary bg-background shadow">
                <ChevronsLeftRight className="h-3.5 w-3.5 text-primary" />
              </div>
            </div>
          </div>
        ) : (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            Pick a Base and Compare version to see the overlay.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
