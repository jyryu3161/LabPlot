/* eslint-disable @next/next/no-html-link-for-pages */
import { BarChart3 } from 'lucide-react';

export function PublicHeader() {
  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
        <a href="/" className="flex items-center gap-2 font-semibold">
          <BarChart3 className="h-5 w-5 text-primary" /> LabPlot AI
        </a>
        <nav className="ml-auto flex items-center gap-3 text-sm">
          <a href="/gallery" className="text-muted-foreground hover:text-foreground">Gallery</a>
          <a href="/login" className="text-muted-foreground hover:text-foreground">Login</a>
          <a
            href="/projects"
            className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
          >
            Open app
          </a>
        </nav>
      </div>
    </header>
  );
}
