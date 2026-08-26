import { useCallback, useEffect, useRef } from 'react';
import { SquarePen, X } from 'lucide-react';
import {
  useAiConfigsQuery,
  useAiConnectionQuery,
  useAiIndexStatusesQuery,
} from '@/lib/query/hooks';
import type { AiChatSource, AiConfig, AiIndexStatus } from '@/lib/types/ipc';
import { useAssistantStore } from '@/stores/assistant';
import { useSelectionStore } from '@/stores/selection';
import { AssistantComposer } from './AssistantComposer';
import { AssistantEmptyState } from './AssistantEmptyState';
import { AssistantNotice } from './AssistantNotice';
import type { AssistantUnavailableCause } from './AssistantNotice';
import { AssistantTranscript } from './AssistantTranscript';

const iconButtonClass =
  'grid size-9 shrink-0 cursor-pointer place-items-center rounded-full text-on-surface-variant hover:bg-surface-container focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-container';

export function unavailableCause(
  config: AiConfig | undefined,
  status: AiIndexStatus | undefined,
  reachable: boolean,
): AssistantUnavailableCause | null {
  if (!config?.enabled) return 'disabled';
  if (config.baseUrl === null) return 'noApiRoot';
  if (config.chatModel === null) return 'noChatModel';
  if (status?.state === 'needsRebuild') return 'needsRebuild';
  if (status?.state !== 'complete' && status?.state !== 'partial') return 'indexNotReady';
  if (!reachable) return 'unreachable';
  return null;
}

export function AssistantPanel({
  accountId,
  onClose,
  onOpenAiSettings,
}: {
  accountId: string;
  onClose: () => void;
  onOpenAiSettings: (cause: AssistantUnavailableCause) => void;
}) {
  const configs = useAiConfigsQuery();
  const statuses = useAiIndexStatusesQuery();
  const connection = useAiConnectionQuery(accountId);
  const messages = useAssistantStore((state) => state.messages);
  const selectAccount = useAssistantStore((state) => state.selectAccount);
  const newChat = useAssistantStore((state) => state.newChat);
  const ask = useAssistantStore((state) => state.ask);
  const prompt = useRef<HTMLTextAreaElement>(null);
  const container = useRef<HTMLElement>(null);

  const config = configs.data?.find((entry) => entry.accountId === accountId);
  const status = statuses.data?.find((entry) => entry.accountId === accountId);
  const cause = unavailableCause(config, status, !connection.isError);

  useEffect(() => {
    selectAccount(accountId);
  }, [accountId, selectAccount]);
  useEffect(() => {
    prompt.current?.focus();
  }, [cause]);
  useEffect(() => {
    const node = container.current;
    if (node === null) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    node.addEventListener('keydown', onEscape);
    return () => node.removeEventListener('keydown', onEscape);
  }, [onClose]);

  const openSource = useCallback((source: AiChatSource) => {
    useSelectionStore.getState().setActiveThreadId(source.threadId);
  }, []);

  return (
    <section
      ref={container}
      aria-label="AI assistant"
      className="flex min-h-0 min-w-0 flex-col bg-surface-container-lowest dark:bg-dark-surface-container-lowest"
    >
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-outline-variant pl-3.5 pr-2 dark:border-dark-outline-variant">
        <span className="flex-1 text-body-sm font-semibold">AI Assistant</span>
        {cause === null && (
          <button
            type="button"
            aria-label="New chat"
            title="New chat"
            onClick={newChat}
            className={iconButtonClass}
          >
            <SquarePen aria-hidden="true" size={16} />
          </button>
        )}
        <button
          type="button"
          aria-label="Close panel"
          title="Close panel"
          onClick={onClose}
          className={iconButtonClass}
        >
          <X aria-hidden="true" size={16} />
        </button>
      </div>
      {cause !== null && (
        <div className="p-3.5">
          <AssistantNotice
            cause={cause}
            accountEmail={config?.email ?? ''}
            indexed={status?.indexedMessages ?? 0}
            total={status?.totalEligibleMessages ?? 0}
            endpoint={config?.baseUrl ?? null}
            onAction={onOpenAiSettings}
          />
        </div>
      )}
      {messages.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
          {cause === null && <AssistantEmptyState onSelect={ask} />}
        </div>
      ) : (
        <AssistantTranscript messages={messages} onSourceActivate={openSource} />
      )}
      {cause === null && <AssistantComposer inputRef={prompt} />}
    </section>
  );
}
