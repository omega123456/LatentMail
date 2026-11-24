import type { TriageIntent } from '@/lib/query/mutations';

export function starToggleIntent(starred: boolean): TriageIntent {
  return {
    kind: 'label',
    add: starred ? [] : ['STARRED'],
    remove: starred ? ['STARRED'] : [],
  };
}

export function readToggleIntent(unread: boolean): TriageIntent {
  return {
    kind: 'label',
    add: unread ? [] : ['UNREAD'],
    remove: unread ? ['UNREAD'] : [],
  };
}

export function spamToggleIntent(isSpam: boolean): TriageIntent {
  return {
    kind: 'move',
    destination: isSpam ? 'INBOX' : 'SPAM',
  };
}

export function selectedRowIds(
  rowId: string,
  selectedIds: ReadonlySet<string>,
  multiSelectActive: boolean,
): string[] {
  return selectedIds.has(rowId) && multiSelectActive ? [...selectedIds] : [rowId];
}
