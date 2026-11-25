import { beforeEach, expect, it } from 'vitest';
import {
  selectHasReadingAttachment,
  selectQualifiesForDraft,
  useComposeStore,
} from '@/stores/compose';
import { openSession } from '@/tests/stores/compose-helpers';

beforeEach(() => useComposeStore.getState().close());

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
