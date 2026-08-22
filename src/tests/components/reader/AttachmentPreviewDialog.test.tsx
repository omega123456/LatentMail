import type React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { AttachmentPreviewDialog } from '@/components/reader/AttachmentPreviewDialog';
import { hasFocusContext } from '@/lib/keyboard/useCommands';
import { ipc } from '@/tests/ipc-mock';
import { useToastStore } from '@/stores/toast';
import type { MessageAttachment } from '@/lib/types/ipc';

vi.mock('pdfjs-dist/legacy/build/pdf.worker.mjs?url', () => ({ default: 'worker-url' }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({ promise: new Promise(() => undefined) }),
}));
vi.mock('mammoth', () => ({
  convertToHtml: () => Promise.resolve({ value: '<p>Converted document</p>', messages: [] }),
}));

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    queryClient,
    ...render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>),
  };
}

const imageAttachment: MessageAttachment = {
  id: 'attachment-3',
  filename: 'scan-0142.jpg',
  mimeType: 'image/jpeg',
  size: 2202009,
  position: 2,
};

const unsupportedAttachment: MessageAttachment = {
  id: 'attachment-4',
  filename: 'archive.zip',
  mimeType: 'application/zip',
  size: 10240,
  position: 3,
};

const csvAttachment: MessageAttachment = {
  id: 'attachment-5',
  filename: 'export.csv',
  mimeType: 'text/csv',
  size: 512,
  position: 4,
};

const textAttachment: MessageAttachment = {
  id: 'attachment-6',
  filename: 'notes.json',
  mimeType: 'application/json',
  size: 128,
  position: 5,
};

const docxAttachment: MessageAttachment = {
  id: 'attachment-7',
  filename: 'agreement.docx',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  size: 4096,
  position: 6,
};

const pdfAttachment: MessageAttachment = {
  id: 'attachment-8',
  filename: 'report.pdf',
  mimeType: 'application/pdf',
  size: 4096,
  position: 7,
};

beforeAppRoot();
function beforeAppRoot() {
  if (!document.getElementById('root')) {
    const root = document.createElement('div');
    root.id = 'root';
    root.className = 'relative';
    document.body.appendChild(root);
  }
}

describe('AttachmentPreviewDialog', () => {
  it('renders the image preview once the cache resolves', async () => {
    ipc.override('ensure_attachment_cached', {
      cachePath: '/cache/scan.jpg',
      displayPath: '/cache/scan.jpg',
      mimeType: 'image/jpeg',
      filename: 'scan-0142.jpg',
      size: 2202009,
    });
    renderWithClient(
      <AttachmentPreviewDialog
        accountId="account-1"
        messageId="message-1"
        attachment={imageAttachment}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(screen.getByAltText('scan-0142.jpg')).toBeInTheDocument());
  });

  it('renders the acquisition-error fallback when the preview bytes fail to load', async () => {
    ipc.override('ensure_attachment_cached', () => Promise.reject(new Error('boom')));
    renderWithClient(
      <AttachmentPreviewDialog
        accountId="account-1"
        messageId="message-1"
        attachment={imageAttachment}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText(/Couldn't load preview/)).toBeInTheDocument();
  });

  it('renders the unsupported fallback with a working Download for an unrecognised type', async () => {
    ipc.override('plugin:dialog|save', '/Users/alex/Downloads/archive.zip');
    renderWithClient(
      <AttachmentPreviewDialog
        accountId="account-1"
        messageId="message-1"
        attachment={unsupportedAttachment}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText(/Preview not available for this file type/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.severity === 'success')).toBe(true),
    );
  });

  it('parses a CSV attachment into a table with an emphasised header row', async () => {
    ipc.override(
      'read_attachment_text',
      'Region,Note\nNorth,"Doe, Jane"\nSouth,"Line one\nLine two"\n',
    );
    renderWithClient(
      <AttachmentPreviewDialog
        accountId="account-1"
        messageId="message-1"
        attachment={csvAttachment}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByRole('columnheader', { name: 'Region' })).toBeInTheDocument();
    expect(screen.getByText('Doe, Jane')).toBeInTheDocument();
    expect(screen.getByText('Line one Line two')).toBeInTheDocument();
  });

  it('renders a text/JSON attachment in a monospace pane', async () => {
    ipc.override('read_attachment_text', '{"ok":true}');
    renderWithClient(
      <AttachmentPreviewDialog
        accountId="account-1"
        messageId="message-1"
        attachment={textAttachment}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText('{"ok":true}')).toBeInTheDocument();
  });

  it('renders a DOCX attachment as converted, sanitised HTML in a script-free frame', async () => {
    ipc.override('read_attachment_bytes', new ArrayBuffer(8));
    const { queryClient, unmount } = renderWithClient(
      <AttachmentPreviewDialog
        accountId="account-1"
        messageId="message-1"
        attachment={docxAttachment}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByTitle('Message body')).toBeInTheDocument();
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .some(({ queryKey }) => queryKey[0] === 'attachmentBytes'),
    ).toBe(false);
    unmount();
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .some(({ queryKey }) => queryKey[0] === 'attachmentBytes'),
    ).toBe(false);
  });

  it('keeps PDF bytes outside the query cache across close and reopen', async () => {
    let reads = 0;
    ipc.override('read_attachment_bytes', () => {
      reads += 1;
      return new ArrayBuffer(8);
    });
    const first = renderWithClient(
      <AttachmentPreviewDialog
        accountId="account-1"
        messageId="message-1"
        attachment={pdfAttachment}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(reads).toBe(1));
    expect(
      first.queryClient
        .getQueryCache()
        .getAll()
        .some(({ queryKey }) => queryKey[0] === 'attachmentBytes'),
    ).toBe(false);
    first.unmount();

    const second = renderWithClient(
      <AttachmentPreviewDialog
        accountId="account-1"
        messageId="message-1"
        attachment={pdfAttachment}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(reads).toBe(2));
    expect(
      second.queryClient
        .getQueryCache()
        .getAll()
        .some(({ queryKey }) => queryKey[0] === 'attachmentBytes'),
    ).toBe(false);
  });

  it('is a role=dialog surface that takes focus, so the global shortcut listener treats it as a focus context', () => {
    renderWithClient(
      <AttachmentPreviewDialog
        accountId="account-1"
        messageId="message-1"
        attachment={unsupportedAttachment}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(hasFocusContext()).toBe(true);
  });

  it('closes when the backdrop around the panel is clicked but not when the panel itself is', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithClient(
      <AttachmentPreviewDialog
        accountId="account-1"
        messageId="message-1"
        attachment={unsupportedAttachment}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByText(unsupportedAttachment.filename));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes only the preview on Escape, without touching mail selection state', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    let selectionCleared = false;
    const clearSelectionOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !hasFocusContext()) selectionCleared = true;
    };
    window.addEventListener('keydown', clearSelectionOnEscape);
    renderWithClient(
      <AttachmentPreviewDialog
        accountId="account-1"
        messageId="message-1"
        attachment={unsupportedAttachment}
        onClose={onClose}
      />,
    );
    await user.keyboard('{Escape}');
    window.removeEventListener('keydown', clearSelectionOnEscape);
    expect(selectionCleared).toBe(false);
    expect(onClose).toHaveBeenCalled();
  });
});
