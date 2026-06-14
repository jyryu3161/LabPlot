'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { getPublicGallery } from '@/lib/api';

export function LandingGalleryStrip() {
  const { data } = useQuery({ queryKey: ['public-gallery', 8], queryFn: () => getPublicGallery(8) });
  const figures = data?.figures ?? [];

  if (figures.length === 0) return null;

  return (
    <section className="bg-muted/30 py-8 sm:py-12">
      <div className="mx-auto max-w-6xl px-4">
        <div className="mb-5 flex items-end justify-between">
          <div>
            <h2 className="text-lg font-semibold">Made with LabPlot AI</h2>
            <p className="text-sm text-muted-foreground">Real figures across every supported chart type.</p>
          </div>
          <Link href="/gallery" className="text-sm font-medium text-primary hover:underline">View full gallery -&gt;</Link>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {figures.slice(0, 8).map((f, i) => (
            <div key={`${f.thumb_url}-${i}`} className="group overflow-hidden rounded-lg border bg-white shadow-sm">
              <img
                src={f.thumb_url}
                alt={f.name}
                loading="lazy"
                decoding="async"
                className="aspect-[4/3] w-full object-contain"
              />
              <div className="border-t px-2.5 py-1.5 text-xs capitalize text-muted-foreground">{f.plot_type.replace('_', ' ')}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
