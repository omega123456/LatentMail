import { act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMultiSelectStore } from '@/stores/multi-select';
import { useSearchStore } from '@/stores/search';
import { useSelectionStore } from '@/stores/selection';
import { useToastStore } from '@/stores/toast';

export function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

export const thread = {
  id: 'thread-1',
  subject: 'Thread',
  sender: { display: '(No sender)', address: null },
  sentRecipient: null,
  latestAt: 0,
  messageCount: 1,
  isUnread: true,
  isStarred: false,
  hasAttachments: false,
  hasDraft: false,
};

export function resetHookTestStores() {
  act(() => {
    useSelectionStore.setState({ activeMailboxId: 'INBOX' });
    useMultiSelectStore.setState({ selectedIds: new Set(['thread-1']), anchorId: 'thread-1' });
    useToastStore.setState({ toasts: [] });
    useSearchStore.setState({
      draft: '',
      submittedQuery: '',
      scope: { kind: 'default' },
      active: false,
      panelOpen: false,
    });
  });
}
