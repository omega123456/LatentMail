export interface Account {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  needsReauthentication: boolean;
}

export interface AiConfig {
  accountId: string;
  email: string;
  displayName: string;
  enabled: boolean;
  baseUrl: string | null;
  chatModel: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  hasApiKey: boolean;
  indexPaused: boolean;
}

export interface AiIndexStatus {
  accountId: string;
  state:
    | 'notStarted'
    | 'preparing'
    | 'building'
    | 'complete'
    | 'partial'
    | 'paused'
    | 'interrupted'
    | 'unavailable'
    | 'needsRebuild';
  indexed: number;
  total: number;
  indexedMessages: number;
  totalEligibleMessages: number;
  indexedPassages: number;
  paused: boolean;
  error: string | null;
}

export interface AiModel {
  id: string;
  ownedBy: string | null;
}

export interface AiChatSource {
  number: number;
  senderName: string;
  senderAddress: string;
  subject: string;
  sentAtMillis: number;
  messageId: string;
  threadId: string;
}

export interface AiChatEventIdentity {
  requestId: string;
  sessionId: string;
  accountId: string;
}

export type AiChatEvent = AiChatEventIdentity &
  (
    | { kind: 'started' }
    | { kind: 'delta'; text: string }
    | { kind: 'sources'; sources: AiChatSource[]; answer: string }
    | { kind: 'done'; cancelled: boolean; error: string | null }
  );
