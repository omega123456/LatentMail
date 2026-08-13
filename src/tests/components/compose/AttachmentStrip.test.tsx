import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AttachmentStrip } from '@/components/compose/AttachmentStrip';
import type { ComposeAttachment } from '@/stores/compose';

const staged = (state: ComposeAttachment['state']): ComposeAttachment => ({
  localId: state,
  filename: 'Q3 budget.pdf',
  mimeType: 'application/pdf',
  size: 253952,
  state,
  staged:
    state === 'settled'
      ? {
          id: 'part-1',
          path: '/staging/Q3 budget.pdf',
          assetUrl: 'asset://staging/Q3%20budget.pdf',
          size: 253952,
        }
      : null,
  contentId: null,
  error: state === 'failed' ? "Couldn't read" : null,
});

describe('AttachmentStrip', () => {
  it('renders settled, reading, and failed files in their own chips and removes the selected file', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <AttachmentStrip
        attachments={(['settled', 'reading', 'failed'] as const).map(staged)}
        onRemove={onRemove}
      />,
    );

    expect(screen.getByTestId('attachment-chip-settled')).toHaveTextContent('248 KB');
    expect(screen.getByTestId('attachment-chip-reading')).toHaveTextContent('Reading…');
    expect(screen.getByTestId('attachment-chip-failed')).toHaveTextContent("Couldn't read");
    await user.click(screen.getByRole('button', { name: 'Cancel Q3 budget.pdf' }));
    expect(onRemove).toHaveBeenCalledWith('reading');
  });

  it('keeps inline-image parts out of the attachment strip', () => {
    render(
      <AttachmentStrip
        attachments={[{ ...staged('settled'), contentId: 'cid:image' }]}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('attachment-strip')).not.toBeInTheDocument();
  });
});
