'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuthContext } from '@/components/auth/AuthProvider';
import { searchOrganizations } from '@/lib/api';
import type { OrganizationSearchItem } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2 } from 'lucide-react';

export default function RegisterPage() {
  const router = useRouter();
  const { register } = useAuthContext();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [orgMode, setOrgMode] = useState<'join' | 'create' | 'none'>('join');
  const [orgQuery, setOrgQuery] = useState('');
  const [orgResults, setOrgResults] = useState<OrganizationSearchItem[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<OrganizationSearchItem | null>(null);
  const [newOrgName, setNewOrgName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (orgMode !== 'join') return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const out = await searchOrganizations(orgQuery);
        if (!cancelled) setOrgResults(out);
      } catch {
        if (!cancelled) setOrgResults([]);
      }
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [orgMode, orgQuery]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setError('');
    if (password !== confirm) { setError('Passwords do not match'); return; }
    if (password.length < 10 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      setError('Password must be at least 10 characters and include a letter and a number');
      return;
    }
    if (orgMode === 'join' && !selectedOrg) {
      setError('Select an organization or choose another organization option');
      return;
    }
    if (orgMode === 'create' && !newOrgName.trim()) {
      setError('Enter an organization name');
      return;
    }
    setLoading(true);
    try {
      await register({
        email,
        password,
        display_name: displayName,
        ...(orgMode === 'join' && selectedOrg ? { organization_id: selectedOrg.id } : {}),
        ...(orgMode === 'create' ? { organization_name: newOrgName.trim() } : {}),
      });
      router.push(`/login?registered=${orgMode}`);
    }
    catch (err) { setError(err instanceof Error ? err.message : 'Registration failed'); }
    finally { setLoading(false); }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Create Account</CardTitle>
          <CardDescription>Join LabPlot AI</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
            <div className="space-y-2">
              <Label htmlFor="dn">Name</Label>
              <Input id="dn" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Dr. Kim" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="researcher@lab.edu" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pw">Password</Label>
              <Input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
              <p className="text-xs text-muted-foreground">Use at least 10 characters with a letter and a number.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cpw">Confirm Password</Label>
              <Input id="cpw" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" required />
            </div>
            <div className="space-y-3 rounded-md border p-3">
              <Label>Organization</Label>
              <div className="grid grid-cols-3 gap-2 text-sm">
                {(['join', 'create', 'none'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => { setOrgMode(mode); setSelectedOrg(null); }}
                    className={`rounded-md border px-2 py-1.5 ${orgMode === mode ? 'bg-primary text-primary-foreground' : 'bg-background'}`}
                  >
                    {mode === 'join' ? 'Join' : mode === 'create' ? 'Create' : 'Later'}
                  </button>
                ))}
              </div>
              {orgMode === 'join' && (
                <div className="space-y-2">
                  <Input value={orgQuery} onChange={(e) => setOrgQuery(e.target.value)} placeholder="Search institution or lab" aria-label="Search organizations" />
                  <div className="max-h-32 space-y-1 overflow-auto">
                    {orgResults.map((org) => (
                      <button key={org.id} type="button" onClick={() => setSelectedOrg(org)}
                        className={`w-full rounded-md border px-2 py-1.5 text-left text-sm ${selectedOrg?.id === org.id ? 'border-primary bg-primary/5' : 'bg-background'}`}>
                        <span className="font-medium">{org.name}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{org.domain || org.slug}</span>
                      </button>
                    ))}
                    {orgResults.length === 0 && <p className="text-xs text-muted-foreground">No organization found. Create one if your lab is not listed.</p>}
                  </div>
                </div>
              )}
              {orgMode === 'create' && (
                <Input value={newOrgName} onChange={(e) => setNewOrgName(e.target.value)} placeholder="Organization or lab name" aria-label="New organization name" />
              )}
              {orgMode === 'none' && <p className="text-xs text-muted-foreground">You can request to join or create an organization later.</p>}
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating account...</> : 'Sign Up'}
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              Already have an account? <Link href="/login" className="text-primary underline">Sign in</Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
