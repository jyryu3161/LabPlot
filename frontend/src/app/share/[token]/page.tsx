'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { getSharedFigure } from '@/lib/api';
import type { SharedFigure } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';

// Public, read-only view of a figure shared via an opaque token. Lives outside
// (with-providers) on purpose: no auth, no app header, no react-query provider.
export default function SharedFigurePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [figure, setFigure] = useState<SharedFigure | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    getSharedFigure(token)
      .then((f) => { if (!cancelled) { setFigure(f); setStatus('ready'); } })
      .catch(() => { if (!cancelled) setStatus('error'); });
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="flex min-h-screen flex-col items-center bg-muted/20 px-4 py-10">
      <main className="w-full max-w-3xl space-y-4">
        <div className="text-center text-sm text-muted-foreground">
          Shared figure · <Link href="/" className="font-medium hover:underline">LabPlot AI</Link>
        </div>

        {status === 'loading' && (
          <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin" /></div>
        )}

        {status === 'error' && (
          <Card>
            <CardContent className="py-16 text-center">
              <h1 className="text-lg font-semibold">This share link is invalid or has been disabled.</h1>
              <p className="mt-2 text-sm text-muted-foreground">Ask the figure owner for a new link.</p>
            </CardContent>
          </Card>
        )}

        {status === 'ready' && figure && (
          <Card>
            <CardContent className="space-y-4 p-6">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-xl font-bold">{figure.name}</h1>
                <Badge variant="secondary">{figure.plot_type}</Badge>
              </div>
              {figure.png_url ? (
                <img
                  src={figure.png_url}
                  alt={figure.name}
                  decoding="async"
                  className="mx-auto max-h-[70vh] w-auto rounded bg-white object-contain"
                />
              ) : (
                <div className="py-20 text-center text-muted-foreground">No preview image available.</div>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>Created {new Date(figure.created_at).toLocaleDateString()}</span>
                {figure.width_in != null && figure.height_in != null && (
                  <span>{figure.width_in} × {figure.height_in} in</span>
                )}
                {figure.dpi != null && <span>{figure.dpi} dpi</span>}
              </div>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
