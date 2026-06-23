import type { ReactNode } from 'react';
import { Providers } from '../providers';
import { Toaster } from '@/components/ui/sonner';
import { ClientErrorReporter } from '@/components/monitoring/ClientErrorReporter';

export default function WithProvidersLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <ClientErrorReporter />
      {children}
      <Toaster richColors />
    </Providers>
  );
}
