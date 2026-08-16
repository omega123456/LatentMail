import { render, screen } from '@testing-library/react';
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

  it('gives the account control a real accessible label since it is the sole identity cue when collapsed', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CollapsedRail
          accounts={accounts}
          activeAccountId="account-1"
          activeMailboxId="INBOX"
          mailboxes={mailboxes}
          onSelectAccount={vi.fn()}
          onSelectMailbox={vi.fn()}
          onExpand={vi.fn()}
          onSettings={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('img', { name: 'a@example.com' })).toBeInTheDocument();
  });
});
