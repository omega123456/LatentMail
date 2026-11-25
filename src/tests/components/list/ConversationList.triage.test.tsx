import { act, fireEvent, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ConversationList } from '@/components/list/ConversationList';
import { renderWithQueryClient } from '@/tests/render-with-query-client';
import { resetConversationListStores } from '@/tests/components/list/conversation-list-helpers';

const TRIAGE_CALLS = 2;

beforeEach(() => {
  resetConversationListStores();
});

it('uses the registry bindings for selected conversations and ignores focused inputs', () => {
  const onTriage = vi.fn();
  renderWithQueryClient(
    <>
      <input aria-label="filter" />
      <ConversationList onTriage={onTriage} />
    </>,
  );
  fireEvent.click(screen.getByLabelText('Open Q3 Marketing Strategy Review'), { ctrlKey: true });
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'I', shiftKey: true })));
  expect(onTriage).toHaveBeenLastCalledWith(['thread-1'], {
    kind: 'label',
    add: [],
    remove: ['UNREAD'],
  });
  act(() =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'J', ctrlKey: true, shiftKey: true })),
  );
  expect(onTriage).toHaveBeenLastCalledWith(['thread-1'], {
    kind: 'move',
    destination: 'INBOX',
  });
  screen.getByLabelText('filter').focus();
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' })));
  expect(onTriage).toHaveBeenCalledTimes(TRIAGE_CALLS);
});
