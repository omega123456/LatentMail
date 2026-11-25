import { screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ConversationRow } from '@/components/list/ConversationRow';
import { renderWithQueryClient } from '@/tests/render-with-query-client';
import type { Conversation } from '@/lib/types/conversation';
import { sampleConversation as conversation } from '@/tests/components/list/conversation-row-fixture';

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
