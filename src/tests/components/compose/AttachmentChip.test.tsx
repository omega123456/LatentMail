import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AttachmentChip } from '@/components/compose/AttachmentChip';
import type { ComposeAttachment } from '@/stores/compose';

function attachment(overrides: Partial<ComposeAttachment> = {}): ComposeAttachment {
  return {
    localId: 'local-1',
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    size: 2048,
    state: 'settled',
    staged: null,
    contentId: null,
    error: null,
    ...overrides,
  };
}

describe('AttachmentChip', () => {
  it('renders filename and formatted size', () => {
    render(<AttachmentChip attachment={attachment()} onRemove={vi.fn()} />);
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByText('2 KB')).toBeInTheDocument();
  });

  it('applies the coloured PDF family well and ink', () => {
    render(<AttachmentChip attachment={attachment()} onRemove={vi.fn()} />);
    const well = screen.getByText('report.pdf').parentElement?.previousElementSibling;
    expect(well?.className).toContain('bg-filetype-pdf-well');
    expect(well?.className).toContain('text-filetype-pdf-ink');
  });

  it('applies the neutral treatment for a text-code family', () => {
    render(
      <AttachmentChip
        attachment={attachment({ filename: 'notes.txt', mimeType: 'text/plain' })}
        onRemove={vi.fn()}
      />,
    );
    const well = screen.getByText('notes.txt').parentElement?.previousElementSibling;
    expect(well?.className).toContain('bg-surface-container-high');
    expect(well?.className).not.toContain('filetype');
  });

  it('shows a reading state with a spinner and Cancel action', () => {
    render(<AttachmentChip attachment={attachment({ state: 'reading' })} onRemove={vi.fn()} />);
    expect(screen.getByText('Reading…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel report.pdf/ })).toBeInTheDocument();
  });

  it('shows a failed state with the error message and error styling', () => {
    render(
      <AttachmentChip
        attachment={attachment({ state: 'failed', error: 'Too large' })}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText('Too large')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Remove report.pdf/ })).toBeInTheDocument();
  });

  it('calls onRemove when the remove control is activated', async () => {
    const onRemove = vi.fn();
    render(<AttachmentChip attachment={attachment()} onRemove={onRemove} />);
    screen.getByRole('button', { name: /Remove report.pdf/ }).click();
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
