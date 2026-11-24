import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DiscardConfirm } from '@/components/compose/DiscardConfirm';

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
});
