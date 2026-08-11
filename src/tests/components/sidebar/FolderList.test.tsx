import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { FolderList } from '@/components/sidebar/FolderList';
import { sidebarMailboxes } from '@/tests/fixtures';

it('renders fixed folders, counts, and mailbox selection', async () => {
  const select = vi.fn();
  const user = userEvent.setup();
  render(
    <FolderList
      activeMailboxId="INBOX"
      mailboxes={sidebarMailboxes}
      showUnreadCounts
      onSelect={select}
    />,
  );
  expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
    'Inbox3',
    'Starred',
    'Drafts1',
    'Sent',
    'Spam',
    'Trash',
  ]);
  expect(screen.getByRole('button', { name: 'Inbox' })).toHaveAttribute('aria-current', 'page');
  await user.click(screen.getByRole('button', { name: 'Drafts' }));
  expect(select).toHaveBeenCalledWith('DRAFT');
});

it('uses icon-only navigation without counts in the collapsed rail', () => {
  render(
    <FolderList
      activeMailboxId="INBOX"
      mailboxes={sidebarMailboxes}
      showUnreadCounts
      collapsed
      onSelect={() => undefined}
    />,
  );
  expect(screen.getByRole('button', { name: 'Inbox' })).toHaveTextContent('');
  expect(screen.queryByText('3')).not.toBeInTheDocument();
});
