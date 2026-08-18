import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountRow } from '@/components/settings/AccountRow';
import { renderWithQueryClient } from '@/tests/render-with-query-client';
import { ipc } from '@/tests/ipc-mock';

const healthy = {
  id: 'account-1',
  email: 'alex@example.com',
  displayName: 'Alex Morgan',
  avatarUrl: null,
  needsReauthentication: false,
};

describe('AccountRow', () => {
  beforeEach(() => ipc.reset());

  it('shows avatar-initial fallback, display name and address for a healthy account', () => {
    renderWithQueryClient(<AccountRow account={healthy} onRemove={vi.fn()} />);

    expect(screen.getByText('Alex Morgan')).toBeInTheDocument();
    expect(screen.getByText('alex@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  });

  it('shows an inline warning and a working Reconnect action for an account needing re-authentication', async () => {
    const user = userEvent.setup();
    const reauth = vi.fn();
    ipc.override('begin_reauthentication', reauth);
    renderWithQueryClient(
      <AccountRow account={{ ...healthy, needsReauthentication: true }} onRemove={vi.fn()} />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Sign-in expired');
    await user.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(reauth).toHaveBeenCalledWith({ accountId: 'account-1' });
  });

  it('invokes onRemove with the account when the remove control is used', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    renderWithQueryClient(<AccountRow account={healthy} onRemove={onRemove} />);

    await user.click(screen.getByRole('button', { name: 'Remove alex@example.com' }));
    expect(onRemove).toHaveBeenCalledWith(healthy);
  });
});
