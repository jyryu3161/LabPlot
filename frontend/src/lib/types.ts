export interface User {
  id: string;
  email: string;
  display_name: string;
  is_active: boolean;
  is_approved: boolean;
  is_admin: boolean;
  active_organization_id?: string | null;
  created_at: string;
}

export interface LoginRequest { email: string; password: string; }
export interface RegisterRequest { email: string; password: string; display_name: string; organization_id?: string; organization_name?: string; }
export interface TokenResponse { access_token: string; refresh_token: string; token_type: string; }

export interface OrganizationItem {
  id: string;
  name: string;
  slug: string;
  domain?: string | null;
  description?: string | null;
  is_active: boolean;
  created_at: string;
}

export interface OrganizationSearchItem {
  id: string;
  name: string;
  slug: string;
  domain?: string | null;
  member_count: number;
}

export interface MembershipItem {
  id: string;
  organization_id: string;
  organization_name: string;
  user_id: string;
  email: string;
  display_name: string;
  role: 'admin' | 'member';
  status: 'pending' | 'active' | 'rejected';
  requested_at: string;
  reviewed_at?: string | null;
}

export interface OrganizationUserSearchItem {
  id: string;
  email: string;
  display_name: string;
  is_approved: boolean;
  membership_status?: 'pending' | 'active' | 'rejected' | null;
  membership_role?: 'admin' | 'member' | null;
}

export interface MyOrganizationItem {
  organization: OrganizationItem;
  membership: MembershipItem;
  active: boolean;
  is_org_admin: boolean;
}

export interface OrganizationAIConfig {
  provider: string;
  enabled: boolean;
  claude_model: string;
  gemini_model: string;
  has_anthropic_key: boolean;
  has_gemini_key: boolean;
  secret_provider: string;
  updated_at?: string | null;
}

export interface OrganizationUsageSummary {
  ai_request_count: number;
  ai_input_tokens: number;
  ai_output_tokens: number;
  ai_total_tokens: number;
  ai_estimated_cost_usd: number;
}

export interface ColumnProfile {
  name: string;
  dtype: string;
  role: string;
  n_unique: number;
  n_missing: number;
  sample_values: unknown[];
  stats: Record<string, number> | null;
}

export interface ColumnValues {
  column: string;
  values: string[];
  distinct_count: number;
  truncated: boolean;
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
  display_order?: number | null;
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

export interface ProjectCollaborator {
  id: string;
  user_id: string;
  email: string;
  display_name: string;
  role: 'editor' | 'viewer';
  status: 'pending' | 'accepted';
  created_at: string;
  accepted_at?: string;
}

export interface ProjectUserSearchItem {
  id: string;
  email: string;
  display_name: string;
}

export interface ProjectInvitation {
  id: string;
  project_id: string;
  project_name: string;
  project_description?: string;
  owner_name: string;
  owner_email: string;
  role: 'editor' | 'viewer';
  created_at: string;
}

export interface ProjectInviteDraft extends ProjectUserSearchItem {
  role: 'editor' | 'viewer';
}

export interface Project {
  id: string;
  owner_id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
  role: 'owner' | 'editor' | 'viewer';
  collaborators?: ProjectCollaborator[];
}
export interface ProjectListItem extends Project { dataset_count: number; figure_count: number; collaborator_count: number; }

export interface DatasetDetail extends DatasetListItem {
  column_profile: ColumnProfile[];
  preview: Record<string, unknown>[];
  statistics?: DatasetStatistics;
  ingest_options?: DatasetIngestOptions;
  focus_columns?: string[];
}

export interface DatasetIngestOptions {
  sheet_name?: string;
  header_row?: number;
  data_start_row?: number;
  end_row?: number;
  start_col?: number;
  end_col?: number;
}

export interface DatasetPreview {
  filename: string;
  format: string;
  sheets: string[];
  selected_sheet?: string;
  ingest_options: DatasetIngestOptions;
  raw_preview: unknown[][];
  parsed_preview: Record<string, unknown>[];
  column_profile: ColumnProfile[];
  n_rows: number;
  n_cols: number;
}

export interface ChartSuggestion {
  plot_type: string;
  title?: string;
  score?: number;
  rank?: number;
  fit?: string;
  rationale?: string;
  suggested_mapping?: Record<string, unknown>;
  required_vars?: Record<string, unknown>;
  example_usage?: string;
  source: string;
}

export interface RecommendationCache {
  cached: boolean;
  suggestions: ChartSuggestion[];
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
export interface StyleDef { key: string; label: string; description?: string; }
export interface PaletteDef {
  key: string;
  label: string;
  colorblind_safe: boolean;
  hex: string[];
  custom?: boolean;
  id?: string;
  name?: string;
}
export interface PublicFigure {
  id: string;
  current_version_id?: string;
  name: string;
  plot_type: string;
  style_preset: string;
  thumb_url: string;
  domain?: string;
  domain_label?: string;
}

export interface GalleryTemplate {
  id: string;
  name: string;
  plot_type: string;
  style_preset: string;
  thumb_url: string;
  domain?: string;
  domain_label?: string;
  source_mapping: Record<string, unknown>;
  options: Record<string, unknown>;
  example_data?: {
    download_url: string;
    filename: string;
    n_rows: number;
    n_cols: number;
    columns: ColumnProfile[];
    preview: Record<string, unknown>[];
  } | null;
}

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
  eps_url?: string;
  html_url?: string;
  r_url?: string;
  // Panel geometry + data ranges for precise annotation placement (null when
  // the plot type has no standard ggplot panel, e.g. 3D/heatmap/network).
  layout?: FigureLayout | null;
  // Populated when a version is produced by applying AI suggestions: dotted
  // paths that were applied vs. dropped as unsupported. Empty for plain edits.
  applied?: string[];
  skipped?: string[];
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
  display_order?: number | null;
  is_favorite: boolean;
  thumb_url?: string;
}

export interface GalleryFigureItem extends FigureListItem {
  dataset_name?: string;
  project_name?: string;
  is_public: boolean;
  current_version_id?: string;
  r_url?: string;
}

export interface FigureTemplateFavoriteItem {
  id: string;
  figure_id: string;
  source_version_id?: string | null;
  name: string;
  figure_name: string;
  plot_type: string;
  style_preset: string;
  source_version_number?: number | null;
  mapping: Record<string, unknown>;
  options: Record<string, unknown>;
  status: string;
  dataset_id: string;
  project_id?: string | null;
  created_at: string;
  updated_at: string;
  figure_updated_at: string;
  is_favorite: true;
  thumb_url?: string;
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
  is_favorite: boolean;
  is_public: boolean;
  share_token?: string | null;
  versions: FigureVersion[];
}

export interface FigureShareResponse {
  share_token: string | null;
  share_url: string | null;
}

export interface SharedFigure {
  id: string;
  name: string;
  plot_type: string;
  created_at: string;
  png_url?: string;
  width_in?: number;
  height_in?: number;
  dpi?: number;
}

export interface UsageSummary {
  ai_monthly_used: number;
  ai_monthly_limit: number;
  render_monthly_used: number;
  render_monthly_limit: number;
  storage_used_mb: number;
  storage_limit_mb: number;
}

export type TransformOperation =
  | { op: 'melt'; id_columns: string[]; value_columns: string[]; names_to?: string; values_to?: string }
  | { op: 'filter'; column: string; operator: '==' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'not_null'; value?: string | number | null }
  | { op: 'derive'; new_column: string; function: 'add' | 'subtract' | 'multiply' | 'divide' | 'log' | 'log2' | 'log10' | 'sqrt' | 'zscore' | 'abs'; columns: string[]; constant?: number }
  | { op: 'select'; columns: string[] }
  | { op: 'rename'; mapping: Record<string, string> };

export interface TransformPreview {
  columns: string[];
  rows: (string | number | null)[][];
  total_rows: number;
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
  // Dotted paths this suggestion proposed that were dropped by sanitization.
  skipped?: string[];
  created_at: string;
}

export interface MethodsTextResponse { methods_text: string; }
export interface AltTextResponse { alt_text: string; }

export interface FigureCodeResponse {
  language: 'python' | 'latex';
  filename: string;
  code: string;
}

export interface FigureLayout {
  panel_px: { x0: number; y0: number; x1: number; y1: number };
  img_px: { w: number; h: number };
  x_range: [number, number];
  y_range: [number, number];
  x_discrete: boolean;
  y_discrete: boolean;
}

export type AnnotationCoord = 'data' | 'relative';
export type FigureAnnotation =
  | { kind: 'text'; x: number; y: number; text: string; size?: number; color?: string; coord?: AnnotationCoord }
  | { kind: 'arrow'; x: number; y: number; x2: number; y2: number; color?: string; coord?: AnnotationCoord }
  | { kind: 'rect'; x: number; y: number; x2: number; y2: number; color?: string; coord?: AnnotationCoord }
  | { kind: 'bracket'; x: number; x2: number; y: number; label?: string; color?: string; coord?: AnnotationCoord };

export interface SeriesStyle {
  color?: string;
  linetype?: 'solid' | 'dashed' | 'dotted' | 'dotdash' | 'longdash';
  shape?: 'circle' | 'square' | 'triangle' | 'diamond';
}

export interface BulkStyleResult {
  updated: string[];
  skipped: string[];
}

export interface FigureComment {
  id: string;
  figure_id: string;
  author_id: string;
  author_name: string;
  body: string;
  created_at: string;
  can_delete: boolean;
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

export interface EmailDeliveryStatus {
  configured: boolean;
  host: string;
  port: number;
  from_address: string;
  username_set: boolean;
  use_tls: boolean;
  use_ssl: boolean;
  app_base_url: string;
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
  ai_monthly_input_tokens: number;
  ai_monthly_output_tokens: number;
  ai_monthly_total_tokens: number;
  ai_monthly_estimated_cost_usd: number;
  ai_monthly_limit: number;
  render_monthly_limit: number;
  storage_limit_mb: number;
  ai_monthly_used: number;
  render_monthly_used: number;
  storage_used_mb: number;
  organizations: {
    organization_id: string;
    organization_name: string;
    role: 'admin' | 'member';
    status: 'pending' | 'active' | 'rejected';
    active: boolean;
  }[];
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

export interface ClientErrorItem {
  id: string;
  user_id?: string;
  source: string;
  message: string;
  path?: string;
  stack?: string;
  user_agent?: string;
  created_at: string;
}

// ---- Multi-panel Canvas (mm physical units) ----
export interface CanvasPanel {
  id: string;
  canvas_id: string;
  figure_id: string;
  pinned_version_id?: string | null;
  x_mm: number;
  y_mm: number;
  width_mm: number;
  height_mm: number;
  z_order: number;
  label?: string | null;
  label_visible: boolean;
  effective_version_id?: string | null;
  render_url?: string | null;
  created_at: string;
  updated_at: string;
}
export interface Canvas {
  id: string;
  name: string;
  description?: string | null;
  project_id?: string | null;
  width_mm: number;
  height_mm: number;
  preset?: string | null;
  background: string;
  export_snapshot?: Record<string, string> | null;
  created_at: string;
  updated_at: string;
}
export interface CanvasDetail extends Canvas {
  panels: CanvasPanel[];
}
export interface CanvasListItem {
  id: string;
  name: string;
  project_id?: string | null;
  width_mm: number;
  height_mm: number;
  panel_count: number;
  updated_at: string;
}
export interface CanvasPreset {
  key: string;
  label: string;
  width_mm: number;
  height_mm: number;
}
export interface CanvasPreviewResult {
  svg_url: string;
  cached: boolean;
}
