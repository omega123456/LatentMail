import type React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ReceivedAttachmentChip } from '@/components/reader/ReceivedAttachmentChip';
import { ipc } from '@/tests/ipc-mock';
import { useLayoutStore } from '@/stores/layout';
import type { MessageAttachment } from '@/lib/types/ipc';

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const pdfAttachment: MessageAttachment = {
  id: 'attachment-1',
  filename: 'Q3-summary.pdf',
  mimeType: 'application/pdf',
  size: 1468006,
  position: 0,
};

const imageAttachment: MessageAttachment = {
  id: 'attachment-3',
  filename: 'scan-0142.jpg',
  mimeType: 'image/jpeg',
  size: 2202009,
  position: 2,
};

describe('ReceivedAttachmentChip', () => {
  it('renders the coloured PDF glyph, filename and size', () => {
    renderWithClient(
      <ReceivedAttachmentChip
        accountId="account-1"
        messageId="message-1"
        attachment={pdfAttachment}
        onPreview={() => undefined}
      />,
    );
    expect(screen.getByText('Q3-summary.pdf')).toBeInTheDocument();
    expect(screen.getByText('1.4 MB')).toBeInTheDocument();
  });

  it('exposes exactly two tab stops, neither nested inside the other', () => {
    renderWithClient(
      <ReceivedAttachmentChip
        accountId="account-1"
        messageId="message-1"
        attachment={pdfAttachment}
        onPreview={() => undefined}
      />,
    );
    const preview = screen.getByRole('button', { name: 'Preview Q3-summary.pdf' });
    const download = screen.getByRole('button', { name: 'Download Q3-summary.pdf' });
    expect(preview.contains(download)).toBe(false);
    expect(download.contains(preview)).toBe(false);
    expect(preview.parentElement).toBe(download.parentElement);
  });

  it('calls onPreview when the preview control is clicked, Enter-activated or Space-activated', async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderWithClient(
      <ReceivedAttachmentChip
        accountId="account-1"
        messageId="message-1"
        attachment={pdfAttachment}
        onPreview={() => {
          calls += 1;
        }}
      />,
    );
    const preview = screen.getByRole('button', { name: 'Preview Q3-summary.pdf' });
    await user.click(preview);
    preview.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(calls).toBe(3);
  });

  it('does not open the preview when the download control is activated', async () => {
    const user = userEvent.setup();
    let previewCalls = 0;
    ipc.override('plugin:dialog|save', null);
    renderWithClient(
      <ReceivedAttachmentChip
        accountId="account-1"
        messageId="message-1"
        attachment={pdfAttachment}
        onPreview={() => {
          previewCalls += 1;
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Download Q3-summary.pdf' }));
    expect(previewCalls).toBe(0);
  });

  it('shows no thumbnail and issues no attachment request when prefetch is off', () => {
    act(() => useLayoutStore.setState({ prefetchImageAttachments: false }));
    renderWithClient(
      <ReceivedAttachmentChip
        accountId="account-1"
        messageId="message-1"
        attachment={imageAttachment}
        onPreview={() => undefined}
      />,
    );
    expect(screen.queryByTestId('attachment-thumbnail')).not.toBeInTheDocument();
    expect(ipc.tauriInvoke).not.toHaveBeenCalledWith('ensure_attachment_cached', expect.anything());
  });

  it('shows a thumbnail when prefetch is on and the cache resolves', async () => {
    act(() => useLayoutStore.setState({ prefetchImageAttachments: true }));
    ipc.override('ensure_attachment_cached', {
      cachePath: '/cache/scan.jpg',
      displayPath: '/cache/scan.jpg',
      mimeType: 'image/jpeg',
      filename: 'scan-0142.jpg',
      size: 2202009,
    });
    renderWithClient(
      <ReceivedAttachmentChip
        accountId="account-1"
        messageId="message-1"
        attachment={imageAttachment}
        onPreview={() => undefined}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('attachment-thumbnail')).toBeInTheDocument());
  });

  it('falls back silently to the glyph on a thumbnail failure, with no error text or retry control', async () => {
    act(() => useLayoutStore.setState({ prefetchImageAttachments: true }));
    ipc.override('ensure_attachment_cached', () => Promise.reject(new Error('boom')));
    renderWithClient(
      <ReceivedAttachmentChip
        accountId="account-1"
        messageId="message-1"
        attachment={imageAttachment}
        onPreview={() => undefined}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByTestId('attachment-thumbnail')).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/retry/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
  });

  it('dims the chip and disables the download control while a download is in flight', async () => {
    const user = userEvent.setup();
    ipc.override('plugin:dialog|save', '/Users/alex/Downloads/Q3-summary.pdf');
    ipc.override('save_attachment_to_path', () => new Promise(() => undefined));
    renderWithClient(
      <ReceivedAttachmentChip
        accountId="account-1"
        messageId="message-1"
        attachment={pdfAttachment}
        onPreview={() => undefined}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Download Q3-summary.pdf' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Downloading Q3-summary.pdf' })).toBeDisabled(),
    );
    expect(screen.getByText('Downloading…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Preview/ })).toBeEnabled();
  });

  it('sanitises a hostile filename before offering it as the Save dialog default path', async () => {
    const user = userEvent.setup();
    let receivedArgs: unknown;
    ipc.override('plugin:dialog|save', (args) => {
      receivedArgs = args;
      return null;
    });
    renderWithClient(
      <ReceivedAttachmentChip
        accountId="account-1"
        messageId="message-1"
        attachment={{ ...pdfAttachment, filename: '../../etc/passwd' }}
        onPreview={() => undefined}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Download ../../etc/passwd' }));
    await waitFor(() =>
      expect(receivedArgs).toEqual({ options: { defaultPath: 'passwd' } }),
    );
  });

  it('shows an inline error and a Retry control on a failed download, without a toast', async () => {
    const user = userEvent.setup();
    ipc.override('plugin:dialog|save', '/Users/alex/Downloads/Q3-summary.pdf');
    ipc.override('save_attachment_to_path', () => Promise.reject(new Error('disk full')));
    renderWithClient(
      <ReceivedAttachmentChip
        accountId="account-1"
        messageId="message-1"
        attachment={pdfAttachment}
        onPreview={() => undefined}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Download Q3-summary.pdf' }));
    await waitFor(() => expect(screen.getByText("Couldn't download")).toBeInTheDocument());
    expect(
      screen.getByRole('button', { name: 'Retry download of Q3-summary.pdf' }),
    ).toBeInTheDocument();
  });

  it('produces no feedback when the native Save dialog is cancelled', async () => {
    const user = userEvent.setup();
    ipc.override('plugin:dialog|save', null);
    let saveCalled = false;
    ipc.override('save_attachment_to_path', () => {
      saveCalled = true;
    });
    renderWithClient(
      <ReceivedAttachmentChip
        accountId="account-1"
        messageId="message-1"
        attachment={pdfAttachment}
        onPreview={() => undefined}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Download Q3-summary.pdf' }));
    expect(saveCalled).toBe(false);
    expect(screen.getByText('1.4 MB')).toBeInTheDocument();
  });
});
