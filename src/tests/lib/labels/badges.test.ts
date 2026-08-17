import { describe, expect, it } from 'vitest';
import { SYSTEM_BADGES, messageBadges, userBadgesByName } from '@/lib/labels/badges';
import type { UserLabel } from '@/lib/labels/badges';

const userLabels: UserLabel[] = [
  { id: 'Label_2', name: 'Work', color: 'blue' },
  { id: 'Label_1', name: 'invoices', color: 'green' },
  { id: 'Label_3', name: 'Archive', color: 'purple' },
];

describe('messageBadges', () => {
  it('orders system status before user labels and disposal last', () => {
    const badges = messageBadges(
      { labelIds: ['SPAM', 'Label_2', 'INBOX', 'Label_1', 'TRASH', 'SENT', 'DRAFT'] },
      userLabels,
    );
    expect(badges).toEqual([
      { kind: 'system', id: 'INBOX' },
      { kind: 'system', id: 'SENT' },
      { kind: 'system', id: 'DRAFT' },
      { kind: 'user', id: 'Label_1', name: 'invoices', color: 'green' },
      { kind: 'user', id: 'Label_2', name: 'Work', color: 'blue' },
      { kind: 'system', id: 'TRASH' },
      { kind: 'system', id: 'SPAM' },
    ]);
  });

  it('takes Starred from the message flag rather than any star label variant', () => {
    expect(messageBadges({ labelIds: ['STARRED', 'YELLOW_STAR'] }, [])).toEqual([]);
    expect(messageBadges({ labelIds: ['YELLOW_STAR'], starred: true }, [])).toEqual([
      { kind: 'system', id: 'STARRED' },
    ]);
  });

  it('never renders a system label without a badge of its own', () => {
    expect(
      messageBadges(
        { labelIds: ['IMPORTANT', 'UNREAD', 'CATEGORY_PROMOTIONS', 'CHAT', 'Label_9'] },
        userLabels,
      ),
    ).toEqual([]);
  });

  it('treats a message with no labels at all as badgeless', () => {
    expect(messageBadges({}, userLabels)).toEqual([]);
  });
});

describe('userBadgesByName', () => {
  it('resolves names to labels and sorts case-insensitively', () => {
    expect(userBadgesByName(['Work', 'invoices', 'Unknown'], userLabels)).toEqual([
      { kind: 'user', id: 'Label_1', name: 'invoices', color: 'green' },
      { kind: 'user', id: 'Label_2', name: 'Work', color: 'blue' },
    ]);
  });
});

describe('SYSTEM_BADGES', () => {
  it('names every badge for people rather than echoing the Gmail id', () => {
    expect(Object.values(SYSTEM_BADGES).map((badge) => badge.name)).toEqual([
      'Inbox',
      'Sent',
      'Drafts',
      'Starred',
      'Trash',
      'Spam',
    ]);
  });
});
