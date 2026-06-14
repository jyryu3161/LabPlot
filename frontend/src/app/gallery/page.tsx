'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { getPublicGallery } from '@/lib/api';
import type { PublicFigure } from '@/lib/types';
import { useAuthContext } from '@/components/auth/AuthProvider';
import { PublicHeader } from '@/components/layout/PublicHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Images } from 'lucide-react';

// preferred display order of domains
const DOMAIN_ORDER = [
  'Basic statistics', 'Omics', 'Clinical / cohort', 'Systems biology',
  'Functional enrichment', 'Genomics', 'Cheminformatics', 'Engineering / physical science',
];

function FigureCard({ f }: { f: PublicFigure }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-white shadow-sm transition hover:shadow-md">
      <img src={f.thumb_url} alt={f.name} loading="lazy" decoding="async" className="aspect-[4/3] w-full object-contain" />
      <div className="flex items-center justify-between border-t px-3 py-2">
        <span className="truncate text-sm font-medium">{f.name}</span>
        <Badge variant="secondary" className="capitalize">{f.plot_type.replace(/_/g, ' ')}</Badge>
      </div>
    </div>
  );
}

export default function GalleryPage() {
  const { isAuthenticated } = useAuthContext();
  const { data, isLoading } = useQuery({ queryKey: ['public-gallery', 60], queryFn: () => getPublicGallery(60) });
  const figures = data?.figures ?? [];

  // group by domain
  const groups = new Map<string, PublicFigure[]>();
  for (const f of figures) {
    const k = f.domain_label || 'Other';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(f);
  }
  const orderedKeys = [
    ...DOMAIN_ORDER.filter((d) => groups.has(d)),
    ...[...groups.keys()].filter((d) => !DOMAIN_ORDER.includes(d)),
  ];

  return (
    <div className="min-h-screen bg-background">
      <PublicHeader />
      <main className="mx-auto max-w-6xl px-4 py-14">
        <div className="mb-10 text-center">
          <h1 className="text-3xl font-bold tracking-tight">Gallery</h1>
          <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
            Publication-ready figures made with LabPlot AI — organized by field. Browse freely, no account needed.
          </p>
          {!isAuthenticated && <Link href="/register"><Button className="mt-5">Create your own →</Button></Link>}
        </div>

        {isLoading ? (
          <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : figures.length === 0 ? (
          <div className="rounded-xl border border-dashed p-16 text-center text-muted-foreground">
            <Images className="mx-auto mb-2 h-8 w-8" /> No public examples yet.
          </div>
        ) : (
          <div className="space-y-12">
            {orderedKeys.map((dom) => (
              <section key={dom}>
                <div className="mb-4 flex items-center gap-3">
                  <h2 className="text-xl font-semibold">{dom}</h2>
                  <span className="h-px flex-1 bg-border" />
                  <Badge variant="outline">{groups.get(dom)!.length}</Badge>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {groups.get(dom)!.map((f, i) => <FigureCard key={i} f={f} />)}
                </div>
              </section>
            ))}
          </div>
        )}

        {!isAuthenticated && figures.length > 0 && (
          <div className="mt-14 rounded-xl border bg-muted/30 p-8 text-center">
            <h2 className="text-xl font-semibold">Create figures like these from your own data</h2>
            <p className="mx-auto mt-2 max-w-lg text-muted-foreground">
              Upload a dataset and LabPlot AI recommends the chart, renders it in ggplot2 (or ComplexHeatmap, ggraph…), and gives you the reproducible R code.
            </p>
            <Link href="/register"><Button className="mt-5">Get started — it&apos;s free</Button></Link>
          </div>
        )}
      </main>
    </div>
  );
}
