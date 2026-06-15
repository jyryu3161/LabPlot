'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Building2, KeyRound, Loader2, Search, Users } from 'lucide-react';
import { AppHeader } from '@/components/layout/AppHeader';
import { useAuthContext } from '@/components/auth/AuthProvider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  addOrganizationMember,
  approveOrganizationMember,
  createOrganization,
  getOrganizationAiConfig,
  getOrganizationUsage,
  joinOrganization,
  listMyOrganizations,
  listOrganizationMembers,
  rejectOrganizationMember,
  searchOrganizations,
  setActiveOrganization,
  updateOrganizationAiConfig,
} from '@/lib/api';

const numberFmt = new Intl.NumberFormat('en-US');
const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });

export default function OrganizationsPage() {
  const qc = useQueryClient();
  const { user } = useAuthContext();
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(user?.active_organization_id || null);
  const [query, setQuery] = useState('');
  const [newOrgName, setNewOrgName] = useState('');
  const [provider, setProvider] = useState('');
  const [claudeModel, setClaudeModel] = useState('');
  const [geminiModel, setGeminiModel] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [geminiKey, setGeminiKey] = useState('');
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRole, setMemberRole] = useState<'admin' | 'member'>('member');

  const { data: myOrgs, isLoading } = useQuery({ queryKey: ['my-organizations'], queryFn: listMyOrganizations });
  const { data: searchResults } = useQuery({ queryKey: ['organization-search', query], queryFn: () => searchOrganizations(query) });
  const selected = useMemo(() => (myOrgs ?? []).find((row) => row.organization.id === selectedOrgId) ?? (myOrgs ?? [])[0], [myOrgs, selectedOrgId]);
  const selectedId = selected?.organization.id;
  const canAdmin = Boolean(selected?.is_org_admin);
  const { data: members } = useQuery({
    queryKey: ['organization-members', selectedId],
    queryFn: () => listOrganizationMembers(selectedId!),
    enabled: Boolean(selectedId && canAdmin),
  });
  const { data: aiCfg } = useQuery({
    queryKey: ['organization-ai-config', selectedId],
    queryFn: () => getOrganizationAiConfig(selectedId!),
    enabled: Boolean(selectedId && canAdmin),
  });
  const { data: usage } = useQuery({
    queryKey: ['organization-usage', selectedId],
    queryFn: () => getOrganizationUsage(selectedId!),
    enabled: Boolean(selectedId && canAdmin),
  });
  const activeProvider = provider || aiCfg?.provider || 'claude';
  const activeClaudeModel = claudeModel || aiCfg?.claude_model || 'claude-sonnet-4-6';
  const activeGeminiModel = geminiModel || aiCfg?.gemini_model || 'gemini-3.5-flash';

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['my-organizations'] });
    qc.invalidateQueries({ queryKey: ['organization-search'] });
    qc.invalidateQueries({ queryKey: ['organization-members'] });
    qc.invalidateQueries({ queryKey: ['organization-ai-config'] });
    qc.invalidateQueries({ queryKey: ['organization-usage'] });
  };

  const createOrg = useMutation({
    mutationFn: () => createOrganization({ name: newOrgName }),
    onSuccess: (org) => { toast.success('Organization created'); setNewOrgName(''); setSelectedOrgId(org.id); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Create failed'),
  });
  const join = useMutation({
    mutationFn: joinOrganization,
    onSuccess: () => { toast.success('Join request sent'); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Join request failed'),
  });
  const activate = useMutation({
    mutationFn: setActiveOrganization,
    onSuccess: () => { toast.success('Active organization updated'); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Update failed'),
  });
  const approve = useMutation({
    mutationFn: ({ id, role }: { id: string; role: 'admin' | 'member' }) => approveOrganizationMember(selectedId!, id, role),
    onSuccess: () => { toast.success('Member approved'); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Approval failed'),
  });
  const addMember = useMutation({
    mutationFn: () => addOrganizationMember(selectedId!, memberEmail, memberRole),
    onSuccess: () => { toast.success('Member added'); setMemberEmail(''); setMemberRole('member'); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Add member failed'),
  });
  const reject = useMutation({
    mutationFn: (id: string) => rejectOrganizationMember(selectedId!, id),
    onSuccess: () => { toast.success('Member rejected'); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Reject failed'),
  });
  const saveAi = useMutation({
    mutationFn: () => updateOrganizationAiConfig(selectedId!, {
      provider: activeProvider,
      claude_model: activeClaudeModel,
      gemini_model: activeGeminiModel,
      ...(anthropicKey ? { anthropic_api_key: anthropicKey } : {}),
      ...(geminiKey ? { gemini_api_key: geminiKey } : {}),
    }),
    onSuccess: () => { toast.success('Organization AI settings saved'); setAnthropicKey(''); setGeminiKey(''); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Save failed'),
  });

  return (
    <div className="min-h-screen bg-muted/20">
      <AppHeader />
      <main className="mx-auto grid max-w-7xl gap-5 px-4 py-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="space-y-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Building2 className="h-4 w-4" /> My Organizations</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
              {(myOrgs ?? []).map((row) => (
                <button key={row.organization.id} type="button" onClick={() => setSelectedOrgId(row.organization.id)}
                  className={`w-full rounded-md border p-2 text-left text-sm ${selected?.organization.id === row.organization.id ? 'border-primary bg-primary/5' : 'bg-background'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{row.organization.name}</span>
                    <Badge variant={row.membership.status === 'active' ? 'outline' : 'secondary'}>{row.membership.status}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{row.membership.role}{row.active ? ' · active' : ''}</p>
                </button>
              ))}
              {(!myOrgs || myOrgs.length === 0) && <p className="text-sm text-muted-foreground">No organizations yet.</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Create Organization</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <Input value={newOrgName} onChange={(e) => setNewOrgName(e.target.value)} placeholder="Lab or institution name" />
              <Button className="w-full" onClick={() => createOrg.mutate()} disabled={createOrg.isPending || !newOrgName.trim()}>
                {createOrg.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create'}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Search className="h-4 w-4" /> Find Organization</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, slug, domain" />
              <div className="max-h-60 space-y-1 overflow-auto">
                {(searchResults ?? []).map((org) => (
                  <div key={org.id} className="rounded-md border bg-background p-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="font-medium">{org.name}</div>
                        <div className="text-xs text-muted-foreground">{org.domain || org.slug} · {org.member_count} members</div>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => join.mutate(org.id)} disabled={join.isPending}>Join</Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </aside>

        <section className="space-y-4">
          {selected ? (
            <>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between gap-3 text-base">
                    <span>{selected.organization.name}</span>
                    <div className="flex gap-2">
                      <Badge variant={selected.is_org_admin ? 'default' : 'secondary'}>{selected.membership.role}</Badge>
                      <Button size="sm" variant="outline" disabled={selected.active || selected.membership.status !== 'active'} onClick={() => activate.mutate(selected.organization.id)}>
                        {selected.active ? 'Active' : 'Set active'}
                      </Button>
                    </div>
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3 text-sm md:grid-cols-3">
                  <div><span className="text-muted-foreground">Slug</span><div className="font-medium">{selected.organization.slug}</div></div>
                  <div><span className="text-muted-foreground">Domain</span><div className="font-medium">{selected.organization.domain || '-'}</div></div>
                  <div><span className="text-muted-foreground">Membership</span><div className="font-medium">{selected.membership.status}</div></div>
                </CardContent>
              </Card>

              {canAdmin && (
                <>
                  <Card>
                    <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4" /> Organization AI Provider</CardTitle></CardHeader>
                    <CardContent className="space-y-3">
                      <div className="grid gap-3 text-sm md:grid-cols-3">
                        <div className="rounded-md border p-2"><span className="text-muted-foreground">Requests this month</span><div className="font-medium">{numberFmt.format(usage?.ai_request_count ?? 0)}</div></div>
                        <div className="rounded-md border p-2"><span className="text-muted-foreground">Tokens this month</span><div className="font-medium">{numberFmt.format(usage?.ai_total_tokens ?? 0)}</div></div>
                        <div className="rounded-md border p-2"><span className="text-muted-foreground">Estimated cost</span><div className="font-medium">{usdFmt.format(usage?.ai_estimated_cost_usd ?? 0)}</div></div>
                      </div>
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
                            <div className="space-y-1"><Label>Claude model</Label><Input value={activeClaudeModel} onChange={(e) => setClaudeModel(e.target.value)} /></div>
                            <div className="space-y-1"><Label>Anthropic key {aiCfg?.has_anthropic_key && <span className="text-xs text-green-600">(set)</span>}</Label><Input type="password" value={anthropicKey} onChange={(e) => setAnthropicKey(e.target.value)} placeholder={aiCfg?.has_anthropic_key ? 'leave blank to keep' : 'sk-ant-...'} /></div>
                          </>
                        ) : (
                          <>
                            <div className="space-y-1"><Label>Gemini model</Label><Input value={activeGeminiModel} onChange={(e) => setGeminiModel(e.target.value)} /></div>
                            <div className="space-y-1"><Label>Gemini key {aiCfg?.has_gemini_key && <span className="text-xs text-green-600">(set)</span>}</Label><Input type="password" value={geminiKey} onChange={(e) => setGeminiKey(e.target.value)} placeholder={aiCfg?.has_gemini_key ? 'leave blank to keep' : 'AIza...'} /></div>
                          </>
                        )}
                        <Button onClick={() => saveAi.mutate()} disabled={saveAi.isPending}>
                          {saveAi.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">Keys are write-only. Stored provider: {aiCfg?.secret_provider || 'not set'}. LabPlot will use this organization key for active members.</p>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Users className="h-4 w-4" /> Members</CardTitle></CardHeader>
                    <CardContent className="space-y-4 overflow-x-auto">
                      <div className="grid items-end gap-2 rounded-md border bg-muted/20 p-3 md:grid-cols-[minmax(0,1fr)_140px_auto]">
                        <div className="space-y-1">
                          <Label>Existing user email</Label>
                          <Input type="email" value={memberEmail} onChange={(e) => setMemberEmail(e.target.value)} placeholder="user@lab.edu" />
                        </div>
                        <div className="space-y-1">
                          <Label>Role</Label>
                          <select className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={memberRole} onChange={(e) => setMemberRole(e.target.value as 'admin' | 'member')}>
                            <option value="member">Member</option>
                            <option value="admin">Admin</option>
                          </select>
                        </div>
                        <Button onClick={() => addMember.mutate()} disabled={addMember.isPending || !memberEmail.trim()}>
                          {addMember.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add user'}
                        </Button>
                      </div>
                      <table className="w-full text-sm">
                        <thead><tr className="border-b text-left text-muted-foreground"><th className="px-2 py-2">User</th><th className="px-2 py-2">Role</th><th className="px-2 py-2">Status</th><th className="px-2 py-2">Actions</th></tr></thead>
                        <tbody>
                          {(members ?? []).map((m) => (
                            <tr key={m.id} className="border-b last:border-0">
                              <td className="px-2 py-2"><div className="font-medium">{m.display_name}</div><div className="text-xs text-muted-foreground">{m.email}</div></td>
                              <td className="px-2 py-2">{m.role}</td>
                              <td className="px-2 py-2"><Badge variant={m.status === 'active' ? 'outline' : m.status === 'pending' ? 'secondary' : 'destructive'}>{m.status}</Badge></td>
                              <td className="px-2 py-2">
                                {m.status === 'pending' ? (
                                  <div className="flex gap-1">
                                    <Button size="sm" variant="outline" onClick={() => approve.mutate({ id: m.id, role: 'member' })}>Approve</Button>
                                    <Button size="sm" variant="outline" onClick={() => approve.mutate({ id: m.id, role: 'admin' })}>Admin</Button>
                                    <Button size="sm" variant="destructive" onClick={() => reject.mutate(m.id)}>Reject</Button>
                                  </div>
                                ) : <span className="text-xs text-muted-foreground">-</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </CardContent>
                  </Card>
                </>
              )}
            </>
          ) : (
            <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">Create or join an organization to manage lab-level settings.</CardContent></Card>
          )}
        </section>
      </main>
    </div>
  );
}
