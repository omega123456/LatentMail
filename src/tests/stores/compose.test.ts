import { beforeEach, describe, expect, it } from 'vitest';
import {
  type OpenComposeArgs,
  selectHasCommittedRecipient,
  selectHasReadingAttachment,
  selectQualifiesForDraft,
  useComposeStore,
} from '@/stores/compose';

const openSession = (overrides: Partial<OpenComposeArgs> = {}) =>
  useComposeStore.getState().open({
    id: 'session',
    mode: 'new',
    accountId: 'account',
    from: 'me@example.com',
    recipients: { to: [], cc: [], bcc: [] },
    subject: '',
    html: '',
    ...overrides,
  });

describe('compose store', () => {
  beforeEach(() => useComposeStore.getState().close());

  it('keeps ephemeral fields and marks edits dirty', () => {
    openSession();
    useComposeStore.getState().setSubject('Hello');
    useComposeStore.getState().setHtml('<p>Body</p>');
    useComposeStore.getState().setDimensions({ width: 600, height: 500 });
    expect(useComposeStore.getState().session).toMatchObject({
      dirty: true,
      subject: 'Hello',
      html: '<p>Body</p>',
      dimensions: { width: 600, height: 500 },
    });
  });

  it('defaults dimensions, reveal state and quote state when none are supplied at open', () => {
    openSession();
    expect(useComposeStore.getState().session).toMatchObject({
      dimensions: { width: 512, height: 500 },
      ccBccRevealed: false,
      overflow: { to: 0, cc: 0, bcc: 0 },
      quote: null,
      quoteOpen: false,
    });
  });

  it('scales the opening size to the viewport, between its floor and its ceiling', () => {
    const resize = (width: number, height: number) => {
      window.innerWidth = width;
      window.innerHeight = height;
    };
    const original = { width: window.innerWidth, height: window.innerHeight };
    try {

      resize(1280, 800);
      openSession();
      expect(useComposeStore.getState().session?.dimensions).toEqual({ width: 538, height: 500 });


      useComposeStore.getState().close();
      resize(1920, 1080);
      openSession();
      expect(useComposeStore.getState().session?.dimensions).toEqual({ width: 806, height: 670 });


      useComposeStore.getState().close();
      resize(3440, 1440);
      openSession();
      expect(useComposeStore.getState().session?.dimensions).toEqual({ width: 840, height: 820 });


      useComposeStore.getState().close();
      resize(500, 400);
      openSession();
      expect(useComposeStore.getState().session?.dimensions).toEqual({ width: 452, height: 360 });
    } finally {
      resize(original.width, original.height);
    }
  });

  it('accepts an initial quote at open', () => {
    openSession({ quote: { html: '<p>Original</p>', attribution: 'On Mar 1, Elena wrote:' } });
    expect(useComposeStore.getState().session?.quote).toEqual({
      html: '<p>Original</p>',
      attribution: 'On Mar 1, Elena wrote:',
    });
  });

  it('starts already revealed when Cc or Bcc already holds a recipient at open (e.g. a future reply-all)', () => {
    openSession({ recipients: { to: [], cc: ['a@example.com'], bcc: [] } });
    expect(useComposeStore.getState().session?.ccBccRevealed).toBe(true);
    openSession({ recipients: { to: [], cc: [], bcc: ['b@example.com'] } });
    expect(useComposeStore.getState().session?.ccBccRevealed).toBe(true);
  });

  it('field setters and close are no-ops with no open session', () => {
    expect(useComposeStore.getState().session).toBeNull();
    useComposeStore.getState().setSubject('ignored');
    useComposeStore.getState().setHtml('<p>ignored</p>');
    useComposeStore.getState().setDimensions({ width: 1, height: 1 });
    useComposeStore.getState().commitRecipient('to', 'ignored@example.com');
    useComposeStore.getState().removeRecipient('to', 0);
    useComposeStore.getState().removeLastRecipient('to');
    useComposeStore.getState().revealCcBcc();
    useComposeStore.getState().setOverflowCount('to', 2);
    useComposeStore.getState().toggleQuote();
    expect(useComposeStore.getState().session).toBeNull();
    useComposeStore.getState().close();
    expect(useComposeStore.getState().session).toBeNull();
  });

  describe('recipients', () => {
    beforeEach(() => openSession());

    it('commits a trimmed chip and strips a trailing comma', () => {
      useComposeStore.getState().commitRecipient('to', '  priya@example.com,  ');
      expect(useComposeStore.getState().session?.recipients.to).toEqual(['priya@example.com']);
      expect(useComposeStore.getState().session?.dirty).toBe(true);
    });

    it('is a no-op for empty or comma-only input', () => {
      useComposeStore.getState().commitRecipient('to', '   ');
      useComposeStore.getState().commitRecipient('to', ',,,');
      expect(useComposeStore.getState().session?.recipients.to).toEqual([]);
    });

    it('suppresses a duplicate by extracted address, case-insensitively', () => {
      useComposeStore.getState().commitRecipient('to', 'Priya Raman <PRIYA@example.com>');
      useComposeStore.getState().commitRecipient('to', 'priya@example.com');
      expect(useComposeStore.getState().session?.recipients.to).toEqual([
        'Priya Raman <PRIYA@example.com>',
      ]);
    });

    it('removes a chip by index and the last chip via backspace semantics', () => {
      useComposeStore.getState().commitRecipient('cc', 'a@example.com');
      useComposeStore.getState().commitRecipient('cc', 'b@example.com');
      useComposeStore.getState().removeRecipient('cc', 0);
      expect(useComposeStore.getState().session?.recipients.cc).toEqual(['b@example.com']);
      useComposeStore.getState().removeLastRecipient('cc');
      expect(useComposeStore.getState().session?.recipients.cc).toEqual([]);

      useComposeStore.getState().removeLastRecipient('cc');
      expect(useComposeStore.getState().session?.recipients.cc).toEqual([]);
    });

    it('reveals Cc/Bcc without marking the session dirty', () => {
      useComposeStore.getState().revealCcBcc();
      expect(useComposeStore.getState().session?.ccBccRevealed).toBe(true);
      expect(useComposeStore.getState().session?.dirty).toBe(false);
    });

    it('tracks overflow count per role', () => {
      useComposeStore.getState().setOverflowCount('to', 4);
      expect(useComposeStore.getState().session?.overflow).toEqual({ to: 4, cc: 0, bcc: 0 });
    });

    it('derives recipient readiness from a committed To recipient', () => {
      expect(selectHasCommittedRecipient(useComposeStore.getState())).toBe(false);
      useComposeStore.getState().commitRecipient('to', 'a@example.com');
      expect(selectHasCommittedRecipient(useComposeStore.getState())).toBe(true);
    });
  });

  describe('quote disclosure', () => {
    it('toggles open/closed, starting closed', () => {
      openSession({ quote: { html: '<p>Hi</p>', attribution: 'Attribution' } });
      expect(useComposeStore.getState().session?.quoteOpen).toBe(false);
      useComposeStore.getState().toggleQuote();
      expect(useComposeStore.getState().session?.quoteOpen).toBe(true);
      useComposeStore.getState().toggleQuote();
      expect(useComposeStore.getState().session?.quoteOpen).toBe(false);
    });
  });

  describe('attachment and draft lifecycle state', () => {
    it('settles, fails, removes, and never resurrects a cancelled attachment', () => {
      openSession();
      const store = useComposeStore.getState();
      store.addReadingAttachment({
        localId: 'one',
        filename: 'one.pdf',
        mimeType: 'application/pdf',
        contentId: null,
      });
      expect(selectHasReadingAttachment(useComposeStore.getState())).toBe(true);
      store.settleAttachment('one', {
        id: 'part-one',
        path: '/stage/one.pdf',
        assetUrl: 'asset://one',
        size: 10,
      });
      expect(useComposeStore.getState().session?.attachments[0]).toMatchObject({
        state: 'settled',
        size: 10,
      });
      store.failAttachment('one', 'broken');
      expect(useComposeStore.getState().session?.attachments[0]).toMatchObject({
        state: 'failed',
        error: 'broken',
      });
      store.removeAttachment('one');
      store.settleAttachment('one', {
        id: 'late',
        path: '/late',
        assetUrl: 'asset://late',
        size: 1,
      });
      store.failAttachment('one', 'late');
      expect(useComposeStore.getState().session?.attachments).toEqual([]);
    });

    it('tracks draft status/id and the exact draft qualification selector', () => {
      openSession();
      const store = useComposeStore.getState();
      expect(selectQualifiesForDraft(useComposeStore.getState())).toBe(false);
      store.setDraftStatus('saving');
      store.setDraftId('draft-1');
      store.setSubject('Subject');
      expect(selectQualifiesForDraft(useComposeStore.getState())).toBe(true);
      store.markSaved();
      expect(useComposeStore.getState().session).toMatchObject({
        draftId: 'draft-1',
        draftStatus: 'saved',
        dirty: false,
      });
    });
  });
});
