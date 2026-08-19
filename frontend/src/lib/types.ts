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
  role_source?: string | null;
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
  mean?: number | null; sd?: number | null; median?: number | null; min?: number | null; max?: number | null; q1?: number | null; q3?: number | null;
}
export interface GroupStat { level: string; n: number; mean?: number | null; sd?: number | null; }
export interface NonparametricComparison {
  test: string;
  statistic?: number | null;
  p_value?: number | null;
  p_value_adjusted?: number | null;
  significant: boolean;
}
export interface Comparison {
  group_column: string; value_column: string; test: string;
  statistic?: number | null; p_value?: number | null; p_value_adjusted?: number | null;
  significant: boolean; significant_fdr?: boolean; groups: GroupStat[];
  nonparametric?: NonparametricComparison;
}
export interface DatasetStatistics {
  descriptive: DescriptiveStat[];
  comparisons: Comparison[];
  comparison_policy?: string;
  one_factor_comparisons_suppressed?: boolean;
  fdr_method?: string;
}

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
  scores?: {
    data_structure_fit: number;
    user_intent_match: number;
    statistical_suitability: number;
    overall: number;
  };
  rank?: number;
  fit?: string;
  rationale?: string;
  suggested_mapping?: Record<string, unknown>;
  suggested_options?: Record<string, unknown>;
  required_vars?: Record<string, unknown>;
  intent?: {
    show_individual_observations?: boolean;
    group_mapping_required?: boolean;
    group_mapping_status?: 'not_requested' | 'satisfied' | 'selection_required';
    group_mapping_candidates?: string[];
    individual_observation_support?: {
      status?: 'not_requested' | 'satisfied' | 'selection_required' | 'unsupported';
      mode?: 'not_requested' | 'individual_points_with_summary' | 'individual_points' | 'raw_trajectories' | 'summary_only';
      reason?: 'renderer_cannot_group_by_replicate' | 'replicate_id_required' | 'renderer_does_not_show_individual_observations';
    };
    line_policy?: {
      replicate_id_column?: string | null;
      raw_trajectory_grouping?: 'not_requested' | 'not_supported_by_renderer' | 'replicate_id_required';
      same_time_replicates?: 'do_not_connect_without_aggregation';
      summary_mode?: 'not_configured' | 'selection_required';
      error_summary?: 'sd' | 'se' | 'ci95' | 'none';
      support_status?: 'not_requested' | 'selection_required';
      blocking_reason?: 'renderer_cannot_group_by_replicate' | 'replicate_id_required';
      requires_confirmation?: boolean;
    };
  };
  mapping_complete?: boolean;
  missing_required_mappings?: Array<{ key: string; label: string }>;
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
  color_editable?: boolean;
}
export interface StyleDef { key: string; label: string; description?: string; }
export interface PaletteDef {
  key: string;
  label: string;
  colorblind_safe: boolean;
  hex: string[];
  is_default_for_new_figures?: boolean;
  usage_note?: string | null;
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
  r_available?: boolean;
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
  /** Physical size (mm) of the current version's render — canvas "native" placement size. */
  native_width_mm?: number | null;
  native_height_mm?: number | null;
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
    review_prompt_version?: string;
    review_schema_version?: string;
    accessibility_checks?: {
      schema_version?: string;
      palette?: {
        status?: 'evaluated' | 'not_evaluable' | string;
        source?: string | null;
        colors?: string[];
        series_count?: number | null;
        reason?: string | null;
      };
      cvd?: {
        status?: 'pass' | 'needs_review' | 'not_evaluable' | string;
        method?: string;
        threshold_delta_e?: number;
        simulations?: Array<{
          mode?: 'protanopia' | 'deuteranopia' | 'tritanopia' | string;
          status?: 'pass' | 'needs_review' | 'not_evaluable' | string;
          min_delta_e?: number | null;
          closest_pair?: [string, string] | null;
        }>;
        reason?: string | null;
      };
      grayscale?: {
        status?: 'pass' | 'needs_review' | 'not_evaluable' | string;
        method?: string;
        threshold_delta_l?: number;
        min_delta_l?: number | null;
        closest_pair?: [string, string] | null;
        reason?: string | null;
      };
      minimum_contrast?: {
        status?: 'pass' | 'needs_review' | 'not_evaluable' | string;
        method?: string;
        threshold_ratio?: number;
        ratio?: number | null;
        foreground?: string | null;
        background?: string;
        reason?: string | null;
      };
    };
    evidence?: {
      render?: { version_id?: string; version_number?: number; image_available?: boolean };
      plot_type?: string;
      style_preset?: string;
      mapping?: Record<string, unknown>;
      options?: Record<string, unknown>;
      last_ai_request?: string | null;
      dataset?: {
        name?: string | null;
        column_count?: number;
        columns?: Array<{ name?: string; role?: string; dtype?: string }>;
        columns_truncated?: boolean;
      };
    };
  };
  created_at: string;
}

// Parts of an improve request the AI reported it could NOT express as a
// supported param_patch (U10b). Same list repeated on every Improvement
// returned from the same /improve call.
export interface UnsupportedRequestItem {
  request: string;
  reason: string;
  mark_id?: string;
  resolved_target?: string;
}

export interface ImprovementEditScope {
  scope_id?: string;
  mark_id?: string | null;
  mark_label?: string | null;
  mark_type?: AiMarkType | null;
  request?: string;
  status?: 'supported' | 'unsupported' | 'blocked' | 'partial' | string;
  resolved_target?: string | AiResolvedMarkTarget | null;
  allowed_patch_keys?: string[];
  reason?: string;
  confidence?: number;
  requested_target_override?: AiResolvedMarkTarget | null;
  accepted_target_override?: AiResolvedMarkTarget | null;
  target_override_status?: 'accepted' | 'rejected' | string | null;
}

export interface Improvement {
  id: string;
  figure_version_id: string;
  suggestion_type?: string;
  current_state?: string;
  recommended?: string;
  param_patch: Record<string, unknown>;
  edit_scope?: ImprovementEditScope | null;
  priority?: string;
  applied: boolean;
  // Dotted paths this suggestion proposed that were dropped by sanitization.
  skipped?: string[];
  unsupported?: UnsupportedRequestItem[];
  // Optional legacy mark-traceability metadata. `edit_scope` is authoritative;
  // old explicit Mark A / Mark #1 fields or prose can still be recognized, but
  // unlinked response rows are never assigned by response order.
  mark_id?: string;
  mark_label?: string;
  mark_type?: 'region' | 'arrow' | 'note';
  support_status?: 'supported' | 'unsupported' | 'blocked';
  unsupported_reason?: string;
  confidence?: number;
  // Explicit safety signals for forward-compatible AI providers. A false
  // value means the patch must never become selectable in the client.
  requested?: boolean;
  unrequested_changes?: string[];
  created_at: string;
}

// (U10b) {key, from, to} for a patch key that visibly changed the render.
export interface AppliedChangeItem {
  key: string;
  from: unknown;
  to: unknown;
  /** True when `from` is the renderer-effective default of a previously
   * unset option rather than a stored value. */
  from_is_default?: boolean;
}

// (U10c) Self-verify loop outcome, present only when the apply call opted in
// with verify=true and a non-empty original_request.
export interface VerificationResult {
  attempts: number;
  satisfied: boolean;
  feedback: string;
  // Machine-readable reason verification could not run (AI_QUOTA_EXCEEDED,
  // AI_API_ERROR, NO_IMAGE, ...). Null/absent when it ran normally.
  skipped?: string | null;
  allowed_patch_keys?: string[];
  unrequested_changes?: AppliedChangeItem[];
}

// Response shape for both apply endpoints (U10b/U10c). Wraps FigureVersion
// instead of extending it so existing FigureVersion consumers (rerender,
// svg-edit, ...) are unaffected.
export interface ImprovementApplyResult {
  version: FigureVersion;
  applied_changes: AppliedChangeItem[];
  dropped_keys: string[];
  verification?: VerificationResult | null;
}

export interface FigureTextGrounding {
  schema_version?: string;
  total_rows?: number;
  row_count_semantics?: string;
  mapped_columns?: Record<string, unknown>;
  series?: Record<string, unknown> | null;
  representation?: Record<string, unknown>;
  descriptive_trends?: Array<Record<string, unknown>>;
}

export interface LegendResponse {
  legend: string;
  grounding?: FigureTextGrounding;
  prompt_version?: string | null;
}

export interface MethodsTextResponse {
  methods_text: string;
  grounding?: FigureTextGrounding;
  runtime_versions?: Record<string, string>;
  generator_version?: string | null;
}

export interface AltTextResponse {
  alt_text: string;
  grounding?: FigureTextGrounding;
  prompt_version?: string | null;
}

export interface FigureCodeResponse {
  language: 'python' | 'latex';
  filename: string;
  code: string;
}

export interface FigurePixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface FigureSceneElement {
  id: string;
  kind?: string;
  role: string;
  geom?: string;
  bbox_px: FigurePixelBox;
  category?: string | null;
  series?: string | null;
  panel_id?: number | null;
  layer_index?: number | null;
  fill?: string | null;
  editable?: boolean;
  setting_path?: string | null;
  unsupported_reason?: string | null;
  /** Degenerate "add here" band for an element that is not actually rendered
   * (e.g. an unset axis label); excluded from automatic hit-testing. */
  placeholder?: boolean;
}

export interface FigureLayout {
  panel_px: { x0: number; y0: number; x1: number; y1: number };
  img_px: { w: number; h: number };
  x_range: [number, number];
  y_range: [number, number];
  x_discrete: boolean;
  y_discrete: boolean;
  // Renderer-sidecar hit regions. Optional for old renders and plot types
  // without standard ggplot text/axis geometry.
  title_px?: FigurePixelBox;
  subtitle_px?: FigurePixelBox;
  xlab_px?: FigurePixelBox;
  ylab_px?: FigurePixelBox;
  x_axis_px?: FigurePixelBox;
  y_axis_px?: FigurePixelBox;
  scene_elements?: FigureSceneElement[];
}

export type AiMarkType = 'region' | 'arrow' | 'note';

export interface AiResolvedMarkTarget {
  type: 'title' | 'subtitle' | 'x_label' | 'y_label' | 'x_axis' | 'y_axis' | 'bar' | 'point' | 'cell'
    | 'x_tick_labels' | 'y_tick_labels' | 'colorbar' | 'legend' | 'scene_element';
  label: string;
  setting_path?: string | null;
  element_id?: string;
  role?: string;
  category?: string | null;
  series?: string | null;
  editable?: boolean;
  unsupported_reason?: string | null;
  placeholder?: boolean;
}

export interface AiEditMark {
  id: string;
  label: string;
  display_number: number;
  type: AiMarkType;
  memo: string;
  bbox_normalized?: { x: number; y: number; width: number; height: number };
  point_normalized?: { x: number; y: number };
  resolved_target?: AiResolvedMarkTarget;
  // Explicit user correction. The server validates this against the
  // persisted renderer scene graph; `resolved_target` remains audit evidence
  // for the client's automatic hit-test.
  target_override?: AiResolvedMarkTarget;
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
  /** null for imported-image panels (image_key set instead). */
  figure_id: string | null;
  /** Imported external image (SVG/PNG/JPEG): relative storage key
   *  "canvases/imports/<hex32>.<ext>"; render_url serves the blob. */
  image_key?: string | null;
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
  /** Native render size (mm) of the effective version — for original-size reset. */
  native_width_mm?: number | null;
  native_height_mm?: number | null;
  created_at: string;
  updated_at: string;
}
// U8: text/shape annotation objects layered above panels. Mirrors the backend
// contract exactly (canvases/service.py sanitizer) — mm coords, absolute-pt
// fonts (font_pt * 25.4/72 = mm, same invariance rule as panel figures).
export type AnnotationType = 'text' | 'arrow' | 'line' | 'rect' | 'ellipse';
export interface CanvasAnnotation {
  id: string;
  type: AnnotationType;
  /** Top-left anchor (text/rect/ellipse). Ignored by arrow/line (see points_mm). */
  x_mm: number;
  y_mm: number;
  /** rect/ellipse REQUIRED; text OPTIONAL (absent = auto width from content). */
  w_mm?: number;
  h_mm?: number;
  /** arrow/line REQUIRED: absolute canvas mm [x1,y1,x2,y2]; arrow head at (x2,y2). */
  points_mm?: [number, number, number, number];
  /** text REQUIRED: single-line, <=500 chars. */
  text?: string;
  /** text only; default 10; clamp 4..72. */
  font_pt?: number;
  /** text only; default 'left'. */
  align?: 'left' | 'center' | 'right';
  /** '#rrggbb'; default '#000000' (outline for shapes, glyph color for text). */
  stroke_hex?: string;
  /** default 1; clamp 0.25..10; ignored for text. */
  stroke_pt?: number;
  /** rect/ellipse interior fill; null/absent = none. */
  fill_hex?: string | null;
  /** integer ordering AMONG annotations; annotations always paint above panels. */
  z: number;
}
export interface Canvas {
  id: string;
  owner_id: string;
  name: string;
  description?: string | null;
  project_id?: string | null;
  width_mm: number;
  height_mm: number;
  preset?: string | null;
  background: string;
  export_snapshot?: Record<string, string> | null;
  annotations: CanvasAnnotation[];
  // Server-incremented on every annotations replace; echo it back as
  // base_annotations_rev so concurrent editors 409 instead of clobbering.
  annotations_rev: number;
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
  layout?: FigureLayout & { series_hex?: Record<string,string>; legend_keys?: { series: string; px: { x0:number;y0:number;x1:number;y1:number } }[]; panels?: unknown[]; layer_geom?: unknown[] } | null;
}

export interface CanvasExportResult {
  url: string;
  format: 'svg' | 'pdf' | 'png' | 'tiff';
  snapshot: Record<string, string>;
}
export interface CanvasApplyStyleResult {
  updated: string[];
  skipped: string[];
}
