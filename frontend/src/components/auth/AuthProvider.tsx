'use client';

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useAuth } from '@/hooks/useAuth';
import type { User, LoginRequest, RegisterRequest } from '@/lib/types';
import { usePathname, useRouter } from 'next/navigation';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  authError: string | null;
  retryAuth: () => Promise<void>;
  login: (data: LoginRequest) => Promise<void>;
  register: (data: RegisterRequest) => Promise<void>;
  logout: () => void | Promise<void>;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
// pages viewable without logging in
const PUBLIC_PATHS = ['/', '/gallery', '/login', '/register', '/forgot-password', '/reset-password'];
// pages an authenticated user shouldn't sit on
const AUTH_ONLY_PATHS = ['/login', '/register', '/forgot-password', '/reset-password'];

export function AuthProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const isPublic = PUBLIC_PATHS.includes(pathname);

  useEffect(() => {
    if (auth.loading || auth.authError) return;
    if (!auth.isAuthenticated && !isPublic) router.push('/login');
    if (auth.isAuthenticated && AUTH_ONLY_PATHS.includes(pathname)) router.push('/projects');
  }, [auth.loading, auth.authError, auth.isAuthenticated, isPublic, pathname, router]);

  if (auth.loading && !isPublic) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (auth.authError && !isPublic) {
    return (
      <AuthContext.Provider value={auth}>
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
          <p className="text-sm text-muted-foreground">{auth.authError}</p>
          <Button type="button" variant="outline" onClick={() => void auth.retryAuth()}>
            <RefreshCw className="mr-2 h-4 w-4" /> Retry
          </Button>
        </div>
      </AuthContext.Provider>
    );
  }

  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}

export function useAuthContext() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuthContext must be used within AuthProvider');
  return ctx;
}
