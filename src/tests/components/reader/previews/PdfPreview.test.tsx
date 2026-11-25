import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MAX_CANVAS_PIXELS, PdfPreview } from '@/components/reader/previews/PdfPreview';

const PAGE_WIDTH_POINTS = 100;
const PAGE_HEIGHT_POINTS = 140;
const PDF_BYTE_LENGTH = 4;
const REPLACEMENT_PDF_BYTE_LENGTH = 8;
const VIEWPORT_WIDTH = 400;
const VIEWPORT_HEIGHT = 300;
const LONG_DOCUMENT_PAGES = 10;
const SHORT_DOCUMENT_PAGES = 3;
const TWO_PAGE_DOCUMENT = 2;
const PAGES_NEAR_VIEW = 3;
const SCROLL_TO_LAST_PAGE = 500;
const RENDERS_AFTER_ZOOM = 2;
const DOCUMENTS_LOADED_AFTER_SWITCH = 2;
const DENSE_SCREEN_PIXEL_RATIO = 100;
const FITTED_ZOOM = 1.25;
const ZOOMED_IN = 1.5;

function textNodeOf(element: HTMLElement): Node {
  const node = element.firstChild;
  if (!node) throw new Error('expected a text node');
  return node;
}

const { PDF_TO_CSS_UNITS } = vi.hoisted(() => {
  const CSS_PIXELS_PER_INCH = 96;
  const PDF_POINTS_PER_INCH = 72;
  return { PDF_TO_CSS_UNITS: CSS_PIXELS_PER_INCH / PDF_POINTS_PER_INCH };
});

const { getDocument, destroyDocument, TextLayer, textLayerCancel } = vi.hoisted(() => {
  const textLayerCancel = vi.fn();
  return {
    getDocument: vi.fn(),
    destroyDocument: vi.fn(() => Promise.resolve()),
    textLayerCancel: textLayerCancel,
    TextLayer: vi.fn(function (this: object, { container }: { container: HTMLElement }) {
      return {
        render: () => {
          container.append(
            Object.assign(document.createElement('span'), { textContent: 'Hello' }),
            Object.assign(document.createElement('span'), { textContent: 'World' }),
          );
          return Promise.resolve();
        },
        cancel: textLayerCancel,
      };
    }),
  };
});
const cancel = vi.fn();
let renderOutcome: () => Promise<void> = () => Promise.resolve();
const renderPage = vi.fn<
  (params: { viewport: { width: number; height: number } }) => {
    promise: Promise<void>;
    cancel: () => void;
  }
>(() => ({ promise: renderOutcome(), cancel: cancel }));

function makePage(pageNumber: number) {
  return {
    pageNumber: pageNumber,
    getViewport: ({ scale }: { scale: number }) => ({
      width: PAGE_WIDTH_POINTS * scale,
      height: PAGE_HEIGHT_POINTS * scale,
    }),
    render: renderPage,
    streamTextContent: () => new ReadableStream(),
  };
}

function makeDocument(numPages: number) {
  return {
    numPages: numPages,
    getPage: vi.fn((pageNumber: number) => Promise.resolve(makePage(pageNumber))),
  };
}

function loads(numPages: number) {
  getDocument.mockReset();
  destroyDocument.mockClear();
  getDocument.mockImplementation(() => ({
    promise: Promise.resolve(makeDocument(numPages)),
    destroy: destroyDocument,
  }));
}

vi.mock('pdfjs-dist/legacy/build/pdf.worker.mjs?url', () => ({ default: 'worker-url' }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  PixelsPerInch: { PDF_TO_CSS_UNITS: PDF_TO_CSS_UNITS },
  getDocument: getDocument,
  TextLayer: TextLayer,
}));

HTMLCanvasElement.prototype.getContext = vi.fn(
  () => ({}) as unknown as CanvasRenderingContext2D,
) as unknown as typeof HTMLCanvasElement.prototype.getContext;

function measure() {
  act(() =>
    (window.__resizeObserverInstances__ ?? []).forEach((instance) =>
      instance.callback([], {} as ResizeObserver),
    ),
  );
}

async function openPreview(numPages: number) {
  loads(numPages);
  const view = render(<PdfPreview bytes={new ArrayBuffer(PDF_BYTE_LENGTH)} />);
  await screen.findByText(`Page 1 of ${numPages}`);
  measure();
  return view;
}

beforeEach(() => {
  renderOutcome = () => Promise.resolve();
  renderPage.mockClear();
  cancel.mockClear();
  TextLayer.mockClear();
  textLayerCancel.mockClear();
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => VIEWPORT_WIDTH,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => VIEWPORT_HEIGHT,
  });
});

afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
});

it('lays every page out in one column and draws only the pages near the view', async () => {
  await openPreview(LONG_DOCUMENT_PAGES);
  expect(screen.getAllByTestId('pdf-page')).toHaveLength(LONG_DOCUMENT_PAGES);
  expect(screen.getByRole('button', { name: 'Zoom level 125%' })).toBeInTheDocument();
  await waitFor(() => expect(screen.getAllByTestId('pdf-canvas')).toHaveLength(PAGES_NEAR_VIEW));
  expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
});

it('follows the page that fills most of the view as the reader scrolls', async () => {
  await openPreview(SHORT_DOCUMENT_PAGES);
  const region = screen.getByRole('region', { name: 'Document pages' });
  region.scrollTop = SCROLL_TO_LAST_PAGE;
  fireEvent.scroll(region);
  expect(screen.getByText('Page 3 of 3')).toBeInTheDocument();
});

it('re-renders sharper once a zoom change settles', async () => {
  const user = userEvent.setup();
  await openPreview(1);
  await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1));
  const firstWidth = renderPage.mock.calls[0][0].viewport.width;
  await user.click(screen.getByRole('button', { name: 'Zoom in' }));
  expect(screen.getByRole('button', { name: 'Zoom level 150%' })).toBeInTheDocument();
  await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(RENDERS_AFTER_ZOOM));
  expect(cancel).toHaveBeenCalled();
  expect(renderPage.mock.calls[1][0].viewport.width).toBeGreaterThan(firstWidth);
});

it('caps a canvas at the pdf.js pixel budget on very dense screens', async () => {
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    value: DENSE_SCREEN_PIXEL_RATIO,
  });
  await openPreview(1);
  const canvas = (await screen.findByTestId('pdf-canvas')) as HTMLCanvasElement;
  await waitFor(() => expect(canvas.width).toBeGreaterThan(0));
  expect(canvas.width * canvas.height).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
});

it('cancels drawing and releases the canvas when the preview closes', async () => {
  const { unmount } = await openPreview(1);
  const canvas = (await screen.findByTestId('pdf-canvas')) as HTMLCanvasElement;
  await waitFor(() => expect(canvas.width).toBeGreaterThan(0));
  unmount();
  expect(cancel).toHaveBeenCalled();
  expect(canvas.width).toBe(0);
  expect(canvas.height).toBe(0);
});

it('lays selectable text over the pages near the view and scales it with zoom', async () => {
  const user = userEvent.setup();
  await openPreview(LONG_DOCUMENT_PAGES);
  await waitFor(() =>
    expect(screen.getAllByTestId('pdf-text-layer')).toHaveLength(PAGES_NEAR_VIEW),
  );
  const [layer] = screen.getAllByTestId('pdf-text-layer');
  expect(await screen.findAllByText('Hello')).toHaveLength(PAGES_NEAR_VIEW);
  expect(layer.style.getPropertyValue('--scale-factor')).toBe(
    String(FITTED_ZOOM * PDF_TO_CSS_UNITS),
  );
  await user.click(screen.getByRole('button', { name: 'Zoom in' }));
  expect(layer.style.getPropertyValue('--scale-factor')).toBe(String(ZOOMED_IN * PDF_TO_CSS_UNITS));
  expect(TextLayer).toHaveBeenCalledTimes(PAGES_NEAR_VIEW);
});

it('cancels and clears the text layer when the preview closes', async () => {
  const { unmount } = await openPreview(1);
  const layer = await screen.findByTestId('pdf-text-layer');
  await screen.findByText('Hello');
  unmount();
  expect(textLayerCancel).toHaveBeenCalled();
  expect(layer).toBeEmptyDOMElement();
});

it('keeps the selection anchored while dragging across the gaps between words', async () => {
  await openPreview(1);
  const layer = await screen.findByTestId('pdf-text-layer');
  const hello = await screen.findByText('Hello');
  const world = screen.getByText('World');
  const end = () => layer.lastElementChild as HTMLElement;
  await waitFor(() => expect(end().tagName).toBe('DIV'));
  const endOfContent = end();
  const select = (from: Node, to: Node) =>
    act(() => {
      document.getSelection()?.setBaseAndExtent(from, 0, to, 1);
      document.dispatchEvent(new Event('selectionchange'));
    });

  fireEvent.mouseDown(layer);
  expect(endOfContent).toHaveAttribute('data-selecting');
  select(textNodeOf(hello), textNodeOf(world));
  expect(world.nextSibling).toBe(endOfContent);
  select(textNodeOf(world), textNodeOf(world));
  expect(world.previousSibling).toBe(endOfContent);
  fireEvent.pointerUp(document);
  expect(end()).toBe(endOfContent);
  expect(endOfContent).not.toHaveAttribute('data-selecting');

  select(textNodeOf(hello), textNodeOf(hello));
  fireEvent.pointerDown(document);
  fireEvent.keyUp(document);
  expect(endOfContent).toHaveAttribute('data-selecting');
  fireEvent.blur(window);
  expect(endOfContent).not.toHaveAttribute('data-selecting');

  select(textNodeOf(hello), textNodeOf(hello));
  fireEvent.keyUp(document);
  expect(end()).toBe(endOfContent);
  expect(endOfContent).not.toHaveAttribute('data-selecting');

  select(textNodeOf(hello), textNodeOf(hello));
  act(() => {
    document.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
  });
  expect(endOfContent).not.toHaveAttribute('data-selecting');
});

it('shows the fallback hint when a page fails to draw', async () => {
  renderOutcome = () => Promise.reject(new Error('broken page'));
  await openPreview(1);
  expect(await screen.findByText(/Preview not available for this file type/)).toBeInTheDocument();
});

it('shows the fallback hint when the document fails to load', async () => {
  getDocument.mockReset();
  getDocument.mockImplementation(() => ({
    promise: Promise.reject(new Error('corrupt')),
    destroy: destroyDocument,
  }));
  render(<PdfPreview bytes={new ArrayBuffer(PDF_BYTE_LENGTH)} />);
  expect(await screen.findByText(/Preview not available for this file type/)).toBeInTheDocument();
});

it('reuses a loading task when Strict Mode repeats the effect after transferring the buffer', async () => {
  getDocument.mockReset();
  getDocument.mockImplementation(({ data }: { data: ArrayBuffer }) => {
    if (data.byteLength === 0)
      return { promise: Promise.reject(new Error('detached')), destroy: destroyDocument };
    structuredClone(data, { transfer: [data] });
    return { promise: Promise.resolve(makeDocument(1)), destroy: destroyDocument };
  });
  destroyDocument.mockClear();
  render(
    <StrictMode>
      <PdfPreview bytes={new ArrayBuffer(PDF_BYTE_LENGTH)} />
    </StrictMode>,
  );
  await waitFor(() => expect(screen.getByText('Page 1 of 1')).toBeInTheDocument());
  expect(getDocument).toHaveBeenCalledTimes(1);
  expect(destroyDocument).not.toHaveBeenCalled();
});

it('destroys the pdf.js document when the preview closes', async () => {
  const view = await openPreview(TWO_PAGE_DOCUMENT);
  expect(destroyDocument).not.toHaveBeenCalled();
  view.unmount();
  await waitFor(() => expect(destroyDocument).toHaveBeenCalledTimes(1));
});

it('destroys the previous document when the preview switches to new bytes', async () => {
  loads(1);
  const view = render(<PdfPreview bytes={new ArrayBuffer(PDF_BYTE_LENGTH)} />);
  await screen.findByText('Page 1 of 1');
  view.rerender(<PdfPreview bytes={new ArrayBuffer(REPLACEMENT_PDF_BYTE_LENGTH)} />);
  await waitFor(() => expect(destroyDocument).toHaveBeenCalledTimes(1));
  expect(getDocument).toHaveBeenCalledTimes(DOCUMENTS_LOADED_AFTER_SWITCH);
});
