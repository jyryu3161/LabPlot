'use client';

import { useEffect } from 'react';

function messageFromReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return 'Unhandled client error';
  }
}

function stackFromReason(reason: unknown): string | undefined {
  return reason instanceof Error ? reason.stack : undefined;
}

export function ClientErrorReporter() {
  useEffect(() => {
    let last = '';
    let lastAt = 0;
    const reportClientError = async (payload: { source: string; message: string; path?: string; stack?: string }) => {
      await fetch('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    };
    const send = (source: string, message: string, stack?: string) => {
      const path = window.location.pathname + window.location.search;
      const key = `${source}:${message}:${path}`;
      const now = Date.now();
      if (key === last && now - lastAt < 10000) return;
      last = key;
      lastAt = now;
      reportClientError({ source, message, stack, path }).catch(() => undefined);
    };

    const onError = (event: ErrorEvent) => {
      send('window.error', event.message || 'Client error', event.error?.stack);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      send('unhandledrejection', messageFromReason(event.reason), stackFromReason(event.reason));
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  return null;
}
