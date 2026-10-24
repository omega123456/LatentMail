import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PdfPreview } from '@/components/reader/previews/PdfPreview';

const { getDocument, TextLayer, textLayerCancel } = vi.hoisted(() => {
  const textLayerCancel = vi.fn();
  return {
    getDocument: vi.fn(),
    textLayerCancel,
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
>(() => ({ promise: renderOutcome(), cancel }));

function makePage(pageNumber: number) {
  return {
    pageNumber,
    getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 140 * scale }),
    render: renderPage,
    streamTextContent: () => new ReadableStream(),
  };
}

function makeDocument(numPages: number) {
  return {
    numPages,
    getPage: vi.fn((pageNumber: number) => Promise.resolve(makePage(pageNumber))),
  };
}

function loads(numPages: number) {
  getDocument.mockReset();
  getDocument.mockImplementation(() => ({ promise: Promise.resolve(makeDocument(numPages)) }));
}

vi.mock('pdfjs-dist/legacy/build/pdf.worker.mjs?url', () => ({ default: 'worker-url' }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  PixelsPerInch: { PDF_TO_CSS_UNITS: 96 / 72 },
  getDocument,
  TextLayer,
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
  const view = render(<PdfPreview bytes={new ArrayBuffer(4)} />);
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
    get: () => 400,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 300,
  });
});

afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
});

describe('PdfPreview', () => {
  it('lays every page out in one column and draws only the pages near the view', async () => {
    await openPreview(10);
    expect(screen.getAllByTestId('pdf-page')).toHaveLength(10);
    expect(screen.getByRole('button', { name: 'Zoom level 125%' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByTestId('pdf-canvas')).toHaveLength(3));
    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
  });

  it('follows the page that fills most of the view as the reader scrolls', async () => {
    await openPreview(3);
    const region = screen.getByRole('region', { name: 'Document pages' });
    region.scrollTop = 500;
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
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(2));
    expect(cancel).toHaveBeenCalled();
    expect(renderPage.mock.calls[1][0].viewport.width).toBeGreaterThan(firstWidth);
  });

  it('caps a canvas at the pdf.js pixel budget on very dense screens', async () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 100 });
    await openPreview(1);
    const canvas = (await screen.findByTestId('pdf-canvas')) as HTMLCanvasElement;
    await waitFor(() => expect(canvas.width).toBeGreaterThan(0));
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(2 ** 25);
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
    await openPreview(10);
    await waitFor(() => expect(screen.getAllByTestId('pdf-text-layer')).toHaveLength(3));
    const [layer] = screen.getAllByTestId('pdf-text-layer');
    expect(await screen.findAllByText('Hello')).toHaveLength(3);
    expect(layer.style.getPropertyValue('--scale-factor')).toBe(String(1.25 * (96 / 72)));
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(layer.style.getPropertyValue('--scale-factor')).toBe(String(1.5 * (96 / 72)));
    expect(TextLayer).toHaveBeenCalledTimes(3);
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
    select(hello.firstChild!, world.firstChild!);
    expect(world.nextSibling).toBe(endOfContent);
    select(world.firstChild!, world.firstChild!);
    expect(world.previousSibling).toBe(endOfContent);
    fireEvent.pointerUp(document);
    expect(end()).toBe(endOfContent);
    expect(endOfContent).not.toHaveAttribute('data-selecting');

    select(hello.firstChild!, hello.firstChild!);
    fireEvent.pointerDown(document);
    fireEvent.keyUp(document);
    expect(endOfContent).toHaveAttribute('data-selecting');
    fireEvent.blur(window);
    expect(endOfContent).not.toHaveAttribute('data-selecting');

    select(hello.firstChild!, hello.firstChild!);
    fireEvent.keyUp(document);
    expect(end()).toBe(endOfContent);
    expect(endOfContent).not.toHaveAttribute('data-selecting');

    select(hello.firstChild!, hello.firstChild!);
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
    getDocument.mockImplementation(() => ({ promise: Promise.reject(new Error('corrupt')) }));
    render(<PdfPreview bytes={new ArrayBuffer(4)} />);
    expect(await screen.findByText(/Preview not available for this file type/)).toBeInTheDocument();
  });

  it('reuses a loading task when Strict Mode repeats the effect after transferring the buffer', async () => {
    getDocument.mockReset();
    getDocument.mockImplementation(({ data }: { data: ArrayBuffer }) => {
      if (data.byteLength === 0) return { promise: Promise.reject(new Error('detached')) };
      structuredClone(data, { transfer: [data] });
      return { promise: Promise.resolve(makeDocument(1)) };
    });
    render(
      <StrictMode>
        <PdfPreview bytes={new ArrayBuffer(4)} />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByText('Page 1 of 1')).toBeInTheDocument());
    expect(getDocument).toHaveBeenCalledTimes(1);
  });
});
