import Link from 'next/link';
import { PublicHeader } from '@/components/layout/PublicHeader';
import { Button } from '@/components/ui/button';
import { LandingCaptureHero } from '@/components/landing/LandingCaptureHero';
import { LandingGalleryStrip } from '@/components/landing/LandingGalleryStrip';
import { LandingPrimaryCta } from '@/components/landing/LandingPrimaryCta';
import {
  Sparkles, BarChart3, Star, FileCode2, FolderKanban, FileText,
  Upload, Wand2, Palette, Download, ShieldCheck, Eye, RefreshCw, Award,
} from 'lucide-react';

const FEATURES = [
  { icon: Sparkles, title: 'AI chart recommendation', desc: 'LabPlot AI reads your column types and suggests the right plot — box, volcano, Kaplan–Meier, PCA and more — with a clear rationale.' },
  { icon: BarChart3, title: 'Publication-quality ggplot2', desc: '22 chart templates, publication style presets, color or grayscale, and colorblind-safe palettes — all rendered in R/ggplot2.' },
  { icon: Star, title: 'AI Figure Review', desc: 'A vision model evaluates your rendered figure for publication readiness and returns a score with concrete fixes.' },
  { icon: FileText, title: 'AI figure legends', desc: 'Draft a journal-style figure legend grounded in your study context and the statistics actually computed — never invented.' },
  { icon: FileCode2, title: 'Reproducible R code', desc: 'Every figure ships with the exact R script. Export to SVG, TIFF (300/600 dpi) and PDF for submission.' },
  { icon: FolderKanban, title: 'Projects & versioning', desc: 'Organize datasets and figures per study or manuscript, and track every version as you iterate.' },
];

const TRUST = [
  { icon: RefreshCw, title: 'Reproducible by design', desc: 'Every figure includes the exact R/ggplot2 script that produced it. Re-run it anywhere and get the same result.' },
  { icon: Eye, title: 'No black box', desc: 'Inspect, edit, and re-render everything yourself. The AI proposes parameter changes against vetted templates — never opaque code.' },
  { icon: Award, title: 'Publication-grade output', desc: 'Publication style presets, colorblind-safe palettes, vector SVG/PDF and high-DPI TIFF — built for figure submission.' },
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
  return (
    <div className="min-h-screen bg-background">
      <PublicHeader />
      <LandingCaptureHero />

      <LandingGalleryStrip />

      {/* features */}
      <section className="mx-auto max-w-6xl px-4 py-10 md:py-20">
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
            <LandingPrimaryCta />
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
