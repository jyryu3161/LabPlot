import { GalleryHorizontal, PencilRuler, Sparkles } from 'lucide-react';

const CAPTURES = [
  {
    label: 'Gallery',
    src: '/landing/capture-gallery.png',
    detail: 'Browse real rendered examples before starting.',
    position: 'center top',
    icon: GalleryHorizontal,
  },
  {
    label: 'Generate',
    src: '/landing/capture-generate.png',
    detail: 'Map columns, compare ranked suggestions, and render.',
    position: 'center top',
    icon: Sparkles,
  },
  {
    label: 'Edit',
    src: '/landing/capture-editing.png',
    detail: 'Polish SVG labels, colors, and layout with version history.',
    position: 'center top',
    icon: PencilRuler,
  },
] as const;

export function LandingGalleryStrip() {
  return (
    <section className="border-b bg-background py-10 sm:py-12">
      <div className="mx-auto max-w-6xl px-4">
        <div className="mx-auto mb-6 max-w-3xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Workflow</p>
          <h2 className="mt-3 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
            Move from examples to final figure without leaving the workspace.
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            The main flow stays focused: choose a visual direction, generate from data, then edit and export the vector output.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          {CAPTURES.map((capture) => {
            const Icon = capture.icon;
            return (
              <article key={capture.label} className="overflow-hidden rounded-lg border bg-background shadow-lg shadow-slate-900/5">
                <div className="flex min-h-16 flex-col gap-1 border-b px-4 py-3">
                  <p className="inline-flex items-center gap-2 text-sm font-semibold">
                    <Icon className="h-4 w-4 text-primary" />
                    {capture.label}
                  </p>
                  <p className="text-sm text-muted-foreground">{capture.detail}</p>
                </div>
                <div className="relative h-[260px] bg-white sm:h-[320px] lg:h-[300px]">
                  <img
                    src={capture.src}
                    alt={`${capture.label} screenshot`}
                    loading="lazy"
                    decoding="async"
                    width={720}
                    height={540}
                    className="h-full w-full object-contain"
                    style={{ objectPosition: capture.position }}
                  />
                </div>
              </article>
            );
          })}
        </div>

        <div className="mt-7 text-center">
          <a
            href="/gallery"
            className="inline-flex h-10 items-center justify-center rounded-md px-4 text-sm font-medium text-primary transition hover:bg-primary/10"
          >
            View curated gallery examples
          </a>
        </div>
      </div>
    </section>
  );
}
