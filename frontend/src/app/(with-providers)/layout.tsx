import type { ReactNode } from 'react';
import { Providers } from '../providers';
import { Toaster } from '@/components/ui/sonner';
import { ClientErrorReporter } from '@/components/monitoring/ClientErrorReporter';
import { CanonicalRouteBoundary } from '@/components/navigation/CanonicalRouteBoundary';

export default function WithProvidersLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <ClientErrorReporter />
      <CanonicalRouteBoundary>{children}</CanonicalRouteBoundary>
      <Toaster richColors />
    </Providers>
  );
}
