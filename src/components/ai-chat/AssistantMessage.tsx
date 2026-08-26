import { CopyButton } from '@/components/shared/CopyButton';
import type { AiChatSource } from '@/lib/types/ipc';
import type { AssistantMessage as AssistantMessageModel } from '@/stores/assistant';
import { AssistantMarkdown } from './AssistantMarkdown';
import { AssistantSources } from './AssistantSources';

const roleClass = 'font-mono text-label-sm uppercase text-outline dark:text-dark-outline';

const bubbleClass =
  'max-w-11/12 justify-self-end rounded-md rounded-br-sm bg-surface-container-high px-2.5 py-2 text-body-sm whitespace-pre-wrap dark:bg-dark-surface-container-high';

export function AssistantMessage({
  message,
  onSourceActivate,
}: {
  message: AssistantMessageModel;
  onSourceActivate: (source: AiChatSource) => void;
}) {
  const copyValue = message.error ?? message.text;
  return (
    <div
      data-testid={`assistant-message-${message.role}`}
      aria-busy={message.streaming ? 'true' : undefined}
      className="group grid gap-1"
    >
      <span className="flex items-center gap-1.5">
        <span className={roleClass}>{message.role === 'user' ? 'You' : 'Assistant'}</span>
        {copyValue.length > 0 && (
          <span className="ml-auto flex">
            <CopyButton value={copyValue} label="Copy message" confirmation="Copied message" />
          </span>
        )}
      </span>
      {message.role === 'user' ? (
        <span className={bubbleClass}>{message.text}</span>
      ) : (
        <>
          {message.text.length > 0 && <AssistantMarkdown text={message.text} />}
          {message.streaming && (
            <span
              data-testid="assistant-caret"
              aria-hidden="true"
              className="inline-block h-3.5 w-1.5 rounded-glyph bg-primary dark:bg-dark-primary"
            />
          )}
          {message.error !== null && (
            <span role="alert" className="text-label-sm text-error dark:text-dark-error">
              {message.error}
            </span>
          )}
          <AssistantSources sources={message.sources} onActivate={onSourceActivate} />
        </>
      )}
    </div>
  );
}
