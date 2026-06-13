'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { login as apiLogin, register as apiRegister, logout as apiLogout, getMe, clearTokens } from '@/lib/api';
import type { User, LoginRequest, RegisterRequest } from '@/lib/types';

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const checkAuth = useCallback(async () => {
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('access_token') : null;
      if (!token) { setUser(null); setLoading(false); return; }
      setUser(await getMe());
    } catch {
      clearTokens(); setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { checkAuth(); }, [checkAuth]);

  const login = async (data: LoginRequest) => {
    await apiLogin(data);
    setUser(await getMe());
    router.push('/projects');
  };

  const register = async (data: RegisterRequest) => {
    await apiRegister(data);
  };

  const logout = () => { apiLogout(); setUser(null); router.push('/login'); };

  return { user, loading, login, register, logout, isAuthenticated: !!user };
}
