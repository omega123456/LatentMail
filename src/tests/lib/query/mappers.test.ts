import { describe, expect, it } from 'vitest';
import {
  computeThreadLabelMembership,
  mapConversation,
  mapLabelsToMailboxes,
  mapLabelsToUserLabels,
  mapThreadToRow,
} from '@/lib/query/mappers';
import type { Conversation, MailLabel, MailThread } from '@/lib/types/ipc';

const thread: MailThread = {
  id: 'thread-1',
  subject: 'Q3 Marketing Strategy Review',
  participants: ['Elena Rodriguez', 'Alex'],
  latestAt: Date.parse('2026-08-11T09:00:00Z'),
  messageCount: 2,
  isUnread: true,
  isStarred: false,
  hasAttachments: true,
  hasDraft: false,
};

const labels: MailLabel[] = [
  { id: 'INBOX', name: 'Inbox', kind: 'system', color: null, messageCount: 5, unreadCount: 2 },
  {
    id: 'Label_1',
    name: 'Work',
    kind: 'user',
    color: { text: '#ffffff', background: '#4a86e8' },
    messageCount: 3,
    unreadCount: 1,
  },
  { id: 'Label_2', name: 'Personal', kind: 'user', color: null, messageCount: 0, unreadCount: 0 },
];

describe('mapThreadToRow', () => {
  it('maps a MailThread onto the conversation row shape', () => {
    expect(mapThreadToRow(thread)).toMatchObject({
      id: 'thread-1',
      sender: 'Elena Rodriguez, Alex',
      subject: 'Q3 Marketing Strategy Review',
      unread: true,
      starred: false,
      hasAttachment: true,
      messageCount: 2,
      draft: false,
    });
  });

  it('falls back to placeholder sender/subject text when both are empty', () => {
    const empty = { ...thread, subject: '', participants: [] };
    const row = mapThreadToRow(empty);
    expect(row.sender).toBe('(No sender)');
    expect(row.subject).toBe('(No subject)');
  });
});

describe('mapLabelsToMailboxes / mapLabelsToUserLabels', () => {
  it('passes every label through as a mailbox candidate', () => {
    expect(mapLabelsToMailboxes(labels)).toEqual([
      { id: 'INBOX', name: 'Inbox', unreadCount: 2 },
      { id: 'Label_1', name: 'Work', unreadCount: 1 },
      { id: 'Label_2', name: 'Personal', unreadCount: 0 },
    ]);
  });

  it('keeps only user-kind labels for the sidebar label list, resolving the real Gmail colour', () => {
    expect(mapLabelsToUserLabels(labels)).toEqual([
      { id: 'Label_1', name: 'Work', unreadCount: 1, color: 'blue' },
      // No colour set yet (or off the curated palette) falls back to the
      // first swatch rather than a fabricated cycle.
      { id: 'Label_2', name: 'Personal', unreadCount: 0, color: 'black' },
    ]);
  });
});

describe('mapConversation', () => {
  it('maps a Conversation DTO into the reader shape, resolving label names', () => {
    const conversation: Conversation = {
      threadId: 'thread-1',
      subject: 'Q3 Marketing Strategy Review',
      messages: [
        {
          id: 'message-1',
          sender: 'Elena Rodriguez <elena.r@example.com>',
          recipients: ['You <you@example.com>'],
          subject: 'Q3 Marketing Strategy Review',
          sentAt: Date.parse('2026-08-10T09:00:00Z'),
          snippet: 'Attached slides',
          htmlBody: '<p>Attached slides</p>',
          htmlPresence: 'present',
          plainBody: null,
          hasAttachments: false,
          isUnread: false,
          isStarred: false,
          labelIds: ['Label_1', 'INBOX'],
          remoteImagesBlocked: true,
        },
      ],
    };
    const result = mapConversation(conversation, new Map([['Label_1', 'Work']]));
    expect(result.messages[0]).toMatchObject({
      sender: { name: 'Elena Rodriguez', address: 'elena.r@example.com' },
      recipients: [{ name: 'You', address: 'you@example.com' }],
      html: '<p>Attached slides</p>',
      text: null,
      labels: ['Work'],
      remoteImagesBlocked: true,
    });
  });
});

describe('computeThreadLabelMembership', () => {
  const userLabels: MailLabel[] = [
    { id: 'Label_1', name: 'Clients', kind: 'user', color: null, messageCount: 1, unreadCount: 0 },
    { id: 'Label_2', name: 'Invoices', kind: 'user', color: null, messageCount: 1, unreadCount: 0 },
    { id: 'INBOX', name: 'Inbox', kind: 'system', color: null, messageCount: 1, unreadCount: 0 },
  ];

  it('renders checked when present on every message, unchecked on none, and indeterminate on some', () => {
    const result = computeThreadLabelMembership(userLabels, [['Label_1', 'INBOX'], ['Label_1']]);
    expect(result).toEqual([
      { id: 'Label_1', name: 'Clients', color: 'black', membership: 'checked' },
      { id: 'Label_2', name: 'Invoices', color: 'black', membership: 'unchecked' },
    ]);
  });

  it('renders every user label unchecked for a thread with no loaded messages', () => {
    const result = computeThreadLabelMembership(userLabels, []);
    expect(result.every((entry) => entry.membership === 'unchecked')).toBe(true);
  });
});
