import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CollapsedRail } from '@/components/sidebar/CollapsedRail';

const accounts = [{ id: 'account-1', email: 'a@example.com', displayName: 'A', avatarUrl: null, needsReauthentication: false }];
const mailboxes = [{ id: 'INBOX', name: 'Inbox', unreadCount: 1 }];

describe('CollapsedRail', () => {
  it('selects mail, expands, and opens settings', async () => {
    const user = userEvent.setup();
    const onSelectMailbox = vi.fn();
    const onExpand = vi.fn();
    const onSettings = vi.fn();
    render(<CollapsedRail accounts={accounts} activeAccountId="account-1" activeMailboxId="INBOX" mailboxes={mailboxes} onSelectAccount={vi.fn()} onSelectMailbox={onSelectMailbox} onExpand={onExpand} onSettings={onSettings} />);
    await user.click(screen.getByRole('button', { name: /Inbox/ }));
    await user.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onSelectMailbox).toHaveBeenCalledWith('INBOX');
    expect(onExpand).toHaveBeenCalledOnce();
    expect(onSettings).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Compose' })).toBeDisabled();
  });
});
