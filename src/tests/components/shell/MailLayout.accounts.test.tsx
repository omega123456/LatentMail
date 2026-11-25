import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import App from '@/App';
import { ipc } from '@/tests/ipc-mock';
import { useSelectionStore } from '@/stores/selection';
import { captureConsole } from '@/tests/console';
import {
  accountOne,
  accountTwo,
  resetAppShellStores,
} from '@/tests/components/shell/app-shell-helpers';

beforeEach(() => {
  resetAppShellStores();
});

it('promotes the first remaining account when the active account disappears from the list', async () => {
  const consoleInfo = captureConsole('info');
  let accounts = [accountOne, accountTwo];
  ipc.override('list_accounts', () => accounts);
  render(<App />);
  await screen.findByTestId('mail-layout');
  await waitFor(() => expect(useSelectionStore.getState().activeAccountId).toBe('account-1'));

  accounts = [accountTwo];
  act(() => ipc.emit('account://state', accountTwo));

  await waitFor(() => expect(useSelectionStore.getState().activeAccountId).toBe('account-2'));
  expect(consoleInfo).toHaveBeenCalledWith(
    'event account://state {"id":"account-2","email":"sam@example.com","displayName":"Sam Rivera","avatarUrl":null,"needsReauthentication":false}',
  );
});

it('still promotes the first account when the active id is null, as it always has', async () => {
  ipc.override('list_accounts', [accountOne]);
  render(<App />);
  await screen.findByTestId('mail-layout');
  await waitFor(() => expect(useSelectionStore.getState().activeAccountId).toBe('account-1'));
});
