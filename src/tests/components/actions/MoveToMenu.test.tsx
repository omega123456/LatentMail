import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MoveToMenu } from '@/components/actions/MoveToMenu';

describe('MoveToMenu', () => {
  it('renders a destination the thread already carries as inert and dispatches a click on any other destination', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<MoveToMenu currentSystemLabelIds={['INBOX']} onSelect={onSelect} />);
    const inbox = screen.getByRole('menuitem', { name: /Inbox/ });
    expect(inbox).toBeDisabled();
    expect(screen.getByText('here')).toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: /Spam/ }));
    expect(onSelect).toHaveBeenCalledWith('SPAM');
  });

  it('never offers Sent or Draft — only the three mutable system mailboxes appear', () => {
    render(<MoveToMenu currentSystemLabelIds={['SENT']} onSelect={vi.fn()} />);
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    expect(screen.getByRole('menuitem', { name: /Inbox/ })).toBeEnabled();
  });

  it('never removes a thread from a user label — no "removing from" affordance is rendered', () => {
    render(<MoveToMenu currentSystemLabelIds={['Label_1']} onSelect={vi.fn()} />);
    expect(screen.queryByText(/Removing from/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    expect(screen.getByRole('menuitem', { name: /Inbox/ })).toBeEnabled();
  });

  it('disables Trash based on real membership regardless of which mailbox is selected', () => {
    render(<MoveToMenu currentSystemLabelIds={['TRASH']} onSelect={vi.fn()} />);
    expect(screen.getByRole('menuitem', { name: /Trash/ })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: /Inbox/ })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: /Spam/ })).toBeEnabled();
  });

  it('wraps ArrowDown/ArrowUp focus between selectable destinations', async () => {
    const user = userEvent.setup();
    render(<MoveToMenu currentSystemLabelIds={['INBOX']} onSelect={vi.fn()} />);
    const spam = screen.getByRole('menuitem', { name: /Spam/ });
    const trash = screen.getByRole('menuitem', { name: /Trash/ });
    spam.focus();
    await user.keyboard('{ArrowDown}');
    expect(trash).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(spam).toHaveFocus();
  });

  it('wraps ArrowUp from the first selectable destination to the last', async () => {
    const user = userEvent.setup();
    render(<MoveToMenu currentSystemLabelIds={['INBOX']} onSelect={vi.fn()} />);
    const spam = screen.getByRole('menuitem', { name: /Spam/ });
    const trash = screen.getByRole('menuitem', { name: /Trash/ });
    spam.focus();
    await user.keyboard('{ArrowUp}');
    expect(trash).toHaveFocus();
  });

  it('selects on Enter', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<MoveToMenu currentSystemLabelIds={['INBOX']} onSelect={onSelect} />);
    screen.getByRole('menuitem', { name: /Trash/ }).focus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('TRASH');
  });
});
