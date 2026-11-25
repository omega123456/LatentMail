import type { AiConfig, AiIndexStatus } from '@/lib/types/ipc';
import { ipc } from '@/tests/ipc-mock';
import { accountOne } from '@/tests/components/shell/app-shell-helpers';

const AVAILABLE_MODEL_COUNT = 4;

const aiConfig: AiConfig = {
  accountId: 'account-1',
  email: 'alex@example.com',
  displayName: 'Alex Morgan',
  enabled: true,
  baseUrl: 'https://api.example.com/v1',
  chatModel: 'chat',
  embeddingModel: 'embedding',
  embeddingDimensions: 768,
  hasApiKey: true,
  indexPaused: false,
};

const aiStatus: AiIndexStatus = {
  accountId: 'account-1',
  state: 'complete',
  indexed: 10,
  total: 10,
  indexedMessages: 10,
  totalEligibleMessages: 10,
  indexedPassages: 30,
  paused: false,
  error: null,
};

export function readyAssistant() {
  ipc.override('list_accounts', [accountOne]);
  ipc.override('read_ai_configs', [aiConfig]);
  ipc.override('read_ai_index_status', [aiStatus]);
  ipc.override('test_ai_connection', AVAILABLE_MODEL_COUNT);
}
