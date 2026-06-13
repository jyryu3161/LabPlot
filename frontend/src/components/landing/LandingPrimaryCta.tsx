'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { useAuthContext } from '@/components/auth/AuthProvider';
import { Button } from '@/components/ui/button';

export function LandingPrimaryCta() {
  const { isAuthenticated } = useAuthContext();

  return isAuthenticated ? (
    <Link href="/projects">
      <Button size="lg" className="h-11 px-6">
        Open the app <ArrowRight className="ml-2 h-4 w-4" />
      </Button>
    </Link>
  ) : (
    <Link href="/register">
      <Button size="lg" className="h-11 px-6">
        Get started - it&apos;s free <ArrowRight className="ml-2 h-4 w-4" />
      </Button>
    </Link>
  );
}
