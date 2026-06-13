'use client';

import Link from 'next/link';
import { useAuthContext } from '@/components/auth/AuthProvider';
import { Button } from '@/components/ui/button';
import { BarChart3, LogOut } from 'lucide-react';

export function PublicHeader() {
  const { isAuthenticated, logout } = useAuthContext();
  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <BarChart3 className="h-5 w-5 text-primary" /> LabPlot AI
        </Link>
        <nav className="ml-auto flex items-center gap-3 text-sm">
          <Link href="/gallery" className="text-muted-foreground hover:text-foreground">Gallery</Link>
          {isAuthenticated ? (
            <>
              <Link href="/projects"><Button size="sm">Open app</Button></Link>
              <Button variant="outline" size="sm" onClick={logout}>
                <LogOut className="h-4 w-4" />
                <span>Log out</span>
              </Button>
            </>
          ) : (
            <>
              <Link href="/login" className="text-muted-foreground hover:text-foreground">Login</Link>
              <Link href="/register"><Button size="sm">Get started</Button></Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
