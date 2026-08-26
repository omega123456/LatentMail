import { getTime, parseISO } from 'date-fns';
import type { AiChatEvent, AiChatEventIdentity, IpcCommandMap } from '@/lib/types/ipc';

export const playwrightAiChatRequestId = 'ai-chat-request-1';

export const playwrightAiChatQuestion = 'Which invoices are still unpaid?';

export const playwrightAiChatAnswer =
  'Two invoices are still open. AutoCare Garage sent **#40218** for £284.50 on 11 August [1], and Harbor Insurance is waiting on the renewal premium [2].';

export const playwrightAiChatReadyConfigs = [
  {
    accountId: 'mail-account',
    email: 'you@example.com',
    displayName: 'Personal',
    enabled: true,
    baseUrl: 'http://localhost:11434/v1/',
    chatModel: 'chat-model',
    embeddingModel: 'nomic-embed-text',
    embeddingDimensions: 768,
    hasApiKey: false,
    indexPaused: false,
  },
] satisfies IpcCommandMap['read_ai_configs']['result'];

export const playwrightAiChatReadyIndexStatuses = [
  {
    accountId: 'mail-account',
    state: 'complete',
    indexed: 4000,
    total: 4000,
    indexedMessages: 4000,
    totalEligibleMessages: 4000,
    indexedPassages: 12000,
    paused: false,
    error: null,
  },
] satisfies IpcCommandMap['read_ai_index_status']['result'];

export const playwrightAiChatSources = [
  {
    number: 1,
    senderName: 'AutoCare Garage',
    senderAddress: 'billing@autocare.example',
    subject: 'Invoice #40218 — service and parts',
    sentAtMillis: getTime(parseISO('2026-08-11T09:12:00Z')),
    messageId: 'message-40218',
    threadId: 'thread-1',
  },
  {
    number: 2,
    senderName: 'Harbor Insurance',
    senderAddress: 'renewals@harbor.example',
    subject: 'Policy renewal quote 2027',
    sentAtMillis: getTime(parseISO('2026-08-09T16:04:00Z')),
    messageId: 'message-88104',
    threadId: 'thread-2',
  },
];

export function playwrightAiChatStream(identity: AiChatEventIdentity): AiChatEvent[] {
  return [
    { ...identity, kind: 'started' },
    { ...identity, kind: 'delta', text: playwrightAiChatAnswer },
    {
      ...identity,
      kind: 'sources',
      sources: playwrightAiChatSources,
      answer: playwrightAiChatAnswer,
    },
    { ...identity, kind: 'done', cancelled: false, error: null },
  ];
}
