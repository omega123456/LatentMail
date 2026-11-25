import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ConversationList } from '@/components/list/ConversationList';
import { useSearchStore } from '@/stores/search';
import { renderWithQueryClient } from '@/tests/render-with-query-client';
import { resetConversationListStores } from '@/tests/components/list/conversation-list-helpers';

beforeEach(() => {
  resetConversationListStores();
});

afterEach(() =>
  act(() =>
    useSearchStore.setState({
      draft: '',
      submittedQuery: '',
      scope: { kind: 'default' },
      active: false,
      panelOpen: false,
    }),
  ),
);

it('renders the search-specific empty state naming the query', () => {
  act(() => useSearchStore.setState({ active: true }));
  renderWithQueryClient(
    <ConversationList threads={[]} state="searchEmpty" searchQueryText="from:anna" />,
  );
  expect(screen.getByTestId('empty-state-search')).toHaveTextContent('from:anna');
});

it('shows the incomplete-backfill notice above rows while search is active and backfill is running, at any result count', () => {
  act(() => useSearchStore.setState({ active: true }));
  renderWithQueryClient(<ConversationList searchIncomplete />);
  expect(screen.getByTestId('search-incomplete-notice')).toBeInTheDocument();
});

it('shows the incomplete notice alongside zero results too', () => {
  act(() => useSearchStore.setState({ active: true }));
  renderWithQueryClient(
    <ConversationList threads={[]} state="searchEmpty" searchQueryText="none" searchIncomplete />,
  );
  expect(screen.getByTestId('search-incomplete-notice')).toBeInTheDocument();
  expect(screen.getByTestId('empty-state-search')).toBeInTheDocument();
});

it('omits the incomplete notice when search is not active even if backfill is running', () => {
  renderWithQueryClient(<ConversationList searchIncomplete />);
  expect(screen.queryByTestId('search-incomplete-notice')).not.toBeInTheDocument();
});
