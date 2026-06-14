export interface User {
  id: string;
  email: string;
  display_name: string;
  is_active: boolean;
  is_approved: boolean;
  is_admin: boolean;
  created_at: string;
}

export interface LoginRequest { email: string; password: string; }
export interface RegisterRequest { email: string; password: string; display_name: string; }
export interface TokenResponse { access_token: string; refresh_token: string; token_type: string; }

export interface ColumnProfile {
  name: string;
  dtype: string;
  role: string;
  n_unique: number;
  n_missing: number;
  sample_values: unknown[];
  stats: Record<string, number> | null;
}

export interface DatasetListItem {
  id: string;
  name: string;
  description?: string;
  original_filename: string;
  format: string;
  n_rows: number;
  n_cols: number;
  project_id?: string;
  created_at: string;
}

export interface DescriptiveStat {
  column: string; n: number;
  mean?: number; sd?: number; median?: number; min?: number; max?: number; q1?: number; q3?: number;
}
export interface GroupStat { level: string; n: number; mean?: number; sd?: number; }
export interface Comparison {
  group_column: string; value_column: string; test: string;
  statistic?: number; p_value?: number; significant: boolean; groups: GroupStat[];
}
export interface DatasetStatistics { descriptive: DescriptiveStat[]; comparisons: Comparison[]; }

export interface Project { id: string; name: string; description?: string; created_at: string; updated_at: string; }
export interface ProjectListItem extends Project { dataset_count: number; figure_count: number; }

export interface DatasetDetail extends DatasetListItem {
  column_profile: ColumnProfile[];
  preview: Record<string, unknown>[];
  statistics?: DatasetStatistics;
}

export interface ChartSuggestion {
  plot_type: string;
  title?: string;
  score?: number;
  rationale?: string;
  suggested_mapping?: Record<string, unknown>;
  required_vars?: Record<string, unknown>;
  example_usage?: string;
  source: string;
}

export interface PlotField { key: string; label: string; roles: string[]; multi?: boolean; }
export interface PlotOption { key: string; label: string; type: string; choices?: string[]; default?: unknown; }
export interface PlotTypeDef {
  type: string;
  label: string;
  required: PlotField[];
  optional: PlotField[];
  options: PlotOption[];
}
export interface StyleDef { key: string; label: string; }
export interface PaletteDef { key: string; label: string; colorblind_safe: boolean; hex: string[]; }
export interface PublicFigure { name: string; plot_type: string; style_preset: string; thumb_url: string; domain?: string; domain_label?: string; }

export interface FigureVersion {
  id: string;
  version_number: number;
  mapping: Record<string, unknown>;
  options: Record<string, unknown>;
  style_preset: string;
  change_note?: string;
  created_at: string;
  png_url?: string;
  svg_url?: string;
  tiff_url?: string;
  pdf_url?: string;
  r_url?: string;
}

export interface FigureListItem {
  id: string;
  name: string;
  plot_type: string;
  style_preset: string;
  status: string;
  dataset_id: string;
  project_id?: string;
  created_at: string;
  updated_at: string;
  thumb_url?: string;
}

export interface GalleryFigureItem extends FigureListItem {
  dataset_name?: string;
  project_name?: string;
  owner_name?: string;
  owner_email?: string;
  current_version_id?: string;
  r_url?: string;
}

export interface FigureDetail {
  id: string;
  name: string;
  plot_type: string;
  style_preset: string;
  status: string;
  dataset_id: string;
  project_id?: string;
  dataset_name?: string;
  description?: string;
  legend?: string;
  current_version_id?: string;
  created_at: string;
  updated_at: string;
  versions: FigureVersion[];
}

export interface Review {
  id: string;
  figure_version_id: string;
  publication_score?: number;
  payload: {
    summary?: string;
    publication_score?: number;
    visual_quality?: { score?: number; comments?: string[] };
    statistical?: { score?: number; comments?: string[] };
    suitability?: { score?: number; comments?: string[] };
    strengths?: string[];
    issues?: string[];
  };
  created_at: string;
}

export interface Improvement {
  id: string;
  figure_version_id: string;
  suggestion_type?: string;
  current_state?: string;
  recommended?: string;
  param_patch: Record<string, unknown>;
  priority?: string;
  applied: boolean;
  created_at: string;
}

export interface AIConfig {
  provider: string;
  enabled: boolean;
  claude_model: string;
  gemini_model: string;
  has_anthropic_key: boolean;
  has_gemini_key: boolean;
  updated_at: string;
}

export interface AdminUser {
  id: string;
  email: string;
  display_name: string;
  is_active: boolean;
  is_approved: boolean;
  is_admin: boolean;
  created_at: string;
  dataset_count: number;
  figure_count: number;
  ai_request_count: number;
  ai_input_tokens: number;
  ai_output_tokens: number;
  ai_total_tokens: number;
  ai_estimated_cost_usd: number;
  ai_monthly_limit: number;
  render_monthly_limit: number;
  storage_limit_mb: number;
  ai_monthly_used: number;
  render_monthly_used: number;
  storage_used_mb: number;
}

export interface AuditLogItem {
  id: string;
  actor_id?: string;
  action: string;
  target_type?: string;
  target_id?: string;
  ip_address?: string;
  user_agent?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
}
