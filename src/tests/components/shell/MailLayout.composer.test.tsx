import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import App from '@/App';
import { ipc } from '@/tests/ipc-mock';
import { useComposeStore } from '@/stores/compose';
import { accountOne, resetAppShellStores } from '@/tests/components/shell/app-shell-helpers';

beforeEach(() => {
  resetAppShellStores();
});

beforeEach(() => act(() => useComposeStore.getState().close()));

it('mounts the composer over the mail surface, openable by driving the compose store directly', async () => {
  ipc.override('list_accounts', [accountOne]);
  render(<App />);
  await screen.findByRole('button', { name: 'Collapse sidebar' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

  act(() => {
    useComposeStore.getState().open({
      id: 'session-1',
      mode: 'new',
      accountId: 'account-1',
      from: 'alex@example.com',
      recipients: { to: [], cc: [], bcc: [] },
      subject: '',
      html: '',
    });
  });
  expect(await screen.findByRole('dialog', { name: 'New Message' })).toBeInTheDocument();
});

it('opens a blank composer from the expanded Compose control', async () => {
  ipc.override('list_accounts', [accountOne]);
  render(<App />);
  const compose = await screen.findByRole('button', { name: 'Compose' });
  await userEvent.setup().click(compose);
  expect(useComposeStore.getState().session).toMatchObject({ mode: 'new' });
});
