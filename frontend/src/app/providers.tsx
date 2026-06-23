'use client';

import type { ReactNode } from 'react';
import { AppProviders } from './app-providers';

export function Providers({ children }: { children: ReactNode }) {
  return <AppProviders>{children}</AppProviders>;
}
