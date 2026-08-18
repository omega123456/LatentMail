import { act, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AccountsSection } from '@/components/settings/AccountsSection';
import { renderWithQueryClient } from '@/tests/render-with-query-client';
import { ipc } from '@/tests/ipc-mock';

function renderWithoutRetry(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const healthy = {
  id: 'account-1',
  email: 'alex@example.com',
  displayName: 'Alex Morgan',
  avatarUrl: null,
  needsReauthentication: false,
};

const expired = {
  id: 'account-2',
  email: 'needs-attention@example.com',
  displayName: 'Needs Attention',
  avatarUrl: null,
  needsReauthentication: true,
};

describe('AccountsSection', () => {
  beforeEach(() => {
    ipc.reset();
  });

  it('shows a loading state before accounts resolve', () => {
    ipc.override('list_accounts', () => new Promise(() => undefined));
    renderWithQueryClient(<AccountsSection />);
    expect(screen.getByText('Loading accounts…')).toBeInTheDocument();
  });

  it('shows an error state when accounts fail to load', async () => {
    ipc.override('list_accounts', () => {
      throw new Error('boom');
    });
    renderWithoutRetry(<AccountsSection />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load your accounts.");
  });

  it('lists every account with avatar, name and address, warning the expired one', async () => {
    ipc.override('list_accounts', [healthy, expired]);
    renderWithQueryClient(<AccountsSection />);

    expect(await screen.findByText('Alex Morgan')).toBeInTheDocument();
    expect(screen.getByText('alex@example.com')).toBeInTheDocument();
    expect(screen.getByText('Needs Attention')).toBeInTheDocument();
    expect(screen.getByText('needs-attention@example.com')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Sign-in expired');
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('reconnects an expired account through begin_reauthentication', async () => {
    const user = userEvent.setup();
    ipc.override('list_accounts', [expired]);
    const reauth = vi.fn();
    ipc.override('begin_reauthentication', reauth);
    renderWithQueryClient(<AccountsSection />);

    await user.click(await screen.findByRole('button', { name: 'Reconnect' }));

    expect(reauth).toHaveBeenCalledWith({ accountId: 'account-2' });
  });

  it('begins the normal sign-in flow from Add account', async () => {
    const user = userEvent.setup();
    ipc.override('list_accounts', [healthy]);
    const beginSignIn = vi.fn();
    ipc.override('begin_sign_in', beginSignIn);
    renderWithQueryClient(<AccountsSection />);

    await user.click(await screen.findByRole('button', { name: 'Add account' }));

    expect(beginSignIn).toHaveBeenCalled();
  });

  it('removing an account requires confirmation naming the address, then calls remove_account', async () => {
    const user = userEvent.setup();
    ipc.override('list_accounts', [healthy]);
    const removeAccount = vi.fn();
    ipc.override('remove_account', removeAccount);
    renderWithQueryClient(<AccountsSection />);

    await user.click(await screen.findByRole('button', { name: 'Remove alex@example.com' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('alex@example.com');
    expect(dialog).toHaveTextContent('cached mail');
    expect(removeAccount).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Remove account' }));

    await waitFor(() => expect(removeAccount).toHaveBeenCalledWith({ accountId: 'account-1' }));
  });

  it('cancelling the confirmation does not remove the account', async () => {
    const user = userEvent.setup();
    ipc.override('list_accounts', [healthy]);
    const removeAccount = vi.fn();
    ipc.override('remove_account', removeAccount);
    renderWithQueryClient(<AccountsSection />);

    await user.click(await screen.findByRole('button', { name: 'Remove alex@example.com' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    await act(async () => undefined);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(removeAccount).not.toHaveBeenCalled();
  });
});
