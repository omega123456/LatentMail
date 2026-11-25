import { beforeEach, expect, it } from 'vitest';
import { useComposeStore } from '@/stores/compose';
import { openSession } from '@/tests/stores/compose-helpers';

const HIDDEN_RECIPIENTS = 2;

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
  const resize = (viewport: { width: number; height: number }) => {
    window.innerWidth = viewport.width;
    window.innerHeight = viewport.height;
  };
  const original = { width: window.innerWidth, height: window.innerHeight };
  try {
    resize({ width: 1280, height: 800 });
    openSession();
    expect(useComposeStore.getState().session?.dimensions).toEqual({ width: 538, height: 500 });

    useComposeStore.getState().close();
    resize({ width: 1920, height: 1080 });
    openSession();
    expect(useComposeStore.getState().session?.dimensions).toEqual({ width: 806, height: 670 });

    useComposeStore.getState().close();
    resize({ width: 3440, height: 1440 });
    openSession();
    expect(useComposeStore.getState().session?.dimensions).toEqual({ width: 840, height: 820 });

    useComposeStore.getState().close();
    resize({ width: 500, height: 400 });
    openSession();
    expect(useComposeStore.getState().session?.dimensions).toEqual({ width: 452, height: 360 });
  } finally {
    resize(original);
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
  useComposeStore.getState().setOverflowCount('to', HIDDEN_RECIPIENTS);
  useComposeStore.getState().toggleQuote();
  expect(useComposeStore.getState().session).toBeNull();
  useComposeStore.getState().close();
  expect(useComposeStore.getState().session).toBeNull();
});

it('toggles open/closed, starting closed', () => {
  openSession({ quote: { html: '<p>Hi</p>', attribution: 'Attribution' } });
  expect(useComposeStore.getState().session?.quoteOpen).toBe(false);
  useComposeStore.getState().toggleQuote();
  expect(useComposeStore.getState().session?.quoteOpen).toBe(true);
  useComposeStore.getState().toggleQuote();
  expect(useComposeStore.getState().session?.quoteOpen).toBe(false);
});
