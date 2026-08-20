import { beforeEach, describe, expect, it } from 'vitest';
import { handleOsIntent } from '@/lib/os/intent';
import { useLayoutStore } from '@/stores/layout';
import { useSelectionStore } from '@/stores/selection';
import { ipc } from '@/tests/ipc-mock';

beforeEach(() => {
  ipc.reset();
  useLayoutStore.setState({ route: 'settings' });
  useSelectionStore.setState({
    activeAccountId: null,
    activeMailboxId: null,
    activeThreadId: null,
    flashThreadId: null,
  });
});

describe('handleOsIntent', () => {
  it('opens an account inbox without selecting a thread', async () => {
    await handleOsIntent({ kind: 'openFolder', accountId: 'account-1' });
    expect(useLayoutStore.getState().route).toBe('mail');
    expect(useSelectionStore.getState()).toMatchObject({
      activeAccountId: 'account-1',
      activeMailboxId: 'INBOX',
      activeThreadId: null,
    });
  });

  it('opens, marks and flashes a notification thread', async () => {
    ipc.useTauriApi();
    await handleOsIntent({ kind: 'openThread', accountId: 'account-1', threadId: 'thread-1' });
    expect(useSelectionStore.getState()).toMatchObject({
      activeAccountId: 'account-1',
      activeMailboxId: 'INBOX',
      activeThreadId: 'thread-1',
      flashThreadId: 'thread-1',
    });
    expect(ipc.tauriInvoke).toHaveBeenCalledWith('mark_thread_read', {
      accountId: 'account-1',
      threadId: 'thread-1',
    });
  });
});
