import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ComposeHeader } from '@/components/compose/ComposeHeader';

describe('ComposeHeader', () => {
  it.each([
    ['new', 'New Message'],
    ['reply', 'Reply'],
    ['reply-all', 'Reply All'],
    ['forward', 'Forward'],
    ['draft', 'Draft'],
  ] as const)('titles the panel for the %s mode', (mode, title) => {
    render(<ComposeHeader mode={mode} onClose={() => {}} />);
    expect(screen.getByText(title)).toBeInTheDocument();
  });

  it('renders Discard as disabled and Close as operable, both with accessible names and titles', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ComposeHeader mode="new" onClose={onClose} />);
    const discard = screen.getByRole('button', { name: 'Discard' });
    expect(discard).toBeDisabled();
    expect(discard).toHaveAttribute('title', 'Discard');
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveAttribute('title', 'Close');
    await user.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
