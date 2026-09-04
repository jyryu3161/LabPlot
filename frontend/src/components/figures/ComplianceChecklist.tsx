'use client';

import type { ReactNode } from 'react';
import { Check, X } from 'lucide-react';

// Shared presentational check-item shape. Both the figure-version compliance
// report (ComplianceReport.checks) and the canvas journal-check report
// (CanvasJournalReport.checks) already match this exact shape (name/ok/
// actual/expected/hint) — see M-C1 contract §7/§10 — so this component takes
// no other props and has no knowledge of either endpoint.
export interface ComplianceChecklistItem {
  name: string;
  ok: boolean;
  actual: string;
  expected: string;
  hint?: string | null;
}

/**
 * Read-only pass/fail checklist used by both the figure page's
 * FigureCompliance panel and the canvas editor's journal-check section.
 */
export function ComplianceChecklist({
  passed,
  checks,
  extra,
}: {
  /** Overall pass/fail for the whole report — shown as a summary badge. */
  passed: boolean;
  checks: ComplianceChecklistItem[];
  /** Slot for report-specific context (e.g. skipped-panels notice). */
  extra?: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div
        role="status"
        className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${
          passed ? 'bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
        }`}
      >
        {passed ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
        {passed ? 'Meets requirements' : 'Needs attention'}
      </div>
      <ul className="divide-y rounded-md border text-sm">
        {checks.map((c) => (
          <li key={c.name} className="flex flex-col gap-0.5 px-3 py-1.5">
            <span className="flex items-center gap-1.5">
              {c.ok
                ? <Check className="h-3.5 w-3.5 shrink-0 text-green-600" aria-label="Pass" />
                : <X className="h-3.5 w-3.5 shrink-0 text-red-600" aria-label="Fail" />}
              <span className="font-medium">{c.name}</span>
            </span>
            <span className="pl-5 text-xs text-muted-foreground">
              {c.actual} <span className="mx-1">·</span> expected {c.expected}
            </span>
            {!c.ok && c.hint && (
              <span className="pl-5 text-xs text-amber-700 dark:text-amber-400">{c.hint}</span>
            )}
          </li>
        ))}
        {checks.length === 0 && (
          <li className="px-3 py-2 text-xs text-muted-foreground">No checks available.</li>
        )}
      </ul>
      {extra}
    </div>
  );
}
