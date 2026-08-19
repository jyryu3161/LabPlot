'use client';

import { useEffect, useRef, useState } from 'react';
import type { FigureLayout } from '@/lib/types';
import { FigureElementEditLayer } from './FigureElementEditLayer';

/**
 * Figure preview with direct element editing (U6 title/axis hit targets).
 *
 * The former drag-to-place annotation tools (Text / Arrow / Box / Bracket
 * behind a "Place on figure" toggle) were removed on request (2026-08-19):
 * the flow proved confusing next to the AI editor's marks and its draft
 * edits kept feeding the live-preview pipeline. Existing stored
 * options.annotations still render inside the R image itself; the UI just no
 * longer creates or edits them.
 */
export function FigureAnnotationOverlay({
  imageUrl,
  alt,
  layout,
  elementOptions,
  renderedElementOptions,
  onOptionsPatch,
}: {
  imageUrl: string;
  alt: string;
  layout?: FigureLayout | null;
  /** U6 element editing (optional): current draft options + patcher. When
   *  provided, title/axis-label/axis-strip hit targets render over the image
   *  and edits go to the page's DRAFT options — zero extra renders. */
  elementOptions?: Record<string, unknown>;
  /** RENDERED version's options (flip mapping follows the on-screen render). */
  renderedElementOptions?: Record<string, unknown>;
  onOptionsPatch?: (patch: Record<string, string | number | boolean | null>) => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  // Keep the edit layer sized to the rendered image (responsive + after load).
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const measure = () => setDims({ w: img.clientWidth, h: img.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(img);
    return () => ro.disconnect();
  }, [imageUrl]);

  const { w, h } = dims;

  return (
    <div className="relative mx-auto w-fit">
      <img
        ref={imgRef}
        src={imageUrl}
        alt={alt}
        decoding="async"
        draggable={false}
        className="mx-auto block max-h-[58vh] w-auto rounded bg-white object-contain"
        onLoad={() => { const img = imgRef.current; if (img) setDims({ w: img.clientWidth, h: img.clientHeight }); }}
      />
      {elementOptions && onOptionsPatch && w > 0 && h > 0 && (
        <FigureElementEditLayer
          layout={layout as Record<string, unknown> | null}
          imgW={w}
          imgH={h}
          options={elementOptions}
          renderedOptions={renderedElementOptions}
          onPatch={onOptionsPatch}
        />
      )}
    </div>
  );
}
