import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerSrc from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

export function PdfPreview({ bytes }: { bytes: ArrayBuffer }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const loadingTask = pdfjsLib.getDocument({ data: bytes.slice(0), isEvalSupported: false });
    loadingTask.promise
      .then((doc) => {
        if (cancelled) return;
        documentRef.current = doc;
        setPageCount(doc.numPages);
        setPage(1);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
      documentRef.current = null;
    };
  }, [bytes]);

  useEffect(() => {
    if (pageCount === 0) return;
    let cancelled = false;
    const doc = documentRef.current;
    if (!doc) return;
    doc
      .getPage(page)
      .then((pdfPage) => {
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const viewport = pdfPage.getViewport({ scale: 2 });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const context = canvas.getContext('2d');
        if (!context) return;
        void pdfPage.render({ canvasContext: context, viewport }).promise;
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [page, pageCount]);

  if (error)
    return (
      <div className="grid h-full place-items-center p-4 text-center text-body-sm text-on-surface-variant dark:text-dark-on-surface-variant">
        <p>
          Preview not available for this file type.
          <br />
          Use Download to save the file.
        </p>
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="flex min-h-full items-center justify-center p-stack-gap-md">
          <canvas
            ref={canvasRef}
            className="max-w-pdf-page-max shadow-segment"
            data-testid="pdf-canvas"
          />
        </div>
      </div>
      {pageCount > 0 && (
        <div className="flex items-center justify-center gap-stack-gap-sm border-t border-outline-variant py-2 text-body-sm text-on-surface-variant dark:border-dark-outline-variant dark:text-dark-on-surface-variant">
          <button
            type="button"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            className="rounded-chip p-1 hover:bg-surface-container disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-primary dark:hover:bg-dark-surface-container"
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <span className="tabular-nums">
            Page {page} of {pageCount}
          </span>
          <button
            type="button"
            aria-label="Next page"
            disabled={page >= pageCount}
            onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
            className="rounded-chip p-1 hover:bg-surface-container disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-primary dark:hover:bg-dark-surface-container"
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
