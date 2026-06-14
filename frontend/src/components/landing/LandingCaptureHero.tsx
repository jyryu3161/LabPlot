import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { LandingPrimaryCta } from '@/components/landing/LandingPrimaryCta';
import { ArrowRight, Check, FileCode2, ShieldCheck, Sparkles } from 'lucide-react';

const PROOF_POINTS = [
  { label: '18 chart templates', detail: 'ggplot2/R rendering' },
  { label: 'SVG, TIFF, PDF', detail: 'submission-ready export' },
  { label: 'Self-hostable', detail: 'private lab deployment' },
];

export function LandingCaptureHero() {
  return (
    <section className="border-b bg-background">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 md:grid-cols-[1.15fr_0.85fr] md:items-center md:py-16 lg:py-20">
        <div className="max-w-3xl">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            AI-assisted, reproducible figure workflow
          </div>
          <h1 className="text-balance text-4xl font-bold leading-tight tracking-tight sm:text-5xl lg:text-6xl">
            Publication-ready figures from data, reference images, and editable R output.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            Upload a dataset, get ranked chart recommendations, refine the SVG visually, and keep the exact R code behind every figure.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <LandingPrimaryCta />
            <Link href="/gallery">
              <Button size="lg" variant="outline" className="h-11 px-6">
                View examples
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </div>
          <div className="mt-7 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
            {['Ranked recommendations', 'Versioned SVG edits', 'Exportable R scripts'].map((item) => (
              <span key={item} className="inline-flex items-center gap-1.5">
                <Check className="h-4 w-4 text-primary" />
                {item}
              </span>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3 md:grid-cols-1">
          {PROOF_POINTS.map((item) => (
            <div key={item.label} className="rounded-lg border bg-card p-4 shadow-sm">
              <p className="text-sm font-semibold">{item.label}</p>
              <p className="mt-1 text-sm text-muted-foreground">{item.detail}</p>
            </div>
          ))}
          <div className="rounded-lg border bg-muted/40 p-4">
            <div className="flex items-start gap-3">
              <FileCode2 className="mt-0.5 h-5 w-5 text-primary" />
              <div>
                <p className="text-sm font-semibold">No black box</p>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  AI proposes the chart and parameters; LabPlot stores the rendered output, figure history, and reproducible code.
                </p>
              </div>
            </div>
            <div className="mt-4 flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 text-primary" />
              <div>
                <p className="text-sm font-semibold">Private by default</p>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  Data files are encrypted at rest and can stay on your own server.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
