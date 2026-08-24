import type { IpcCommandMap } from '@/lib/types/ipc';

export const playwrightAiConfigs = [
  {
    accountId: 'mail-account',
    email: 'you@example.com',
    displayName: 'Personal',
    enabled: true,
    baseUrl: 'http://localhost:11434/v1/',
    chatModel: null,
    embeddingModel: 'nomic-embed-text',
    embeddingDimensions: 768,
    hasApiKey: false,
    indexPaused: false,
  },
  {
    accountId: 'reauth-account',
    email: 'work@example.com',
    displayName: 'Work',
    enabled: true,
    baseUrl: 'https://api.example.com/v1/',
    chatModel: 'chat-model',
    embeddingModel: 'embed-model',
    embeddingDimensions: 1536,
    hasApiKey: true,
    indexPaused: false,
  },
] satisfies IpcCommandMap['read_ai_configs']['result'];

export const playwrightAiIndexStatuses = [
  {
    accountId: 'mail-account',
    state: 'building',
    indexed: 1240,
    total: 4000,
    indexedMessages: 1240,
    totalEligibleMessages: 4000,
    indexedPassages: 3720,
    paused: false,
    error: null,
  },
  {
    accountId: 'reauth-account',
    state: 'complete',
    indexed: 800,
    total: 800,
    indexedMessages: 800,
    totalEligibleMessages: 800,
    indexedPassages: 2400,
    paused: false,
    error: null,
  },
] satisfies IpcCommandMap['read_ai_index_status']['result'];

export const playwrightAiModels = [
  { id: 'nomic-embed-text', ownedBy: 'local' },
  { id: 'embed-model', ownedBy: 'provider' },
  { id: 'chat-model', ownedBy: 'provider' },
] satisfies IpcCommandMap['list_ai_models']['result'];
