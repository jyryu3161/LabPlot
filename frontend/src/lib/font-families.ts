// Shared "font family" option list — the figure editor's per-figure
// `options.font_family` selector (figures/[id]/page.tsx) and the Canvas
// journal typography form (CanvasJournalPanel.tsx, M-C1 §6) both render this
// exact set so a canvas-wide typography patch only ever proposes a value the
// figure renderer already accepts. Keep in sync with the backend's font
// family whitelist (r_engine font resolution).
export const FONT_FAMILY_OPTIONS = [
  { value: '', label: 'Default (sans)' },
  { value: 'sans', label: 'Sans-serif' },
  { value: 'arial', label: 'Arial-compatible sans' },
  { value: 'dejavu_sans', label: 'DejaVu Sans (installed Arial-compatible fallback)' },
  { value: 'helvetica', label: 'Helvetica-compatible sans' },
  { value: 'serif', label: 'Serif' },
  { value: 'mono', label: 'Monospace' },
] as const;
