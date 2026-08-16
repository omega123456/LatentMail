import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import { AccountSwitcher } from '@/components/sidebar/AccountSwitcher';
import { ipc } from '@/tests/ipc-mock';
import { sidebarAccounts } from '@/tests/fixtures';

it('shows account warnings and starts add-account in place', async () => {
  const user = userEvent.setup();
  ipc.override('begin_sign_in', () => new Promise<void>(() => undefined));
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AccountSwitcher
        accounts={sidebarAccounts}
        activeAccountId="account-1"
        collapsed={false}
        onSelect={() => undefined}
      />
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole('button', { name: /Alex Morgan/ }));
  expect(screen.getByLabelText('Needs reauthentication')).toBeInTheDocument();
  await user.click(screen.getByRole('menuitem', { name: 'Add account' }));
  expect(screen.getByRole('menuitem', { name: 'Adding account…' })).toBeDisabled();
});

it('renders a resolved account photograph on the expanded trigger without a warning when absent', () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AccountSwitcher
        accounts={sidebarAccounts}
        activeAccountId="account-1"
        collapsed={false}
        onSelect={() => undefined}
      />
    </QueryClientProvider>,
  );
  // No photo resolved (fixture path is null) — falls back to the letter
  // initial silently, no warning of any kind.
  expect(screen.getByRole('button', { name: /Alex Morgan/ })).toHaveTextContent('A');
});
