import { getTime, parseISO } from 'date-fns';
import type { IpcCommandMap } from '@/lib/types/ipc';

export const playwrightLogEntries: IpcCommandMap['read_log_entries']['result'] = [
  {
    timestampMillis: getTime(parseISO('2026-08-19T14:41:22.118Z')),
    level: 'ERROR',
    message:
      'sync: history sync failed for kovacsjozsef89@hotmail.com — 429 rateLimitExceeded, retrying in 32s',
  },
  {
    timestampMillis: getTime(parseISO('2026-08-19T14:41:22.094Z')),
    level: 'WARN',
    message: 'gmail: quota window at 9412/10000 units, backing off before the next retry',
  },
  {
    timestampMillis: getTime(parseISO('2026-08-19T14:40:58.702Z')),
    level: 'INFO',
    message: 'queue: mutation lane seated mutation:star:17f3a2c9 after 1 retry',
  },
  {
    timestampMillis: getTime(parseISO('2026-08-19T14:38:11.365Z')),
    level: 'ERROR',
    message:
      'frontend: load_conversation failed: database is locked\n    at dispatchInvoke (commands.ts:14:11)\n    at useConversationQuery (hooks.ts:212:24)',
  },
  {
    timestampMillis: getTime(parseISO('2026-08-19T14:38:04.219Z')),
    level: 'INFO',
    message: 'sync: applied 14 history records, checkpoint advanced to 8841203',
  },
  {
    timestampMillis: getTime(parseISO('2026-08-19T14:37:51.880Z')),
    level: 'DEBUG',
    message: 'auth: access token refreshed, expires in 3599s',
  },
  {
    timestampMillis: getTime(parseISO('2026-08-18T14:57:06.441Z')),
    level: 'WARN',
    message: 'sync: probe skipped, background lane already seated',
  },
  {
    timestampMillis: getTime(parseISO('2026-08-18T14:55:12.003Z')),
    level: 'INFO',
    message: 'frontend: window closed, flushing window state',
  },
];
