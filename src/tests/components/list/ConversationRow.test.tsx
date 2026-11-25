import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConversationRow } from '@/components/list/ConversationRow';
import { renderWithQueryClient } from '@/tests/render-with-query-client';
import { sampleConversation as conversation } from '@/tests/components/list/conversation-row-fixture';

describe('ConversationRow', () => {
  it('reports completion only after its notification flash animation ends', () => {
    const onFlashComplete = vi.fn();
    renderWithQueryClient(
      <ConversationRow
        conversation={conversation}
        density="comfortable"
        active={false}
        flash
        onFlashComplete={onFlashComplete}
        onOpen={vi.fn()}
        onStar={vi.fn()}
      />,
    );
    const row = screen.getByTestId('conversation-row');
    expect(row).toHaveClass('motion-safe:animate-row-flash');
    fireEvent(row, new Event('animationend', { bubbles: true }));
    expect(onFlashComplete).toHaveBeenCalledOnce();
  });

  it('shows the active highlight when active and no multi-selection is in play', () => {
    renderWithQueryClient(
      <ConversationRow
        conversation={conversation}
        density="comfortable"
        active
        onOpen={vi.fn()}
        onStar={vi.fn()}
      />,
    );
    expect(screen.getByTestId('conversation-row')).toHaveAttribute('data-active', 'true');
  });

  it('suppresses the active highlight whenever a multi-selection is active, even on an unselected row', () => {
    renderWithQueryClient(
      <ConversationRow
        conversation={conversation}
        density="comfortable"
        active
        multiSelectActive
        onOpen={vi.fn()}
        onStar={vi.fn()}
      />,
    );
    expect(screen.getByTestId('conversation-row')).not.toHaveAttribute('data-active');
  });

  it('renders the selected accent bar and never the active highlight at the same time', () => {
    renderWithQueryClient(
      <ConversationRow
        conversation={conversation}
        density="comfortable"
        active
        selected
        multiSelectActive
        onOpen={vi.fn()}
        onStar={vi.fn()}
      />,
    );
    const row = screen.getByTestId('conversation-row');
    expect(row).toHaveAttribute('data-selected', 'true');
    expect(row).not.toHaveAttribute('data-active');
  });

  it('passes the click event through to onOpen so modifier clicks can be told apart', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderWithQueryClient(
      <ConversationRow
        conversation={conversation}
        density="comfortable"
        active={false}
        onOpen={onOpen}
        onStar={vi.fn()}
      />,
    );
    await user.click(screen.getByLabelText('Open Q3 review'));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen.mock.calls[0][0]).toMatchObject({ type: 'click' });
  });

  it('opens plainly (no modifiers) from the row context menu', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderWithQueryClient(
      <ConversationRow
        conversation={conversation}
        density="comfortable"
        active={false}
        onOpen={onOpen}
        onStar={vi.fn()}
      />,
    );
    await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('conversation-row') });
    await user.click(await screen.findByText('Open'));
    expect(onOpen).toHaveBeenCalledWith({ shiftKey: false, metaKey: false, ctrlKey: false });
  });

  it('dispatches context-menu triage changes instead of dropping them', async () => {
    const user = userEvent.setup();
    const onTriage = vi.fn();
    renderWithQueryClient(
      <ConversationRow
        conversation={{ ...conversation, unread: true }}
        density="comfortable"
        active={false}
        onOpen={vi.fn()}
        onStar={vi.fn()}
        onTriage={onTriage}
      />,
    );
    await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('conversation-row') });
    await user.click(await screen.findByText('Mark read'));
    expect(onTriage).toHaveBeenCalledWith({ kind: 'label', add: [], remove: ['UNREAD'] });
  });

  it('dispatches reply, reply-all, forward and edit-draft actions from its context menu', async () => {
    const user = userEvent.setup();
    const onCompose = vi.fn();
    renderWithQueryClient(
      <ConversationRow
        conversation={{ ...conversation, draft: true }}
        density="comfortable"
        active={false}
        onOpen={vi.fn()}
        onStar={vi.fn()}
        onCompose={onCompose}
      />,
    );
    await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('conversation-row') });
    await user.click(await screen.findByText('Reply'));
    expect(onCompose).toHaveBeenCalledWith('reply');
    await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('conversation-row') });
    await user.click(await screen.findByText('Reply all'));
    expect(onCompose).toHaveBeenCalledWith('reply-all');
    await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('conversation-row') });
    await user.click(await screen.findByText('Forward'));
    expect(onCompose).toHaveBeenCalledWith('forward');
    await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('conversation-row') });
    await user.click(await screen.findByText('Edit draft'));
    expect(onCompose).toHaveBeenCalledWith('edit-draft');
  });

  it('dispatches move-to, mark-as-spam and delete from its context menu', async () => {
    const user = userEvent.setup();
    const onTriage = vi.fn();
    renderWithQueryClient(
      <ConversationRow
        conversation={conversation}
        density="comfortable"
        active={false}
        onOpen={vi.fn()}
        onStar={vi.fn()}
        onTriage={onTriage}
      />,
    );
    await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('conversation-row') });
    await user.hover(await screen.findByText('Move to'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Spam/ }));
    expect(onTriage).toHaveBeenCalledWith({ kind: 'move', destination: 'SPAM' });

    await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('conversation-row') });
    await user.click(await screen.findByText('Mark as spam'));
    expect(onTriage).toHaveBeenCalledWith({ kind: 'move', destination: 'SPAM' });

    await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('conversation-row') });
    await user.click(await screen.findByText('Delete'));
    expect(onTriage).toHaveBeenCalledWith({ kind: 'delete' });
  });
});
