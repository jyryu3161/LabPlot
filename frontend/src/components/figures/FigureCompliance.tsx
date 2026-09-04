'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, FileCheck2, Download } from 'lucide-react';
import { getFigureCompliance, downloadSubmissionBundle } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ComplianceChecklist } from './ComplianceChecklist';

/**
 * Journal-compliance checklist for a figure version (M-C1 §10), plus a
 * "Submission bundle" download (figure export + checklist, sized to a
 * single- or double-column journal width). Mounted on the figure page next
 * to FigureCodeExport.
 */
export function FigureCompliance({ figureId, versionId }: { figureId: string; versionId: string | null }) {
  const [downloadingColumn, setDownloadingColumn] = useState<'single' | 'double' | null>(null);

  const { data: report, isLoading, isError } = useQuery({
    queryKey: ['figure-compliance', figureId, versionId],
    queryFn: () => getFigureCompliance(figureId, versionId!),
    enabled: Boolean(versionId),
  });

  async function handleBundle(column: 'single' | 'double') {
    if (!versionId || downloadingColumn) return;
    setDownloadingColumn(column);
    try {
      await downloadSubmissionBundle(figureId, versionId, column);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Submission bundle failed');
    } finally {
      setDownloadingColumn(null);
    }
  }

  return (
    <Card role="region" aria-label="Journal compliance">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><FileCheck2 className="h-4 w-4" /> Journal compliance</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!versionId ? (
          <p className="text-sm text-muted-foreground">No rendered version to check yet.</p>
        ) : isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Checking…</div>
        ) : isError || !report ? (
          <p className="text-sm text-muted-foreground">Compliance check unavailable for this version.</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {report.journal ? `Style preset: ${report.style_preset} · Journal: ${report.journal}` : `Style preset: ${report.style_preset}`}
              {' · '}{report.width_in.toFixed(2)}×{report.height_in.toFixed(2)} in @ {report.dpi} dpi
            </p>
            <ComplianceChecklist passed={report.passed} checks={report.checks} />
          </>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <span className="text-xs text-muted-foreground">Submission bundle:</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!versionId || downloadingColumn !== null}
            onClick={() => handleBundle('single')}
            aria-label="Download submission bundle, single column"
          >
            {downloadingColumn === 'single' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Single column
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!versionId || downloadingColumn !== null}
            onClick={() => handleBundle('double')}
            aria-label="Download submission bundle, double column"
          >
            {downloadingColumn === 'double' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Double column
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
