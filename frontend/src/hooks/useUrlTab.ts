'use client';

import { useCallback, useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

function pathWithQuery(pathname: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/**
 * Keep a page-level tab in the URL so browser history, refresh, and copied
 * links all restore the same workspace. The default tab keeps the legacy
 * query-free URL; invalid tab values are removed without adding history.
 */
export function useUrlTab<T extends string>(validTabs: readonly T[], defaultTab: T) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const activeTab = requestedTab && validTabs.includes(requestedTab as T)
    ? requestedTab as T
    : defaultTab;

  useEffect(() => {
    if (!requestedTab || validTabs.includes(requestedTab as T)) return;
    const next = new URLSearchParams(searchParams.toString());
    next.delete('tab');
    router.replace(pathWithQuery(pathname, next), { scroll: false });
  }, [pathname, requestedTab, router, searchParams, validTabs]);

  const setActiveTab = useCallback((nextTab: T) => {
    if (!validTabs.includes(nextTab)) return;
    const next = new URLSearchParams(searchParams.toString());
    if (nextTab === defaultTab) next.delete('tab');
    else next.set('tab', nextTab);
    router.push(pathWithQuery(pathname, next), { scroll: false });
  }, [defaultTab, pathname, router, searchParams, validTabs]);

  return [activeTab, setActiveTab] as const;
}
