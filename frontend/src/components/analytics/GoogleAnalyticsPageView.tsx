'use client';

import { useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

type GtagCommand = 'config' | 'event' | 'js';
type Gtag = (command: GtagCommand, target: string | Date, params?: Record<string, unknown>) => void;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: Gtag;
  }
}

export function GoogleAnalyticsPageView({ measurementId }: { measurementId: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!measurementId || !pathname) return;
    const search = searchParams.toString();
    const pagePath = search ? `${pathname}?${search}` : pathname;
    const pageLocation = `${window.location.origin}${pagePath}`;
    const payload = {
      page_path: pagePath,
      page_location: pageLocation,
      page_title: document.title,
    };

    window.dataLayer = window.dataLayer || [];
    if (typeof window.gtag === 'function') {
      window.gtag('event', 'page_view', payload);
    } else {
      window.dataLayer.push(['event', 'page_view', payload]);
    }
  }, [measurementId, pathname, searchParams]);

  return null;
}
