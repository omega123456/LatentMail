import type React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';
import { MessageSourceDialog } from '@/components/reader/MessageSourceDialog';
import { ipc } from '@/tests/ipc-mock';
import { useMessageSourceStore } from '@/stores/message-source';
import { useToastStore } from '@/stores/toast';
import type { MessageSource } from '@/lib/types/ipc';

const source: MessageSource = {
  messageId: '<invoice@northwind.example>',
  sentAt: Date.parse('2026-10-23T09:14:05Z'),
  sender: 'Northwind <billing@northwind.example>',
  to: 'me@example.com',
  cc: '',
  subject: 'Your invoice for October is ready',
  authenticationResults: 'mx.google.com; dkim=pass; spf=pass; dmarc=pass',
  sizeBytes: 412000,
  raw: 'Subject: Your invoice\r\n\r\nQUJDREVG',
  display: 'Subject: Your invoice\n\n[Encoded part · 1 KB of base64 hidden]',
};

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (ui: React.ReactElement) => (
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
  return render(wrap(<MessageSourceDialog />));
}

function openFor(messageId = 'message-1') {
  act(() => useMessageSourceStore.getState().open({ accountId: 'account-1', messageId }));
}

beforeEach(() => {
  if (!document.getElementById('root')) {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
  }
  useMessageSourceStore.setState({ target: null });
  useToastStore.setState({ toasts: [] });
});

describe('MessageSourceDialog', () => {
  it('renders nothing until a message is chosen', () => {
    renderDialog();
    expect(screen.queryByTestId('message-source-modal')).not.toBeInTheDocument();
  });

  it('shows the loading state, then the header summary and the collapsed source', async () => {
    let resolve: (value: MessageSource) => void = () => undefined;
    ipc.override('read_message_source', () => new Promise((done) => (resolve = done)));
    renderDialog();
    openFor();

    expect(await screen.findByText('Loading source…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download .eml' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
    await act(async () => resolve(source));

    expect(
      await screen.findByText('Original message · Your invoice for October is ready'),
    ).toBeInTheDocument();
    expect(screen.getByText('<invoice@northwind.example>')).toBeInTheDocument();
    expect(screen.getByText('mx.google.com; dkim=pass; spf=pass; dmarc=pass')).toBeInTheDocument();
    expect(screen.queryByText('Cc')).not.toBeInTheDocument();
    expect(screen.getByText('Raw source · 402 KB')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Raw message source' })).toHaveTextContent(
      '[Encoded part · 1 KB of base64 hidden]',
    );
  });

  it('copies the full raw source rather than the collapsed display', async () => {
    ipc.override('read_message_source', source);
    renderDialog();
    openFor();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Copy' }));

    expect(await navigator.clipboard.readText()).toBe(source.raw);
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('Copied original message');
  });

  it('reports a clipboard that refuses the write', async () => {
    ipc.override('read_message_source', source);
    renderDialog();
    openFor();
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: 'Copy' });
    const writeText = navigator.clipboard.writeText;
    navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));

    await user.click(button);

    await waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
        "Couldn't copy the original message",
      ),
    );
    navigator.clipboard.writeText = writeText;
  });

  it('toggles line wrapping on the raw pane', async () => {
    ipc.override('read_message_source', source);
    renderDialog();
    openFor();
    const user = userEvent.setup();
    const pane = await screen.findByRole('textbox', { name: 'Raw message source' });
    expect(pane).toHaveClass('whitespace-pre-wrap');

    await user.click(screen.getByRole('checkbox', { name: 'Wrap lines' }));

    expect(pane).toHaveClass('whitespace-pre');
    expect(pane).not.toHaveClass('whitespace-pre-wrap');
  });

  it('downloads the original as .eml after the destination is chosen', async () => {
    const saved: string[] = [];
    ipc.override('read_message_source', source);
    ipc.override('plugin:dialog|save', ({ options }) => {
      saved.push(options.defaultPath ?? '');
      return '/Users/me/Downloads/invoice.eml';
    });
    ipc.override('save_message_source_to_path', ({ destination }) => {
      saved.push(destination);
    });
    renderDialog();
    openFor();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Download .eml' }));

    await waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)?.message).toBe('Saved "invoice.eml"'),
    );
    expect(saved).toEqual([
      '2026-10-23 Your invoice for October is ready.eml',
      '/Users/me/Downloads/invoice.eml',
    ]);
  });

  it('explains a failed load and retries on request', async () => {
    let attempts = 0;
    ipc.override('read_message_source', () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject('This message is too large to show its source here.')
        : source;
    });
    renderDialog();
    openFor();
    const user = userEvent.setup();

    expect(await screen.findByText("Couldn't load the original message.")).toBeInTheDocument();
    expect(
      screen.getByText('This message is too large to show its source here.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('falls back to a generic hint when the failure carries no message', async () => {
    ipc.override('read_message_source', () => Promise.reject(new Error('offline')));
    renderDialog();
    openFor();

    expect(await screen.findByText('Check your connection, then try again.')).toBeInTheDocument();
  });

  it('closes from the close button', async () => {
    ipc.override('read_message_source', source);
    renderDialog();
    openFor();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Close original message' }));

    expect(useMessageSourceStore.getState().target).toBeNull();
    expect(screen.queryByTestId('message-source-modal')).not.toBeInTheDocument();
  });
});
