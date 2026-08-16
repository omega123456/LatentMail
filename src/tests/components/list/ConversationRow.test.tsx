import { act, screen } from '@testing-library/react';
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
  it('shows the active highlight when active and no multi-selection is in play', () => {
    renderWithQueryClient(
      <ConversationRow
        conversation={conversation}
        density="comfortable"
        active
        mailboxId="INBOX"
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
        mailboxId="INBOX"
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
        mailboxId="INBOX"
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
        mailboxId="INBOX"
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
        mailboxId="INBOX"
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
        mailboxId="INBOX"
        onOpen={vi.fn()}
        onStar={vi.fn()}
        onTriage={onTriage}
      />,
    );
    await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('conversation-row') });
    await user.click(await screen.findByText('Mark read'));
    expect(onTriage).toHaveBeenCalledWith({ add: [], remove: ['UNREAD'] });
  });

  it('dispatches reply and forward actions from its context menu', async () => {
    const user = userEvent.setup();
    const onCompose = vi.fn();
    renderWithQueryClient(
      <ConversationRow
        conversation={conversation}
        density="comfortable"
        active={false}
        mailboxId="INBOX"
        onOpen={vi.fn()}
        onStar={vi.fn()}
        onCompose={onCompose}
      />,
    );
    await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('conversation-row') });
    await user.click(await screen.findByText('Reply'));
    expect(onCompose).toHaveBeenCalledWith('reply');
    await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('conversation-row') });
    await user.click(await screen.findByText('Forward'));
    expect(onCompose).toHaveBeenCalledWith('forward');
  });

  describe('avatar presence and read-state accessibility', () => {
    it('renders a 32px avatar at comfortable density and exposes the accessible read state', () => {
      renderWithQueryClient(
        <ConversationRow
          conversation={conversation}
          density="comfortable"
          active={false}
          mailboxId="INBOX"
          onOpen={vi.fn()}
          onStar={vi.fn()}
        />,
      );
      expect(screen.getByTestId('conversation-row').querySelector('.size-8')).toBeInTheDocument();
      // Comfortable/spacious density exposes the read state as real sr-only
      // text content (not just `aria-label`), so it's reliably exposed by
      // assistive technology.
      expect(screen.getByText('Read')).toBeInTheDocument();
    });

    it('renders a 40px avatar at spacious density', () => {
      renderWithQueryClient(
        <ConversationRow
          conversation={conversation}
          density="spacious"
          active={false}
          mailboxId="INBOX"
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
          mailboxId="INBOX"
          onOpen={vi.fn()}
          onStar={vi.fn()}
        />,
      );
      expect(screen.getByTestId('conversation-row').querySelector('.size-8')).not.toBeInTheDocument();
      expect(screen.getByTestId('conversation-row').querySelector('.size-10')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Unread')).toBeInTheDocument();
    });

    it('renders nothing (not even the letter initial) when the preference is off', () => {
      act(() => useLayoutStore.setState({ showSenderAvatars: false }));
      renderWithQueryClient(
        <ConversationRow
          conversation={conversation}
          density="comfortable"
          active={false}
          mailboxId="INBOX"
          onOpen={vi.fn()}
          onStar={vi.fn()}
        />,
      );
      expect(screen.getByTestId('conversation-row').querySelector('.size-8')).not.toBeInTheDocument();
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
          mailboxId="INBOX"
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
          mailboxId="INBOX"
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
          mailboxId="INBOX"
          onOpen={vi.fn()}
          onStar={vi.fn()}
        />,
      );
      const notch = screen.getByTestId('conversation-row').querySelector('.bg-primary.ring-2');
      expect(notch).toHaveClass('ring-primary/10');
    });
  });
});
