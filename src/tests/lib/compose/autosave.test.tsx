import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOSAVE_DELAY_MS,
  qualifiesForDraft,
  toDraftRequest,
  useComposeAutosave,
} from '@/lib/compose/autosave';
import { useComposeStore } from '@/stores/compose';
import { ipc } from '@/tests/ipc-mock';
import { openSession } from '@/tests/stores/compose-helpers';

const open = () =>
  useComposeStore.getState().open({
    id: 'session',
    mode: 'reply',
    accountId: 'account',
    from: 'me@example.com',
    recipients: { to: ['to@example.com'], cc: ['cc@example.com'], bcc: ['bcc@example.com'] },
    subject: 'Subject',
    html: '<p>Body</p>',
    draftId: 'draft-1',
    threadId: 'thread',
    inReplyTo: '<reply>',
    references: ['<first>'],
    originalMessageId: 'local',
    originalGmailMessageId: 'gmail',
    quote: { html: '<p>Quote</p>', attribution: 'On yesterday' },
    attachments: [
      {
        localId: 'local-part',
        filename: 'a.pdf',
        mimeType: 'application/pdf',
        size: 42,
        state: 'settled',
        staged: { id: 'part', path: '/stage/a.pdf', assetUrl: 'asset://a', size: 42 },
        contentId: null,
        error: null,
      },
      {
        localId: 'reading',
        filename: 'pending',
        mimeType: 'text/plain',
        size: 0,
        state: 'reading',
        staged: null,
        contentId: null,
        error: null,
      },
    ],
  });

beforeEach(() => {
  act(() => {
    useComposeStore.getState().close();
    open();
    useComposeStore.getState().setHtml('<p>Changed</p>');
  });
});

describe('compose autosave', () => {
  it('recognizes the exact qualifying threshold and serializes only staged attachments', () => {
    expect(
      qualifiesForDraft({ recipients: { to: [], cc: ['cc'], bcc: [] }, subject: ' ', html: ' ' }),
    ).toBe(false);
    expect(
      qualifiesForDraft({ recipients: { to: ['to'], cc: [], bcc: [] }, subject: '', html: '' }),
    ).toBe(true);
    const session = useComposeStore.getState().session;
    expect(session && toDraftRequest(session)).toMatchObject({
      draftId: 'draft-1',
      attachments: [{ id: 'part', filename: 'a.pdf' }],
    });
  });

  it('autosaves after the debounce and records the returned stable draft id', async () => {
    vi.useFakeTimers();
    const save = vi.fn(() => ({ operationId: 'op', draftId: 'draft-2' }));
    ipc.override('save_compose_draft', save);
    act(() => useComposeStore.getState().recordDraftSaved('session', null));
    renderHook(() => useComposeAutosave());
    act(() => useComposeStore.getState().setHtml('<p>Autosave this</p>'));
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ draft: expect.anything() }));
    expect(useComposeStore.getState().session).toMatchObject({
      draftId: 'draft-2',
      dirty: false,
      draftStatus: 'saved',
    });
    vi.useRealTimers();
  });

  it('saveNow is a no-op without qualifying content and reports failures', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result } = renderHook(() => useComposeAutosave());
    act(() => {
      useComposeStore.getState().setSubject('');
      useComposeStore.getState().setHtml('');
      useComposeStore.getState().removeLastRecipient('to');
    });
    await act(async () => result.current.saveNow());
    expect(ipc.tauriInvoke).not.toHaveBeenCalledWith('save_compose_draft', expect.anything());
    act(() => useComposeStore.getState().setSubject('again'));
    ipc.override('save_compose_draft', () => Promise.reject(new Error('offline')));
    await act(async () => result.current.saveNow());
    expect(useComposeStore.getState().session).toMatchObject({
      draftStatus: 'failed',
      lifecycleError: 'Couldn’t save draft.',
    });
    error.mockRestore();
  });
});

describe('compose autosave across sessions', () => {
  it('leaves a newly opened session alone when the previous session’s save resolves', async () => {
    let acceptSave: (acceptance: { operationId: string; draftId: string }) => void = () => {};
    ipc.override('save_compose_draft', () => new Promise((resolve) => (acceptSave = resolve)));
    const { result } = renderHook(() => useComposeAutosave());
    let pendingSave: Promise<void> = Promise.resolve();
    act(() => {
      pendingSave = result.current.saveNow();
    });
    act(() => {
      useComposeStore.getState().close();
      openSession({ id: 'reply-session', subject: 'Reply' });
      useComposeStore.getState().setHtml('<p>Reply body</p>');
    });
    await act(async () => {
      acceptSave({ operationId: 'op', draftId: 'draft-of-the-first-session' });
      await pendingSave;
    });
    expect(useComposeStore.getState().session).toMatchObject({
      id: 'reply-session',
      draftId: null,
      dirty: true,
    });
  });

  it('does not report a previous session’s failed save on a newly opened session', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let rejectSave: (reason: Error) => void = () => {};
    ipc.override(
      'save_compose_draft',
      () => new Promise((_resolve, reject) => (rejectSave = reject)),
    );
    const { result } = renderHook(() => useComposeAutosave());
    let pendingSave: Promise<void> = Promise.resolve();
    act(() => {
      pendingSave = result.current.saveNow();
    });
    act(() => {
      useComposeStore.getState().close();
      openSession({ id: 'reply-session', subject: 'Reply' });
    });
    await act(async () => {
      rejectSave(new Error('offline'));
      await pendingSave;
    });
    expect(useComposeStore.getState().session).toMatchObject({
      id: 'reply-session',
      draftStatus: 'idle',
      lifecycleError: null,
    });
    error.mockRestore();
  });
});
