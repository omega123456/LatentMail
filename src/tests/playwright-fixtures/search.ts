import { getTime, parseISO } from 'date-fns';
import type { IpcCommandMap, MailThread } from '@/lib/types/ipc';

export const playwrightSearchThreads: MailThread[] = [
  {
    id: 'search-thread-1',
    subject: 'Q3 invoice attached',
    sender: { display: 'Anna Whitfield', address: 'anna@example.com' },
    sentRecipient: null,
    latestAt: getTime(parseISO('2026-08-11T09:42:00Z')),
    messageCount: 1,
    isUnread: false,
    isStarred: false,
    hasAttachments: true,
    hasDraft: false,
    snippet: 'Attached is the Q3 invoice for your records.',
    labelIndicators: ['Receipts'],
    systemLabelIds: ['INBOX'],
  },
  {
    id: 'search-thread-2',
    subject: 'Re: Q3 invoice',
    sender: { display: 'Anna Whitfield', address: 'anna@example.com' },
    sentRecipient: { display: 'Anna Whitfield', address: 'anna@example.com' },
    latestAt: getTime(parseISO('2026-08-10T14:05:00Z')),
    messageCount: 2,
    isUnread: false,
    isStarred: false,
    hasAttachments: false,
    hasDraft: false,
    snippet: 'Thanks, confirming receipt of the Q3 invoice.',
    labelIndicators: [],
    systemLabelIds: ['SENT'],
  },
];

export const playwrightSearchThreadPage: IpcCommandMap['search_threads']['result'] = {
  items: playwrightSearchThreads,
  nextCursor: null,
  previousCursor: null,
};

export const playwrightSearchTotal: IpcCommandMap['search_total']['result'] = 7;

export const playwrightParsedSearchQuery: IpcCommandMap['parse_search_query']['result'] = {
  hasTextTerm: true,
  from: 'anna',
  to: null,
  subject: null,
  includes: ['quarterly'],
  excludes: [],
  predicates: [],
};

export const playwrightEmptySearchPage: IpcCommandMap['search_threads']['result'] = {
  items: [],
  nextCursor: null,
  previousCursor: null,
};

export const playwrightZeroSearchTotal: IpcCommandMap['search_total']['result'] = 0;

export const playwrightEmptyParsedSearchQuery: IpcCommandMap['parse_search_query']['result'] = {
  hasTextTerm: false,
  from: null,
  to: null,
  subject: null,
  includes: [],
  excludes: [],
  predicates: [],
};
