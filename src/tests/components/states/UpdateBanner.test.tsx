import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateBanner } from '@/components/states/UpdateBanner';
import { renderWithQueryClient } from '@/tests/render-with-query-client';
import { useUpdateStore } from '@/stores/update';
import { useToastStore } from '@/stores/toast';
import { ipc } from '@/tests/ipc-mock';

const available = {
  currentVersion: '0.1.0',
  available: { version: '0.1.1', notes: 'Fixes and improvements.', dateMillis: 1_755_648_000_000 },
};

describe('UpdateBanner', () => {
  beforeEach(() => {
    ipc.reset();
  });

  afterEach(() => {
    act(() => {
      useUpdateStore.setState({ dismissedVersion: null });
      useToastStore.setState({ toasts: [] });
    });
  });

  it('renders nothing when no update is available', async () => {
    const checkForUpdate = vi
      .fn()
      .mockResolvedValue({ currentVersion: '0.1.0', available: null });
    ipc.override('check_for_update', checkForUpdate);
    renderWithQueryClient(<UpdateBanner />);
    await waitFor(() => expect(checkForUpdate).toHaveBeenCalled());
    expect(screen.queryByTestId('update-banner')).not.toBeInTheDocument();
  });

  it('shows the available version and lets the user install it', async () => {
    const user = userEvent.setup();
    ipc.override('check_for_update', available);
    let resolveInstall!: () => void;
    ipc.override(
      'install_update',
      () =>
        new Promise<void>((done) => {
          resolveInstall = done;
        }),
    );
    renderWithQueryClient(<UpdateBanner />);
    expect(await screen.findByTestId('update-banner')).toHaveTextContent(
      'LatentMail 0.1.1 is available. You have 0.1.0.',
    );
    await user.click(screen.getByRole('button', { name: 'Install and restart' }));
    expect(screen.getByRole('button', { name: 'Installing…' })).toBeDisabled();
    resolveInstall();
  });

  it('dismisses the banner and remembers the dismissed version', async () => {
    const user = userEvent.setup();
    ipc.override('check_for_update', available);
    renderWithQueryClient(<UpdateBanner />);
    await screen.findByTestId('update-banner');
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('update-banner')).not.toBeInTheDocument();
    expect(useUpdateStore.getState().dismissedVersion).toBe('0.1.1');
  });

  it('shows a toast when install fails', async () => {
    const user = userEvent.setup();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ipc.override('check_for_update', available);
    ipc.override('install_update', () => Promise.reject(new Error('offline')));
    renderWithQueryClient(<UpdateBanner />);
    await user.click(await screen.findByRole('button', { name: 'Install and restart' }));
    await waitFor(() =>
      expect(useToastStore.getState().toasts).toContainEqual(
        expect.objectContaining({ severity: 'error', message: 'Couldn’t install the update.' }),
      ),
    );
    error.mockRestore();
  });
});
