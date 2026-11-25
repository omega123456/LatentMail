import { beforeEach, expect, it } from 'vitest';
import { selectHasCommittedRecipient, useComposeStore } from '@/stores/compose';
import { openSession } from '@/tests/stores/compose-helpers';

const MANY_HIDDEN_RECIPIENTS = 4;

beforeEach(() => useComposeStore.getState().close());

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
  useComposeStore.getState().setOverflowCount('to', MANY_HIDDEN_RECIPIENTS);
  expect(useComposeStore.getState().session?.overflow).toEqual({
    to: MANY_HIDDEN_RECIPIENTS,
    cc: 0,
    bcc: 0,
  });
});

it('derives recipient readiness from a committed To recipient', () => {
  expect(selectHasCommittedRecipient(useComposeStore.getState())).toBe(false);
  useComposeStore.getState().commitRecipient('to', 'a@example.com');
  expect(selectHasCommittedRecipient(useComposeStore.getState())).toBe(true);
});
