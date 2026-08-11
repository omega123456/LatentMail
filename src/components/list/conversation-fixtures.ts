import type { Conversation } from '@/lib/types/conversation';

export const conversationFixtures: Conversation[] = [
  {
    id: 'thread-1',
    sender: 'Elena Rodriguez',
    subject: 'Q3 Marketing Strategy Review',
    snippet:
      "I've attached the finalized slides for tomorrow's presentation. Please review the budget allocation section.",
    date: new Date('2026-08-11T10:42:00Z'),
    unread: true,
    starred: true,
    hasAttachment: true,
    messageCount: 3,
    labels: ['Marketing'],
  },
  {
    id: 'thread-2',
    sender: 'Design Systems Guild',
    subject: 'Updates to Color Tokens',
    snippet:
      "We've deprecated several tertiary colors to improve contrast accessibility across the platform.",
    date: new Date('2026-08-10T09:00:00Z'),
    unread: false,
    starred: false,
  },
  {
    id: 'thread-3',
    sender: 'Security Team',
    subject: 'Action Required: 2FA Setup',
    snippet:
      'Please complete your mandatory two-factor authentication setup before the end of the week.',
    date: new Date('2026-08-07T12:00:00Z'),
    unread: false,
    starred: false,
  },
  {
    id: 'thread-4',
    sender: 'Alex Chen',
    subject: 'Lunch next week?',
    snippet:
      'Are you free for lunch next Tuesday? I want to bounce some ideas off you regarding the new project.',
    date: new Date('2026-07-31T15:30:00Z'),
    unread: false,
    starred: false,
  },
];
