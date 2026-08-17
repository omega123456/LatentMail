import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '@/App';
import { ipc } from '@/tests/ipc-mock';
import { useSelectionStore } from '@/stores/selection';
import { useSyncStore } from '@/stores/sync';
import { useComposeStore } from '@/stores/compose';

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

describe('MailLayout — composer mounting', () => {
  beforeEach(() => act(() => useComposeStore.getState().close()));

  it('mounts the composer over the mail surface, openable by driving the compose store directly', async () => {
    ipc.override('list_accounts', [account]);
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
    ipc.override('list_accounts', [account]);
    render(<App />);
    const compose = await screen.findByRole('button', { name: 'Compose' });
    await userEvent.setup().click(compose);
    expect(useComposeStore.getState().session).toMatchObject({ mode: 'new' });
  });
});
