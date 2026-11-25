import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import App from '@/App';
import { ipc } from '@/tests/ipc-mock';
import { captureConsole } from '@/tests/console';
import {
  accountOne,
  resetAppShellStores,
  workLabel,
} from '@/tests/components/shell/app-shell-helpers';

beforeEach(() => {
  resetAppShellStores();
});

it('creates a label through the real create_label IPC command', async () => {
  const user = userEvent.setup();
  ipc.override('list_accounts', [accountOne]);
  ipc.override('list_labels', [workLabel]);
  let created: unknown;
  ipc.override('create_label', (request) => {
    created = request;
    return { ...workLabel, id: 'Label_2', name: (request as { name: string }).name };
  });
  render(<App />);
  await screen.findByText('Work');
  await user.click(screen.getByRole('button', { name: 'Create label' }));
  await user.type(screen.getByPlaceholderText('Label name'), 'Contracts');
  await user.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(created).toMatchObject({ accountId: 'account-1', name: 'Contracts' }));
});

it('renames and deletes a label through the real IPC commands', async () => {
  const consoleInfo = captureConsole('info');
  const user = userEvent.setup();
  ipc.override('list_accounts', [accountOne]);
  ipc.override('list_labels', [workLabel]);
  let renamed: unknown;
  let deleted: unknown;
  ipc.override('rename_label', (request) => {
    renamed = request;
    ipc.emit('mail://changed', { accountId: 'account-1' });
    return { ...workLabel, name: (request as { name: string }).name };
  });
  ipc.override('delete_label', (request) => {
    deleted = request;
    ipc.emit('mail://changed', { accountId: 'account-1' });
    return undefined;
  });
  render(<App />);
  await screen.findByText('Work');

  await user.click(screen.getByRole('button', { name: 'Edit Work' }));
  const input = screen.getByDisplayValue('Work');
  await user.clear(input);
  await user.type(input, 'Projects');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(renamed).toMatchObject({
      accountId: 'account-1',
      labelId: 'Label_1',
      name: 'Projects',
    }),
  );

  await user.click(screen.getByRole('button', { name: 'Delete Work' }));
  await user.click(screen.getByRole('button', { name: 'Yes' }));
  await waitFor(() =>
    expect(deleted).toMatchObject({ accountId: 'account-1', labelId: 'Label_1' }),
  );
  expect(consoleInfo).toHaveBeenCalledWith('event mail://changed {"accountId":"account-1"}');
});
