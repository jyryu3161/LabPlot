'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Download, Loader2, Trash2, UserCircle } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';

import { AppHeader } from '@/components/layout/AppHeader';
import { useAuthContext } from '@/components/auth/AuthProvider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { deleteAccount, downloadAccountExport } from '@/lib/api';

export default function AccountPage() {
  const { user, logout } = useAuthContext();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const exportData = useMutation({
    mutationFn: downloadAccountExport,
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Export failed'),
  });
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
                <Label>Password</Label>
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Type DELETE</Label>
                <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
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
