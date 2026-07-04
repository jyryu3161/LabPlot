'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { HelpCircle, X } from 'lucide-react';

const HINTS_DISMISSED_KEY = 'labplot-canvas-hints-dismissed';

/** "?" toolbar button with a small popover listing the editor gestures. */
export function CanvasHelpPopover() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        // Consume Escape so the editor's window-level handler doesn't also
        // deselect the current panel — this popover close is the only effect.
        e.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <Button
        type="button"
        size="icon-sm"
        variant="outline"
        aria-label="Canvas editor help"
        aria-expanded={open}
        title="Gestures & keyboard shortcuts"
        onClick={() => setOpen((v) => !v)}
      >
        <HelpCircle className="h-4 w-4" />
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="Canvas gestures and shortcuts"
          className="absolute right-0 top-full z-50 mt-1 w-72 rounded-md border bg-popover p-3 text-popover-foreground shadow-md"
        >
          <p className="mb-2 text-xs font-semibold">Gestures & shortcuts</p>
          <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
            <li>Drag a panel to move it — hold Alt to disable snapping</li>
            <li>Drag its corners or edges to resize — snaps to nearby panels too</li>
            <li>Scroll to pan · pinch or Ctrl/Cmd+scroll to zoom</li>
            <li>Drag empty space to select · Space+drag or scroll to pan</li>
            <li>Shift+click a panel to add or remove it from the selection</li>
            <li>Click a panel to edit colors · click its title/axis labels to edit text</li>
            <li>Arrow keys nudge 1mm (Shift = 5mm)</li>
            <li>Delete removes the selected panel(s)</li>
            <li>Ctrl/Cmd+Z undo · Ctrl/Cmd+Shift+Z redo</li>
            <li>Left toolbar: add text/arrow/line/rectangle/ellipse annotations (V/T/A/L/R/O) — drag to draw, click to place text, Esc back to Select</li>
            <li>1 = zoom 100% · Shift+1 = fit to view · Shift+2 = zoom to selection</li>
            <li>mm rulers along the top/left edges track the current zoom and pan</li>
            <li>Toggle the grid and grid-snap from the toolbar (5mm lines, 10mm accent)</li>
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * One-time slim hint bar shown above the stage when the canvas has panels.
 * Dismissal persists in localStorage; never shown again after the ✕.
 */
export function CanvasHintsBar({ show }: { show: boolean }) {
  // Start hidden (assume dismissed) so SSR/hydration never flashes the bar,
  // then read the real flag on mount.
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(HINTS_DISMISSED_KEY) === '1');
    } catch {
      /* storage unavailable — keep hidden */
    }
  }, []);

  if (!show || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(HINTS_DISMISSED_KEY, '1');
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-1 text-xs text-muted-foreground">
      <span>Drag to move · corners/edges to resize · Space+drag or scroll to pan · Ctrl/Cmd+scroll to zoom (1=100%, Shift+1=fit, Shift+2=zoom to selection) · click a panel to edit · arrow keys nudge 1mm (Shift=5mm) · left toolbar adds text/shape annotations (V/T/A/L/R/O) · grid/grid-snap toggles in the toolbar</span>
      <button
        type="button"
        className="ml-auto rounded p-0.5 hover:bg-muted hover:text-foreground"
        aria-label="Dismiss hints"
        onClick={dismiss}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
