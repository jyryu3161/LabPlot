import { ArrowRight } from 'lucide-react';

export function LandingPrimaryCta() {
  return (
    <a
      href="/register"
      className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
    >
      Get started - it&apos;s free <ArrowRight className="ml-2 h-4 w-4" />
    </a>
  );
}
