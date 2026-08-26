import { create } from 'zustand';
import { getTime } from 'date-fns';
import { invoke } from '@/lib/ipc/commands';
import type { AiChatSource } from '@/lib/types/ipc';

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

type AssistantState = {
  sessionId: string;
  accountId: string | null;
  messages: AssistantMessage[];
  activeRequestId: string | null;
  cancelPending: boolean;
  draft: string;
  historyCursor: number | null;
  displacedDraft: string | null;
  setDraft: (draft: string) => void;
  selectAccount: (accountId: string) => void;
  newChat: () => void;
  ask: (question: string) => void;
  stop: () => void;
  adoptRequest: (requestId: string) => void;
  appendDelta: (text: string) => void;
  setSources: (sources: AiChatSource[], answer: string) => void;
  finish: (outcome: { cancelled: boolean; error: string | null }) => void;
  historyPrevious: () => void;
  historyNext: () => void;
};

let sequence = 0;

function nextId(prefix: string) {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

function emptySession(accountId: string | null) {
  return {
    sessionId: nextId('assistant-session'),
    accountId,
    messages: [] as AssistantMessage[],
    activeRequestId: null,
    cancelPending: false,
    draft: '',
    historyCursor: null,
    displacedDraft: null,
  };
}

function message(role: AssistantRole, text: string, streaming: boolean): AssistantMessage {
  return {
    id: nextId(`assistant-${role}`),
    role,
    text,
    error: null,
    sources: [],
    streaming,
    createdAt: getTime(new Date()),
  };
}

function withLastAssistant(
  messages: AssistantMessage[],
  update: (message: AssistantMessage) => AssistantMessage,
) {
  const index = messages.map((entry) => entry.role).lastIndexOf('assistant');
  if (index === -1) return messages;
  return messages.map((entry, position) => (position === index ? update(entry) : entry));
}

export function isStreaming(messages: AssistantMessage[]) {
  return messages.some((entry) => entry.streaming);
}

function questions(messages: AssistantMessage[]) {
  return messages.filter((entry) => entry.role === 'user').map((entry) => entry.text);
}

export const useAssistantStore = create<AssistantState>((set, get) => ({
  ...emptySession(null),
  setDraft: (draft) => set({ draft }),
  selectAccount: (accountId) => {
    if (get().accountId === accountId) return;
    get().stop();
    set(emptySession(accountId));
  },
  newChat: () => {
    get().stop();
    set(emptySession(get().accountId));
  },
  ask: (question) => {
    const { accountId, sessionId, messages } = get();
    const text = question.trim();
    if (accountId === null || text.length === 0 || text.length > QUESTION_LIMIT) return;
    if (isStreaming(messages)) return;
    set({
      messages: [...messages, message('user', text, false), message('assistant', '', true)],
      draft: '',
      historyCursor: null,
      displacedDraft: null,
      activeRequestId: null,
      cancelPending: false,
    });
    void invoke('start_ai_chat', { accountId, sessionId, question: text })
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
    if (activeRequestId === null) set({ cancelPending: true });
    else void invoke('cancel_ai_chat', { requestId: activeRequestId });
    get().finish({ cancelled: true, error: null });
  },
  adoptRequest: (requestId) => set({ activeRequestId: requestId }),
  appendDelta: (text) =>
    set((state) => ({
      messages: withLastAssistant(state.messages, (entry) => ({
        ...entry,
        text: `${entry.text}${text}`,
      })),
    })),
  setSources: (sources, answer) =>
    set((state) => ({
      messages: withLastAssistant(state.messages, (entry) => ({
        ...entry,
        sources,
        text: answer,
      })),
    })),
  finish: ({ cancelled, error }) =>
    set((state) => ({
      activeRequestId: null,
      messages: withLastAssistant(state.messages, (entry) => ({
        ...entry,
        streaming: false,
        sources: cancelled ? [] : entry.sources,
        error,
      })),
    })),
  historyPrevious: () => {
    const { messages, historyCursor, draft } = get();
    const asked = questions(messages);
    if (asked.length === 0) return;
    const cursor = historyCursor === null ? asked.length - 1 : Math.max(0, historyCursor - 1);
    set({
      historyCursor: cursor,
      displacedDraft: historyCursor === null ? draft : get().displacedDraft,
      draft: asked[cursor],
    });
  },
  historyNext: () => {
    const { messages, historyCursor, displacedDraft } = get();
    if (historyCursor === null) return;
    const asked = questions(messages);
    if (historyCursor >= asked.length - 1) {
      set({ historyCursor: null, displacedDraft: null, draft: displacedDraft ?? '' });
      return;
    }
    const cursor = historyCursor + 1;
    set({ historyCursor: cursor, draft: asked[cursor] });
  },
}));
