import type {
  User, TokenResponse, LoginRequest, RegisterRequest,
  DatasetListItem, DatasetDetail, ChartSuggestion, PlotTypeDef, StyleDef,
  FigureListItem, FigureDetail, FigureVersion, Review, Improvement, AdminUser, AIConfig, GalleryFigureItem,
  Project, ProjectListItem,
} from './types';

// Same-origin by default (Caddy proxies /api and /static on :7070).
const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('access_token');
}
function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('refresh_token');
}
export function setTokens(access: string, refresh: string): void {
  localStorage.setItem('access_token', access);
  localStorage.setItem('refresh_token', refresh);
}
export function clearTokens(): void {
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
}

function parseErrorMessage(body: string, statusText: string): string {
  try {
    const json = JSON.parse(body);
    if (json.detail) {
      if (typeof json.detail === 'object' && !Array.isArray(json.detail) && json.detail.message) return json.detail.message;
      if (Array.isArray(json.detail)) return json.detail.map((e: { msg?: string }) => e.msg || 'Validation error').join('. ');
      if (typeof json.detail === 'string') return json.detail;
    }
  } catch { /* not json */ }
  return body || `Request failed: ${statusText}`;
}

async function fetcher<T>(path: string, options?: RequestInit, retried = false): Promise<T> {
  const token = getAccessToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string>),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  if (res.status === 401 && !retried) {
    try {
      await refreshToken();
      return fetcher<T>(path, options, true);
    } catch {
      clearTokens();
      if (typeof window !== 'undefined') window.location.href = '/login';
      throw new ApiError('Session expired', 401);
    }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(parseErrorMessage(body, res.statusText), res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ── auth ──
export async function register(data: RegisterRequest): Promise<User> {
  return fetcher<User>('/api/auth/register', { method: 'POST', body: JSON.stringify(data) });
}
export async function login(data: LoginRequest): Promise<TokenResponse> {
  const r = await fetcher<TokenResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify(data) });
  setTokens(r.access_token, r.refresh_token);
  return r;
}
export async function refreshToken(): Promise<TokenResponse> {
  const refresh = getRefreshToken();
  if (!refresh) throw new ApiError('No refresh token', 401);
  const r = await fetcher<TokenResponse>('/api/auth/refresh', { method: 'POST', body: JSON.stringify({ refresh_token: refresh }) }, true);
  setTokens(r.access_token, r.refresh_token);
  return r;
}
export async function getMe(): Promise<User> { return fetcher<User>('/api/auth/me'); }
export function logout(): void { clearTokens(); }

// ── projects ──
export async function listProjects(): Promise<ProjectListItem[]> { return fetcher('/api/projects'); }
export async function getProject(id: string): Promise<Project> { return fetcher(`/api/projects/${id}`); }
export async function createProject(data: { name: string; description?: string }): Promise<Project> {
  return fetcher('/api/projects', { method: 'POST', body: JSON.stringify(data) });
}
export async function updateProject(id: string, data: { name?: string; description?: string }): Promise<Project> {
  return fetcher(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}
export async function deleteProject(id: string): Promise<void> { return fetcher(`/api/projects/${id}`, { method: 'DELETE' }); }
export async function downloadProjectPack(projectId: string, name: string): Promise<void> {
  const headers: Record<string, string> = {};
  const token = getAccessToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}/api/projects/${projectId}/export`, { headers });
  if (!res.ok) throw new ApiError('Export failed', res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${name}.zip`; document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(url);
}

// ── datasets ──
export async function listDatasets(projectId?: string): Promise<DatasetListItem[]> {
  return fetcher(`/api/datasets${projectId ? `?project_id=${projectId}` : ''}`);
}
export async function getDataset(id: string): Promise<DatasetDetail> { return fetcher(`/api/datasets/${id}`); }
export async function deleteDataset(id: string): Promise<void> { return fetcher(`/api/datasets/${id}`, { method: 'DELETE' }); }
export async function updateDataset(id: string, data: { name?: string; description?: string }): Promise<DatasetDetail> {
  return fetcher(`/api/datasets/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}
export async function getPublicGallery(limit = 12): Promise<{ figures: import('./types').PublicFigure[] }> {
  return fetcher(`/api/public/gallery?limit=${limit}`);
}
export async function enhancePrompt(draft: string, kind: string, context?: string): Promise<{ enhanced: string }> {
  return fetcher('/api/ai/enhance-prompt', { method: 'POST', body: JSON.stringify({ draft, kind, context }) });
}
export async function uploadDataset(file: File, projectId?: string, description?: string, name?: string): Promise<DatasetDetail> {
  const fd = new FormData();
  fd.append('file', file);
  if (projectId) fd.append('project_id', projectId);
  if (description) fd.append('description', description);
  if (name) fd.append('name', name);
  const headers: Record<string, string> = {};
  const token = getAccessToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}/api/datasets`, { method: 'POST', body: fd, headers });
  if (!res.ok) { const b = await res.text().catch(() => ''); throw new ApiError(parseErrorMessage(b, res.statusText), res.status); }
  return res.json();
}
export async function getChartSuggestions(datasetId: string): Promise<{ suggestions: ChartSuggestion[] }> {
  return fetcher(`/api/datasets/${datasetId}/chart-suggestions`);
}
export async function recommendCharts(datasetId: string): Promise<ChartSuggestion[]> {
  return fetcher(`/api/datasets/${datasetId}/recommend`, { method: 'POST' });
}
export async function recommendChartsFromImage(datasetId: string, file: File): Promise<ChartSuggestion[]> {
  const fd = new FormData();
  fd.append('file', file);
  const headers: Record<string, string> = {};
  const token = getAccessToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}/api/datasets/${datasetId}/recommend-from-image`, { method: 'POST', body: fd, headers });
  if (!res.ok) { const b = await res.text().catch(() => ''); throw new ApiError(parseErrorMessage(b, res.statusText), res.status); }
  return res.json();
}

// ── meta ──
export async function getPlotTypes(): Promise<{ plot_types: PlotTypeDef[] }> { return fetcher('/api/plot-types'); }
export async function getStyles(): Promise<{ styles: StyleDef[] }> { return fetcher('/api/styles'); }
export async function getPalettes(): Promise<{ palettes: import('./types').PaletteDef[] }> { return fetcher('/api/palettes'); }

// ── figures ──
export interface FigureCreatePayload {
  dataset_id: string; name: string; plot_type: string;
  mapping: Record<string, unknown>; options: Record<string, unknown>; style_preset: string;
}
export async function createFigure(p: FigureCreatePayload): Promise<FigureDetail> {
  return fetcher('/api/figures', { method: 'POST', body: JSON.stringify(p) });
}
export async function listFigures(projectId?: string): Promise<FigureListItem[]> {
  return fetcher(`/api/figures${projectId ? `?project_id=${projectId}` : ''}`);
}
export async function listGalleryFigures(limit = 200): Promise<GalleryFigureItem[]> {
  return fetcher(`/api/figures/gallery?limit=${limit}`);
}
export async function getFigure(id: string): Promise<FigureDetail> { return fetcher(`/api/figures/${id}`); }
export async function deleteFigure(id: string): Promise<void> { return fetcher(`/api/figures/${id}`, { method: 'DELETE' }); }
export async function updateFigure(id: string, data: { name?: string; description?: string; legend?: string }): Promise<FigureDetail> {
  return fetcher(`/api/figures/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}
export async function generateLegend(figureId: string, versionId: string): Promise<{ legend: string }> {
  return fetcher(`/api/figures/${figureId}/versions/${versionId}/legend`, { method: 'POST' });
}
export async function rerenderFigure(id: string, body: { plot_type?: string; mapping?: Record<string, unknown>; options?: Record<string, unknown>; style_preset?: string; change_note?: string }): Promise<FigureVersion> {
  return fetcher(`/api/figures/${id}/rerender`, { method: 'POST', body: JSON.stringify(body) });
}
export async function saveSvgEditVersion(figureId: string, versionId: string, body: { svg: string; change_note?: string }): Promise<FigureVersion> {
  return fetcher(`/api/figures/${figureId}/versions/${versionId}/svg-edit`, { method: 'POST', body: JSON.stringify(body) });
}
export async function reviewVersion(figureId: string, versionId: string): Promise<Review> {
  return fetcher(`/api/figures/${figureId}/versions/${versionId}/review`, { method: 'POST' });
}
export async function improveVersion(figureId: string, versionId: string): Promise<Improvement[]> {
  return fetcher(`/api/figures/${figureId}/versions/${versionId}/improve`, { method: 'POST' });
}
export async function listImprovements(figureId: string, versionId: string): Promise<Improvement[]> {
  return fetcher(`/api/figures/${figureId}/versions/${versionId}/improvements`);
}
export async function applyImprovement(figureId: string, improvementId: string): Promise<FigureVersion> {
  return fetcher(`/api/figures/${figureId}/improvements/${improvementId}/apply`, { method: 'POST' });
}
export function exportUrl(figureId: string, versionId: string, fmt: string): string {
  return `${BASE_URL}/api/figures/${figureId}/versions/${versionId}/export?format=${fmt}`;
}
export async function downloadExport(figureId: string, versionId: string, fmt: string, filename: string): Promise<void> {
  const headers: Record<string, string> = {};
  const token = getAccessToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(exportUrl(figureId, versionId, fmt), { headers });
  if (!res.ok) throw new ApiError('Export failed', res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(url);
}
export async function downloadGalleryExport(figureId: string, versionId: string, fmt: string, filename: string): Promise<void> {
  const headers: Record<string, string> = {};
  const token = getAccessToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}/api/figures/gallery/${figureId}/versions/${versionId}/export?format=${fmt}`, { headers });
  if (!res.ok) throw new ApiError('Gallery export failed', res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(url);
}

// ── admin ──
export async function adminListUsers(): Promise<AdminUser[]> { return fetcher('/api/admin/users'); }
export async function adminCreateUser(data: { email: string; password: string; display_name: string; is_admin: boolean }): Promise<User> {
  return fetcher('/api/admin/users', { method: 'POST', body: JSON.stringify(data) });
}
export async function adminUpdateUser(id: string, data: { display_name?: string; is_active?: boolean; is_approved?: boolean; is_admin?: boolean }): Promise<User> {
  return fetcher(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}
export async function adminResetPassword(id: string, password: string): Promise<User> {
  return fetcher(`/api/admin/users/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ password }) });
}
export async function adminDeleteUser(id: string): Promise<void> { return fetcher(`/api/admin/users/${id}`, { method: 'DELETE' }); }

// ── admin: AI config ──
export async function getAiConfig(): Promise<AIConfig> { return fetcher('/api/admin/ai-config'); }
export async function updateAiConfig(data: Partial<AIConfig> & { anthropic_api_key?: string; gemini_api_key?: string }): Promise<AIConfig> {
  return fetcher('/api/admin/ai-config', { method: 'PUT', body: JSON.stringify(data) });
}
