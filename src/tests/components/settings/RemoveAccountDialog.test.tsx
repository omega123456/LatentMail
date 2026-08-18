import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RemoveAccountDialog } from '@/components/settings/RemoveAccountDialog';

const account = {
  id: 'account-1',
  email: 'alex@example.com',
  displayName: 'Alex Morgan',
  avatarUrl: null,
  needsReauthentication: false,
};

describe('RemoveAccountDialog', () => {
  it('names the address and states that cached mail will be deleted', () => {
    render(
      <RemoveAccountDialog
        account={account}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        removing={false}
      />,
    );

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('alex@example.com');
    expect(dialog).toHaveTextContent(/delete.*cached mail/i);
  });

  it('calls onConfirm from the destructive action', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <RemoveAccountDialog
        account={account}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
        removing={false}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Remove account' }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('calls onCancel from Cancel', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <RemoveAccountDialog
        account={account}
        onConfirm={vi.fn()}
        onCancel={onCancel}
        removing={false}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('disables the destructive action while removal is in progress', () => {
    render(
      <RemoveAccountDialog account={account} onConfirm={vi.fn()} onCancel={vi.fn()} removing />,
    );

    expect(screen.getByRole('button', { name: 'Removing…' })).toBeDisabled();
  });
});
