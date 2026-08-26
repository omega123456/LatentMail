import { useEffect, useRef } from 'react';
import type { AiChatSource } from '@/lib/types/ipc';
import type { AssistantMessage as AssistantMessageModel } from '@/stores/assistant';
import { AssistantMessage } from './AssistantMessage';

export function AssistantTranscript({
  messages,
  onSourceActivate,
}: {
  messages: AssistantMessageModel[];
  onSourceActivate: (source: AiChatSource) => void;
}) {
  const region = useRef<HTMLDivElement>(null);
  const last = messages.at(-1);
  const follow = `${messages.length}:${last?.text.length ?? 0}:${last?.sources.length ?? 0}`;
  useEffect(() => {
    const element = region.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [follow]);
  return (
    <div
      ref={region}
      role="log"
      aria-live="polite"
      aria-atomic="false"
      aria-label="Assistant conversation"
      className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-3.5"
    >
      {messages.map((message) => (
        <AssistantMessage key={message.id} message={message} onSourceActivate={onSourceActivate} />
      ))}
    </div>
  );
}
