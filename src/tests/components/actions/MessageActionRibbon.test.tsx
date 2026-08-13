import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MessageActionRibbon } from '@/components/actions/MessageActionRibbon';

function baseHandlers() {
  return {
    onToggleRead: vi.fn(),
    onToggleStar: vi.fn(),
    onApplyLabels: vi.fn(),
    onMoveTo: vi.fn(),
    onToggleSpam: vi.fn(),
    onDelete: vi.fn(),
    onReply: vi.fn(),
    onReplyAll: vi.fn(),
    onForward: vi.fn(),
  };
}

describe('MessageActionRibbon', () => {
  it('is present without any hover interaction and is reachable by keyboard', () => {
    render(
      <MessageActionRibbon
        mailboxId="INBOX"
        unread={false}
        starred={false}
        labels={[]}
        {...baseHandlers()}
      />,
    );
    const ribbon = screen.getByRole('toolbar', { name: 'Message actions' });
    expect(ribbon).toBeInTheDocument();
    const deleteButton = screen.getByRole('button', { name: 'Delete' });
    expect(deleteButton).not.toHaveAttribute('disabled');
    deleteButton.focus();
    expect(deleteButton).toHaveFocus();
  });

  it('dispatches star and delete for the whole conversation from a single message', async () => {
    const user = userEvent.setup();
    const handlers = baseHandlers();
    render(
      <MessageActionRibbon
        mailboxId="INBOX"
        unread={false}
        starred={false}
        labels={[]}
        {...handlers}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Star' }));
    expect(handlers.onToggleStar).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(handlers.onDelete).toHaveBeenCalledOnce();
  });

  it('opens Labels and applies a change', async () => {
    const user = userEvent.setup();
    const handlers = baseHandlers();
    render(
      <MessageActionRibbon
        mailboxId="INBOX"
        unread={false}
        starred={false}
        labels={[{ id: 'Label_1', name: 'Clients', color: 'blue', membership: 'unchecked' }]}
        {...handlers}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Labels' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /Clients/ }));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(handlers.onApplyLabels).toHaveBeenCalledWith({ add: ['Label_1'], remove: [] });
  });

  it('opens Move to and dispatches a destination', async () => {
    const user = userEvent.setup();
    const handlers = baseHandlers();
    render(
      <MessageActionRibbon
        mailboxId="INBOX"
        unread={false}
        starred={false}
        labels={[]}
        {...handlers}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Move to' }));
    await user.click(await screen.findByRole('menuitem', { name: /Trash/ }));
    expect(handlers.onMoveTo).toHaveBeenCalledWith('TRASH');
  });

  it('dispatches spam toggle', async () => {
    const user = userEvent.setup();
    const handlers = baseHandlers();
    render(
      <MessageActionRibbon
        mailboxId="INBOX"
        unread={false}
        starred={false}
        labels={[]}
        {...handlers}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Mark as spam' }));
    expect(handlers.onToggleSpam).toHaveBeenCalledOnce();
  });

  it('dispatches read toggle', async () => {
    const user = userEvent.setup();
    const handlers = baseHandlers();
    render(
      <MessageActionRibbon mailboxId="INBOX" unread starred={false} labels={[]} {...handlers} />,
    );
    await user.click(screen.getByRole('button', { name: 'Mark read' }));
    expect(handlers.onToggleRead).toHaveBeenCalledOnce();
  });

  it('hides every label-mutating action in Drafts', () => {
    render(
      <MessageActionRibbon
        mailboxId="DRAFT"
        unread={false}
        starred={false}
        labels={[]}
        {...baseHandlers()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Star' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Labels' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });
});
