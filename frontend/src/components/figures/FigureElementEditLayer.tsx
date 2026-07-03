'use client';

import { useEffect, useRef, useState } from 'react';
import {
  textRegionBoxes, axisRegionBoxes, regionCssRect,
  REGION_OPTION_KEY, REGION_LABEL,
  type TextRegion, type AxisRegion,
} from '@/components/canvases/regions';
import { CanvasAxisPopover } from '@/components/canvases/CanvasAxisPopover';
import type { Box } from '@/components/canvases/recolor';

/**
 * U6: Prism-style element editing on the FIGURE page. Same sidecar hit boxes
 * as the canvas overlay (title / axis labels / axis strips), but edits go to
 * the page's DRAFT options (setOptions) instead of committing a render — the
 * page's existing live-preview / Apply / undo-redo pipeline takes over, so
 * inline editing here costs zero extra renders.
 *
 * Mounted inside the annotation overlay's relative image wrapper; all targets
 * sit OUTSIDE the plotting panel, so they never collide with the annotation
 * stage (which covers only the panel interior).
 */
export function FigureElementEditLayer({
  layout,
  imgW,
  imgH,
  options,
  renderedOptions,
  onPatch,
}: {
  layout: Record<string, unknown> | null | undefined;
  imgW: number;
  imgH: number;
  options: Record<string, unknown>;
  /** The RENDERED version's options — hit boxes are positional in the render,
   *  so flip mapping must follow what's on screen, not a pending draft toggle. */
  renderedOptions?: Record<string, unknown>;
  onPatch: (patch: Record<string, string | number | boolean | null>) => void;
}) {
  const [textEdit, setTextEdit] = useState<{ region: TextRegion; value: string } | null>(null);
  const [axisEdit, setAxisEdit] = useState<AxisRegion | null>(null);
  // Live-preview completion remounts this layer (page keys the overlay on the
  // version id); commit any in-flight inline text into the draft on unmount so
  // typing is never silently discarded.
  const commitRef = useRef<() => void>(() => {});
  useEffect(() => () => commitRef.current(), []);

  const imgPxRaw = (layout as { img_px?: { w?: number; h?: number } } | null)?.img_px;
  const imgPx = imgPxRaw && typeof imgPxRaw.w === 'number' && imgPxRaw.w > 0
    && typeof imgPxRaw.h === 'number' && imgPxRaw.h > 0
    ? { w: imgPxRaw.w, h: imgPxRaw.h } : null;
  const regionBoxes = textRegionBoxes(layout);
  const axisBoxes = axisRegionBoxes(layout);

  // coord_flip: the bottom cell renders the y label (verified in-container for
  // U4); map the clicked POSITIONAL box to the option that renders there.
  const flipped = Boolean((renderedOptions ?? options).flip_coords);
  const optionKeyFor = (r: TextRegion) =>
    flipped && r === 'xlab' ? 'y_label' : flipped && r === 'ylab' ? 'x_label' : REGION_OPTION_KEY[r];
  const labelFor = (r: TextRegion) =>
    flipped && r === 'xlab' ? REGION_LABEL.ylab : flipped && r === 'ylab' ? REGION_LABEL.xlab : REGION_LABEL[r];
  const axisAestheticFor = (r: AxisRegion): 'x' | 'y' =>
    r === 'xaxis' ? (flipped ? 'y' : 'x') : (flipped ? 'x' : 'y');
  const axisDiscreteFor = (r: AxisRegion): boolean =>
    Boolean(r === 'xaxis' ? (layout as Record<string, unknown>).x_discrete : (layout as Record<string, unknown>).y_discrete);

  const optionText = (key: string): string => {
    const v = options[key];
    return typeof v === 'string' ? v : '';
  };

  function commitTextDraft() {
    if (!textEdit) return;
    const key = optionKeyFor(textEdit.region);
    const value = textEdit.value.trim();
    if (value !== optionText(key).trim()) onPatch({ [key]: value });
    setTextEdit(null);
  }
  // Keep the unmount-commit pointing at the latest closure. Assigned in an
  // effect (refs must not be written during render), placed after the
  // declaration (compiler forbids forward references), and BEFORE the layout
  // guard so the hook order is unconditional.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { commitRef.current = commitTextDraft; });
  if (!layout || !imgPx || imgW <= 0 || imgH <= 0) return null;

  return (
    <>
      {/* axis strip click targets (rendered FIRST so zero-height label bands
          — the way to re-add a cleared label — stay clickable on top) */}
      {!textEdit && !axisEdit
        ? (Object.entries(axisBoxes) as [AxisRegion, Box][]).map(([region, box]) => {
            const rect = regionCssRect(box, imgPx);
            return (
              <button
                key={region}
                type="button"
                aria-label={`Edit ${axisAestheticFor(region)} axis`}
                title={`Edit ${axisAestheticFor(region)} axis (range, ticks, scale)`}
                className="absolute cursor-pointer rounded-sm bg-transparent hover:bg-primary/10 hover:ring-1 hover:ring-primary/60"
                style={{ ...rect, border: 'none', padding: 0 }}
                onClick={(e) => {
                  e.stopPropagation();
                  setAxisEdit(region);
                }}
              />
            );
          })
        : null}
      {/* text-element click targets */}
      {!textEdit && !axisEdit
        ? (Object.entries(regionBoxes) as [TextRegion, Box][]).map(([region, box]) => {
            const rect = regionCssRect(box, imgPx);
            return (
              <button
                key={region}
                type="button"
                aria-label={`Edit ${labelFor(region)}`}
                title={`Edit ${labelFor(region)}`}
                className="absolute cursor-text rounded-sm bg-transparent hover:bg-primary/10 hover:ring-1 hover:ring-primary/60"
                style={{ ...rect, border: 'none', padding: 0 }}
                onClick={(e) => {
                  e.stopPropagation();
                  setTextEdit({ region, value: optionText(optionKeyFor(region)) });
                }}
              />
            );
          })
        : null}
      {/* inline text editor (drafts only — Escape cancels, Enter/blur patches) */}
      {textEdit && regionBoxes[textEdit.region] ? (() => {
        const rect = regionCssRect(regionBoxes[textEdit.region]!, imgPx);
        return (
          <div className="absolute z-30" style={{ left: rect.left, top: rect.top, minWidth: 200, maxWidth: '85%' }}>
            <input
              autoFocus
              aria-label={`${labelFor(textEdit.region)} text`}
              className="w-full rounded border border-primary bg-white px-1.5 py-0.5 text-xs shadow-md outline-none"
              value={textEdit.value}
              placeholder={`${labelFor(textEdit.region)} (empty hides it)`}
              maxLength={200}
              onChange={(e) => setTextEdit((s) => (s ? { ...s, value: e.target.value } : s))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTextDraft();
                else if (e.key === 'Escape') setTextEdit(null);
                e.stopPropagation();
              }}
              onBlur={commitTextDraft}
            />
          </div>
        );
      })() : null}
      {/* axis popover — Apply patches the DRAFT (no render, page Apply commits) */}
      {axisEdit && axisBoxes[axisEdit] ? (() => {
        const box = axisBoxes[axisEdit]!;
        const stripTop = imgH * (box.y0 / imgPx.h);
        const anchor = axisEdit === 'xaxis'
          ? stripTop > 310
            ? { left: imgW * 0.3, top: stripTop - 4, transform: 'translateY(-100%)' }
            // Short image: pin INSIDE the image area — anchoring below the
            // strip would clip on the Card's overflow.
            : { left: imgW * 0.3, top: Math.max(8, imgH - 315) }
          : { left: imgW * (box.x1 / imgPx.w) + 8, top: Math.max(8, imgH * 0.08) };
        return (
          <div className="absolute z-30" style={anchor}>
            <CanvasAxisPopover
              aesthetic={axisAestheticFor(axisEdit)}
              discrete={axisDiscreteFor(axisEdit)}
              scaleEditable={Boolean((layout as Record<string, unknown>)[`scale_editable_${axisAestheticFor(axisEdit)}`])}
              showAngle={axisAestheticFor(axisEdit) === 'x' && !flipped}
              options={options}
              pending={false}
              onApply={(patch) => { onPatch(patch); setAxisEdit(null); }}
              onClose={() => setAxisEdit(null)}
            />
          </div>
        );
      })() : null}
    </>
  );
}
