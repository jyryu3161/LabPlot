/**
 * Undo/redo manager for the multi-panel canvas editor.
 *
 * Every canvas edit is ALREADY persisted server-side the moment it happens
 * (immediate PATCH/POST/DELETE), so history entries store the information
 * needed to apply the INVERSE of an edit (undo) or re-apply it (redo) via the
 * very same API mutations. This module is pure TypeScript (no React, no I/O):
 * the editor component owns the mutations and applies the ops it pops from
 * here.
 *
 * Id remapping: undoing a delete (or redoing an add) re-creates the panel via
 * `addCanvasPanel`, which returns a NEW server id. Later history entries still
 * reference the OLD id, so the manager keeps an idMap (recordedId → current
 * live id) and `mapId()` translates ids on every subsequent application.
 *
 * idMap sanity trace (add → undo → redo → later ops):
 *   1. user adds panel        → record panel-add   {snapshot.panelId: "P1"}
 *   2. user moves it          → record panel-update{panelId: "P1", …}
 *   3. undo (move)            → PATCH mapId("P1") = "P1"          (map empty)
 *   4. undo (add)             → DELETE mapId("P1") = "P1"
 *   5. redo (add)             → POST returns "P2" → remap("P1","P2")
 *   6. redo (move)            → PATCH mapId("P1") = "P2"          ✓ remapped
 *   7. user deletes it        → record panel-delete{snapshot.panelId: "P2"}
 *   8. undo (delete)          → POST returns "P3" → remap("P2","P3");
 *                                the alias chain updates "P1"→"P3" too, so
 *                                even entry (2) still resolves correctly.
 *
 * U8 annotations: unlike panels, annotations have no server-assigned id (the
 * client generates the uuid) and no per-item CRUD endpoint — the whole array
 * round-trips in one `updateCanvas({ annotations })` PATCH. That sidesteps id
 * remapping entirely, so 'annotations-update' just snapshots the full
 * before/after array (capped at 200 small items — cheap to store whole).
 */

import type { CanvasAnnotation } from '@/lib/types';

/** Fields of a panel that `updateCanvasPanel` can patch. */
export type PanelFields = Partial<{
  x_mm: number;
  y_mm: number;
  width_mm: number;
  height_mm: number;
  z_order: number;
  label: string | null;
  label_visible: boolean;
  pinned_version_id: string | null;
}>;

/** Everything needed to re-create a deleted panel via `addCanvasPanel`. */
export interface PanelSnapshot {
  /** The panel's live server id at the time the op was recorded. */
  panelId: string;
  /** null for imported-image panels (image_key identifies the blob instead). */
  figure_id: string | null;
  /** Imported-image blob key — blobs are never deleted on panel removal, so
   *  undo can always re-reference the same key. */
  image_key?: string | null;
  x_mm: number;
  y_mm: number;
  width_mm: number;
  height_mm: number;
  z_order: number;
  label: string | null;
  label_visible: boolean;
  pinned_version_id: string | null;
}

export interface CanvasSize {
  width_mm: number;
  height_mm: number;
}

export type HistoryOp =
  /** Move / resize / z-order / label / label_visible / pin change.
   *  Undo → updateCanvasPanel(mapId(panelId), before); redo → …(after). */
  | { type: 'panel-update'; panelId: string; before: PanelFields; after: PanelFields; label: string }
  /** Multi-panel batch (U7 group move / align / distribute / group resize / nudge).
   *  One entry covers every panel touched by a single gesture. Undo applies each
   *  item's `before`, redo applies each item's `after` — both mapId()-remapped,
   *  same as `panel-update`. */
  | { type: 'panels-update'; items: { panelId: string; before: PanelFields; after: PanelFields }[]; label: string }
  /** Panel added. Undo → deleteCanvasPanel (no confirm); redo → addCanvasPanel(snapshot) + remap. */
  | { type: 'panel-add'; snapshot: PanelSnapshot; label: string }
  /** Panel deleted. Undo → addCanvasPanel(snapshot) + remap; redo → deleteCanvasPanel(mapped id). */
  | { type: 'panel-delete'; snapshot: PanelSnapshot; label: string }
  /** Canvas physical size change. Undo/redo via updateCanvas. */
  | { type: 'canvas-size'; before: CanvasSize; after: CanvasSize; label: string }
  /** U8: annotation create/move/resize/endpoint-drag/inspector-edit/delete/
   *  z-change. Whole-array snapshot; undo → updateCanvas({annotations: before}),
   *  redo → …after. */
  | { type: 'annotations-update'; before: CanvasAnnotation[]; after: CanvasAnnotation[]; label: string };

export const HISTORY_CAP = 50;

export class CanvasHistory {
  private past: HistoryOp[] = [];
  private future: HistoryOp[] = [];
  /** recordedId → current live id (see module docblock). */
  private idMap = new Map<string, string>();
  private applying = false;
  private readonly onChange?: () => void;

  constructor(onChange?: () => void) {
    this.onChange = onChange;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** True while an undo/redo is being applied — record() is a no-op then. */
  get isApplying(): boolean {
    return this.applying;
  }

  beginApply(): void {
    this.applying = true;
  }

  endApply(): void {
    this.applying = false;
  }

  /** Record a fresh user edit. Truncates the redo tail; capped at HISTORY_CAP. */
  record(op: HistoryOp): void {
    if (this.applying) return; // guard: applying an undo/redo must not re-record
    this.past.push(op);
    if (this.past.length > HISTORY_CAP) this.past.shift();
    this.future = [];
    this.onChange?.();
  }

  /** Pop the op to undo (already moved onto the redo stack). Null at the end. */
  undo(): HistoryOp | null {
    const op = this.past.pop() ?? null;
    if (op) {
      this.future.push(op);
      this.onChange?.();
    }
    return op;
  }

  /** Pop the op to redo (already moved back onto the undo stack). Null at the end. */
  redo(): HistoryOp | null {
    const op = this.future.pop() ?? null;
    if (op) {
      this.past.push(op);
      this.onChange?.();
    }
    return op;
  }

  /** Move the last popped op back where it came from (failed application). */
  rollback(direction: 'undo' | 'redo'): void {
    if (direction === 'undo') {
      const op = this.future.pop();
      if (op) this.past.push(op);
    } else {
      const op = this.past.pop();
      if (op) this.future.push(op);
    }
    this.onChange?.();
  }

  /** Translate a recorded panel id to its current live id (after re-adds). */
  mapId(id: string): string {
    return this.idMap.get(id) ?? id;
  }

  /**
   * After re-creating a panel (undo delete / redo add): every alias that
   * currently resolves to `oldId` — plus `oldId` itself — now points at
   * `newId`, so arbitrarily long delete/re-add chains keep resolving.
   */
  remap(oldId: string, newId: string): void {
    for (const [k, v] of this.idMap) {
      if (v === oldId) this.idMap.set(k, newId);
    }
    this.idMap.set(oldId, newId);
  }
}
