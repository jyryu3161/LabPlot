'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { LandingPrimaryCta } from '@/components/landing/LandingPrimaryCta';
import { BarChart3, Check, Sparkles } from 'lucide-react';

const CAPTURES = [
  { label: 'Gallery', src: '/landing/capture-gallery.png' },
  { label: 'Generate figure', src: '/landing/capture-generate.png' },
  { label: 'Vector editing', src: '/landing/capture-editing.png' },
];

export function LandingCaptureHero() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setActive((i) => (i + 1) % CAPTURES.length), 4500);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <section className="relative min-h-[76vh] overflow-hidden border-b bg-zinc-950 text-white">
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
        <div className="absolute inset-0 bg-black/55" />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-zinc-950 to-transparent" />
      </div>

      <div className="relative mx-auto flex min-h-[76vh] max-w-6xl flex-col justify-center px-4 py-20">
        <div className="max-w-3xl">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-medium text-white/80 backdrop-blur">
            <Sparkles className="h-3.5 w-3.5" /> AI-powered publication figure copilot
          </div>
          <h1 className="max-w-3xl text-balance text-4xl font-bold tracking-tight sm:text-6xl">
            Publication-ready figures, powered by AI and reproducible in R.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-white/78">
            Upload your data, compare recommended plots, tune the figure visually, and export submission-ready SVG, TIFF, PDF, and R code from one workflow.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <LandingPrimaryCta />
            <Link href="/gallery"><Button size="lg" variant="secondary" className="h-11 px-6">Explore the gallery</Button></Link>
          </div>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-white/78">
            {['Template-bound R rendering', 'Versioned SVG editing', 'Colorblind-safe palettes', 'Self-hostable stack'].map((t) => (
              <span key={t} className="inline-flex items-center gap-1.5"><Check className="h-4 w-4" /> {t}</span>
            ))}
          </div>
        </div>

        <div className="absolute bottom-5 right-4 flex items-center gap-2 rounded-full border border-white/20 bg-black/35 px-3 py-2 text-xs text-white/80 backdrop-blur">
          <BarChart3 className="h-4 w-4" />
          {CAPTURES.map((capture, index) => (
            <button
              key={capture.label}
              type="button"
              onClick={() => setActive(index)}
              className={`rounded-full px-2 py-1 transition ${index === active ? 'bg-white text-zinc-950' : 'hover:bg-white/10'}`}
            >
              {capture.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
