'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * U5: anchored popover editing one axis of a canvas panel. All fields map to
 * EXISTING universal figure options (x_min/x_max, log_x, reverse_x, x_breaks,
 * x_tick_format, x_text_angle and their y_* twins) — one Apply = one commit =
 * one FigureVersion via the caller's rerender mutation.
 *
 * `aesthetic` is the OPTION family this popover edits ('x' or 'y'); with
 * coord_flip the caller maps the clicked positional strip to the aesthetic
 * that actually renders there. `discrete` gates range/format fields (they
 * target continuous scales; category axes only reorder/angle).
 */
const TICK_FORMATS = ['number', 'comma', 'percent', 'scientific'] as const;

type Patch = Record<string, string | number | boolean | null>;

function numText(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

export function CanvasAxisPopover({
  aesthetic,
  discrete,
  scaleEditable,
  showAngle,
  options,
  pending,
  onApply,
  onClose,
}: {
  aesthetic: 'x' | 'y';
  discrete: boolean;
  /** Backend emits a tick/format/reverse scale layer for this aesthetic —
   *  false for e.g. line-plot x or temporal axes, where those options are
   *  provably inert (committing them would burn a render for no change). */
  scaleEditable: boolean;
  showAngle: boolean;
  options: Record<string, unknown>;
  pending: boolean;
  onApply: (patch: Patch, revert: Patch) => void;
  onClose: () => void;
}) {
  const k = (suffix: string) => `${aesthetic}_${suffix}`;
  const kPre = (prefix: string) => `${prefix}_${aesthetic}`;

  const [min, setMin] = useState(numText(options[k('min')]));
  const [max, setMax] = useState(numText(options[k('max')]));
  const [breaks, setBreaks] = useState(numText(options[k('breaks')]));
  const [format, setFormat] = useState(typeof options[k('tick_format')] === 'string' ? (options[k('tick_format')] as string) : '');
  const [reverse, setReverse] = useState(Boolean(options[kPre('reverse')]));
  const [log, setLog] = useState(Boolean(options[kPre('log')]));
  const [angle, setAngle] = useState(numText(options.x_text_angle));

  const [error, setError] = useState<string | null>(null);
  function apply() {
    // Guard paid no-op commits: the renderer ignores min>=max, and a log scale
    // with a non-positive limit errors R-side.
    const minN = min.trim() === '' ? null : Number(min);
    const maxN = max.trim() === '' ? null : Number(max);
    if (!discrete && minN !== null && maxN !== null && Number.isFinite(minN) && Number.isFinite(maxN) && minN >= maxN) {
      setError('Min must be less than Max.');
      return;
    }
    if (!discrete && log && ((minN !== null && minN <= 0) || (maxN !== null && maxN <= 0))) {
      setError('Log scale needs positive limits.');
      return;
    }
    setError(null);
    const patch: Patch = {};
    const revert: Patch = {};
    const setNum = (key: string, draft: string, prevRaw: unknown) => {
      const prevText = numText(prevRaw);
      if (draft.trim() === prevText) return;
      const n = Number(draft);
      patch[key] = draft.trim() === '' || !Number.isFinite(n) ? null : n; // blank = auto (unset)
      revert[key] = typeof prevRaw === 'number' ? prevRaw : null;
    };
    if (!discrete) {
      setNum(k('min'), min, options[k('min')]);
      setNum(k('max'), max, options[k('max')]);
      // min/max (coord_cartesian) and log are universal; ticks/format/reverse
      // only exist where the backend emits a scale layer for this aesthetic.
      if (scaleEditable) {
        setNum(k('breaks'), breaks, options[k('breaks')]);
        const prevFormat = typeof options[k('tick_format')] === 'string' ? (options[k('tick_format')] as string) : '';
        if (format !== prevFormat) {
          patch[k('tick_format')] = format === '' ? null : format;
          revert[k('tick_format')] = prevFormat === '' ? null : prevFormat;
        }
        const prevRev = Boolean(options[kPre('reverse')]);
        if (reverse !== prevRev) {
          patch[kPre('reverse')] = reverse;
          revert[kPre('reverse')] = typeof options[kPre('reverse')] === 'boolean' ? (options[kPre('reverse')] as boolean) : null;
        }
      }
      const prevLog = Boolean(options[kPre('log')]);
      if (log !== prevLog) {
        patch[kPre('log')] = log;
        revert[kPre('log')] = typeof options[kPre('log')] === 'boolean' ? (options[kPre('log')] as boolean) : null;
        // Turning log ON kills the tick/format/reverse scale layer for this
        // axis — drop them from the same Apply so nothing dead is committed.
        if (log) {
          for (const dead of [k('breaks'), k('tick_format'), kPre('reverse')]) {
            delete patch[dead];
            delete revert[dead];
          }
        }
      }
    }
    if (showAngle) setNum('x_text_angle', angle, options.x_text_angle);
    if (Object.keys(patch).length) onApply(patch, revert);
    else onClose();
  }

  // Focus lands INSIDE the popover on open — otherwise Escape/Delete reach the
  // editor's window-level handlers and deselect or delete the panel.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => { rootRef.current?.focus(); }, []);

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="flex w-56 flex-col gap-2 rounded-md border bg-white p-2.5 text-xs shadow-lg outline-none"
      role="dialog"
      aria-label={`Edit ${aesthetic} axis`}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); e.stopPropagation(); }}
    >
      <div className="flex items-center justify-between">
        <span className="font-semibold">{aesthetic.toUpperCase()} axis</span>
        <button type="button" aria-label="Close axis editor" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {discrete ? (
        <p className="text-muted-foreground">Category axis — range and number format don’t apply.</p>
      ) : (
        <>
          <div className="flex items-center gap-1.5">
            <Label className="w-10 shrink-0 text-[11px] text-muted-foreground" htmlFor={`axis-${aesthetic}-min`}>Min</Label>
            <Input id={`axis-${aesthetic}-min`} type="number" step="any" className="h-6 text-xs" placeholder="auto" value={min} onChange={(e) => setMin(e.target.value)} />
            <Label className="w-10 shrink-0 text-center text-[11px] text-muted-foreground" htmlFor={`axis-${aesthetic}-max`}>Max</Label>
            <Input id={`axis-${aesthetic}-max`} type="number" step="any" className="h-6 text-xs" placeholder="auto" value={max} onChange={(e) => setMax(e.target.value)} />
          </div>
          <div className="flex items-center gap-1.5">
            <Button type="button" size="xs" variant="outline" onClick={() => { setMin(''); setMax(''); }}>
              Auto fit
            </Button>
            {scaleEditable && (
              <>
                <Label className="ml-1 shrink-0 text-[11px] text-muted-foreground" htmlFor={`axis-${aesthetic}-breaks`}>Ticks</Label>
                <Input id={`axis-${aesthetic}-breaks`} type="number" min={2} max={20} className="h-6 w-14 text-xs" placeholder="auto" value={breaks} onChange={(e) => setBreaks(e.target.value)} />
              </>
            )}
          </div>
          {scaleEditable ? (
            <div className="flex items-center gap-1.5">
              <Label className="w-10 shrink-0 text-[11px] text-muted-foreground" htmlFor={`axis-${aesthetic}-format`}>Format</Label>
              <select
                id={`axis-${aesthetic}-format`}
                aria-label={`${aesthetic} tick format`}
                className="h-6 flex-1 rounded border bg-white px-1 text-xs"
                value={format}
                onChange={(e) => setFormat(e.target.value)}
              >
                <option value="">default</option>
                {TICK_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">Tick styling isn’t available for this axis type.</p>
          )}
        </>
      )}

      {!discrete && (
        <div className="flex items-center gap-3">
          {/* reverse rides the scale layer (dead when !scaleEditable and on
              discrete axes — both verified paid no-ops); log is universal. */}
          {scaleEditable && (
            <label className="flex cursor-pointer items-center gap-1">
              <input type="checkbox" checked={reverse} onChange={(e) => setReverse(e.target.checked)} /> reverse
            </label>
          )}
          <label className="flex cursor-pointer items-center gap-1">
            <input type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} /> log scale
          </label>
        </div>
      )}

      {showAngle && (
        <div className="flex items-center gap-1.5">
          <Label className="shrink-0 text-[11px] text-muted-foreground" htmlFor="axis-x-angle">Tick angle</Label>
          <Input id="axis-x-angle" type="number" min={0} max={90} className="h-6 w-16 text-xs" placeholder="0" value={angle} onChange={(e) => setAngle(e.target.value)} />
          <span className="text-[10px] text-muted-foreground">0–90°</span>
        </div>
      )}

      {error && <p className="text-[11px] text-red-600">{error}</p>}
      <Button type="button" size="sm" className="mt-1" disabled={pending} onClick={apply}>
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
        Apply axis
      </Button>
    </div>
  );
}
