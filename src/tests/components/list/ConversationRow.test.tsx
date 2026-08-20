import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConversationRow } from '@/components/list/ConversationRow';
import { useLayoutStore } from '@/stores/layout';
import { renderWithQueryClient } from '@/tests/render-with-query-client';
import type { Conversation } from '@/lib/types/conversation';

const conversation: Conversation = {
  id: 'thread-1',
  sender: 'Elena Rodriguez',
  identityLabel: 'Elena Rodriguez',
  avatarDomain: 'example.com',
  subject: 'Q3 review',
  snippet: 'Attached slides',
  date: new Date('2026-08-11T10:42:00Z'),
  unread: false,
  starred: false,
};

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

  describe('avatar presence and read-state accessibility', () => {
    it('renders a 32px avatar at comfortable density and exposes the accessible read state', () => {
      renderWithQueryClient(
        <ConversationRow
          conversation={conversation}
          density="comfortable"
          active={false}
          onOpen={vi.fn()}
          onStar={vi.fn()}
        />,
      );
      expect(screen.getByTestId('conversation-row').querySelector('.size-8')).toBeInTheDocument();

      expect(screen.getByText('Read')).toBeInTheDocument();
    });

    it('renders a 40px avatar at spacious density', () => {
      renderWithQueryClient(
        <ConversationRow
          conversation={conversation}
          density="spacious"
          active={false}
          onOpen={vi.fn()}
          onStar={vi.fn()}
        />,
      );
      expect(screen.getByTestId('conversation-row').querySelector('.size-10')).toBeInTheDocument();
    });

    it('renders no avatar at compact density but keeps the accessible read-state label', () => {
      renderWithQueryClient(
        <ConversationRow
          conversation={{ ...conversation, unread: true }}
          density="compact"
          active={false}
          onOpen={vi.fn()}
          onStar={vi.fn()}
        />,
      );
      expect(
        screen.getByTestId('conversation-row').querySelector('.size-8'),
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId('conversation-row').querySelector('.size-10'),
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText('Unread')).toBeInTheDocument();
    });

    it('renders nothing (not even the letter initial) when the preference is off', () => {
      act(() => useLayoutStore.setState({ showSenderAvatars: false }));
      renderWithQueryClient(
        <ConversationRow
          conversation={conversation}
          density="comfortable"
          active={false}
          onOpen={vi.fn()}
          onStar={vi.fn()}
        />,
      );
      expect(
        screen.getByTestId('conversation-row').querySelector('.size-8'),
      ).not.toBeInTheDocument();
      act(() => useLayoutStore.setState({ showSenderAvatars: true }));
    });
  });

  describe('unread notch ring color', () => {
    const unreadConversation: Conversation = { ...conversation, unread: true };

    it('rings the resting/hover ground by default', () => {
      renderWithQueryClient(
        <ConversationRow
          conversation={unreadConversation}
          density="comfortable"
          active={false}
          onOpen={vi.fn()}
          onStar={vi.fn()}
        />,
      );
      const notch = screen.getByTestId('conversation-row').querySelector('.bg-primary.ring-2');
      expect(notch).toHaveClass('ring-surface');
      expect(notch).toHaveClass('group-hover:ring-surface-container-low');
    });

    it('rings the active row ground when active', () => {
      renderWithQueryClient(
        <ConversationRow
          conversation={unreadConversation}
          density="comfortable"
          active
          onOpen={vi.fn()}
          onStar={vi.fn()}
        />,
      );
      const notch = screen.getByTestId('conversation-row').querySelector('.bg-primary.ring-2');
      expect(notch).toHaveClass('ring-surface-container-highest');
    });

    it('rings the selected row ground when selected', () => {
      renderWithQueryClient(
        <ConversationRow
          conversation={unreadConversation}
          density="comfortable"
          active={false}
          selected
          multiSelectActive
          onOpen={vi.fn()}
          onStar={vi.fn()}
        />,
      );
      const notch = screen.getByTestId('conversation-row').querySelector('.bg-primary.ring-2');
      expect(notch).toHaveClass('ring-primary/10');
    });
  });

  describe('source-folder badge', () => {
    const sentFromInbox: Conversation = {
      ...conversation,
      systemLabelIds: ['SENT'],
      labels: ['Receipts'],
    };
    const labelEntries = [
      { id: 'Label_1', name: 'Receipts', color: 'blue' as const, membership: 'checked' as const },
    ];

    it('is absent in compact density', () => {
      renderWithQueryClient(
        <ConversationRow
          conversation={sentFromInbox}
          density="compact"
          active={false}
          allLabels={labelEntries}
          onOpen={vi.fn()}
          onStar={vi.fn()}
        />,
      );
      expect(screen.queryByText('Sent')).not.toBeInTheDocument();
    });

    it('renders icon-only in comfortable density', () => {
      renderWithQueryClient(
        <ConversationRow
          conversation={sentFromInbox}
          density="comfortable"
          active={false}
          allLabels={labelEntries}
          onOpen={vi.fn()}
          onStar={vi.fn()}
        />,
      );
      const badge = screen.getByTitle('Sent');
      expect(badge.querySelector('span')).toHaveClass('sr-only');
    });

    it('renders a full text chip in spacious density', () => {
      renderWithQueryClient(
        <ConversationRow
          conversation={sentFromInbox}
          density="spacious"
          active={false}
          allLabels={labelEntries}
          onOpen={vi.fn()}
          onStar={vi.fn()}
        />,
      );
      expect(screen.getByText('Sent')).toBeVisible();
    });

    it('shows no source badge for a thread carrying no system label', () => {
      renderWithQueryClient(
        <ConversationRow
          conversation={{ ...conversation, systemLabelIds: [] }}
          density="spacious"
          active={false}
          onOpen={vi.fn()}
          onStar={vi.fn()}
        />,
      );
      expect(screen.queryByTitle('Sent')).not.toBeInTheDocument();
      expect(screen.queryByTitle('Inbox')).not.toBeInTheDocument();
    });

    it('is never evicted by ROW_BADGE_LIMIT and widens the badge list accessible name', () => {
      renderWithQueryClient(
        <ConversationRow
          conversation={{
            ...conversation,
            systemLabelIds: ['SENT'],
            labels: ['Receipts', 'Work', 'Personal'],
          }}
          density="spacious"
          active={false}
          allLabels={[
            { id: 'Label_1', name: 'Receipts', color: 'blue', membership: 'checked' },
            { id: 'Label_2', name: 'Work', color: 'green', membership: 'checked' },
            { id: 'Label_3', name: 'Personal', color: 'red', membership: 'checked' },
          ]}
          onOpen={vi.fn()}
          onStar={vi.fn()}
        />,
      );
      const list = screen.getByRole('list', { name: 'Labels and source mailbox' });
      expect(list).toContainElement(screen.getByText('Sent'));
      expect(screen.getByText('+1')).toBeInTheDocument();
    });

    it('hides the source badge when it matches the current folder', () => {
      renderWithQueryClient(
        <ConversationRow
          conversation={sentFromInbox}
          density="spacious"
          active={false}
          allLabels={labelEntries}
          currentFolderId="SENT"
          onOpen={vi.fn()}
          onStar={vi.fn()}
        />,
      );
      expect(screen.queryByText('Sent')).not.toBeInTheDocument();
    });

    it('shows the source badge when it differs from the current folder', () => {
      renderWithQueryClient(
        <ConversationRow
          conversation={sentFromInbox}
          density="spacious"
          active={false}
          allLabels={labelEntries}
          currentFolderId="INBOX"
          onOpen={vi.fn()}
          onStar={vi.fn()}
        />,
      );
      expect(screen.getByText('Sent')).toBeVisible();
    });
  });
});
