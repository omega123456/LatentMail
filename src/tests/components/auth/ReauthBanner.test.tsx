import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReauthBanner } from '@/components/auth/ReauthBanner';
import { ipc } from '@/tests/ipc-mock';

describe('ReauthBanner', () => {
  it('starts reauthentication and remains disabled while it is pending', async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    ipc.override('begin_reauthentication', () => new Promise<void>((done) => { resolve = done; }));
    render(<ReauthBanner accountId="account-1" />);
    await user.click(screen.getByRole('button', { name: 'Fix' }));
    expect(screen.getByRole('button', { name: 'Fixing…' })).toBeDisabled();
    resolve();
  });

  it('lets the user retry after an error', async () => {
    const user = userEvent.setup();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ipc.override('begin_reauthentication', () => Promise.reject(new Error('offline')));
    render(<ReauthBanner accountId="account-1" />);
    await user.click(screen.getByRole('button', { name: 'Fix' }));
    expect(await screen.findByRole('button', { name: 'Fix' })).toBeEnabled();
    expect(error).toHaveBeenCalledWith('ipc begin_reauthentication failed: offline');
    error.mockRestore();
  });
});
