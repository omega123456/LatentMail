import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { openEditDraft, openForward, openNewMessage, openReply } from '@/lib/compose/entry';
import { useComposeStore } from '@/stores/compose';
import { ipc } from '@/tests/ipc-mock';

const message = {
  id: 'message-1',
  sender: { name: 'Elena', address: 'elena@example.com' },
  recipients: [{ name: 'Me', address: 'me@example.com' }],
  toRecipients: [{ name: 'Me', address: 'me@example.com' }],
  ccRecipients: [{ name: 'Team', address: 'team@example.com' }],
  bccRecipients: [],
  sentAt: new Date('2026-08-13T12:00:00Z'),
  snippet: 'Hello',
  html: '<p>Hello</p>',
  text: 'Hello',
};

beforeEach(() => {
  act(() => useComposeStore.getState().close());
});

describe('compose entry actions', () => {
  it('opens reply and reply-all from Rust-derived context, preserving a display quote', async () => {
    ipc.override('reply_context', {
      to: ['reply@example.com'],
      cc: ['copy@example.com'],
      subject: 'Re: Subject',
      originalMessageId: 'original',
      targetThreadId: 'thread',
      inReplyTo: '<original@example.com>',
      references: ['<prior@example.com>', '<original@example.com>'],
      originalGmailMessageId: 'original',
      displayQuote: { html: '<p>Quote</p>', attribution: 'On Aug 10, 2026, Sender wrote:' },
      attachments: [],
    });

    await act(async () => openReply('reply-all', 'account', 'me@example.com', message));

    expect(useComposeStore.getState().session).toMatchObject({
      mode: 'reply-all',
      accountId: 'account',
      recipients: { to: ['reply@example.com'], cc: ['copy@example.com'], bcc: [] },
      subject: 'Re: Subject',
      quote: { html: '<p>Quote</p>' },
    });
    expect(useComposeStore.getState().session?.attachments).toEqual([]);
  });

  it('does nothing for reply/forward/edit draft actions without a target', async () => {
    await act(async () => openReply('reply', 'account', 'me@example.com', undefined));
    await act(async () => openForward('account', 'me@example.com', undefined));
    await act(async () => openEditDraft('account', 'me@example.com', 'Subject', undefined));
    expect(useComposeStore.getState().session).toBeNull();
  });

  it('opens a forward with blank recipients and a plain-text escaped quote fallback', async () => {
    ipc.override('reply_context', {
      to: [],
      cc: [],
      subject: 'Fwd: Subject',
      originalMessageId: '',
      targetThreadId: null,
      inReplyTo: null,
      references: [],
      originalGmailMessageId: 'original',
      displayQuote: { html: '<p>Quote</p>', attribution: 'On Aug 10, 2026, Sender wrote:' },
      attachments: [],
    });
    await act(async () =>
      openForward('account', 'me@example.com', { ...message, html: null, text: '<safe>\nline' }),
    );
    expect(useComposeStore.getState().session).toMatchObject({
      mode: 'forward',
      recipients: { to: [], cc: [], bcc: [] },
      subject: 'Fwd: Subject',
      quote: { html: '<p>Quote</p>' },
    });
  });

  it('forwarding a message whose only attachment-shaped parts are inline images stages none', async () => {
    ipc.override('reply_context', {
      to: [],
      cc: [],
      subject: 'Fwd: Subject',
      originalMessageId: '',
      targetThreadId: null,
      inReplyTo: null,
      references: [],
      originalGmailMessageId: 'original',
      displayQuote: null,
      attachments: [],
    });
    await act(async () => openForward('account', 'me@example.com', message));
    expect(useComposeStore.getState().session?.attachments).toEqual([]);
    expect(ipc.tauriInvoke).not.toHaveBeenCalledWith(
      'stage_attachment_into_draft',
      expect.anything(),
    );
  });

  it('stages each forwarded attachment through the compose store, independently reporting failures', async () => {
    ipc.override('reply_context', {
      to: [],
      cc: [],
      subject: 'Fwd: Subject',
      originalMessageId: '',
      targetThreadId: null,
      inReplyTo: null,
      references: [],
      originalGmailMessageId: 'original',
      displayQuote: null,
      attachments: [
        { id: 'att-ok', filename: 'report.pdf', mimeType: 'application/pdf', size: 1024 },
        { id: 'att-bad', filename: 'broken.zip', mimeType: 'application/zip', size: 512 },
      ],
    });
    const stageCalls: unknown[] = [];
    ipc.override('stage_attachment_into_draft', (args) => {
      stageCalls.push(args);
      if (args.attachmentId === 'att-bad') return Promise.reject(new Error('Gmail unavailable'));
      return Promise.resolve({
        id: 'staged-ok',
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        path: '/staged/report.pdf',
        contentId: null,
        size: 1024,
      });
    });

    await act(async () => openForward('account', 'me@example.com', message));
    const owner = useComposeStore.getState().session?.id;
    expect(owner).toBeTruthy();
    expect(useComposeStore.getState().session?.attachments).toHaveLength(2);
    expect(stageCalls).toEqual([
      expect.objectContaining({ attachmentId: 'att-ok', owner }),
      expect.objectContaining({ attachmentId: 'att-bad', owner }),
    ]);

    await waitFor(() => {
      const attachments = useComposeStore.getState().session?.attachments ?? [];
      expect(attachments.every((entry) => entry.state !== 'reading')).toBe(true);
    });

    const attachments = useComposeStore.getState().session?.attachments ?? [];
    const ok = attachments.find((entry) => entry.filename === 'report.pdf');
    const bad = attachments.find((entry) => entry.filename === 'broken.zip');
    expect(ok).toMatchObject({ state: 'settled', size: 1024 });
    expect(bad).toMatchObject({ state: 'failed', error: 'Gmail unavailable' });
  });

  it('saves qualifying dirty work before reliably retargeting the composer', async () => {
    act(() =>
      openNewMessage('account', 'me@example.com', { name: 'Priya', address: 'p@example.com' }),
    );
    expect(useComposeStore.getState().session?.recipients.to).toEqual(['Priya <p@example.com>']);
    act(() => useComposeStore.getState().setSubject('Keep this'));
    await act(async () => openNewMessage('other', 'other@example.com'));
    expect(useComposeStore.getState().session).toMatchObject({
      accountId: 'other',
      subject: '',
    });
  });

  it('hydrates a server draft including parts and falls back to the loaded message when no id exists', async () => {
    ipc.override('hydrate_compose_draft', {
      sessionId: 'hydrated',
      accountId: 'account',
      draftId: 'draft-1',
      from: 'me@example.com',
      to: ['to@example.com'],
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      subject: 'Saved',
      html: '<p>Saved</p>',
      quoteHtml: '<p>Quote</p>',
      quotePlain: null,
      mode: 'reply',
      threadId: 'thread',
      inReplyTo: '<id>',
      references: ['<id>'],
      originalMessageId: 'local',
      originalGmailMessageId: 'gmail',
      attachments: [
        {
          id: 'part',
          filename: 'a.pdf',
          mimeType: 'application/pdf',
          size: 12,
          path: '/stage/a.pdf',
          contentId: null,
        },
      ],
    });
    await act(async () =>
      openEditDraft('account', 'me@example.com', 'ignored', {
        ...message,
        draftId: 'draft-1',
      } as typeof message & { draftId: string }),
    );
    expect(useComposeStore.getState().session).toMatchObject({
      id: 'hydrated',
      draftId: 'draft-1',
      threadId: 'thread',
      quote: { html: '<p>Quote</p>' },
    });
    expect(useComposeStore.getState().session?.attachments[0]).toMatchObject({
      localId: 'part',
      state: 'settled',
    });

    act(() => useComposeStore.getState().close());
    await act(async () => openEditDraft('account', 'me@example.com', 'Loaded', message));
    expect(useComposeStore.getState().session).toMatchObject({
      mode: 'draft',
      subject: 'Loaded',
      html: '<p>Hello</p>',
    });
  });
});
