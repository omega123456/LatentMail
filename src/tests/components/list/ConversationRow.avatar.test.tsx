import { act, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ConversationRow } from '@/components/list/ConversationRow';
import { useLayoutStore } from '@/stores/layout';
import { renderWithQueryClient } from '@/tests/render-with-query-client';
import { sampleConversation as conversation } from '@/tests/components/list/conversation-row-fixture';

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
      onOpen={vi.fn()}
      onStar={vi.fn()}
    />,
  );
  expect(screen.getByTestId('conversation-row').querySelector('.size-8')).not.toBeInTheDocument();
  act(() => useLayoutStore.setState({ showSenderAvatars: true }));
});
