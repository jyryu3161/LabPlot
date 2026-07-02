'use client';

import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  adminListUsers, adminCreateUser, adminUpdateUser, adminResetPassword, adminDeleteUser,
  adminListAuditLogs, adminListClientErrors, getAiConfig, updateAiConfig,
  getEmailDeliveryStatus, sendEmailTest,
} from '@/lib/api';
import { useAuthContext } from '@/components/auth/AuthProvider';
import { AppHeader } from '@/components/layout/AppHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Activity, EyeOff, Images, Loader2, Shield, UserPlus, KeyRound, Trash2, Cpu, Mail } from 'lucide-react';

type LimitKey = 'ai_monthly_limit' | 'render_monthly_limit' | 'storage_limit_mb';
type LimitDialogState = { id: string; key: LimitKey; email: string };
type ResetDialogState = { id: string; email: string };
type UnpublishDialogState = { id: string; name: string; ownerEmail: string };

// ── Gallery moderation API (local helpers: lib/api.ts does not export its
//    fetcher, and that module is owned by another workstream) ──
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

type AdminGalleryFigure = {
  id: string;
  name: string;
  plot_type: string;
  status?: string | null;
  created_at: string;
  updated_at: string;
  owner_email: string;
  owner_name?: string | null;
  thumb_url?: string | null;
};

async function adminGalleryFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = typeof window === 'undefined' ? null : localStorage.getItem('access_token');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string>),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let message = body || `Request failed: ${res.statusText}`;
    try {
      const json = JSON.parse(body);
      if (typeof json.detail === 'string') message = json.detail;
      else if (json.detail?.message) message = json.detail.message;
    } catch { /* not json */ }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

const adminListGalleryFigures = () => adminGalleryFetch<AdminGalleryFigure[]>('/api/admin/gallery');
const adminUnpublishGalleryFigure = (id: string) =>
  adminGalleryFetch<{ ok: boolean }>(`/api/admin/gallery/${id}/unpublish`, { method: 'POST' });

// Same-origin by default; when the API lives on another origin, static asset
// paths need the API base prefixed (mirrors lib/api.ts normalizeAssetUrl).
const galleryThumbSrc = (url: string | null | undefined) =>
  url && API_BASE && url.startsWith('/') ? `${API_BASE}${url}` : url ?? null;

const numberFmt = new Intl.NumberFormat('en-US');
const usdFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const passwordOk = (pw: string) => pw.length >= 10 && /[A-Za-z]/.test(pw) && /\d/.test(pw);
const GEMINI_MODEL_OPTIONS = [
  { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite' },
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
];

export default function AdminPage() {
  const qc = useQueryClient();
  const { user } = useAuthContext();
  const { data: users, isLoading, error } = useQuery({ queryKey: ['admin-users'], queryFn: adminListUsers });
  const { data: auditLogs } = useQuery({ queryKey: ['admin-audit-logs'], queryFn: () => adminListAuditLogs(100) });
  const { data: clientErrors } = useQuery({ queryKey: ['admin-client-errors'], queryFn: () => adminListClientErrors(50) });

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);

  // ── Limit + password-reset modals (replace window.prompt) ──
  const [limitDialog, setLimitDialog] = useState<LimitDialogState | null>(null);
  const [limitValue, setLimitValue] = useState('');
  const [resetDialog, setResetDialog] = useState<ResetDialogState | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('');

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-users'] });
    qc.invalidateQueries({ queryKey: ['admin-audit-logs'] });
  };

  // ── AI provider config ──
  const { data: aiCfg } = useQuery({ queryKey: ['ai-config'], queryFn: getAiConfig });
  const [provider, setProvider] = useState('');
  const [claudeModel, setClaudeModel] = useState('');
  const [geminiModel, setGeminiModel] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [geminiKey, setGeminiKey] = useState('');
  const activeProvider = provider || aiCfg?.provider || 'claude';
  const activeClaudeModel = claudeModel || aiCfg?.claude_model || '';
  const activeGeminiModel = geminiModel || aiCfg?.gemini_model || 'gemini-3.1-flash-lite';
  const saveAi = useMutation({
    mutationFn: () => updateAiConfig({
      provider: activeProvider, claude_model: activeClaudeModel, gemini_model: activeGeminiModel,
      ...(anthropicKey ? { anthropic_api_key: anthropicKey } : {}),
      ...(geminiKey ? { gemini_api_key: geminiKey } : {}),
    }),
    onSuccess: () => { toast.success('AI settings saved'); setAnthropicKey(''); setGeminiKey(''); qc.invalidateQueries({ queryKey: ['ai-config'] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Save failed'),
  });

  const { data: emailCfg } = useQuery({ queryKey: ['email-config'], queryFn: getEmailDeliveryStatus });
  const [testEmail, setTestEmail] = useState('');
  const sendTestEmail = useMutation({
    mutationFn: () => sendEmailTest(testEmail || user?.email || ''),
    onSuccess: (res) => {
      toast.success(res.message);
      qc.invalidateQueries({ queryKey: ['admin-audit-logs'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Email test failed'),
  });

  const create = useMutation({
    mutationFn: () => {
      if (!passwordOk(password)) throw new Error('Password must be at least 10 characters and include a letter and a number');
      return adminCreateUser({ email, password, display_name: name, is_admin: isAdmin });
    },
    onSuccess: () => { toast.success('User created'); setEmail(''); setName(''); setPassword(''); setIsAdmin(false); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Create failed'),
  });
  const update = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, boolean | number> }) => adminUpdateUser(id, data),
    onSuccess: () => { toast.success('Updated'); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Update failed'),
  });
  const resetPw = useMutation({
    mutationFn: ({ id, pw }: { id: string; pw: string }) => adminResetPassword(id, pw),
    onSuccess: () => { toast.success('Password reset'); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Reset failed'),
  });
  const del = useMutation({
    mutationFn: adminDeleteUser,
    onSuccess: () => { toast.success('User deleted'); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Delete failed'),
  });

  // ── Gallery moderation ──
  const { data: galleryFigures, isLoading: galleryLoading } = useQuery({
    queryKey: ['admin-gallery'],
    queryFn: adminListGalleryFigures,
  });
  const [unpublishDialog, setUnpublishDialog] = useState<UnpublishDialogState | null>(null);
  const unpublish = useMutation({
    mutationFn: (id: string) => adminUnpublishGalleryFigure(id),
    onSuccess: () => {
      toast.success('Figure removed from the public gallery');
      qc.invalidateQueries({ queryKey: ['admin-gallery'] });
      qc.invalidateQueries({ queryKey: ['admin-audit-logs'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Unpublish failed'),
  });

  function submitUnpublish() {
    if (!unpublishDialog) return;
    unpublish.mutate(unpublishDialog.id);
    setUnpublishDialog(null);
  }

  function openLimitDialog(id: string, key: LimitKey, email: string, current: number) {
    setLimitDialog({ id, key, email });
    setLimitValue(String(current));
  }

  function submitLimit() {
    if (!limitDialog) return;
    const value = Number(limitValue);
    if (!Number.isInteger(value) || value < 0) {
      toast.error('Limit must be a non-negative integer');
      return;
    }
    update.mutate({ id: limitDialog.id, data: { [limitDialog.key]: value } });
    setLimitDialog(null);
  }

  function openResetDialog(id: string, email: string) {
    setResetDialog({ id, email });
    setNewPassword('');
    setNewPasswordConfirm('');
  }

  function submitReset() {
    if (!resetDialog) return;
    if (!passwordOk(newPassword)) {
      toast.error('Password must be at least 10 characters and include a letter and a number');
      return;
    }
    if (newPassword !== newPasswordConfirm) {
      toast.error('Passwords do not match');
      return;
    }
    resetPw.mutate({ id: resetDialog.id, pw: newPassword });
    setResetDialog(null);
  }

  const limitLabel = limitDialog ? limitDialog.key.replaceAll('_', ' ') : '';

  return (
    <div className="min-h-screen bg-muted/20">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-4 py-8">
        <h1 className="mb-6 flex items-center gap-2 text-2xl font-bold"><Shield className="h-6 w-6 text-primary" /> Admin</h1>

        <Card className="mb-6">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Cpu className="h-4 w-4" /> AI Provider</CardTitle></CardHeader>
          <CardContent>
            <div className="grid items-end gap-3 md:grid-cols-4">
              <div className="space-y-1">
                <Label htmlFor="ai-provider">Provider</Label>
                <select id="ai-provider" className="w-full rounded-md border px-3 py-2 text-sm" value={activeProvider} onChange={(e) => setProvider(e.target.value)}>
                  <option value="claude">Claude (Anthropic)</option>
                  <option value="gemini">Gemini (Google)</option>
                </select>
              </div>
              {activeProvider === 'claude' ? (
                <>
                  <div className="space-y-1"><Label htmlFor="ai-claude-model">Claude model</Label><Input id="ai-claude-model" value={activeClaudeModel} onChange={(e) => setClaudeModel(e.target.value)} placeholder="claude-sonnet-4-6" /></div>
                  <div className="space-y-1"><Label htmlFor="ai-anthropic-key">Anthropic API key {aiCfg?.has_anthropic_key && <span className="text-xs text-green-600">(set)</span>}</Label><Input id="ai-anthropic-key" type="password" value={anthropicKey} onChange={(e) => setAnthropicKey(e.target.value)} placeholder={aiCfg?.has_anthropic_key ? '•••••• (leave blank to keep)' : 'sk-ant-...'} /></div>
                </>
              ) : (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="ai-gemini-model">Gemini model</Label>
                    <select id="ai-gemini-model" className="w-full rounded-md border px-3 py-2 text-sm" value={activeGeminiModel} onChange={(e) => setGeminiModel(e.target.value)}>
                      {GEMINI_MODEL_OPTIONS.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1"><Label htmlFor="ai-gemini-key">Gemini API key {aiCfg?.has_gemini_key && <span className="text-xs text-green-600">(set)</span>}</Label><Input id="ai-gemini-key" type="password" value={geminiKey} onChange={(e) => setGeminiKey(e.target.value)} placeholder={aiCfg?.has_gemini_key ? '•••••• (leave blank to keep)' : 'AIza...'} /></div>
                </>
              )}
              <Button onClick={() => saveAi.mutate()} disabled={saveAi.isPending}>
                {saveAi.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save AI settings'}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Active: <span className="font-medium">{aiCfg?.provider}</span> · {aiCfg?.provider === 'gemini' ? aiCfg?.gemini_model : aiCfg?.claude_model}. Used for chart recommendation, Figure Review (vision) and Improve.</p>
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Mail className="h-4 w-4" /> Email Delivery
              <Badge variant={emailCfg?.configured ? 'outline' : 'destructive'}>{emailCfg?.configured ? 'configured' : 'not configured'}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 text-sm md:grid-cols-4">
              <div><span className="text-muted-foreground">SMTP host</span><div className="font-medium">{emailCfg?.host || '-'}</div></div>
              <div><span className="text-muted-foreground">Port</span><div className="font-medium">{emailCfg?.port ?? '-'}</div></div>
              <div><span className="text-muted-foreground">From</span><div className="font-medium">{emailCfg?.from_address || '-'}</div></div>
              <div><span className="text-muted-foreground">Security</span><div className="font-medium">{emailCfg?.use_ssl ? 'SSL' : emailCfg?.use_tls ? 'STARTTLS' : 'None'} · {emailCfg?.username_set ? 'auth' : 'no auth'}</div></div>
            </div>
            <div className="mt-4 grid items-end gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
              <div className="space-y-1">
                <Label htmlFor="test-recipient">Test recipient</Label>
                <Input id="test-recipient" type="email" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} placeholder={user?.email || 'admin@example.com'} />
              </div>
              <Button onClick={() => sendTestEmail.mutate()} disabled={sendTestEmail.isPending || !(testEmail || user?.email)}>
                {sendTestEmail.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Send test email'}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Password reset email uses this SMTP configuration and reset links point to {emailCfg?.app_base_url || 'APP_BASE_URL'}.</p>
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><UserPlus className="h-4 w-4" /> Create user</CardTitle></CardHeader>
          <CardContent>
            <div className="grid items-end gap-3 md:grid-cols-5">
              <div className="space-y-1"><Label htmlFor="new-user-email">Email</Label><Input id="new-user-email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@lab.edu" /></div>
              <div className="space-y-1"><Label htmlFor="new-user-name">Name</Label><Input id="new-user-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" /></div>
              <div className="space-y-1"><Label htmlFor="new-user-password">Password</Label><Input id="new-user-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="10+ chars, letter + number" /></div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} /> Admin</label>
              <Button onClick={() => create.mutate()} disabled={create.isPending || !email || !name || !password}>
                {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create'}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Users</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            {isLoading ? <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
              : error ? <p className="py-4 text-sm text-red-600">Admin access required.</p>
              : (
                <table className="w-full min-w-[1360px] text-sm">
                  <thead><tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="px-2 py-2">Email</th><th scope="col" className="px-2 py-2">Name</th><th scope="col" className="px-2 py-2">Organizations</th><th scope="col" className="px-2 py-2">Role</th>
                    <th scope="col" className="whitespace-nowrap px-2 py-2">Approval</th><th scope="col" className="px-2 py-2">Active</th><th scope="col" className="px-2 py-2">Data</th><th scope="col" className="px-2 py-2">Figs</th>
                    <th scope="col" className="w-36 min-w-36 whitespace-nowrap px-2 py-2">AI Calls</th><th scope="col" className="w-32 min-w-32 whitespace-nowrap px-2 py-2">Renders</th><th scope="col" className="w-36 min-w-36 whitespace-nowrap px-2 py-2">Storage</th>
                    <th scope="col" className="w-36 min-w-36 whitespace-nowrap px-2 py-2">Tokens (mo)</th><th scope="col" className="w-40 min-w-40 whitespace-nowrap px-2 py-2">Est. Cost (mo)</th><th scope="col" className="px-2 py-2">Actions</th>
                  </tr></thead>
                  <tbody>
                    {users?.map((u) => (
                      <tr key={u.id} className="border-b last:border-0">
                        <td className="px-2 py-2 font-medium">{u.email}</td>
                        <td className="px-2 py-2">{u.display_name}</td>
                        <td className="min-w-48 px-2 py-2">
                          {u.organizations?.length ? (
                            <div className="flex max-w-64 flex-wrap gap-1">
                              {u.organizations.map((org) => (
                                <Badge key={`${u.id}-${org.organization_id}`} variant={org.status === 'active' ? 'outline' : 'secondary'} title={`${org.organization_name} · ${org.role} · ${org.status}`}>
                                  {org.organization_name}{org.active ? ' *' : ''} · {org.role}{org.status !== 'active' ? `/${org.status}` : ''}
                                </Badge>
                              ))}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">-</span>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <Badge variant={u.is_admin ? 'default' : 'secondary'} className="cursor-pointer"
                            onClick={() => u.id !== user?.id && update.mutate({ id: u.id, data: { is_admin: !u.is_admin } })}>
                            {u.is_admin ? 'admin' : 'user'}
                          </Badge>
                        </td>
                        <td className="px-2 py-2">
                          <Badge variant={u.is_approved ? 'outline' : 'destructive'} className="cursor-pointer"
                            onClick={() => u.id !== user?.id && update.mutate({ id: u.id, data: { is_approved: !u.is_approved } })}>
                            {u.is_approved ? 'approved' : 'pending'}
                          </Badge>
                        </td>
                        <td className="px-2 py-2">
                          <Badge variant={u.is_active ? 'outline' : 'destructive'} className="cursor-pointer"
                            onClick={() => u.id !== user?.id && update.mutate({ id: u.id, data: { is_active: !u.is_active } })}>
                            {u.is_active ? 'active' : 'inactive'}
                          </Badge>
                        </td>
                        <td className="px-2 py-2 text-muted-foreground">{u.dataset_count}</td>
                        <td className="px-2 py-2 text-muted-foreground">{u.figure_count}</td>
                        <td className="w-36 min-w-36 whitespace-nowrap px-2 py-2 text-muted-foreground">
                          <button className="text-left hover:underline" onClick={() => openLimitDialog(u.id, 'ai_monthly_limit', u.email, u.ai_monthly_limit)}>
                            {numberFmt.format(u.ai_monthly_used)} / {u.ai_monthly_limit || 'unlimited'}
                          </button>
                        </td>
                        <td className="w-32 min-w-32 whitespace-nowrap px-2 py-2 text-muted-foreground">
                          <button className="text-left hover:underline" onClick={() => openLimitDialog(u.id, 'render_monthly_limit', u.email, u.render_monthly_limit)}>
                            {numberFmt.format(u.render_monthly_used)} / {u.render_monthly_limit || 'unlimited'}
                          </button>
                        </td>
                        <td className="w-36 min-w-36 whitespace-nowrap px-2 py-2 text-muted-foreground">
                          <button className="text-left hover:underline" onClick={() => openLimitDialog(u.id, 'storage_limit_mb', u.email, u.storage_limit_mb)}>
                            {u.storage_used_mb} / {u.storage_limit_mb || 'unlimited'} MB
                          </button>
                        </td>
                        <td
                          className="w-36 min-w-36 whitespace-nowrap px-2 py-2 text-muted-foreground"
                          title={`This month: ${numberFmt.format(u.ai_monthly_input_tokens)} input / ${numberFmt.format(u.ai_monthly_output_tokens)} billable output. All-time: ${numberFmt.format(u.ai_total_tokens)} total.`}
                        >
                          {numberFmt.format(u.ai_monthly_total_tokens)}
                        </td>
                        <td
                          className="w-40 min-w-40 whitespace-nowrap px-2 py-2 text-muted-foreground"
                          title={`All-time estimated cost: ${usdFmt.format(u.ai_estimated_cost_usd)}`}
                        >
                          {usdFmt.format(u.ai_monthly_estimated_cost_usd)}
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex gap-1">
                            <Button variant="ghost" size="sm" title="Reset password" aria-label={`Reset password for ${u.email}`}
                              onClick={() => openResetDialog(u.id, u.email)}>
                              <KeyRound className="h-4 w-4" />
                            </Button>
                            {u.id !== user?.id && (
                              <Button variant="ghost" size="sm" title="Delete" aria-label={`Delete ${u.email}`}
                                onClick={() => { if (confirm(`Delete ${u.email}?`)) del.mutate(u.id); }}>
                                <Trash2 className="h-4 w-4 text-red-500" />
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
            )}
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Images className="h-4 w-4" /> Gallery</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            {galleryLoading ? <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin" /></div> : (
              <table className="w-full text-sm">
                <thead><tr className="border-b text-left text-muted-foreground">
                  <th scope="col" className="px-2 py-2">Preview</th><th scope="col" className="px-2 py-2">Name</th><th scope="col" className="px-2 py-2">Type</th>
                  <th scope="col" className="px-2 py-2">Owner</th><th scope="col" className="whitespace-nowrap px-2 py-2">Published</th><th scope="col" className="px-2 py-2">Actions</th>
                </tr></thead>
                <tbody>
                  {(galleryFigures ?? []).map((fig) => (
                    <tr key={fig.id} className="border-b last:border-0">
                      <td className="px-2 py-2">
                        {galleryThumbSrc(fig.thumb_url) ? (
                          <img src={galleryThumbSrc(fig.thumb_url)!} alt={fig.name} loading="lazy" className="h-10 w-14 rounded border bg-white object-contain" />
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="max-w-xs truncate px-2 py-2 font-medium" title={fig.name}>{fig.name}</td>
                      <td className="px-2 py-2 text-muted-foreground">{fig.plot_type}</td>
                      <td className="px-2 py-2 text-muted-foreground" title={fig.owner_name ?? undefined}>{fig.owner_email}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-muted-foreground">{new Date(fig.updated_at).toLocaleString()}</td>
                      <td className="px-2 py-2">
                        <Button variant="ghost" size="sm" title="Unpublish" aria-label={`Unpublish ${fig.name}`}
                          onClick={() => setUnpublishDialog({ id: fig.id, name: fig.name, ownerEmail: fig.owner_email })}>
                          <EyeOff className="h-4 w-4 text-red-500" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {!galleryLoading && (!galleryFigures || galleryFigures.length === 0) && (
                    <tr><td colSpan={6} className="px-2 py-6 text-center text-muted-foreground">No public figures.</td></tr>
                  )}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Activity className="h-4 w-4" /> Recent audit log</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b text-left text-muted-foreground">
                <th scope="col" className="px-2 py-2">Time</th><th scope="col" className="px-2 py-2">Action</th><th scope="col" className="px-2 py-2">Target</th><th scope="col" className="px-2 py-2">IP</th><th scope="col" className="px-2 py-2">Metadata</th>
              </tr></thead>
              <tbody>
                {(auditLogs ?? []).slice(0, 40).map((log) => (
                  <tr key={log.id} className="border-b last:border-0">
                    <td className="whitespace-nowrap px-2 py-2 text-muted-foreground">{new Date(log.created_at).toLocaleString()}</td>
                    <td className="px-2 py-2 font-medium">{log.action}</td>
                    <td className="px-2 py-2 text-muted-foreground">{log.target_type ?? '-'} {log.target_id ? String(log.target_id).slice(0, 8) : ''}</td>
                    <td className="px-2 py-2 text-muted-foreground">{log.ip_address ?? '-'}</td>
                    <td className="max-w-md truncate px-2 py-2 text-muted-foreground">{JSON.stringify(log.metadata_json)}</td>
                  </tr>
                ))}
                {(!auditLogs || auditLogs.length === 0) && (
                  <tr><td colSpan={5} className="px-2 py-6 text-center text-muted-foreground">No audit events yet.</td></tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Activity className="h-4 w-4" /> Client errors</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b text-left text-muted-foreground">
                <th scope="col" className="px-2 py-2">Time</th><th scope="col" className="px-2 py-2">Source</th><th scope="col" className="px-2 py-2">Path</th><th scope="col" className="px-2 py-2">Message</th>
              </tr></thead>
              <tbody>
                {(clientErrors ?? []).slice(0, 30).map((row) => (
                  <tr key={row.id} className="border-b last:border-0">
                    <td className="whitespace-nowrap px-2 py-2 text-muted-foreground">{new Date(row.created_at).toLocaleString()}</td>
                    <td className="px-2 py-2 text-muted-foreground">{row.source}</td>
                    <td className="max-w-xs truncate px-2 py-2 text-muted-foreground">{row.path ?? '-'}</td>
                    <td className="max-w-lg truncate px-2 py-2 font-medium" title={row.stack ?? row.message}>{row.message}</td>
                  </tr>
                ))}
                {(!clientErrors || clientErrors.length === 0) && (
                  <tr><td colSpan={4} className="px-2 py-6 text-center text-muted-foreground">No client errors.</td></tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Dialog open={Boolean(limitDialog)} onOpenChange={(open) => { if (!open) setLimitDialog(null); }}>
          <DialogContent>
            <form onSubmit={(e) => { e.preventDefault(); submitLimit(); }} className="grid gap-4">
              <DialogHeader>
                <DialogTitle className="capitalize">Set {limitLabel}</DialogTitle>
                <DialogDescription>{limitDialog?.email}. Use 0 for unlimited.</DialogDescription>
              </DialogHeader>
              <div className="space-y-1">
                <Label htmlFor="limit-value" className="capitalize">{limitLabel}</Label>
                <Input id="limit-value" type="number" min={0} step={1} value={limitValue} onChange={(e) => setLimitValue(e.target.value)} />
              </div>
              <DialogFooter>
                <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
                <Button type="submit" disabled={update.isPending}>
                  {update.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <Dialog open={Boolean(unpublishDialog)} onOpenChange={(open) => { if (!open) setUnpublishDialog(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Unpublish figure</DialogTitle>
              <DialogDescription>
                Remove &ldquo;{unpublishDialog?.name}&rdquo; by {unpublishDialog?.ownerEmail} from the public gallery?
                The owner keeps the figure; it just stops being publicly visible.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
              <Button variant="destructive" disabled={unpublish.isPending} onClick={submitUnpublish}>
                {unpublish.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Unpublish'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={Boolean(resetDialog)} onOpenChange={(open) => { if (!open) setResetDialog(null); }}>
          <DialogContent>
            <form onSubmit={(e) => { e.preventDefault(); submitReset(); }} className="grid gap-4">
              <DialogHeader>
                <DialogTitle>Reset password</DialogTitle>
                <DialogDescription>Set a new password for {resetDialog?.email}.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="reset-password">New password</Label>
                  <Input id="reset-password" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="10+ chars, letter + number" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="reset-password-confirm">Confirm password</Label>
                  <Input id="reset-password-confirm" type="password" autoComplete="new-password" value={newPasswordConfirm} onChange={(e) => setNewPasswordConfirm(e.target.value)} />
                </div>
              </div>
              <DialogFooter>
                <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
                <Button type="submit" disabled={resetPw.isPending}>
                  {resetPw.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Reset password'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </main>
    </div>
  );
}
