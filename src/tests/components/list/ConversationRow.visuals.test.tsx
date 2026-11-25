import { act, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConversationRow } from '@/components/list/ConversationRow';
import { useLayoutStore } from '@/stores/layout';
import { renderWithQueryClient } from '@/tests/render-with-query-client';
import type { Conversation } from '@/lib/types/conversation';
import { sampleConversation as conversation } from '@/tests/components/list/conversation-row-fixture';

describe('ConversationRow visuals', () => {
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
