'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { getPublicGallery } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { GalleryHorizontal, PencilRuler, Sparkles } from 'lucide-react';

const CAPTURES = [
  {
    label: 'Gallery',
    src: '/landing/capture-gallery.png',
    detail: 'Inspect real LabPlot output across supported chart families before starting.',
    icon: GalleryHorizontal,
  },
  {
    label: 'Generate figure',
    src: '/landing/capture-generate.png',
    detail: 'Upload data, review ranked recommendations, and render with mapped columns.',
    icon: Sparkles,
  },
  {
    label: 'Vector editing',
    src: '/landing/capture-editing.png',
    detail: 'Edit SVG labels, colors, and layout while preserving version history.',
    icon: PencilRuler,
  },
];

export function LandingGalleryStrip() {
  const [active, setActive] = useState(1);
  const { data } = useQuery({ queryKey: ['public-gallery', 8], queryFn: () => getPublicGallery(8) });
  const figures = data?.figures ?? [];
  const activeCapture = CAPTURES[active];

  return (
    <section className="border-b bg-muted/30 py-10 sm:py-14">
      <div className="mx-auto max-w-6xl px-4">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <Badge variant="secondary" className="mb-2">Product workflow</Badge>
            <h2 className="text-2xl font-bold tracking-tight">Gallery, generation, and vector editing in one loop</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Start from examples, create a figure from your data, then polish the exported SVG without losing the R code lineage.
            </p>
          </div>
          <Link href="/gallery">
            <Button variant="outline">Open gallery</Button>
          </Link>
        </div>

        <div className="grid gap-5 lg:grid-cols-[280px_1fr] lg:items-start">
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1">
            {CAPTURES.map((capture, index) => {
              const Icon = capture.icon;
              const selected = index === active;
              return (
                <button
                  key={capture.label}
                  type="button"
                  onClick={() => setActive(index)}
                  aria-pressed={selected}
                  className={`rounded-lg border p-4 text-left transition ${
                    selected ? 'border-primary bg-background shadow-sm' : 'bg-background/60 hover:border-primary/60'
                  }`}
                >
                  <span className="flex items-center gap-2 text-sm font-semibold">
                    <Icon className="h-4 w-4 text-primary" />
                    {capture.label}
                  </span>
                  <span className="mt-2 block text-sm leading-relaxed text-muted-foreground">{capture.detail}</span>
                </button>
              );
            })}
          </div>

          <div className="overflow-hidden rounded-lg border bg-background shadow-sm">
            <div className="border-b px-4 py-3">
              <p className="text-sm font-semibold">{activeCapture.label}</p>
            </div>
            <img
              src={activeCapture.src}
              alt={`${activeCapture.label} screenshot`}
              loading="lazy"
              decoding="async"
              className="aspect-[1440/842] w-full bg-white object-contain"
            />
          </div>
        </div>

        {figures.length > 0 && (
          <div className="mt-9">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold">Recent gallery figures</h3>
                <p className="text-sm text-muted-foreground">Real rendered examples from the public gallery.</p>
              </div>
              <Link href="/gallery" className="text-sm font-medium text-primary hover:underline">
                View all
              </Link>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {figures.slice(0, 4).map((f, i) => (
                <div key={`${f.thumb_url}-${i}`} className="overflow-hidden rounded-lg border bg-background shadow-sm">
                  <img
                    src={f.thumb_url}
                    alt={f.name}
                    loading="lazy"
                    decoding="async"
                    className="aspect-[4/3] w-full bg-white object-contain"
                  />
                  <div className="border-t px-2.5 py-1.5 text-xs capitalize text-muted-foreground">
                    {f.plot_type.replace('_', ' ')}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
