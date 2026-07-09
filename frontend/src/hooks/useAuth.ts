'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { login as apiLogin, register as apiRegister, logout as apiLogout, getMe, clearTokens, ApiError } from '@/lib/api';
import type { User, LoginRequest, RegisterRequest } from '@/lib/types';

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const router = useRouter();

  const checkAuth = useCallback(async () => {
    setLoading(true);
    setAuthError(null);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('access_token') : null;
      if (!token) { setUser(null); setLoading(false); return; }
      setUser(await getMe());
    } catch (err) {
      // Only drop the session on a genuine auth failure (401). Transient
      // network blips or 5xx errors must NOT clear tokens / log the user out.
      if (err instanceof ApiError && err.status === 401) {
        clearTokens(); setUser(null);
      } else {
        setAuthError('Authentication service is temporarily unavailable.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { checkAuth(); }, [checkAuth]);

  const login = async (data: LoginRequest) => {
    await apiLogin(data);
    setUser(await getMe());
    setAuthError(null);
    router.push('/projects');
  };

  const register = async (data: RegisterRequest) => {
    await apiRegister(data);
  };

  const logout = async () => { await apiLogout(); setUser(null); setAuthError(null); router.push('/login'); };

  return { user, loading, authError, retryAuth: checkAuth, login, register, logout, isAuthenticated: !!user };
}
