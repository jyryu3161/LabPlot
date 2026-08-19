'use client';

import { useEffect, useReducer, type ReactNode } from 'react';
import { usePathname, useSelectedLayoutSegments } from 'next/navigation';
import { Loader2 } from 'lucide-react';

function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname || '/';
}

function pathnameFromSegments(segments: string[]): string {
  // Route groups are an organisational detail and never appear in a public
  // URL. Dynamic segments are returned here as their resolved value.
  const publicSegments = segments.filter((segment) => !(segment.startsWith('(') && segment.endsWith(')')));
  return normalizePathname(`/${publicSegments.join('/')}`);
}

/**
 * App Router transitions may resolve the next React tree in a different task
 * from the browser history commit. Never expose that next screen while the
 * address bar still identifies the previous resource. We do not manipulate
 * history here; the router remains the single owner of navigation.
 */
export function CanonicalRouteBoundary({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const selectedSegments = useSelectedLayoutSegments();
  const [, checkLocationAgain] = useReducer((value: number) => value + 1, 0);
  const routePathname = pathnameFromSegments(selectedSegments);
  const browserPathname = normalizePathname(
    typeof window === 'undefined' ? pathname : window.location.pathname,
  );
  const metadataPathname = normalizePathname(pathname);
  // `usePathname()` and window.location can briefly agree on the OLD path
  // after the App Router has already swapped in the next streamed child tree.
  // The active layout segments identify that rendered tree, closing the exact
  // window that previously exposed a canvas/project under a figure/list URL.
  const routeIsCanonical = browserPathname === metadataPathname
    && browserPathname === routePathname;

  useEffect(() => {
    if (routeIsCanonical) return;

    let frame = 0;
    const check = () => {
      // If usePathname metadata is still stale, its own subscription will
      // re-render this boundary. Avoid a tight render loop during that window;
      // force one render only for history changes that React cannot observe.
      if (
        normalizePathname(window.location.pathname) === routePathname
        && metadataPathname === routePathname
      ) {
        checkLocationAgain();
        return;
      }
      frame = window.requestAnimationFrame(check);
    };
    frame = window.requestAnimationFrame(check);
    return () => window.cancelAnimationFrame(frame);
  }, [metadataPathname, routeIsCanonical, routePathname]);

  if (!routeIsCanonical) {
    return (
      <div
        className="flex min-h-screen items-center justify-center gap-2 bg-muted/20 text-sm text-muted-foreground"
        data-testid="canonical-route-pending"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        Opening destination…
      </div>
    );
  }

  return children;
}
