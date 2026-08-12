import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '@/App';
import { ipc } from '@/tests/ipc-mock';
import { useSelectionStore } from '@/stores/selection';
import { useSyncStore } from '@/stores/sync';

beforeEach(() => {
  act(() => {
    useSelectionStore.setState({
      activeAccountId: null,
      activeMailboxId: null,
      activeThreadId: null,
      keyboardCursor: null,
    });
    useSyncStore.setState({ accountId: null, lastSynced: null, syncState: 'idle' });
  });
});

const account = {
  id: 'account-1',
  email: 'alex@example.com',
  displayName: 'Alex Morgan',
  avatarUrl: null,
  needsReauthentication: false,
};

const workLabel = {
  id: 'Label_1',
  name: 'Work',
  kind: 'user',
  color: { text: '#ffffff', background: '#4a86e8' },
  messageCount: 1,
  unreadCount: 0,
};

/** `MailLayout` binds the four label-lifecycle mutation hooks to
 * `LabelList` — exercised here through the real component tree (rather
 * than `LabelList`'s own unit tests, which stub the calls) so the wiring
 * itself — the actual IPC command invoked per action — is covered. */
describe('MailLayout — label lifecycle wiring', () => {
  it('creates a label through the real create_label IPC command', async () => {
    const user = userEvent.setup();
    ipc.override('list_accounts', [account]);
    ipc.override('list_labels', [workLabel]);
    let created: unknown;
    ipc.override('create_label', (args) => {
      created = args;
      return { ...workLabel, id: 'Label_2', name: (args as { name: string }).name };
    });
    render(<App />);
    await screen.findByText('Work');
    await user.click(screen.getByRole('button', { name: 'Create label' }));
    await user.type(screen.getByPlaceholderText('Label name'), 'Contracts');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(created).toMatchObject({ accountId: 'account-1', name: 'Contracts' }),
    );
  });

  it('renames and deletes a label through the real IPC commands', async () => {
    const user = userEvent.setup();
    ipc.override('list_accounts', [account]);
    ipc.override('list_labels', [workLabel]);
    let renamed: unknown;
    let deleted: unknown;
    ipc.override('rename_label', (args) => {
      renamed = args;
      return { ...workLabel, name: (args as { name: string }).name };
    });
    ipc.override('delete_label', (args) => {
      deleted = args;
      return undefined;
    });
    render(<App />);
    await screen.findByText('Work');

    await user.click(screen.getByRole('button', { name: 'Edit Work' }));
    const input = screen.getByDisplayValue('Work');
    await user.clear(input);
    await user.type(input, 'Projects');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
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
  });
});
