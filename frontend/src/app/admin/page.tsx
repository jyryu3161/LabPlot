'use client';

import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  adminListUsers, adminCreateUser, adminUpdateUser, adminResetPassword, adminDeleteUser,
  getAiConfig, updateAiConfig,
} from '@/lib/api';
import { useAuthContext } from '@/components/auth/AuthProvider';
import { AppHeader } from '@/components/layout/AppHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Loader2, Shield, UserPlus, KeyRound, Trash2, Cpu } from 'lucide-react';

const numberFmt = new Intl.NumberFormat('en-US');
const usdFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

export default function AdminPage() {
  const qc = useQueryClient();
  const { user } = useAuthContext();
  const { data: users, isLoading, error } = useQuery({ queryKey: ['admin-users'], queryFn: adminListUsers });

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-users'] });

  // ── AI provider config ──
  const { data: aiCfg } = useQuery({ queryKey: ['ai-config'], queryFn: getAiConfig });
  const [provider, setProvider] = useState('');
  const [claudeModel, setClaudeModel] = useState('');
  const [geminiModel, setGeminiModel] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [geminiKey, setGeminiKey] = useState('');
  const activeProvider = provider || aiCfg?.provider || 'claude';
  const activeClaudeModel = claudeModel || aiCfg?.claude_model || '';
  const activeGeminiModel = geminiModel || aiCfg?.gemini_model || '';
  const saveAi = useMutation({
    mutationFn: () => updateAiConfig({
      provider: activeProvider, claude_model: activeClaudeModel, gemini_model: activeGeminiModel,
      ...(anthropicKey ? { anthropic_api_key: anthropicKey } : {}),
      ...(geminiKey ? { gemini_api_key: geminiKey } : {}),
    }),
    onSuccess: () => { toast.success('AI settings saved'); setAnthropicKey(''); setGeminiKey(''); qc.invalidateQueries({ queryKey: ['ai-config'] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Save failed'),
  });

  const create = useMutation({
    mutationFn: () => adminCreateUser({ email, password, display_name: name, is_admin: isAdmin }),
    onSuccess: () => { toast.success('User created'); setEmail(''); setName(''); setPassword(''); setIsAdmin(false); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Create failed'),
  });
  const update = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, boolean> }) => adminUpdateUser(id, data),
    onSuccess: () => { toast.success('Updated'); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Update failed'),
  });
  const resetPw = useMutation({
    mutationFn: ({ id, pw }: { id: string; pw: string }) => adminResetPassword(id, pw),
    onSuccess: () => toast.success('Password reset'),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Reset failed'),
  });
  const del = useMutation({
    mutationFn: adminDeleteUser,
    onSuccess: () => { toast.success('User deleted'); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Delete failed'),
  });

  return (
    <div className="min-h-screen bg-muted/20">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-6 flex items-center gap-2 text-2xl font-bold"><Shield className="h-6 w-6 text-primary" /> Admin</h1>

        <Card className="mb-6">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Cpu className="h-4 w-4" /> AI Provider</CardTitle></CardHeader>
          <CardContent>
            <div className="grid items-end gap-3 md:grid-cols-4">
              <div className="space-y-1">
                <Label>Provider</Label>
                <select className="w-full rounded-md border px-3 py-2 text-sm" value={activeProvider} onChange={(e) => setProvider(e.target.value)}>
                  <option value="claude">Claude (Anthropic)</option>
                  <option value="gemini">Gemini (Google)</option>
                </select>
              </div>
              {activeProvider === 'claude' ? (
                <>
                  <div className="space-y-1"><Label>Claude model</Label><Input value={activeClaudeModel} onChange={(e) => setClaudeModel(e.target.value)} placeholder="claude-sonnet-4-6" /></div>
                  <div className="space-y-1"><Label>Anthropic API key {aiCfg?.has_anthropic_key && <span className="text-xs text-green-600">(set)</span>}</Label><Input type="password" value={anthropicKey} onChange={(e) => setAnthropicKey(e.target.value)} placeholder={aiCfg?.has_anthropic_key ? '•••••• (leave blank to keep)' : 'sk-ant-...'} /></div>
                </>
              ) : (
                <>
                  <div className="space-y-1"><Label>Gemini model</Label><Input value={activeGeminiModel} onChange={(e) => setGeminiModel(e.target.value)} placeholder="gemini-3.5-flash" /></div>
                  <div className="space-y-1"><Label>Gemini API key {aiCfg?.has_gemini_key && <span className="text-xs text-green-600">(set)</span>}</Label><Input type="password" value={geminiKey} onChange={(e) => setGeminiKey(e.target.value)} placeholder={aiCfg?.has_gemini_key ? '•••••• (leave blank to keep)' : 'AIza...'} /></div>
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
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><UserPlus className="h-4 w-4" /> Create user</CardTitle></CardHeader>
          <CardContent>
            <div className="grid items-end gap-3 md:grid-cols-5">
              <div className="space-y-1"><Label>Email</Label><Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@lab.edu" /></div>
              <div className="space-y-1"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" /></div>
              <div className="space-y-1"><Label>Password</Label><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••" /></div>
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
                <table className="w-full text-sm">
                  <thead><tr className="border-b text-left text-muted-foreground">
                    <th className="px-2 py-2">Email</th><th className="px-2 py-2">Name</th><th className="px-2 py-2">Role</th>
                    <th className="px-2 py-2">Approval</th><th className="px-2 py-2">Active</th><th className="px-2 py-2">Data</th><th className="px-2 py-2">Figs</th>
                    <th className="px-2 py-2">AI Calls</th><th className="px-2 py-2">Tokens</th><th className="px-2 py-2">Est. Cost</th><th className="px-2 py-2">Actions</th>
                  </tr></thead>
                  <tbody>
                    {users?.map((u) => (
                      <tr key={u.id} className="border-b last:border-0">
                        <td className="px-2 py-2 font-medium">{u.email}</td>
                        <td className="px-2 py-2">{u.display_name}</td>
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
                        <td className="px-2 py-2 text-muted-foreground">{numberFmt.format(u.ai_request_count)}</td>
                        <td className="px-2 py-2 text-muted-foreground" title={`${numberFmt.format(u.ai_input_tokens)} input / ${numberFmt.format(u.ai_output_tokens)} output`}>
                          {numberFmt.format(u.ai_total_tokens)}
                        </td>
                        <td className="px-2 py-2 text-muted-foreground">{usdFmt.format(u.ai_estimated_cost_usd)}</td>
                        <td className="px-2 py-2">
                          <div className="flex gap-1">
                            <Button variant="ghost" size="sm" title="Reset password"
                              onClick={() => { const pw = prompt(`New password for ${u.email}:`); if (pw) resetPw.mutate({ id: u.id, pw }); }}>
                              <KeyRound className="h-4 w-4" />
                            </Button>
                            {u.id !== user?.id && (
                              <Button variant="ghost" size="sm" title="Delete"
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
      </main>
    </div>
  );
}
