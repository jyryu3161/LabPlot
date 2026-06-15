'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuthContext } from '@/components/auth/AuthProvider';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { acceptProjectInvitation, listProjectInvitations, rejectProjectInvitation } from '@/lib/api';
import { BarChart3, Bell, Building2, Check, FolderKanban, Images, Shield, LogOut, GalleryHorizontalEnd, UserCircle, X } from 'lucide-react';

const NAV = [
  { href: '/projects', label: 'Projects', icon: FolderKanban },
  { href: '/gallery', label: 'Gallery', icon: GalleryHorizontalEnd },
  { href: '/figures', label: 'Figures', icon: Images },
  { href: '/organizations', label: 'Organizations', icon: Building2 },
];

export function AppHeader() {
  const { user, logout } = useAuthContext();
  const pathname = usePathname();
  const qc = useQueryClient();
  const [invitationsOpen, setInvitationsOpen] = useState(false);
  const { data: invitations } = useQuery({
    queryKey: ['project-invitations'],
    queryFn: listProjectInvitations,
    enabled: Boolean(user),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const pendingCount = invitations?.length ?? 0;

  const accept = useMutation({
    mutationFn: acceptProjectInvitation,
    onSuccess: () => {
      toast.success('Invitation accepted');
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['project-invitations'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Accept failed'),
  });
  const reject = useMutation({
    mutationFn: rejectProjectInvitation,
    onSuccess: () => {
      toast.success('Invitation declined');
      qc.invalidateQueries({ queryKey: ['project-invitations'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Decline failed'),
  });

  return (
    <header className="border-b bg-background sticky top-0 z-30">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
        <Link href="/projects" className="flex items-center gap-2 font-semibold">
          <BarChart3 className="h-5 w-5 text-primary" /> LabPlot AI
        </Link>
        <nav className="flex items-center gap-1">
          {NAV.map((n) => {
            const Icon = n.icon;
            const active = pathname.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href}
                className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm', active ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground')}>
                <Icon className="h-4 w-4" /> {n.label}
              </Link>
            );
          })}
          {user?.is_admin && (
            <Link href="/admin"
              className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm', pathname.startsWith('/admin') ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground')}>
              <Shield className="h-4 w-4" /> Admin
            </Link>
          )}
          <Link href="/account"
            className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm', pathname.startsWith('/account') ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground')}>
            <UserCircle className="h-4 w-4" /> Account
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <div className="relative">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={pendingCount ? `Project invitations: ${pendingCount} pending` : 'Project invitations'}
              aria-expanded={invitationsOpen}
              onClick={() => setInvitationsOpen((open) => !open)}
            >
              <Bell className={pendingCount ? 'text-primary' : 'text-muted-foreground'} />
            </Button>
            {pendingCount > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
                {pendingCount > 9 ? '9+' : pendingCount}
              </span>
            )}
            {invitationsOpen && (
              <div data-testid="header-invitations-menu" className="absolute right-0 top-9 z-50 w-80 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg">
                <div className="flex items-center justify-between border-b px-3 py-2">
                  <span className="text-sm font-medium">Project invitations</span>
                  {pendingCount > 0 && <Badge variant="secondary">{pendingCount}</Badge>}
                </div>
                {pendingCount === 0 ? (
                  <div className="px-3 py-4 text-sm text-muted-foreground">No pending invitations.</div>
                ) : (
                  <div className="max-h-96 overflow-y-auto p-2">
                    {invitations?.map((invite) => (
                      <div key={invite.id} className="rounded-md border bg-background p-3">
                        <p className="truncate text-sm font-medium">{invite.project_name}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Invited by {invite.owner_name} as {invite.role}
                        </p>
                        <div className="mt-3 flex gap-2">
                          <Button size="sm" onClick={() => accept.mutate(invite.id)} disabled={accept.isPending}>
                            <Check className="mr-1 h-3.5 w-3.5" /> Accept
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => reject.mutate(invite.id)} disabled={reject.isPending}>
                            <X className="mr-1 h-3.5 w-3.5" /> Decline
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <span className="text-sm text-muted-foreground">{user?.display_name}{user?.is_admin ? ' (admin)' : ''}</span>
          <Button variant="outline" size="sm" onClick={logout}>
            <LogOut className="h-4 w-4" />
            <span>Log out</span>
          </Button>
        </div>
      </div>
    </header>
  );
}
