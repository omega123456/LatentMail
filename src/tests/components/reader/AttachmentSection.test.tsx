import type React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { AttachmentSection } from '@/components/reader/AttachmentSection';
import type { MessageAttachment } from '@/lib/types/ipc';

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const attachment = (overrides: Partial<MessageAttachment> = {}): MessageAttachment => ({
  id: 'attachment-1',
  filename: 'Q3-summary.pdf',
  mimeType: 'application/pdf',
  size: 1468006,
  position: 0,
  ...overrides,
});

describe('AttachmentSection', () => {
  it('renders nothing when there are no attachments', () => {
    const { container } = renderWithClient(
      <AttachmentSection accountId="account-1" messageId="message-1" attachments={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows an exact singular count and one chip for a single attachment', () => {
    renderWithClient(
      <AttachmentSection
        accountId="account-1"
        messageId="message-1"
        attachments={[attachment()]}
      />,
    );
    expect(screen.getByText('1 attachment')).toBeInTheDocument();
    expect(screen.getByTestId('received-attachment-chip-attachment-1')).toBeInTheDocument();
  });

  it('shows an exact plural count and one chip per attachment', () => {
    const attachments = [
      attachment(),
      attachment({ id: 'attachment-2', filename: 'close-workbook.xlsx', position: 1 }),
      attachment({ id: 'attachment-3', filename: 'scan-0142.jpg', position: 2 }),
    ];
    renderWithClient(
      <AttachmentSection accountId="account-1" messageId="message-1" attachments={attachments} />,
    );
    expect(screen.getByText('3 attachments')).toBeInTheDocument();
    expect(screen.getByTestId('received-attachment-chip-attachment-1')).toBeInTheDocument();
    expect(screen.getByTestId('received-attachment-chip-attachment-2')).toBeInTheDocument();
    expect(screen.getByTestId('received-attachment-chip-attachment-3')).toBeInTheDocument();
  });

  it('opens the preview dialog when a chip is activated', async () => {
    const user = userEvent.setup();
    renderWithClient(
      <AttachmentSection
        accountId="account-1"
        messageId="message-1"
        attachments={[attachment()]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Preview Q3-summary.pdf' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
