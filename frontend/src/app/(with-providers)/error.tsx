'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { AlertTriangle, RotateCcw } from 'lucide-react';

// Segment error boundary for the authenticated app. Catches render-time
// exceptions in these pages (which would otherwise blank the screen) and
// offers a retry. Rendered inside the providers layout, so it can use the
// design system freely.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/20 p-4">
      <div className="w-full max-w-md rounded-xl border bg-background p-8 text-center shadow-sm">
        <AlertTriangle className="mx-auto mb-4 h-10 w-10 text-destructive" />
        <h1 className="mb-2 text-xl font-semibold">Something went wrong</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          An unexpected error occurred while loading this page. You can try again.
        </p>
        <Button onClick={() => reset()}>
          <RotateCcw className="mr-1 h-4 w-4" /> Try again
        </Button>
      </div>
    </div>
  );
}
