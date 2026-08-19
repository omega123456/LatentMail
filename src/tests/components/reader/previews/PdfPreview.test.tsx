import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PdfPreview } from '@/components/reader/previews/PdfPreview';

const renderPage = vi.fn(() => ({ promise: Promise.resolve() }));

function makePage() {
  return {
    getViewport: () => ({ width: 100, height: 140 }),
    render: renderPage,
  };
}

function makeDocument(numPages: number) {
  return {
    numPages,
    getPage: vi.fn(() => Promise.resolve(makePage())),
  };
}

let mockDocument: ReturnType<typeof makeDocument> | null = null;
let shouldFail = false;

vi.mock('pdfjs-dist/legacy/build/pdf.worker.mjs?url', () => ({ default: 'worker-url' }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: shouldFail ? Promise.reject(new Error('corrupt')) : Promise.resolve(mockDocument),
  }),
}));

HTMLCanvasElement.prototype.getContext = vi.fn(
  () => ({}) as unknown as CanvasRenderingContext2D,
) as unknown as typeof HTMLCanvasElement.prototype.getContext;

describe('PdfPreview', () => {
  it('renders the first page and disables Previous at the start', async () => {
    shouldFail = false;
    mockDocument = makeDocument(3);
    render(<PdfPreview bytes={new ArrayBuffer(4)} />);
    await waitFor(() => expect(screen.getByText('Page 1 of 3')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next page' })).not.toBeDisabled();
  });

  it('pages forward and back, disabling controls at each end', async () => {
    shouldFail = false;
    mockDocument = makeDocument(2);
    const user = userEvent.setup();
    render(<PdfPreview bytes={new ArrayBuffer(4)} />);
    await waitFor(() => expect(screen.getByText('Page 1 of 2')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(screen.getByText('Page 2 of 2')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    await waitFor(() => expect(screen.getByText('Page 1 of 2')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  });

  it('shows the fallback hint when the document fails to load', async () => {
    shouldFail = true;
    mockDocument = null;
    render(<PdfPreview bytes={new ArrayBuffer(4)} />);
    expect(await screen.findByText(/Preview not available for this file type/)).toBeInTheDocument();
  });
});
