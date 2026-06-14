'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useQuery } from '@tanstack/react-query';
import { getPublicGallery } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { GalleryHorizontal, PencilRuler, Sparkles } from 'lucide-react';

const CAPTURES = [
  {
    label: 'Gallery',
    src: '/landing/capture-gallery.png',
    detail: 'Browse real rendered examples before starting.',
    icon: GalleryHorizontal,
  },
  {
    label: 'Generate',
    src: '/landing/capture-generate.png',
    detail: 'Map columns, compare ranked suggestions, and render.',
    icon: Sparkles,
  },
  {
    label: 'Edit',
    src: '/landing/capture-editing.png',
    detail: 'Polish SVG labels, colors, and layout with version history.',
    icon: PencilRuler,
  },
];

export function LandingGalleryStrip() {
  const [active, setActive] = useState(1);
  const { data } = useQuery({ queryKey: ['public-gallery', 8], queryFn: () => getPublicGallery(8) });
  const figures = data?.figures ?? [];
  const activeCapture = CAPTURES[active];

  return (
    <section className="border-b bg-background py-14 sm:py-16">
      <div className="mx-auto max-w-6xl px-4">
        <div className="mx-auto mb-7 max-w-3xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Workflow</p>
          <h2 className="mt-3 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
            Move from examples to final figure without leaving the workspace.
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            The main flow stays focused: choose a visual direction, generate from data, then edit the vector output.
          </p>
        </div>

        <div className="mb-5 flex justify-center">
          <div className="inline-flex rounded-lg border bg-muted p-1">
            {CAPTURES.map((capture, index) => {
              const Icon = capture.icon;
              const selected = index === active;
              return (
                <button
                  key={capture.label}
                  type="button"
                  onClick={() => setActive(index)}
                  aria-pressed={selected}
                  className={`inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm font-medium transition sm:px-4 ${
                    selected ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {capture.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border bg-background shadow-xl shadow-slate-900/5">
          <div className="flex min-h-12 flex-col gap-1 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm font-semibold">{activeCapture.label}</p>
            <p className="text-sm text-muted-foreground">{activeCapture.detail}</p>
          </div>
          <Image
            src={activeCapture.src}
            alt={`${activeCapture.label} screenshot`}
            width={1440}
            height={842}
            loading="lazy"
            sizes="(min-width: 1024px) 1024px, 100vw"
            className="aspect-[1440/842] w-full bg-white object-contain"
          />
        </div>

        {figures.length > 0 && (
          <div className="mt-10">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-slate-900">Recent gallery figures</h3>
              <Link href="/gallery">
                <Button variant="ghost" size="sm">View all</Button>
              </Link>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {figures.slice(0, 4).map((f, i) => (
                <div key={`${f.thumb_url}-${i}`} className="overflow-hidden rounded-lg border bg-background">
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
