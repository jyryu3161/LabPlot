'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { getFigureCode } from '@/lib/api';
import type { FigureCodeResponse } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Copy, Download, FileCode, Loader2 } from 'lucide-react';

type CodeLang = 'python' | 'latex';
const LANG_LABELS: Record<CodeLang, string> = { python: 'Python code', latex: 'LaTeX snippet' };

/**
 * "Python code" / "LaTeX snippet" export buttons for a figure version.
 * Fetches the generated code on click and shows it in a dialog with
 * copy-to-clipboard and file download actions.
 */
export function FigureCodeExport({ figureId, versionId }: { figureId: string; versionId: string | null }) {
  const [loadingLang, setLoadingLang] = useState<CodeLang | null>(null);
  const [result, setResult] = useState<FigureCodeResponse | null>(null);
  const [open, setOpen] = useState(false);

  async function fetchCode(lang: CodeLang) {
    if (!versionId || loadingLang) return;
    setLoadingLang(lang);
    try {
      const res = await getFigureCode(figureId, versionId, lang);
      setResult(res);
      setOpen(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Code export failed');
    } finally {
      setLoadingLang(null);
    }
  }

  async function copyCode() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.code);
      toast.success(`${LANG_LABELS[result.language]} copied to clipboard`);
    } catch {
      toast.error('Copy failed');
    }
  }

  function downloadCode() {
    if (!result) return;
    const blob = new Blob([result.code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = result.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      {(Object.keys(LANG_LABELS) as CodeLang[]).map((lang) => (
        <Button
          key={lang}
          type="button"
          variant="outline"
          size="sm"
          disabled={!versionId || loadingLang !== null}
          onClick={() => fetchCode(lang)}
          aria-label={`Show ${LANG_LABELS[lang]}`}
        >
          {loadingLang === lang ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <FileCode className="mr-1 h-4 w-4" />}
          {LANG_LABELS[lang]}
        </Button>
      ))}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] w-[95vw] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{result ? LANG_LABELS[result.language] : 'Code export'}</DialogTitle>
            <DialogDescription className="font-mono text-xs">{result?.filename}</DialogDescription>
          </DialogHeader>
          <pre className="max-h-[55vh] overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs">{result?.code ?? ''}</pre>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={copyCode} aria-label="Copy code to clipboard">
              <Copy className="mr-1 h-4 w-4" /> Copy
            </Button>
            <Button type="button" size="sm" onClick={downloadCode} aria-label="Download code file">
              <Download className="mr-1 h-4 w-4" /> Download
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
