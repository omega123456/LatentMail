import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsShell } from '@/components/settings/SettingsShell';
import { renderWithQueryClient } from '@/tests/render-with-query-client';
import { ipc } from '@/tests/ipc-mock';
import { useLayoutStore } from '@/stores/layout';
import { useSettingsUiStore } from '@/stores/settings-ui';

describe('SettingsShell', () => {
  beforeEach(() => {
    ipc.override('list_accounts', []);
    ipc.override('read_queue_operations', []);
    act(() => {
      useSettingsUiStore.setState({ activeSection: 'general' });
      useLayoutStore.setState({ route: 'settings' });
    });
  });

  it('renders General by default with the nav and content pane', () => {
    renderWithQueryClient(<SettingsShell />);

    expect(screen.getByTestId('settings-shell')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument();
  });

  it('renders real content for Accounts, Keyboard and Queue', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<SettingsShell />);

    await user.click(screen.getByRole('button', { name: 'Accounts' }));
    expect(screen.getByTestId('settings-accounts-section')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Keyboard' }));
    expect(screen.getByTestId('settings-keyboard-section')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Queue' }));
    expect(await screen.findByTestId('settings-queue-section')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Queue' })).toBeInTheDocument();
  });

  it('calls setRoute("mail") and nothing else when Back to Mail is clicked', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<SettingsShell />);

    await user.click(screen.getByRole('button', { name: 'Back to Mail' }));

    expect(useLayoutStore.getState().route).toBe('mail');
  });
});
