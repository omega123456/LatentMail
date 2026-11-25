import { expect, it } from 'vitest';
import { computeRibbonVisibility } from '@/components/actions/ActionRibbon';

it('hides every label-mutating action in Drafts, leaving only delete', () => {
  const visibility = computeRibbonVisibility(['DRAFT']);
  expect(visibility).toMatchObject({
    showReadToggle: false,
    showStar: false,
    showLabels: false,
    showMoveTo: false,
    showSpamToggle: false,
    showDelete: true,
  });
});

it('hides star and delete in Trash', () => {
  const visibility = computeRibbonVisibility(['TRASH']);
  expect(visibility.showStar).toBe(false);
  expect(visibility.showDelete).toBe(false);
});

it('swaps to notSpam mode in Spam', () => {
  expect(computeRibbonVisibility(['SPAM']).spamMode).toBe('notSpam');
  expect(computeRibbonVisibility(['INBOX']).spamMode).toBe('markSpam');
});

it('derives visibility from real label membership, independent of any mailbox selection', () => {
  expect(computeRibbonVisibility(['TRASH']).showDelete).toBe(false);
  expect(computeRibbonVisibility(['TRASH']).showMoveTo).toBe(true);
  expect(computeRibbonVisibility([]).showDelete).toBe(true);
});
