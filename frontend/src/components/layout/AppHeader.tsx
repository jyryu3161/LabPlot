'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuthContext } from '@/components/auth/AuthProvider';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { BarChart3, Building2, FolderKanban, Images, Shield, LogOut, GalleryHorizontalEnd, UserCircle } from 'lucide-react';

const NAV = [
  { href: '/projects', label: 'Projects', icon: FolderKanban },
  { href: '/gallery', label: 'Gallery', icon: GalleryHorizontalEnd },
  { href: '/figures', label: 'Figures', icon: Images },
  { href: '/organizations', label: 'Organizations', icon: Building2 },
];

export function AppHeader() {
  const { user, logout } = useAuthContext();
  const pathname = usePathname();

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
