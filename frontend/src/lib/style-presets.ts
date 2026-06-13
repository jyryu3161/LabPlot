const STYLE_PRESET_LABELS: Record<string, string> = {
  nature: 'Clean Classic',
  science: 'Grid Classic',
  cell: 'Biomedical',
  minimal: 'Minimal',
  colorblind: 'Colorblind-safe',
};

export function formatStylePreset(key?: string | null): string {
  if (!key) return '';
  return STYLE_PRESET_LABELS[key] ?? key;
}
