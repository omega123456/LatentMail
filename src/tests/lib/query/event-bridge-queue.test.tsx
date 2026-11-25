import { act, render, waitFor } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, type MockInstance, vi } from 'vitest';
import {
  EventBridge,
  MAILBOX_INVALIDATION_DEBOUNCE_MS,
  QUEUE_SNAPSHOT_DEBOUNCE_MS,
} from '@/lib/query/event-bridge';
import { queryKeys } from '@/lib/query/keys';
import type { IpcEventMap } from '@/lib/types/ipc';
import { QueryProvider } from '@/providers/QueryProvider';
import { useComposeStore } from '@/stores/compose';
import { useSyncStore } from '@/stores/sync';
import { useToastStore } from '@/stores/toast';
import { ipc } from '@/tests/ipc-mock';
import { captureConsole } from '@/tests/console';
import {
  resetEventBridgeSyncStore,
  renderEventBridge,
} from '@/tests/lib/query/event-bridge-helpers';

const QUEUE_ITEM_BURST = 20;

beforeEach(() => vi.spyOn(console, 'info').mockImplementation(() => undefined));

afterEach(() => {
  vi.useRealTimers();
  resetEventBridgeSyncStore();
});

it('updates the queue store from queue summaries', async () => {
  render(
    <QueryProvider>
      <EventBridge />
    </QueryProvider>,
  );
  await waitFor(() =>
    expect(ipc.tauriListen).toHaveBeenCalledWith('queue://summary', expect.any(Function)),
  );
  expect(ipc.tauriEmit).toHaveBeenCalledWith('frontend://ready', {});
  act(() =>
    ipc.emit('queue://summary', {
      pending: 3,
      active: 1,
      failed: 0,
      done: 0,
      paused: true,
      suspended: true,
    }),
  );
  expect(useSyncStore.getState().queue).toMatchObject({
    pending: 3,
    active: 1,
    paused: true,
    suspended: true,
  });
});

it('refreshes the mailbox of the account named in a finished mutation event payload', async () => {
  const clientCapture = renderEventBridge();
  await waitFor(() =>
    expect(ipc.tauriListen).toHaveBeenCalledWith('queue://item', expect.any(Function)),
  );
  vi.useFakeTimers();
  const invalidate = vi.spyOn(clientCapture.client(), 'invalidateQueries');
  act(() => {
    ipc.emit('queue://item', {
      id: 'mutation:operation-7',
      status: 'done',
      accountId: 'account-2',
      lane: 'interactive',
    });
    vi.advanceTimersByTime(MAILBOX_INVALIDATION_DEBOUNCE_MS);
  });
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: queryKeys.threadsForAccount('account-2'),
  });
  expect(invalidate).not.toHaveBeenCalledWith({
    queryKey: queryKeys.threadsForAccount('operation-7'),
  });
  vi.useRealTimers();
});

it('coalesces a burst of queue item and summary events into one queue-snapshot invalidation', async () => {
  const clientCapture = renderEventBridge();
  await waitFor(() =>
    expect(ipc.tauriListen).toHaveBeenCalledWith('queue://item', expect.any(Function)),
  );
  vi.useFakeTimers();
  const invalidate = vi.spyOn(clientCapture.client(), 'invalidateQueries');
  act(() => {
    for (let count = 0; count < QUEUE_ITEM_BURST; count += 1)
      ipc.emit('queue://item', {
        id: `queue:account-1:${count}`,
        status: 'active',
        accountId: 'account-1',
        lane: 'interactive',
      });
    ipc.emit('queue://summary', {
      pending: 1,
      active: 1,
      failed: 0,
      done: 0,
      paused: false,
      suspended: false,
    });
    vi.advanceTimersByTime(QUEUE_SNAPSHOT_DEBOUNCE_MS);
  });
  const queueSnapshotCalls = invalidate.mock.calls.filter(
    ([invalidation]) =>
      JSON.stringify(invalidation?.queryKey) === JSON.stringify(queryKeys.queueOperations),
  );
  expect(queueSnapshotCalls).toHaveLength(1);
  vi.useRealTimers();
});

const GMAIL_BAD_REQUEST = 'Gmail request failed with status 400';
const QUEUED_MUTATION_ID = 'mutation:account-1:1';

type QueueItemChange = Omit<IpcEventMap['queue://item'], 'accountId'>;
type InvalidateSpy = MockInstance<QueryClient['invalidateQueries']>;

function openDraftSession() {
  act(() =>
    useComposeStore.getState().open({
      id: 'session-1',
      mode: 'new',
      accountId: 'account-1',
      from: 'me@example.com',
      recipients: { to: [], cc: [], bcc: [] },
      subject: 'Draft',
      html: '',
    }),
  );
}

function latestToastMessage() {
  return useToastStore.getState().toasts.at(-1)?.message;
}

function emitComposeFailure(kind: IpcEventMap['compose://failed']['kind']) {
  act(() =>
    ipc.emit('compose://failed', {
      accountId: 'account-1',
      sessionId: 'session-1',
      kind: kind,
      error: GMAIL_BAD_REQUEST,
    }),
  );
}

function emitQueueItem(change: QueueItemChange) {
  act(() => ipc.emit('queue://item', { ...change, accountId: 'account-1' }));
}

function expectDraftSaveAndSendOutcomesSurfaced() {
  act(() =>
    ipc.emit('draft://saved', {
      accountId: 'account-1',
      sessionId: 'session-1',
      draftId: 'draft-1',
    }),
  );
  expect(useComposeStore.getState().session).toMatchObject({ draftId: 'draft-1', dirty: false });
  act(() => ipc.emit('send://uncertain', { accountId: 'account-1' }));
  expect(latestToastMessage()).toBe('Send status unknown — check Sent and Drafts.');
  act(() =>
    ipc.emit('send://complete', {
      accountId: 'account-1',
      sessionId: 'session-1',
      draftId: 'draft-1',
    }),
  );
  expect(latestToastMessage()).toBe('Message sent.');
}

function expectComposeFailuresSurfaced() {
  emitComposeFailure('draft');
  expect(useComposeStore.getState().session).toMatchObject({
    draftStatus: 'failed',
    lifecycleError: 'Couldn’t save draft.',
  });
  expect(latestToastMessage()).toBe('Message sent.');

  act(() => useComposeStore.getState().close());
  emitComposeFailure('send');
  expect(latestToastMessage()).toBe('Couldn’t send your message.');
}

function expectAccountViewsInvalidated(invalidate: InvalidateSpy) {
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: queryKeys.threadsForAccount('account-1'),
  });
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: queryKeys.searchForAccount('account-1'),
  });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.labels('account-1') });
}

it('handles compose delivery events and ignores unrelated queue items through the shared IPC harness', async () => {
  const consoleError = captureConsole('error');
  const clientCapture = renderEventBridge();
  await waitFor(() =>
    expect(ipc.tauriListen).toHaveBeenCalledWith('draft://saved', expect.any(Function)),
  );
  openDraftSession();
  const invalidate = vi.spyOn(clientCapture.client(), 'invalidateQueries');
  expectDraftSaveAndSendOutcomesSurfaced();
  expectComposeFailuresSurfaced();

  const callsBeforeUnrelatedItem = invalidate.mock.calls.length;
  vi.useFakeTimers();
  emitQueueItem({ id: 'queue:account-1:1', status: 'done', lane: 'background' });
  expect(invalidate).toHaveBeenCalledTimes(callsBeforeUnrelatedItem);

  emitQueueItem({ id: QUEUED_MUTATION_ID, status: 'queued', lane: 'interactive' });
  emitQueueItem({ id: QUEUED_MUTATION_ID, status: 'active', lane: 'interactive' });
  expect(invalidate).toHaveBeenCalledTimes(callsBeforeUnrelatedItem);
  emitQueueItem({ id: QUEUED_MUTATION_ID, status: 'done', lane: 'interactive' });
  act(() => vi.advanceTimersByTime(MAILBOX_INVALIDATION_DEBOUNCE_MS));
  expectAccountViewsInvalidated(invalidate);
  vi.useRealTimers();
  expect(consoleError).toHaveBeenCalledWith(`compose send failed: ${GMAIL_BAD_REQUEST}`);
});
