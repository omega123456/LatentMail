import type { IpcCommandMap, MailThread } from '@/lib/types/ipc';

export const playwrightThreads: MailThread[] = [
  {
    id: 'thread-1',
    subject: 'Q3 Marketing Strategy Review',
    participants: ['Elena Rodriguez'],
    latestAt: Date.parse('2026-08-11T10:42:00Z'),
    messageCount: 3,
    isUnread: true,
    isStarred: true,
    hasAttachments: true,
    hasDraft: false,
  },
  {
    id: 'thread-2',
    subject: 'Updates to Color Tokens',
    participants: ['Design Systems Guild'],
    latestAt: Date.parse('2026-08-10T09:00:00Z'),
    messageCount: 1,
    isUnread: false,
    isStarred: false,
    hasAttachments: false,
    hasDraft: false,
  },
  {
    id: 'thread-3',
    subject: 'Action Required: 2FA Setup',
    participants: ['Security Team'],
    latestAt: Date.parse('2026-08-07T12:00:00Z'),
    messageCount: 1,
    isUnread: false,
    isStarred: false,
    hasAttachments: false,
    hasDraft: false,
  },
  {
    id: 'thread-4',
    subject: 'Lunch next week?',
    participants: ['Alex Chen'],
    latestAt: Date.parse('2026-07-31T15:30:00Z'),
    messageCount: 1,
    isUnread: false,
    isStarred: false,
    hasAttachments: false,
    hasDraft: false,
  },
];

export const playwrightThreadPage: IpcCommandMap['list_threads']['result'] = {
  items: playwrightThreads,
  nextCursor: null,
};
