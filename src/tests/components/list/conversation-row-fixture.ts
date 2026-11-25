import { parseISO } from 'date-fns';
import type { Conversation } from '@/lib/types/conversation';

export const sampleConversation: Conversation = {
  id: 'thread-1',
  sender: 'Elena Rodriguez',
  identityLabel: 'Elena Rodriguez',
  avatarDomain: 'example.com',
  subject: 'Q3 review',
  snippet: 'Attached slides',
  date: parseISO('2026-08-11T10:42:00Z'),
  unread: false,
  starred: false,
};
