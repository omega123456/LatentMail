import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { CollapsedRail } from '@/components/sidebar/CollapsedRail';

const accounts = [
  {
    id: 'account-1',
    email: 'a@example.com',
    displayName: 'A',
    avatarUrl: null,
    needsReauthentication: false,
  },
];
const mailboxes = [{ id: 'INBOX', name: 'Inbox', unreadCount: 1 }];

describe('CollapsedRail', () => {
  it('selects mail, expands, and opens settings', async () => {
    const user = userEvent.setup();
    const onSelectMailbox = vi.fn();
    const onExpand = vi.fn();
    const onSettings = vi.fn();
    const onCompose = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CollapsedRail
          accounts={accounts}
          activeAccountId="account-1"
          activeMailboxId="INBOX"
          mailboxes={mailboxes}
          labels={[]}
          onSelectAccount={vi.fn()}
          onSelectMailbox={onSelectMailbox}
          onExpand={onExpand}
          onSettings={onSettings}
          onCompose={onCompose}
        />
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole('button', { name: /Inbox/ }));
    await user.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onSelectMailbox).toHaveBeenCalledWith('INBOX');
    expect(onExpand).toHaveBeenCalledOnce();
    expect(onSettings).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Compose' }));
    expect(onCompose).toHaveBeenCalledOnce();
  });

  it('shows colored labels with tooltips and selects a label mailbox', async () => {
    const user = userEvent.setup();
    const onSelectMailbox = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CollapsedRail
          accounts={accounts}
          activeAccountId="account-1"
          activeMailboxId="work"
          mailboxes={mailboxes}
          labels={[
            { id: 'work', name: 'Work', unreadCount: 3, color: 'blue' },
            { id: 'personal', name: 'Personal', unreadCount: 0, color: 'green' },
          ]}
          onSelectAccount={vi.fn()}
          onSelectMailbox={onSelectMailbox}
          onExpand={vi.fn()}
          onSettings={vi.fn()}
        />
      </QueryClientProvider>,
    );
    const labels = within(screen.getByRole('navigation', { name: 'Labels' }));
    expect(labels.getByRole('button', { name: 'Work' })).toHaveAttribute('title', 'Work');
    expect(labels.getByRole('button', { name: 'Work' })).toHaveAttribute('aria-current', 'page');
    const personal = labels.getByRole('button', { name: 'Personal' });
    expect(personal).not.toHaveAttribute('aria-current');
    await user.click(personal);
    expect(onSelectMailbox).toHaveBeenCalledWith('personal');
  });

  it('gives the account control a real accessible label since it is the sole identity cue when collapsed', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CollapsedRail
          accounts={accounts}
          activeAccountId="account-1"
          activeMailboxId="INBOX"
          mailboxes={mailboxes}
          labels={[]}
          onSelectAccount={vi.fn()}
          onSelectMailbox={vi.fn()}
          onExpand={vi.fn()}
          onSettings={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('img', { name: 'a@example.com' })).toBeInTheDocument();
  });

  it('shows the search icon with the query as its tooltip when search is active', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CollapsedRail
          accounts={accounts}
          activeAccountId="account-1"
          activeMailboxId="INBOX"
          mailboxes={mailboxes}
          labels={[]}
          onSelectAccount={vi.fn()}
          onSelectMailbox={vi.fn()}
          onExpand={vi.fn()}
          onSettings={vi.fn()}
          searchActive
          searchQuery="from:anna"
        />
      </QueryClientProvider>,
    );
    const indicator = screen.getByTestId('collapsed-search-indicator');
    expect(indicator).toHaveAttribute('title', 'from:anna');
  });

  it('omits the search indicator when search is not active', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CollapsedRail
          accounts={accounts}
          activeAccountId="account-1"
          activeMailboxId="INBOX"
          mailboxes={mailboxes}
          labels={[]}
          onSelectAccount={vi.fn()}
          onSelectMailbox={vi.fn()}
          onExpand={vi.fn()}
          onSettings={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId('collapsed-search-indicator')).not.toBeInTheDocument();
  });
});
