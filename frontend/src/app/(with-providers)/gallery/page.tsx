'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { getPublicGallery } from '@/lib/api';
import type { PublicFigure } from '@/lib/types';
import { useAuthContext } from '@/components/auth/AuthProvider';
import { AppHeader } from '@/components/layout/AppHeader';
import { PublicHeader } from '@/components/layout/PublicHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Images } from 'lucide-react';

// preferred display order of domains
const DOMAIN_ORDER = [
  'Basic Statistics',
  'Biology & Medicine',
  'Chemistry',
  'Biotechnology',
  'Engineering',
  'Advanced & Specialized',
];

function FigureCard({ f }: { f: PublicFigure }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm transition hover:shadow-md">
      <img src={f.thumb_url} alt={f.name} loading="lazy" decoding="async" className="aspect-[4/3] w-full bg-white object-contain" />
      <div className="space-y-3 border-t px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">{f.name}</span>
          <Badge variant="secondary" className="capitalize">{f.plot_type.replace(/_/g, ' ')}</Badge>
        </div>
        <Link href={`/gallery/template/${f.id}`}>
          <Button size="sm" variant="outline" className="w-full">View template details</Button>
        </Link>
      </div>
    </div>
  );
}

export default function GalleryPage() {
  const { isAuthenticated } = useAuthContext();
  const { data, isLoading } = useQuery({ queryKey: ['public-gallery', 120], queryFn: () => getPublicGallery(120) });
  const figures = data?.figures ?? [];
  const [search, setSearch] = useState('');
  const [domainFilter, setDomainFilter] = useState('all');
  const [plotTypeFilter, setPlotTypeFilter] = useState('all');
  const [sortBy, setSortBy] = useState<'featured' | 'name' | 'type'>('featured');

  const domainOptions = [
    ...DOMAIN_ORDER.filter((domain) => figures.some((figure) => (figure.domain_label || 'Other') === domain)),
    ...Array.from(new Set(figures.map((figure) => figure.domain_label || 'Other')))
      .filter((domain) => !DOMAIN_ORDER.includes(domain))
      .sort(),
  ];
  const plotTypeOptions = Array.from(new Set(figures.map((figure) => figure.plot_type))).sort();
  const normalizedSearch = search.trim().toLowerCase();
  const visibleFigures = figures
    .filter((figure) => (
      (!normalizedSearch
        || figure.name.toLowerCase().includes(normalizedSearch)
        || figure.plot_type.replace(/_/g, ' ').toLowerCase().includes(normalizedSearch)
        || (figure.domain_label || '').toLowerCase().includes(normalizedSearch))
      && (domainFilter === 'all' || (figure.domain_label || 'Other') === domainFilter)
      && (plotTypeFilter === 'all' || figure.plot_type === plotTypeFilter)
    ))
    .sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'type') return a.plot_type.localeCompare(b.plot_type) || a.name.localeCompare(b.name);
      return 0;
    });

  // group by domain
  const groups = new Map<string, PublicFigure[]>();
  for (const f of visibleFigures) {
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
      {isAuthenticated ? <AppHeader /> : <PublicHeader />}
      <main className="mx-auto max-w-6xl px-4 py-14">
        <div className="mb-10 text-center">
          <h1 className="text-3xl font-bold tracking-tight">Gallery</h1>
          <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
            Publication-ready figures made with LabPlot AI — organized by field.
          </p>
          {!isAuthenticated && <Link href="/register"><Button className="mt-5">Create your own →</Button></Link>}
        </div>

        {!isLoading && figures.length > 0 && (
          <div className="mb-8 grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5 sm:col-span-2 lg:col-span-1">
              <Label htmlFor="gallery-search">Search templates</Label>
              <Input
                id="gallery-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Name, field, or chart type"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gallery-domain">Research field</Label>
              <select id="gallery-domain" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={domainFilter} onChange={(event) => setDomainFilter(event.target.value)}>
                <option value="all">All fields</option>
                {domainOptions.map((domain) => <option key={domain} value={domain}>{domain}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gallery-chart-type">Chart type</Label>
              <select id="gallery-chart-type" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={plotTypeFilter} onChange={(event) => setPlotTypeFilter(event.target.value)}>
                <option value="all">All chart types</option>
                {plotTypeOptions.map((plotType) => <option key={plotType} value={plotType}>{plotType.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gallery-sort">Sort</Label>
              <select id="gallery-sort" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)}>
                <option value="featured">Featured order</option>
                <option value="name">Name</option>
                <option value="type">Chart type</option>
              </select>
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-4" role="status" aria-live="polite">
              Showing {visibleFigures.length} of {figures.length} templates. Open a template to inspect its required columns and example data before using it.
            </p>
          </div>
        )}

        {isLoading ? (
          <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : figures.length === 0 ? (
          <div className="rounded-xl border border-dashed p-16 text-center text-muted-foreground">
            <Images className="mx-auto mb-2 h-8 w-8" /> No public examples yet.
          </div>
        ) : visibleFigures.length === 0 ? (
          <div className="rounded-xl border border-dashed p-12 text-center text-muted-foreground">
            <Images className="mx-auto mb-2 h-8 w-8" /> No templates match these filters.
            <Button type="button" variant="outline" className="mx-auto mt-4 block" onClick={() => { setSearch(''); setDomainFilter('all'); setPlotTypeFilter('all'); setSortBy('featured'); }}>
              Clear filters
            </Button>
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
                  {groups.get(dom)!.map((f) => <FigureCard key={f.id} f={f} />)}
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
