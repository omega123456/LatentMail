import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DiscardConfirm } from '@/components/compose/DiscardConfirm';
import { ComposeFooter } from '@/components/compose/ComposeFooter';

describe('compose lifecycle controls', () => {
  it('keeps or discards through the inline non-modal confirmation', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onDiscard = vi.fn();
    render(<DiscardConfirm onCancel={onCancel} onDiscard={onDiscard} />);
    expect(screen.getByRole('alertdialog')).toHaveAttribute('aria-modal', 'false');
    await user.click(screen.getByRole('button', { name: 'Keep' }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onDiscard).toHaveBeenCalledOnce();
  });

  it('accepts Send safely when its optional callback is omitted', async () => {
    const user = userEvent.setup();
    render(
      <ComposeFooter
        editor={null}
        onLink={() => undefined}
        onAttach={() => undefined}
        onInsertImage={() => undefined}
        ready
        status=""
        blocked={false}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Send' }));
  });
});
