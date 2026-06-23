'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { useState, type ReactNode } from 'react';
import { AuthProvider } from '@/components/auth/AuthProvider';

const enableQueryDevtools = process.env.NODE_ENV === 'development' && process.env.NEXT_PUBLIC_ENABLE_QUERY_DEVTOOLS === '1';

const ReactQueryDevtools = enableQueryDevtools
  ? dynamic(
      () => import('@tanstack/react-query-devtools').then((mod) => mod.ReactQueryDevtools),
      { ssr: false }
    )
  : function NoDevtools() { return null; };

export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        {children}
      </AuthProvider>
      {enableQueryDevtools && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  );
}
