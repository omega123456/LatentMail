import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerSrc from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { useZoom } from '@/lib/attachments/useZoom';
import { PREVIEW_PADDING, type Size } from '@/lib/attachments/zoom';
import { ZoomToolbar } from './ZoomToolbar';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

const PDF_FIT_CAP = 1.25;
const RENDER_SETTLE_MS = 200;
const MAX_CANVAS_PIXELS = 2 ** 25;

type PageLayout = { tops: number[]; content: Size };

function layoutPages(sizes: Size[]): PageLayout {
  const tops: number[] = [];
  let cursor = PREVIEW_PADDING;
  for (const size of sizes) {
    tops.push(cursor);
    cursor += size.height + PREVIEW_PADDING;
  }
  const widest = Math.max(...sizes.map((size) => size.width));
  return { tops, content: { width: widest + PREVIEW_PADDING * 2, height: cursor } };
}

function pageVisibility(
  sizes: Size[],
  layout: PageLayout,
  zoom: number,
  scrollTop: number,
  viewportHeight: number,
) {
  const offset = Math.max(0, (viewportHeight - layout.content.height * zoom) / 2);
  const top = (scrollTop - offset) / zoom;
  const height = viewportHeight / zoom;
  let current = 0;
  let mostVisible = -Infinity;
  const near = sizes.map((size, index) => {
    const start = layout.tops[index];
    const end = start + size.height;
    const visible = Math.min(end, top + height) - Math.max(start, top);
    if (visible > mostVisible) {
      mostVisible = visible;
      current = index;
    }
    return end > top - height && start < top + height * 2;
  });
  return { current, near };
}

function renderScale(page: PDFPageProxy, zoom: number): number {
  const desired = zoom * pdfjsLib.PixelsPerInch.PDF_TO_CSS_UNITS * window.devicePixelRatio;
  const unit = page.getViewport({ scale: 1 });
  const pixelsPerUnitScale = unit.width * unit.height;
  return Math.min(desired, Math.sqrt(MAX_CANVAS_PIXELS / pixelsPerUnitScale));
}

function PdfCanvas({
  page,
  zoom,
  onError,
}: {
  page: PDFPageProxy;
  zoom: number;
  onError: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const viewport = page.getViewport({ scale: renderScale(page, zoom) });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    let cancelled = false;
    const task = page.render({ canvasContext: context, viewport });
    task.promise.catch(() => {
      if (!cancelled) onError();
    });
    return () => {
      cancelled = true;
      task.cancel();
    };
  }, [page, zoom, onError]);

  useEffect(() => {
    const canvas = canvasRef.current;
    return () => {
      if (!canvas) return;
      canvas.width = 0;
      canvas.height = 0;
    };
  }, []);

  return <canvas ref={canvasRef} className="absolute inset-0 size-full" data-testid="pdf-canvas" />;
}

export function PdfPreview({ bytes }: { bytes: ArrayBuffer }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef<{
    bytes: ArrayBuffer;
    task: ReturnType<typeof pdfjsLib.getDocument>;
  } | null>(null);
  const [pdf, setPdf] = useState<{ pages: PDFPageProxy[]; sizes: Size[] } | null>(null);
  const [error, setError] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [renderZoom, setRenderZoom] = useState<number | null>(null);
  const showError = useCallback(() => setError(true), []);

  useEffect(() => {
    let cancelled = false;
    if (loadingRef.current?.bytes !== bytes) {
      loadingRef.current = {
        bytes,
        task: pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }),
      };
    }
    loadingRef.current.task.promise
      .then((doc) =>
        Promise.all(Array.from({ length: doc.numPages }, (_, index) => doc.getPage(index + 1))),
      )
      .then((pages) => {
        if (cancelled) return;
        const sizes = pages.map((page) => {
          const { width, height } = page.getViewport({
            scale: pdfjsLib.PixelsPerInch.PDF_TO_CSS_UNITS,
          });
          return { width, height };
        });
        setPdf({ pages, sizes });
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  const layout = useMemo(() => (pdf ? layoutPages(pdf.sizes) : null), [pdf]);
  const { zoom, mode, viewport, ready, zoomIn, zoomOut, selectPreset } = useZoom({
    scrollRef,
    content: layout?.content ?? null,
    defaultMode: 'fit-width',
    fitCap: PDF_FIT_CAP,
  });

  useEffect(() => {
    if (!ready || renderZoom === zoom) return;
    const timer = setTimeout(() => setRenderZoom(zoom), renderZoom === null ? 0 : RENDER_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [ready, zoom, renderZoom]);

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

  const visibility =
    pdf && layout && viewport
      ? pageVisibility(pdf.sizes, layout, zoom, scrollTop, viewport.height)
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        role="region"
        aria-label="Document pages"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        className="min-h-0 flex-1 overflow-auto bg-surface-container-high dark:bg-dark-surface-container"
      >
        {pdf && layout && (
          <div className="grid min-h-full w-max min-w-full place-items-center">
            <div
              className="flex flex-col items-center"
              style={{
                width: layout.content.width * zoom,
                height: layout.content.height * zoom,
                padding: PREVIEW_PADDING * zoom,
                gap: PREVIEW_PADDING * zoom,
              }}
            >
              {pdf.pages.map((page, index) => (
                <div
                  key={page.pageNumber}
                  data-testid="pdf-page"
                  className="relative shrink-0 bg-white shadow-page dark:shadow-dark-page"
                  style={{
                    width: pdf.sizes[index].width * zoom,
                    height: pdf.sizes[index].height * zoom,
                  }}
                >
                  {renderZoom !== null && visibility?.near[index] && (
                    <PdfCanvas page={page} zoom={renderZoom} onError={showError} />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {pdf && (
        <ZoomToolbar
          zoom={zoom}
          mode={mode}
          leading={`Page ${(visibility?.current ?? 0) + 1} of ${pdf.pages.length}`}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onSelectPreset={selectPreset}
        />
      )}
    </div>
  );
}
