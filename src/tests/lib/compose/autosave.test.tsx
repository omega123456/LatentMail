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
    expect(toDraftRequest(useComposeStore.getState().session!)).toMatchObject({
      draftId: 'draft-1',
      attachments: [{ id: 'part', filename: 'a.pdf' }],
    });
  });

  it('autosaves after the debounce and records the returned stable draft id', async () => {
    vi.useFakeTimers();
    const save = vi.fn(() => ({ operationId: 'op', draftId: 'draft-2' }));
    ipc.override('save_compose_draft', save);
    act(() => useComposeStore.getState().markSaved());
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
  });
});
