import { getTime } from 'date-fns';
import type { AiChatSource } from '@/lib/types/ipc';
import type { AssistantMessage, AssistantRole } from '../assistant';

export type AssistantData = {
  sessionId: string;
  accountId: string | null;
  messages: AssistantMessage[];
  activeRequestId: string | null;
  cancelPending: boolean;
  draft: string;
  historyCursor: number | null;
  displacedDraft: string | null;
};

let sequence = 0;

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

export function createEmptyAssistantSession(accountId: string | null): AssistantData {
  return {
    sessionId: nextId('assistant-session'),
    accountId: accountId,
    messages: [],
    activeRequestId: null,
    cancelPending: false,
    draft: '',
    historyCursor: null,
    displacedDraft: null,
  };
}

function createMessage(role: AssistantRole, text: string, streaming: boolean): AssistantMessage {
  return {
    id: nextId(`assistant-${role}`),
    role: role,
    text: text,
    error: null,
    sources: [],
    streaming: streaming,
    createdAt: getTime(new Date()),
  };
}

function withLastAssistant(
  messages: AssistantMessage[],
  update: (message: AssistantMessage) => AssistantMessage,
): AssistantMessage[] {
  const index = messages.map((entry) => entry.role).lastIndexOf('assistant');
  if (index === -1) return messages;
  return messages.map((entry, position) => (position === index ? update(entry) : entry));
}

function userQuestions(messages: AssistantMessage[]): string[] {
  return messages.filter((entry) => entry.role === 'user').map((entry) => entry.text);
}

export function beginAssistantExchange(
  messages: AssistantMessage[],
  text: string,
): Partial<AssistantData> {
  return {
    messages: [
      ...messages,
      createMessage('user', text, false),
      createMessage('assistant', '', true),
    ],
    draft: '',
    historyCursor: null,
    displacedDraft: null,
    activeRequestId: null,
    cancelPending: false,
  };
}

export function appendAssistantDelta(
  messages: AssistantMessage[],
  delta: string,
): AssistantMessage[] {
  return withLastAssistant(messages, (entry) => ({
    ...entry,
    text: `${entry.text}${delta}`,
  }));
}

export function applyAssistantSources(
  messages: AssistantMessage[],
  input: { sources: AiChatSource[]; answer: string },
): AssistantMessage[] {
  return withLastAssistant(messages, (entry) => ({
    ...entry,
    sources: input.sources,
    text: input.answer,
  }));
}

export function finishAssistantExchange(
  messages: AssistantMessage[],
  outcome: { cancelled: boolean; error: string | null },
): Partial<AssistantData> {
  return {
    activeRequestId: null,
    messages: withLastAssistant(messages, (entry) => ({
      ...entry,
      streaming: false,
      sources: outcome.cancelled ? [] : entry.sources,
      error: outcome.error,
    })),
  };
}

export function stepAssistantHistoryPrevious(state: AssistantData): Partial<AssistantData> | null {
  const asked = userQuestions(state.messages);
  if (asked.length === 0) return null;
  const cursor =
    state.historyCursor === null ? asked.length - 1 : Math.max(0, state.historyCursor - 1);
  return {
    historyCursor: cursor,
    displacedDraft: state.historyCursor === null ? state.draft : state.displacedDraft,
    draft: asked[cursor],
  };
}

export function stepAssistantHistoryNext(state: AssistantData): Partial<AssistantData> | null {
  if (state.historyCursor === null) return null;
  const asked = userQuestions(state.messages);
  if (state.historyCursor >= asked.length - 1) {
    return {
      historyCursor: null,
      displacedDraft: null,
      draft: state.displacedDraft ?? '',
    };
  }
  const cursor = state.historyCursor + 1;
  return { historyCursor: cursor, draft: asked[cursor] };
}
