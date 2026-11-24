import { useEffect } from 'react';
import { listenUntilDisposed } from '@/lib/ipc/listen-managed';
import { isStreaming, useAssistantStore } from '@/stores/assistant';
import type { AiChatEvent } from '@/lib/types/ipc';

type AssistantStoreState = ReturnType<typeof useAssistantStore.getState>;

type ChatEventHandlers = {
  [Kind in AiChatEvent['kind']]: (
    state: AssistantStoreState,
    event: Extract<AiChatEvent, { kind: Kind }>,
  ) => void;
};

const CHAT_EVENT_HANDLERS: ChatEventHandlers = {
  started: (state, event) => state.adoptRequest(event.requestId),
  delta: (state, event) => {
    state.adoptRequest(event.requestId);
    state.appendDelta(event.text);
  },
  sources: (state, event) => state.setSources(event.sources, event.answer),
  done: (state, event) => state.finish({ cancelled: event.cancelled, error: event.error }),
};

function matchesActiveSession(state: AssistantStoreState, event: AiChatEvent): boolean {
  const sameSession = event.sessionId === state.sessionId && event.accountId === state.accountId;
  if (!sameSession) return false;
  if (state.activeRequestId === null) return isStreaming(state.messages);
  return state.activeRequestId === event.requestId;
}

export function handleAssistantChatEvent(event: AiChatEvent) {
  const state = useAssistantStore.getState();
  if (!matchesActiveSession(state, event)) return;
  const handler = CHAT_EVENT_HANDLERS[event.kind] as (
    current: AssistantStoreState,
    payload: AiChatEvent,
  ) => void;
  handler(state, event);
}

export function AssistantChatEvents() {
  useEffect(() => listenUntilDisposed('ai-chat://event', handleAssistantChatEvent), []);
  return null;
}
