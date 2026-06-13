'use client';

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useAuth } from '@/hooks/useAuth';
import type { User, LoginRequest, RegisterRequest } from '@/lib/types';
import { usePathname, useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (data: LoginRequest) => Promise<void>;
  register: (data: RegisterRequest) => Promise<void>;
  logout: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
// pages viewable without logging in
const PUBLIC_PATHS = ['/', '/gallery', '/login', '/register'];
// pages an authenticated user shouldn't sit on
const AUTH_ONLY_PATHS = ['/login', '/register'];

export function AuthProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (auth.loading) return;
    const isPublic = PUBLIC_PATHS.includes(pathname);
    if (!auth.isAuthenticated && !isPublic) router.push('/login');
    if (auth.isAuthenticated && AUTH_ONLY_PATHS.includes(pathname)) router.push('/projects');
  }, [auth.loading, auth.isAuthenticated, pathname, router]);

  if (auth.loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}

export function useAuthContext() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuthContext must be used within AuthProvider');
  return ctx;
}
