import { useEffect } from 'react';
import { listen } from '@/lib/ipc/events';
import { isStreaming, useAssistantStore } from '@/stores/assistant';
import type { AiChatEvent } from '@/lib/types/ipc';

export function handleAssistantChatEvent(event: AiChatEvent) {
  const state = useAssistantStore.getState();
  if (event.sessionId !== state.sessionId || event.accountId !== state.accountId) return;
  if (state.activeRequestId === null && !isStreaming(state.messages)) return;
  if (state.activeRequestId !== null && state.activeRequestId !== event.requestId) return;
  switch (event.kind) {
    case 'started':
      state.adoptRequest(event.requestId);
      break;
    case 'delta':
      state.adoptRequest(event.requestId);
      state.appendDelta(event.text);
      break;
    case 'sources':
      state.setSources(event.sources, event.answer);
      break;
    case 'done':
      state.finish({ cancelled: event.cancelled, error: event.error });
      break;
  }
}

export function AssistantChatEvents() {
  useEffect(() => {
    let disposed = false;
    let remove: (() => void | Promise<void>) | undefined;
    void listen('ai-chat://event', handleAssistantChatEvent).then((unlisten) => {
      if (disposed) void unlisten();
      else remove = unlisten;
    });
    return () => {
      disposed = true;
      if (remove) void remove();
    };
  }, []);
  return null;
}
