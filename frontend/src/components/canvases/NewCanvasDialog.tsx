'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { createCanvas, getCanvasPresets } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Plus } from 'lucide-react';

const MM_MIN = 20;
const MM_MAX = 500;
const CUSTOM = 'custom';

function clampMm(value: number): number {
  if (Number.isNaN(value)) return MM_MIN;
  return Math.min(MM_MAX, Math.max(MM_MIN, Math.round(value)));
}

/**
 * "New canvas" dialog (journal/ISO preset or custom mm). Shared between the
 * global /canvases page and a project's Canvases tab — pass `projectId` to
 * create the canvas inside that project (U3).
 */
export function NewCanvasDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId?: string;
}) {
  const qc = useQueryClient();
  const router = useRouter();

  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [presetKey, setPresetKey] = useState<string>(CUSTOM);
  // A4 portrait — matches the first backend preset, so the form shows A4 even
  // before the presets query resolves (or if it fails).
  const [widthMm, setWidthMm] = useState<number>(210);
  const [heightMm, setHeightMm] = useState<number>(297);

  const { data: presets } = useQuery({
    queryKey: ['canvas-presets'],
    queryFn: getCanvasPresets,
    enabled: open,
  });

  // Reset to a clean form on OPEN; seed the preset ONCE per open when presets
  // arrive. A single [open, presets] reset effect would re-fire when the
  // presets query resolves after open and wipe the user's in-flight typing.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    seededRef.current = false;
    setName('');
    setDesc('');
    setPresetKey(CUSTOM);
    setWidthMm(210);
    setHeightMm(297);
  }, [open]);
  useEffect(() => {
    if (!open || seededRef.current || !presets?.length) return;
    seededRef.current = true;
    const first = presets[0];
    setPresetKey(first.key);
    setWidthMm(first.width_mm);
    setHeightMm(first.height_mm);
  }, [open, presets]);

  const create = useMutation({
    mutationFn: () => createCanvas({
      name: name.trim(),
      description: desc.trim() || undefined,
      preset: presetKey === CUSTOM ? undefined : presetKey,
      width_mm: clampMm(widthMm),
      height_mm: clampMm(heightMm),
      ...(projectId ? { project_id: projectId } : {}),
    }),
    onSuccess: (canvas) => {
      toast.success('Canvas created');
      // Prefix invalidation covers both the global list ['canvases'] and any
      // project-scoped list ['canvases', projectId].
      qc.invalidateQueries({ queryKey: ['canvases'] });
      onOpenChange(false);
      router.push(`/canvases/${canvas.id}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Create failed'),
  });

  const canSubmit = name.trim().length > 0 && !create.isPending;

  function onPresetChange(key: string | null) {
    const next = key ?? CUSTOM;
    setPresetKey(next);
    if (next !== CUSTOM) {
      const preset = presets?.find((p) => p.key === next);
      if (preset) {
        setWidthMm(preset.width_mm);
        setHeightMm(preset.height_mm);
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New canvas</DialogTitle>
          <DialogDescription>
            {projectId
              ? 'The canvas is created inside this project and shared with its members.'
              : 'Pick a journal preset or set a custom physical size (mm).'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => { e.preventDefault(); if (canSubmit) create.mutate(); }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="canvas-name">Name</Label>
            <Input
              id="canvas-name"
              value={name}
              autoFocus
              maxLength={255}
              placeholder="e.g. Figure 1 — main"
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="canvas-preset">Preset</Label>
            <Select value={presetKey} onValueChange={onPresetChange}>
              <SelectTrigger id="canvas-preset" aria-label="Canvas size preset" className="w-full">
                <SelectValue placeholder="Choose a preset">
                  {(value) =>
                    value === CUSTOM
                      ? 'Custom size'
                      : presets?.find((p) => p.key === value)?.label ?? 'Choose a preset'
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {presets?.map((p) => (
                  <SelectItem key={p.key} value={p.key}>
                    {p.label} ({p.width_mm} × {p.height_mm} mm)
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM}>Custom size</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="canvas-width">Width (mm)</Label>
              <Input
                id="canvas-width"
                type="number"
                inputMode="numeric"
                min={MM_MIN}
                max={MM_MAX}
                value={widthMm}
                onChange={(e) => { setWidthMm(Number(e.target.value)); setPresetKey(CUSTOM); }}
                onBlur={() => setWidthMm((v) => clampMm(v))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="canvas-height">Height (mm)</Label>
              <Input
                id="canvas-height"
                type="number"
                inputMode="numeric"
                min={MM_MIN}
                max={MM_MAX}
                value={heightMm}
                onChange={(e) => { setHeightMm(Number(e.target.value)); setPresetKey(CUSTOM); }}
                onBlur={() => setHeightMm((v) => clampMm(v))}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Each side is clamped to {MM_MIN}–{MM_MAX} mm.</p>

          <div className="space-y-1.5">
            <Label htmlFor="canvas-desc">Description</Label>
            <Textarea
              id="canvas-desc"
              value={desc}
              rows={2}
              placeholder="Optional"
              onChange={(e) => setDesc(e.target.value)}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {create.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
              Create canvas
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
