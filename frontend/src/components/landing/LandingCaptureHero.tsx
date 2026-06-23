import { LandingPrimaryCta } from '@/components/landing/LandingPrimaryCta';
import { ArrowRight, Check, Sparkles } from 'lucide-react';

const BENEFITS = [
  'Ranked chart recommendations',
  'Editable SVG with version history',
  'Reproducible R code and export files',
];

export function LandingCaptureHero() {
  return (
    <section className="relative overflow-hidden border-b bg-zinc-950 text-white">
      <div className="absolute inset-0 bg-[linear-gradient(135deg,#09090b_0%,#111827_52%,#064e3b_100%)]" />
      <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-zinc-950 to-transparent" />

      <div className="relative mx-auto flex min-h-[62vh] max-w-6xl flex-col items-center justify-center px-4 py-12 text-center sm:py-14 lg:py-16">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-medium text-white/78 backdrop-blur">
          <Sparkles className="h-3.5 w-3.5 text-teal-200" />
          AI-powered publication figure copilot
        </div>

        <h1 className="mx-auto max-w-4xl text-balance text-4xl font-bold leading-tight tracking-tight sm:text-5xl lg:text-6xl">
          Publication-quality figures from your data, reproducible in R.
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/72 sm:text-lg">
          Upload your data, compare ranked plot recommendations, refine the figure visually, and keep the exact R code behind every result.
        </p>

        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <LandingPrimaryCta />
          <a
            href="/gallery"
            className="inline-flex h-11 items-center justify-center rounded-md bg-white px-6 text-sm font-medium text-zinc-950 shadow-sm transition hover:bg-white/90"
          >
            Explore the gallery
            <ArrowRight className="ml-2 h-4 w-4" />
          </a>
        </div>

        <div className="mt-7 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-white/72">
          {BENEFITS.map((benefit) => (
            <span key={benefit} className="inline-flex items-center gap-1.5">
              <Check className="h-4 w-4 text-teal-200" />
              {benefit}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
