import { useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { TextArea } from '@/components/shared/TextArea';
import { isStreaming, QUESTION_LIMIT, useAssistantStore } from '@/stores/assistant';

const sendClass =
  'grid size-8 shrink-0 cursor-pointer place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-primary';

export function AssistantComposer({
  inputRef,
}: {
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const promptRef = inputRef ?? fallbackRef;
  const draft = useAssistantStore((state) => state.draft);
  const messages = useAssistantStore((state) => state.messages);
  const setDraft = useAssistantStore((state) => state.setDraft);
  const ask = useAssistantStore((state) => state.ask);
  const stop = useAssistantStore((state) => state.stop);
  const historyPrevious = useAssistantStore((state) => state.historyPrevious);
  const historyNext = useAssistantStore((state) => state.historyNext);

  useLayoutEffect(() => {
    const prompt = promptRef.current;
    if (!prompt) return;
    prompt.style.height = 'auto';
    prompt.style.height = `${prompt.scrollHeight + prompt.offsetHeight - prompt.clientHeight}px`;
  }, [draft, promptRef]);

  const streaming = isStreaming(messages);
  const length = draft.trim().length;
  const over = draft.length > QUESTION_LIMIT;
  const canSend = length > 0 && !over && !streaming;

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSend) ask(draft);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      historyPrevious();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      historyNext();
    }
  };

  return (
    <div className="grid gap-1.5 border-t border-outline-variant px-3 pb-3 pt-2.5 dark:border-dark-outline-variant">
      <TextArea
        ref={promptRef}
        aria-label="Ask a question"
        placeholder="Ask a question…"
        spellCheck
        rows={1}
        disabled={streaming}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        className="min-h-ai-prompt-min max-h-ai-prompt-max"
      />
      <div className="flex items-center gap-2">
        <span className="text-label-sm font-normal text-outline dark:text-dark-outline">
          {streaming ? 'Answering…' : 'Enter sends · Shift+Enter for a new line'}
        </span>
        <span
          data-testid="assistant-counter"
          className={`ml-auto font-mono text-label-sm tabular-nums ${
            over
              ? 'font-bold text-error dark:text-dark-error'
              : 'text-outline dark:text-dark-outline'
          }`}
        >
          {draft.length} / {QUESTION_LIMIT}
        </span>
        {streaming ? (
          <button
            type="button"
            aria-label="Stop answering"
            title="Stop answering"
            onClick={stop}
            className={`${sendClass} bg-error-container text-on-error-container dark:bg-dark-error-container dark:text-dark-on-error-container`}
          >
            <Square aria-hidden="true" size={14} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Send question"
            title="Send question"
            disabled={!canSend}
            onClick={() => ask(draft)}
            className={`${sendClass} ${
              canSend
                ? 'bg-primary text-on-primary dark:bg-dark-primary dark:text-dark-on-primary'
                : 'cursor-not-allowed bg-surface-container-high text-outline dark:bg-dark-surface-container-high dark:text-dark-outline'
            }`}
          >
            <ArrowUp aria-hidden="true" size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
