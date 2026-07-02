'use client';

import { useEffect } from 'react';

// Root-level error boundary. This replaces the root layout when it renders,
// so it must provide its own <html>/<body> and cannot rely on Tailwind/global
// styles being available. Inline styles keep it self-contained and robust.
export default function GlobalError({
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
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1rem',
          backgroundColor: '#f8fafc',
          color: '#0f172a',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: '28rem',
            borderRadius: '0.75rem',
            border: '1px solid #e2e8f0',
            backgroundColor: '#ffffff',
            padding: '2rem',
            textAlign: 'center',
            boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)',
          }}
        >
          <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem', fontWeight: 600 }}>
            Something went wrong
          </h1>
          <p style={{ margin: '0 0 1.5rem', fontSize: '0.875rem', color: '#64748b' }}>
            An unexpected error occurred. Please try again — if the problem persists,
            reload the page.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '2.25rem',
              padding: '0 1rem',
              borderRadius: '0.5rem',
              border: 'none',
              cursor: 'pointer',
              fontSize: '0.875rem',
              fontWeight: 500,
              backgroundColor: '#0f172a',
              color: '#ffffff',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
