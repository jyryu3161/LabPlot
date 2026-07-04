'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowDown, Trash2, AlignLeft, AlignCenter, AlignRight } from 'lucide-react';
import type { CanvasAnnotation } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  ANNOTATION_TYPE_LABEL, FONT_PT_DEFAULT, FONT_PT_MAX, FONT_PT_MIN,
  STROKE_HEX_DEFAULT, STROKE_PT_DEFAULT, STROKE_PT_MAX, STROKE_PT_MIN,
  clampFontPt, clampStrokePt, isValidHex, sanitizeText, TEXT_MAX_LEN,
} from './annotations';

// A small, fixed swatch row -- "palette swatches consistent with existing
// UI" per the design ask; CanvasColorEditor's own color input has no fixed
// palette to borrow from, so this is a sensible general-purpose set.
const SWATCHES = [
  '#000000', '#ffffff', '#ef4444', '#f97316', '#f59e0b',
  '#22c55e', '#0ea5e9', '#2563eb', '#7c3aed', '#ec4899', '#64748b',
];

function ColorField({
  label, value, onDraft, onCommit,
}: {
  label: string;
  value: string;
  onDraft: (hex: string) => void;
  onCommit: (hex: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          value={isValidHex(draft) ? draft : STROKE_HEX_DEFAULT}
          // Draft path, not onCommit: the native picker fires an input event
          // per mouse move while dragging the palette — a commit each would
          // flood the server with whole-array PATCHes and evict the 50-op
          // undo history with color micro-steps. onDraft applies the cache
          // patch instantly (live feedback) and the parent debounces ONE
          // PATCH + ONE history entry 400ms after the drag settles.
          onChange={(e) => { setDraft(e.target.value); onDraft(e.target.value); }}
          className="h-7 w-9 shrink-0 cursor-pointer rounded border p-0"
          aria-label={`${label} picker`}
        />
        <Input
          className="h-7 flex-1 font-mono text-xs uppercase"
          value={draft}
          maxLength={7}
          aria-label={`${label} hex`}
          // Only VALID hex may reach the shared cache: a partial draft like
          // '#f' would otherwise be debounce-committed, 400 on the server,
          // and poison every subsequent annotation commit until corrected.
          onChange={(e) => {
            const v = e.target.value;
            setDraft(v);
            if (isValidHex(v)) onDraft(v);
          }}
          onBlur={() => { if (isValidHex(draft)) onCommit(draft); else setDraft(value); }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }}
        />
      </div>
      <div className="flex flex-wrap gap-1">
        {SWATCHES.map((hex) => (
          <button
            key={hex}
            type="button"
            aria-label={`${label} ${hex}`}
            title={hex}
            className="h-4 w-4 rounded-sm border border-black/10 ring-offset-1 hover:ring-1 hover:ring-primary"
            style={{ background: hex }}
            onClick={() => { setDraft(hex); onCommit(hex); }}
          />
        ))}
      </div>
    </div>
  );
}

export function CanvasAnnotationInspector({
  selected,
  onDraft,
  onCommit,
  onBringForward,
  onSendBackward,
  onDelete,
}: {
  /** The currently-selected annotations (pure annotation selection). */
  selected: CanvasAnnotation[];
  /** Optimistic, non-debounced-commit local update (parent debounces the
   *  actual PATCH+history ~400ms after the last call for a given id). */
  onDraft: (id: string, patch: Partial<CanvasAnnotation>) => void;
  /** Immediate commit (discrete actions: swatches, align, fill toggle). */
  onCommit: (id: string, patch: Partial<CanvasAnnotation>, label: string) => void;
  onBringForward: (ids: string[]) => void;
  onSendBackward: (ids: string[]) => void;
  onDelete: (ids: string[]) => void;
}) {
  const ids = selected.map((a) => a.id);
  const single = selected.length === 1 ? selected[0] : null;

  // Local drafts for debounced text/number fields, reseeded when the SINGLE
  // selection's identity changes (not on every prop update, so mid-typing
  // re-renders from the optimistic patch don't fight the input's own value).
  const [textDraft, setTextDraft] = useState(single?.text ?? '');
  const [fontDraft, setFontDraft] = useState(String(single?.font_pt ?? FONT_PT_DEFAULT));
  const [strokeDraft, setStrokeDraft] = useState(String(single?.stroke_pt ?? STROKE_PT_DEFAULT));
  const seededId = useRef<string | null>(null);
  useEffect(() => {
    if (!single || seededId.current === single.id) return;
    seededId.current = single.id;
    setTextDraft(single.text ?? '');
    setFontDraft(String(single.font_pt ?? FONT_PT_DEFAULT));
    setStrokeDraft(String(single.stroke_pt ?? STROKE_PT_DEFAULT));
  }, [single]);

  if (selected.length === 0) return null;

  // ── multi-selection: quick actions only (delete, z) ──
  if (!single) {
    return (
      <div className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-l bg-background p-3 text-sm">
        <span className="font-semibold">{selected.length} annotations selected</span>
        <div className="flex items-center gap-1">
          <Button type="button" size="xs" variant="outline" onClick={() => onBringForward(ids)} title="Bring forward (among annotations)">
            <ArrowUp className="h-3.5 w-3.5" /> Forward
          </Button>
          <Button type="button" size="xs" variant="outline" onClick={() => onSendBackward(ids)} title="Send backward (among annotations)">
            <ArrowDown className="h-3.5 w-3.5" /> Back
          </Button>
        </div>
        <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={() => onDelete(ids)}>
          <Trash2 className="h-3.5 w-3.5" /> Delete {selected.length} annotations
        </Button>
      </div>
    );
  }

  const isText = single.type === 'text';
  const isShapeFill = single.type === 'rect' || single.type === 'ellipse';
  const hasStroke = !isText;

  return (
    <div className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-l bg-background p-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-semibold">{ANNOTATION_TYPE_LABEL[single.type]}</span>
      </div>

      {isText && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ann-text" className="text-[11px] text-muted-foreground">Text</Label>
          <Input
            id="ann-text"
            className="h-7 text-xs"
            maxLength={TEXT_MAX_LEN}
            value={textDraft}
            placeholder="Empty text is removed on blur"
            onChange={(e) => {
              const v = sanitizeText(e.target.value);
              setTextDraft(v);
              onDraft(single.id, { text: v });
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }}
            onBlur={() => onCommit(single.id, { text: textDraft }, 'edit text')}
          />

          <Label className="text-[11px] text-muted-foreground">Align</Label>
          <div className="flex items-center gap-0.5">
            {([['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight]] as const).map(([a, Icon]) => (
              <Button
                key={a}
                type="button"
                size="icon-sm"
                variant={(single.align ?? 'left') === a ? 'default' : 'outline'}
                aria-label={`Align text ${a}`}
                title={`Align ${a}`}
                onClick={() => onCommit(single.id, { align: a }, 'text align')}
              >
                <Icon className="h-3.5 w-3.5" />
              </Button>
            ))}
          </div>

          <Label htmlFor="ann-font" className="text-[11px] text-muted-foreground">Font size (pt)</Label>
          <Input
            id="ann-font"
            className="h-7 w-20 text-xs"
            type="number"
            min={FONT_PT_MIN}
            max={FONT_PT_MAX}
            value={fontDraft}
            onChange={(e) => {
              setFontDraft(e.target.value);
              const n = Number(e.target.value);
              if (Number.isFinite(n)) onDraft(single.id, { font_pt: clampFontPt(n) });
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }}
            onBlur={() => {
              const n = clampFontPt(Number(fontDraft) || FONT_PT_DEFAULT);
              setFontDraft(String(n));
              onCommit(single.id, { font_pt: n }, 'font size');
            }}
          />

          <ColorField
            label="Text color"
            value={single.fill_hex ?? STROKE_HEX_DEFAULT}
            onDraft={(hex) => onDraft(single.id, { fill_hex: hex })}
            onCommit={(hex) => onCommit(single.id, { fill_hex: hex }, 'text color')}
          />
        </div>
      )}

      {hasStroke && (
        <div className="flex flex-col gap-1.5">
          <ColorField
            label="Stroke color"
            value={single.stroke_hex ?? STROKE_HEX_DEFAULT}
            onDraft={(hex) => onDraft(single.id, { stroke_hex: hex })}
            onCommit={(hex) => onCommit(single.id, { stroke_hex: hex }, 'stroke color')}
          />
          <Label htmlFor="ann-stroke-w" className="text-[11px] text-muted-foreground">Stroke width (pt)</Label>
          <Input
            id="ann-stroke-w"
            className="h-7 w-20 text-xs"
            type="number"
            min={STROKE_PT_MIN}
            max={STROKE_PT_MAX}
            step={0.25}
            value={strokeDraft}
            onChange={(e) => {
              setStrokeDraft(e.target.value);
              const n = Number(e.target.value);
              if (Number.isFinite(n)) onDraft(single.id, { stroke_pt: clampStrokePt(n) });
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }}
            onBlur={() => {
              const n = clampStrokePt(Number(strokeDraft) || STROKE_PT_DEFAULT);
              setStrokeDraft(String(n));
              onCommit(single.id, { stroke_pt: n }, 'stroke width');
            }}
          />
        </div>
      )}

      {isShapeFill && (
        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={single.fill_hex != null}
              aria-label="Enable fill"
              onChange={(e) => onCommit(single.id, { fill_hex: e.target.checked ? '#ffffff' : null }, 'fill')}
            />
            Fill
          </span>
          {single.fill_hex != null && (
            <ColorField
              label="Fill color"
              value={single.fill_hex}
              onDraft={(hex) => onDraft(single.id, { fill_hex: hex })}
              onCommit={(hex) => onCommit(single.id, { fill_hex: hex }, 'fill color')}
            />
          )}
        </div>
      )}

      <div className="flex items-center gap-1">
        <Button type="button" size="xs" variant="outline" onClick={() => onBringForward(ids)} title="Bring forward (among annotations)">
          <ArrowUp className="h-3.5 w-3.5" /> Forward
        </Button>
        <Button type="button" size="xs" variant="outline" onClick={() => onSendBackward(ids)} title="Send backward (among annotations)">
          <ArrowDown className="h-3.5 w-3.5" /> Back
        </Button>
      </div>
      <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={() => onDelete(ids)}>
        <Trash2 className="h-3.5 w-3.5" /> Delete
      </Button>
    </div>
  );
}
