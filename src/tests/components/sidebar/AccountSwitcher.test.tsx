import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { AccountSwitcher } from '@/components/sidebar/AccountSwitcher';
import { ipc } from '@/tests/ipc-mock';
import { sidebarAccounts } from '@/tests/fixtures';

it('shows account warnings and starts add-account in place', async () => {
  const user = userEvent.setup();
  ipc.override('begin_sign_in', () => new Promise<void>(() => undefined));
  render(
    <AccountSwitcher
      accounts={sidebarAccounts}
      activeAccountId="account-1"
      collapsed={false}
      onSelect={() => undefined}
    />,
  );
  await user.click(screen.getByRole('button', { name: /Alex Morgan/ }));
  expect(screen.getByLabelText('Needs reauthentication')).toBeInTheDocument();
  await user.click(screen.getByRole('menuitem', { name: 'Add account' }));
  expect(screen.getByRole('menuitem', { name: 'Adding account…' })).toBeDisabled();
});
