'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { getPublicGallery } from '@/lib/api';
import { useAuthContext } from '@/components/auth/AuthProvider';
import { PublicHeader } from '@/components/layout/PublicHeader';
import { Button } from '@/components/ui/button';
import {
  Sparkles, BarChart3, Star, FileCode2, FolderKanban, FileText,
  ArrowRight, Upload, Wand2, Palette, Download, ShieldCheck, Eye, RefreshCw, Award, Check,
} from 'lucide-react';

const FEATURES = [
  { icon: Sparkles, title: 'AI chart recommendation', desc: 'LabPlot AI reads your column types and suggests the right plot — box, volcano, Kaplan–Meier, PCA and more — with a clear rationale.' },
  { icon: BarChart3, title: 'Publication-quality ggplot2', desc: '9 chart types, journal-style themes, color or grayscale, and colorblind-safe palettes — all rendered in R/ggplot2.' },
  { icon: Star, title: 'AI Figure Review', desc: 'A vision model evaluates your rendered figure for publication readiness and returns a score with concrete fixes.' },
  { icon: FileText, title: 'AI figure legends', desc: 'Draft a journal-style figure legend grounded in your study context and the statistics actually computed — never invented.' },
  { icon: FileCode2, title: 'Reproducible R code', desc: 'Every figure ships with the exact R script. Export to SVG, TIFF (300/600 dpi) and PDF for submission.' },
  { icon: FolderKanban, title: 'Projects & versioning', desc: 'Organize datasets and figures per study or manuscript, and track every version as you iterate.' },
];

const TRUST = [
  { icon: RefreshCw, title: 'Reproducible by design', desc: 'Every figure includes the exact R/ggplot2 script that produced it. Re-run it anywhere and get the same result.' },
  { icon: Eye, title: 'No black box', desc: 'Inspect, edit, and re-render everything yourself. The AI proposes parameter changes against vetted templates — never opaque code.' },
  { icon: Award, title: 'Publication-grade output', desc: 'Journal-style themes, colorblind-safe palettes, vector SVG/PDF and high-DPI TIFF — built for figure submission.' },
  { icon: ShieldCheck, title: 'Private & self-hosted', desc: 'Runs on your own lab or institutional server. Your unpublished data stays under your control.' },
];

const STEPS = [
  { icon: Upload, t: 'Upload', d: 'Drop a CSV/TSV/XLSX. Column types and summary statistics are detected automatically.' },
  { icon: Wand2, t: 'Recommend', d: 'Rule-based + AI suggestions point you to the right chart for your data.' },
  { icon: Palette, t: 'Style & edit', d: 'Adjust axes, labels, colors, size and chart type with full control.' },
  { icon: Star, t: 'Review', d: 'AI reviews publication readiness and drafts your figure legend.' },
  { icon: Download, t: 'Export', d: 'Download SVG/TIFF/PDF and the reproducible R script.' },
];

export default function LandingPage() {
  const { isAuthenticated } = useAuthContext();
  const { data } = useQuery({ queryKey: ['public-gallery', 8], queryFn: () => getPublicGallery(8) });
  const figures = data?.figures ?? [];

  const primaryCta = isAuthenticated
    ? <Link href="/projects"><Button size="lg" className="h-11 px-6">Open the app <ArrowRight className="ml-2 h-4 w-4" /></Button></Link>
    : <Link href="/register"><Button size="lg" className="h-11 px-6">Get started — it&apos;s free <ArrowRight className="ml-2 h-4 w-4" /></Button></Link>;

  return (
    <div className="min-h-screen bg-background">
      <PublicHeader />

      {/* hero */}
      <section className="relative overflow-hidden border-b">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_0%,theme(colors.primary/8%),transparent)]" />
        <div className="relative mx-auto max-w-5xl px-4 py-24 text-center">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border bg-background px-3 py-1 text-xs font-medium text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 text-primary" /> AI-powered publication figure copilot
          </div>
          <h1 className="mx-auto max-w-3xl text-balance text-4xl font-bold tracking-tight sm:text-5xl">
            Publication-ready figures, powered by AI —{' '}
            <span className="text-primary">fully reproducible in R.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
            Upload your data and LabPlot AI recommends the right chart, renders it in ggplot2 at journal
            quality, reviews it like a peer reviewer, and hands you the reproducible R code.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            {primaryCta}
            <Link href="/gallery"><Button size="lg" variant="outline" className="h-11 px-6">Explore the gallery</Button></Link>
          </div>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
            {['Reproducible R code', 'ggplot2 rendering', 'Colorblind-safe palettes', 'Runs on your own server'].map((t) => (
              <span key={t} className="inline-flex items-center gap-1.5"><Check className="h-4 w-4 text-primary" /> {t}</span>
            ))}
          </div>
        </div>
      </section>

      {/* gallery strip */}
      {figures.length > 0 && (
        <section className="bg-muted/30 py-12">
          <div className="mx-auto max-w-6xl px-4">
            <div className="mb-5 flex items-end justify-between">
              <div>
                <h2 className="text-lg font-semibold">Made with LabPlot AI</h2>
                <p className="text-sm text-muted-foreground">Real figures across every supported chart type.</p>
              </div>
              <Link href="/gallery" className="text-sm font-medium text-primary hover:underline">View full gallery →</Link>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {figures.slice(0, 8).map((f, i) => (
                <div key={i} className="group overflow-hidden rounded-xl border bg-white shadow-sm">
                  <img src={f.thumb_url} alt={f.name} className="aspect-[4/3] w-full object-contain" />
                  <div className="border-t px-2.5 py-1.5 text-xs capitalize text-muted-foreground">{f.plot_type.replace('_', ' ')}</div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* features */}
      <section className="mx-auto max-w-6xl px-4 py-20">
        <div className="mx-auto mb-12 max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight">Everything you need for a figure</h2>
          <p className="mt-3 text-muted-foreground">No R expertise required — yet every result is fully reproducible in R.</p>
        </div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <div key={f.title} className="rounded-xl border bg-card p-6 transition hover:shadow-md">
                <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10">
                  <Icon className="h-5 w-5 text-primary" />
                </div>
                <h3 className="mb-1.5 font-semibold">{f.title}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{f.desc}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* trust */}
      <section className="border-y bg-muted/30 py-20">
        <div className="mx-auto max-w-6xl px-4">
          <div className="mx-auto mb-12 max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight">Built to be trusted in research</h2>
            <p className="mt-3 text-muted-foreground">Transparent, reproducible, and under your control — the way research tooling should be.</p>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {TRUST.map((t) => {
              const Icon = t.icon;
              return (
                <div key={t.title} className="rounded-xl border bg-background p-6">
                  <Icon className="mb-3 h-6 w-6 text-primary" />
                  <h3 className="mb-1.5 font-semibold">{t.title}</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">{t.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* how it works */}
      <section className="mx-auto max-w-6xl px-4 py-20">
        <div className="mx-auto mb-12 max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight">How it works</h2>
          <p className="mt-3 text-muted-foreground">From raw data to a submission-ready figure in five steps.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            return (
              <div key={s.t} className="rounded-xl border bg-card p-5">
                <div className="mb-3 flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">{i + 1}</span>
                  <Icon className="h-4 w-4 text-primary" />
                </div>
                <h3 className="font-semibold">{s.t}</h3>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{s.d}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* final CTA */}
      <section className="border-t bg-muted/30">
        <div className="mx-auto max-w-3xl px-4 py-20 text-center">
          <h2 className="text-3xl font-bold tracking-tight">Make your first figure today</h2>
          <p className="mt-3 text-muted-foreground">Create an account, upload your data, and get a publication-ready figure in under a minute.</p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            {primaryCta}
            <Link href="/gallery"><Button size="lg" variant="outline" className="h-11 px-6">See examples</Button></Link>
          </div>
        </div>
      </section>

      <footer className="border-t py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 text-sm text-muted-foreground sm:flex-row">
          <span className="inline-flex items-center gap-2"><BarChart3 className="h-4 w-4 text-primary" /> LabPlot AI</span>
          <span>Reproducible figures with R / ggplot2 · a non-commercial research tool</span>
        </div>
      </footer>
    </div>
  );
}
