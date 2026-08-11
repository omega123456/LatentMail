import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConversationListContainer } from '@/components/list/ConversationList';
import { useSelectionStore } from '@/stores/selection';
import { ipc } from '@/tests/ipc-mock';
import { useToastStore } from '@/stores/toast';

const thread = {
  id: 'thread-1', subject: 'Mutation', participants: ['A'], latestAt: 0, messageCount: 1,
  isUnread: true, isStarred: false, hasAttachments: false, hasDraft: false,
};

beforeEach(() => {
  useSelectionStore.setState({ activeAccountId: 'account', activeMailboxId: 'INBOX' });
  useToastStore.getState().dismiss();
  ipc.override('list_threads', { items: [thread], nextCursor: null });
});

function renderList() {
  return render(<QueryClientProvider client={new QueryClient()}><ConversationListContainer /></QueryClientProvider>);
}

describe('thread mutations', () => {
  it('optimistically stars a conversation', async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    ipc.override('star_thread', () => new Promise<void>((done) => { resolve = done; }));
    renderList();
    await user.click(await screen.findByLabelText('Star Mutation'));
    expect(screen.getByLabelText('Unstar Mutation')).toBeInTheDocument();
    resolve();
  });

  it('rolls a failed star back and shows an error toast', async () => {
    const user = userEvent.setup();
    ipc.override('star_thread', () => Promise.reject(new Error('offline')));
    renderList();
    await user.click(await screen.findByLabelText('Star Mutation'));
    await waitFor(() => expect(screen.getByLabelText('Star Mutation')).toBeInTheDocument());
    expect(useToastStore.getState().toast?.message).toMatch(/couldn’t update/i);
  });
});
