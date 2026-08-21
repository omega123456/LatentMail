import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '@/App';
import { ipc } from '@/tests/ipc-mock';
import { useLayoutStore } from '@/stores/layout';
import { useSettingsUiStore } from '@/stores/settings-ui';

const account = {
  id: 'account-1',
  email: 'alex@example.com',
  displayName: 'Alex Morgan',
  avatarUrl: null,
  needsReauthentication: false,
};

async function openUpdates() {
  const user = userEvent.setup();
  ipc.override('list_accounts', [account]);
  ipc.override('list_labels', () => []);
  ipc.override('list_threads', () => ({ items: [], nextCursor: null }));
  render(<App />);
  await screen.findByTestId('mail-layout');
  await user.click(screen.getByRole('button', { name: 'Settings' }));
  await user.click(screen.getByRole('button', { name: 'Updates' }));
  await screen.findByRole('heading', { name: 'Updates' });
  return user;
}

describe('UpdatesSection', () => {
  beforeEach(() => {
    act(() => {
      useLayoutStore.setState({ route: 'mail', hydrated: false });
      useSettingsUiStore.setState({ activeSection: 'general' });
    });
  });

  it('shows the running version as up to date when no update is available', async () => {
    ipc.override('check_for_update', { currentVersion: '0.1.0', available: null });
    await openUpdates();

    const status = await screen.findByTestId('updates-status');
    expect(status).toHaveTextContent('LatentMail 0.1.0');
    expect(screen.getByRole('button', { name: 'Check now' })).toBeInTheDocument();
    expect(screen.getByText('0.1.0', { selector: 'dd' })).toBeInTheDocument();
  });

  it('offers to install an available update and shows its release notes', async () => {
    ipc.override('check_for_update', {
      currentVersion: '0.1.0',
      available: {
        version: '0.1.1',
        notes: 'Fixes a crash.\nImproves attachment previews.',
        dateMillis: null,
      },
    });
    await openUpdates();

    const section = await screen.findByTestId('settings-updates-section');
    const status = within(section).getByTestId('updates-status');
    expect(status).toHaveTextContent('LatentMail 0.1.1 is available');
    expect(within(status).getByRole('button', { name: 'Install and restart' })).toBeInTheDocument();
    const notes = within(section).getByTestId('updates-notes');
    expect(notes).toHaveTextContent('Fixes a crash.');
    expect(notes).toHaveTextContent('Improves attachment previews.');
  });

  it('offers hourly/5-hour/daily/weekly/off check intervals and persists the change', async () => {
    ipc.override('check_for_update', { currentVersion: '0.1.0', available: null });
    const writes: Array<{ key: string; value: unknown }> = [];
    ipc.override('write_setting', (args) => {
      writes.push(args as { key: string; value: unknown });
    });
    const user = await openUpdates();

    const select = screen.getByRole('combobox', { name: 'Check for updates' });
    expect(select).toHaveTextContent('Every day');

    await user.click(select);
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Every hour',
      'Every 5 hours',
      'Every day',
      'Every 7 days',
      'Off',
    ]);
    await user.click(screen.getByRole('option', { name: 'Off' }));

    expect(writes).toContainEqual({ key: 'updateCheckInterval', value: 'off' });
  });

  it('confirms with a toast when a manual check finds no update', async () => {
    let checks = 0;
    ipc.override('check_for_update', () => {
      checks += 1;
      return { currentVersion: '0.1.0', available: null };
    });
    const user = await openUpdates();
    const checksBeforeClick = checks;

    await user.click(screen.getByRole('button', { name: 'Check now' }));

    expect(await screen.findByText('LatentMail 0.1.0 is up to date.')).toBeInTheDocument();
    expect(checks).toBeGreaterThan(checksBeforeClick);
  });

  it('reports a failed manual check with an error toast', async () => {
    let shouldFail = false;
    ipc.override('check_for_update', () => {
      if (shouldFail) throw new Error('network down');
      return { currentVersion: '0.1.0', available: null };
    });
    const user = await openUpdates();
    shouldFail = true;

    await user.click(screen.getByRole('button', { name: 'Check now' }));

    expect(await screen.findByText('Couldn’t check for updates.')).toBeInTheDocument();
  });

  it('toggles install on quit and persists the change', async () => {
    ipc.override('check_for_update', { currentVersion: '0.1.0', available: null });
    const writes: Array<{ key: string; value: unknown }> = [];
    ipc.override('write_setting', (args) => {
      writes.push(args as { key: string; value: unknown });
    });
    const user = await openUpdates();

    const toggle = screen.getByRole('switch', { name: 'Install on quit' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await user.click(toggle);

    expect(writes).toContainEqual({ key: 'installUpdateOnQuit', value: false });
  });
});
