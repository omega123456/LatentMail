import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MoveToMenu } from '@/components/actions/MoveToMenu';

describe('MoveToMenu', () => {
  it('renders the current mailbox inert and dispatches a click on any other destination', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<MoveToMenu currentMailboxId="INBOX" onSelect={onSelect} />);
    const inbox = screen.getByRole('menuitem', { name: /Inbox/ });
    expect(inbox).toBeDisabled();
    expect(screen.getByText('here')).toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: /Spam/ }));
    expect(onSelect).toHaveBeenCalledWith('SPAM');
  });

  it('never offers Sent or Draft — only the three mutable system mailboxes appear', () => {
    render(<MoveToMenu currentMailboxId="SENT" onSelect={vi.fn()} />);
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    expect(screen.getByRole('menuitem', { name: /Inbox/ })).toBeEnabled();
  });

  it('shows the current user label as the removed source rather than as a destination', () => {
    render(
      <MoveToMenu currentMailboxId="Label_1" currentLabelName="Clients" onSelect={vi.fn()} />,
    );
    expect(screen.getByText('Removing from Clients')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    expect(screen.getByRole('menuitem', { name: /Inbox/ })).toBeEnabled();
  });

  it('wraps ArrowDown/ArrowUp focus between selectable destinations', async () => {
    const user = userEvent.setup();
    render(<MoveToMenu currentMailboxId="INBOX" onSelect={vi.fn()} />);
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
    render(<MoveToMenu currentMailboxId="INBOX" onSelect={vi.fn()} />);
    const spam = screen.getByRole('menuitem', { name: /Spam/ });
    const trash = screen.getByRole('menuitem', { name: /Trash/ });
    spam.focus();
    await user.keyboard('{ArrowUp}');
    expect(trash).toHaveFocus();
  });

  it('selects on Enter', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<MoveToMenu currentMailboxId="INBOX" onSelect={onSelect} />);
    screen.getByRole('menuitem', { name: /Trash/ }).focus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('TRASH');
  });
});
