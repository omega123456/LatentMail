import { create } from 'zustand';
import { invoke } from '@/lib/ipc/commands';
import type { AiChatSource } from '@/lib/types/ipc';
import {
  appendAssistantDelta,
  applyAssistantSources,
  beginAssistantExchange,
  createEmptyAssistantSession,
  finishAssistantExchange,
  stepAssistantHistoryNext,
  stepAssistantHistoryPrevious,
  type AssistantData,
} from './assistant/transitions';

export const QUESTION_LIMIT = 2000;

export type AssistantRole = 'user' | 'assistant';

export type AssistantMessage = {
  id: string;
  role: AssistantRole;
  text: string;
  error: string | null;
  sources: AiChatSource[];
  streaming: boolean;
  createdAt: number;
};

type AssistantState = AssistantData & {
  setDraft: (draft: string) => void;
  selectAccount: (accountId: string) => void;
  newChat: () => void;
  detachAccount: () => void;
  ask: (question: string) => void;
  stop: () => void;
  adoptRequest: (requestId: string) => void;
  appendDelta: (text: string) => void;
  setSources: (sources: AiChatSource[], answer: string) => void;
  finish: (outcome: { cancelled: boolean; error: string | null }) => void;
  historyPrevious: () => void;
  historyNext: () => void;
};

export function isStreaming(messages: AssistantMessage[]) {
  return messages.some((entry) => entry.streaming);
}

function cancelInFlightRequest(activeRequestId: string | null, markPending: () => void) {
  if (activeRequestId === null) {
    markPending();
    return;
  }
  void invoke('cancel_ai_chat', { requestId: activeRequestId });
}

function canAskQuestion(messages: AssistantMessage[], text: string): boolean {
  const hasValidLength = text.length > 0 && text.length <= QUESTION_LIMIT;
  return hasValidLength && !isStreaming(messages);
}

export const useAssistantStore = create<AssistantState>((set, get) => ({
  ...createEmptyAssistantSession(null),
  setDraft: (draft) => set({ draft }),
  selectAccount: (accountId) => {
    if (get().accountId === accountId) return;
    get().stop();
    set(createEmptyAssistantSession(accountId));
  },
  newChat: () => {
    get().stop();
    set(createEmptyAssistantSession(get().accountId));
  },
  detachAccount: () => {
    get().stop();
    set(createEmptyAssistantSession(null));
  },
  ask: (question) => {
    const { accountId, sessionId, messages } = get();
    const text = question.trim();
    if (accountId === null) return;
    if (!canAskQuestion(messages, text)) return;
    set(beginAssistantExchange(messages, text));
    void invoke('start_ai_chat', { accountId: accountId, sessionId: sessionId, question: text })
      .then((requestId) => {
        if (get().sessionId !== sessionId) {
          void invoke('cancel_ai_chat', { requestId });
          return;
        }
        if (get().cancelPending) {
          set({ cancelPending: false });
          void invoke('cancel_ai_chat', { requestId });
          return;
        }
        set({ activeRequestId: requestId });
      })
      .catch((reason: unknown) => {
        if (get().sessionId !== sessionId) return;
        get().finish({ cancelled: false, error: String(reason) });
      });
  },
  stop: () => {
    const { activeRequestId, messages } = get();
    if (!isStreaming(messages)) return;
    cancelInFlightRequest(activeRequestId, () => set({ cancelPending: true }));
    get().finish({ cancelled: true, error: null });
  },
  adoptRequest: (requestId) => set({ activeRequestId: requestId }),
  appendDelta: (text) => set((state) => ({ messages: appendAssistantDelta(state.messages, text) })),
  setSources: (sources, answer) =>
    set((state) => ({ messages: applyAssistantSources(state.messages, { sources, answer }) })),
  finish: (outcome) => set((state) => finishAssistantExchange(state.messages, outcome)),
  historyPrevious: () => {
    const next = stepAssistantHistoryPrevious(get());
    if (next) set(next);
  },
  historyNext: () => {
    const next = stepAssistantHistoryNext(get());
    if (next) set(next);
  },
}));
