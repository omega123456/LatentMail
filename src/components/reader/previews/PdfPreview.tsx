import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerSrc from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { useZoom } from '@/lib/attachments/useZoom';
import { centringOffset, paddedLength, PREVIEW_PADDING, type Size } from '@/lib/attachments/zoom';
import { followSelection } from './pdf-selection';
import { ZoomToolbar } from './ZoomToolbar';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

const PDF_FIT_CAP = 1.25;
const RENDER_SETTLE_MS = 200;
export const MAX_CANVAS_PIXELS = 33_554_432;
const PRELOAD_VIEWPORTS_AHEAD = 2;

type PageLayout = { tops: number[]; content: Size };
type LoadedPdf = { pages: PDFPageProxy[]; sizes: Size[] };
type DocumentState = { bytes: ArrayBuffer; pdf: LoadedPdf | null; failed: boolean };

type DocumentLoad = {
  bytes: ArrayBuffer;
  task: ReturnType<typeof pdfjsLib.getDocument>;
  released: boolean;
};

function startDocumentLoad(bytes: ArrayBuffer): DocumentLoad {
  return {
    bytes: bytes,
    task: pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }),
    released: false,
  };
}

function claimDocumentLoad(current: DocumentLoad | null, bytes: ArrayBuffer): DocumentLoad {
  if (current?.bytes !== bytes) return startDocumentLoad(bytes);
  current.released = false;
  return current;
}

function releaseDocumentLoad(load: DocumentLoad) {
  load.released = true;
  queueMicrotask(() => {
    if (load.released) void load.task.destroy();
  });
}

function layoutPages(sizes: Size[]): PageLayout {
  const tops: number[] = [];
  let cursor = PREVIEW_PADDING;
  for (const size of sizes) {
    tops.push(cursor);
    cursor += size.height + PREVIEW_PADDING;
  }
  const widest = Math.max(...sizes.map((size) => size.width));
  return { tops: tops, content: { width: paddedLength(widest), height: cursor } };
}

function pageVisibility({
  sizes,
  layout,
  zoom,
  scrollTop,
  viewportHeight,
}: {
  sizes: Size[];
  layout: PageLayout;
  zoom: number;
  scrollTop: number;
  viewportHeight: number;
}) {
  const offset = centringOffset(viewportHeight, layout.content.height * zoom);
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
    return end > top - height && start < top + height * PRELOAD_VIEWPORTS_AHEAD;
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
    const task = page.render({ canvasContext: context, viewport: viewport });
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

function PdfTextLayer({ page, zoom }: { page: PDFPageProxy; zoom: number }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const layer = new pdfjsLib.TextLayer({
      textContentSource: page.streamTextContent(),
      container: container,
      viewport: page.getViewport({ scale: pdfjsLib.PixelsPerInch.PDF_TO_CSS_UNITS }),
    });
    let active = true;
    let stopFollowing = () => {};
    layer
      .render()
      .then(() => {
        if (active) stopFollowing = followSelection(container);
      })
      .catch(() => {});
    return () => {
      active = false;
      layer.cancel();
      stopFollowing();
      container.replaceChildren();
    };
  }, [page]);

  return (
    <div
      ref={containerRef}
      data-testid="pdf-text-layer"
      className="absolute inset-0 z-0 origin-top-left overflow-clip leading-none select-text forced-color-adjust-none selection:bg-primary/25 **:absolute **:origin-top-left **:cursor-text **:whitespace-pre **:text-transparent"
      style={{ '--scale-factor': zoom * pdfjsLib.PixelsPerInch.PDF_TO_CSS_UNITS } as CSSProperties}
    />
  );
}

function computePageVisibility({
  pdf,
  layout,
  viewport,
  zoom,
  scrollTop,
}: {
  pdf: LoadedPdf | null;
  layout: PageLayout | null;
  viewport: Size | null;
  zoom: number;
  scrollTop: number;
}) {
  if (!pdf || !layout || !viewport) return null;
  return pageVisibility({
    sizes: pdf.sizes,
    layout: layout,
    zoom: zoom,
    scrollTop: scrollTop,
    viewportHeight: viewport.height,
  });
}

function PdfPageStack({
  pdf,
  layout,
  zoom,
  renderZoom,
  near,
  onError,
}: {
  pdf: LoadedPdf;
  layout: PageLayout;
  zoom: number;
  renderZoom: number | null;
  near: boolean[] | undefined;
  onError: () => void;
}) {
  return (
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
        {pdf.pages.map((page, index) => {
          const shouldRender = renderZoom !== null && Boolean(near?.[index]);
          return (
            <div
              key={page.pageNumber}
              data-testid="pdf-page"
              className="relative shrink-0 bg-white shadow-page dark:shadow-dark-page"
              style={{
                width: pdf.sizes[index].width * zoom,
                height: pdf.sizes[index].height * zoom,
              }}
            >
              {shouldRender && <PdfCanvas page={page} zoom={renderZoom} onError={onError} />}
              {shouldRender && <PdfTextLayer page={page} zoom={zoom} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function usePdfDocument(bytes: ArrayBuffer) {
  const loadingRef = useRef<DocumentLoad | null>(null);
  const [loadedDocument, setLoadedDocument] = useState<DocumentState>({
    bytes: bytes,
    pdf: null,
    failed: false,
  });
  const showError = useCallback(
    () => setLoadedDocument((current) => ({ ...current, failed: true })),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const load = claimDocumentLoad(loadingRef.current, bytes);
    loadingRef.current = load;
    load.task.promise
      .then((doc) =>
        Promise.all(Array.from({ length: doc.numPages }, (_page, index) => doc.getPage(index + 1))),
      )
      .then((pages) => {
        if (cancelled) return;
        const sizes = pages.map((page) => {
          const { width, height } = page.getViewport({
            scale: pdfjsLib.PixelsPerInch.PDF_TO_CSS_UNITS,
          });
          return { width, height };
        });
        setLoadedDocument({ bytes: bytes, pdf: { pages, sizes }, failed: false });
      })
      .catch(() => {
        if (!cancelled) setLoadedDocument({ bytes: bytes, pdf: null, failed: true });
      });
    return () => {
      cancelled = true;
      releaseDocumentLoad(load);
    };
  }, [bytes]);

  const isCurrentDocument = loadedDocument.bytes === bytes;
  return {
    pdf: isCurrentDocument ? loadedDocument.pdf : null,
    error: isCurrentDocument && loadedDocument.failed,
    showError: showError,
  };
}

function useSettledZoom(ready: boolean, zoom: number) {
  const [renderZoom, setRenderZoom] = useState<number | null>(null);
  useEffect(() => {
    if (!ready || renderZoom === zoom) return;
    const timer = setTimeout(() => setRenderZoom(zoom), renderZoom === null ? 0 : RENDER_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [ready, zoom, renderZoom]);
  return renderZoom;
}

function PdfErrorMessage() {
  return (
    <div className="grid h-full place-items-center p-4 text-center text-body-sm text-on-surface-variant dark:text-dark-on-surface-variant">
      <p>
        Preview not available for this file type.
        <br />
        Use Download to save the file.
      </p>
    </div>
  );
}

export function PdfPreview({ bytes }: { bytes: ArrayBuffer }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { pdf, error, showError } = usePdfDocument(bytes);
  const [scrollTop, setScrollTop] = useState(0);
  const layout = useMemo(() => (pdf ? layoutPages(pdf.sizes) : null), [pdf]);
  const { zoom, mode, viewport, ready, zoomIn, zoomOut, selectPreset } = useZoom({
    scrollRef: scrollRef,
    content: layout ? layout.content : null,
    defaultMode: 'fit-width',
    fitCap: PDF_FIT_CAP,
  });
  const renderZoom = useSettledZoom(ready, zoom);

  if (error) return <PdfErrorMessage />;

  const visibility = computePageVisibility({ pdf, layout, viewport, zoom, scrollTop });
  const currentPage = (visibility?.current ?? 0) + 1;

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
          <PdfPageStack
            pdf={pdf}
            layout={layout}
            zoom={zoom}
            renderZoom={renderZoom}
            near={visibility?.near}
            onError={showError}
          />
        )}
      </div>
      {pdf && (
        <ZoomToolbar
          zoom={zoom}
          mode={mode}
          leading={`Page ${currentPage} of ${pdf.pages.length}`}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onSelectPreset={selectPreset}
        />
      )}
    </div>
  );
}
