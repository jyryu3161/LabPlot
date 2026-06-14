import Link from 'next/link';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { LandingPrimaryCta } from '@/components/landing/LandingPrimaryCta';
import { ArrowRight, Check, Sparkles } from 'lucide-react';

const BENEFITS = [
  'Ranked chart recommendations',
  'Editable SVG with version history',
  'Reproducible R code and export files',
];

export function LandingCaptureHero() {
  return (
    <section className="overflow-hidden border-b bg-[#f7f8fb]">
      <div className="mx-auto max-w-6xl px-4 pt-14 text-center sm:pt-[4.5rem] lg:pt-20">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 shadow-sm">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          AI-powered publication figure copilot
        </div>

        <h1 className="mx-auto max-w-4xl text-balance text-4xl font-bold leading-tight tracking-tight text-slate-950 sm:text-5xl lg:text-6xl">
          Publication-ready figures, powered by AI and reproducible in R.
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-slate-600 sm:text-lg">
          Upload your data, compare ranked plot recommendations, refine the figure visually, and keep the exact R code behind every result.
        </p>

        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <LandingPrimaryCta />
          <Link href="/gallery">
            <Button size="lg" variant="outline" className="h-11 border-slate-300 bg-white px-6">
              Explore the gallery
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
        </div>

        <div className="mt-7 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-slate-600">
          {BENEFITS.map((benefit) => (
            <span key={benefit} className="inline-flex items-center gap-1.5">
              <Check className="h-4 w-4 text-primary" />
              {benefit}
            </span>
          ))}
        </div>

        <div className="mx-auto mt-11 max-w-5xl rounded-lg border border-slate-200 bg-white p-1 shadow-2xl shadow-slate-900/10">
          <div className="flex h-9 items-center justify-between border-b border-slate-200 px-3">
            <div className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
              <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
            </div>
            <div className="hidden text-xs font-medium text-slate-500 sm:block">Generate figure</div>
            <div className="hidden text-xs text-slate-400 sm:block">LabPlot AI</div>
          </div>
          <div className="max-h-[430px] overflow-hidden bg-white">
            <Image
              src="/landing/capture-generate.png"
              alt="LabPlot AI generate figure screen"
              width={1440}
              height={842}
              priority
              sizes="(min-width: 1024px) 1024px, 100vw"
              className="aspect-[1440/842] w-full object-cover object-top"
            />
          </div>
        </div>
      </div>
    </section>
  );
}
