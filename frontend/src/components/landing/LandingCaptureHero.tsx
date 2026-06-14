'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { LandingPrimaryCta } from '@/components/landing/LandingPrimaryCta';
import { BarChart3, Check, Sparkles } from 'lucide-react';

const CAPTURES = [
  { label: 'Gallery', src: '/landing/capture-gallery.png', detail: 'Browse real output before starting a new figure.' },
  { label: 'Generate figure', src: '/landing/capture-generate.png', detail: 'Upload data and tune recommended plot settings.' },
  { label: 'Vector editing', src: '/landing/capture-editing.png', detail: 'Adjust SVG text, colors, and layout after rendering.' },
];

export function LandingCaptureHero() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => setActive((i) => (i + 1) % CAPTURES.length), 4500);
    return () => window.clearInterval(timer);
  }, []);

  const activeCapture = CAPTURES[active];

  return (
    <section className="relative min-h-[calc(100svh-7rem)] overflow-hidden border-b bg-zinc-950 text-white md:min-h-[78vh]">
      <div className="absolute inset-0">
        {CAPTURES.map((capture, index) => (
          <img
            key={capture.src}
            src={capture.src}
            alt={`${capture.label} screenshot`}
            className={`absolute inset-0 h-full w-full object-cover object-top transition-opacity duration-700 ${index === active ? 'opacity-100' : 'opacity-0'}`}
            decoding="async"
          />
        ))}
        <div className="absolute inset-0 bg-zinc-950/65 md:bg-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-zinc-950 via-zinc-950/70 to-zinc-950/10" />
        <div className="absolute inset-0 bg-gradient-to-b from-zinc-950/30 via-transparent to-zinc-950/85" />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-zinc-950 to-transparent" />
      </div>

      <div className="relative mx-auto flex min-h-[calc(100svh-7rem)] max-w-6xl flex-col justify-center px-4 py-12 md:min-h-[78vh] md:py-24">
        <div className="max-w-3xl">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-medium text-white/80 backdrop-blur">
            <Sparkles className="h-3.5 w-3.5" /> AI-powered publication figure copilot
          </div>
          <h1 className="max-w-3xl text-balance text-3xl font-bold leading-tight tracking-tight sm:text-6xl">
            Publication-ready figures, powered by AI and reproducible in R.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-white/78 sm:text-lg">
            Upload your data, compare recommended plots, tune the figure visually, and export submission-ready SVG, TIFF, PDF, and R code from one workflow.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-2 sm:gap-3">
            <LandingPrimaryCta />
            <Link href="/gallery"><Button size="lg" variant="secondary" className="h-11 px-6">Explore the gallery</Button></Link>
          </div>
          <div className="mt-7 grid max-w-2xl grid-cols-2 gap-x-4 gap-y-2 text-xs text-white/78 sm:text-sm md:flex md:flex-wrap md:gap-x-6">
            {['Template-bound R rendering', 'Versioned SVG editing', 'Colorblind-safe palettes', 'Self-hostable stack'].map((t) => (
              <span key={t} className="inline-flex items-center gap-1.5"><Check className="h-4 w-4" /> {t}</span>
            ))}
          </div>
        </div>

        <div className="mt-7 max-w-3xl border border-white/20 bg-black/35 p-3 backdrop-blur md:absolute md:bottom-6 md:right-4 md:mt-0 md:w-[520px]">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-white/80">
            <BarChart3 className="h-4 w-4" />
            <span>{activeCapture.detail}</span>
          </div>
          <div className="grid grid-cols-3 gap-1.5 text-xs text-white/80">
            {CAPTURES.map((capture, index) => (
              <button
                key={capture.label}
                type="button"
                onClick={() => setActive(index)}
                aria-pressed={index === active}
                className={`min-h-9 px-2 py-1.5 text-left transition ${index === active ? 'bg-white text-zinc-950' : 'bg-white/5 hover:bg-white/10'}`}
              >
                {capture.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
