'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Download, Loader2, RotateCcw, Trash2, UserCircle } from 'lucide-react';
import { useMutation, useQuery } from '@tanstack/react-query';

import { AppHeader } from '@/components/layout/AppHeader';
import { useAuthContext } from '@/components/auth/AuthProvider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { deleteAccount, downloadAccountExport, getAccountUsage } from '@/lib/api';

const numberFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

function UsageMeter({ label, used, limit, unit }: { label: string; used: number; limit: number; unit?: string }) {
  const unlimited = limit <= 0;
  const pct = unlimited ? 0 : Math.min(100, (used / limit) * 100);
  const barColor = unlimited || pct < 80 ? 'bg-primary' : pct < 95 ? 'bg-amber-500' : 'bg-red-500';
  const fmt = (n: number) => `${numberFmt.format(n)}${unit ? ` ${unit}` : ''}`;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{fmt(used)} / {unlimited ? '∞' : fmt(limit)}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        {...(unlimited ? {} : { 'aria-valuemax': limit, 'aria-valuenow': Math.min(used, limit), 'aria-valuetext': `${fmt(used)} of ${fmt(limit)}` })}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function AccountPage() {
  const { user, logout } = useAuthContext();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const exportData = useMutation({
    mutationFn: downloadAccountExport,
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Export failed'),
  });
  const usage = useQuery({ queryKey: ['account-usage'], queryFn: getAccountUsage });
  const remove = useMutation({
    mutationFn: () => deleteAccount(password, confirm),
    onSuccess: () => {
      toast.success('Account deleted');
      logout();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Delete failed'),
  });

  return (
    <div className="min-h-screen bg-muted/20">
      <AppHeader />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-6 flex items-center gap-2 text-2xl font-bold">
          <UserCircle className="h-6 w-6 text-primary" /> Account
        </h1>

        <Card className="mb-6">
          <CardHeader className="pb-2"><CardTitle className="text-base">Profile</CardTitle></CardHeader>
          <CardContent className="grid gap-3 text-sm md:grid-cols-2">
            <div><span className="text-muted-foreground">Email</span><div className="font-medium">{user?.email}</div></div>
            <div><span className="text-muted-foreground">Name</span><div className="font-medium">{user?.display_name}</div></div>
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader className="pb-2"><CardTitle className="text-base">Usage</CardTitle></CardHeader>
          <CardContent>
            {usage.isLoading ? (
              <div className="space-y-4" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="space-y-1">
                    <div className="h-4 w-40 animate-pulse rounded bg-muted" />
                    <div className="h-1.5 w-full animate-pulse rounded-full bg-muted" />
                  </div>
                ))}
              </div>
            ) : usage.isError ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
                <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-destructive" />
                <p className="mb-3 text-sm text-muted-foreground">{usage.error instanceof Error ? usage.error.message : 'Could not load usage.'}</p>
                <Button variant="outline" size="sm" onClick={() => usage.refetch()}><RotateCcw className="mr-1 h-4 w-4" /> Retry</Button>
              </div>
            ) : usage.data ? (
              <div className="space-y-4">
                <UsageMeter label="AI requests this month" used={usage.data.ai_monthly_used} limit={usage.data.ai_monthly_limit} />
                <UsageMeter label="Renders this month" used={usage.data.render_monthly_used} limit={usage.data.render_monthly_limit} />
                <UsageMeter label="Storage" used={usage.data.storage_used_mb} limit={usage.data.storage_limit_mb} unit="MB" />
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader className="pb-2"><CardTitle className="text-base">Data Export</CardTitle></CardHeader>
          <CardContent>
            <Button onClick={() => exportData.mutate()} disabled={exportData.isPending}>
              {exportData.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              <span>Download ZIP</span>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Delete Account</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="delete-password">Password</Label>
                <Input id="delete-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="delete-confirm">Type DELETE</Label>
                <Input id="delete-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </div>
            </div>
            <Button
              variant="destructive"
              disabled={remove.isPending || !password || confirm !== 'DELETE'}
              onClick={() => { if (confirm === 'DELETE' && window.confirm('Delete your account and all LabPlot data?')) remove.mutate(); }}
            >
              {remove.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              <span>Delete Account</span>
            </Button>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
