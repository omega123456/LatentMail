import { format, isSameYear, toDate } from 'date-fns';
import type { AiChatSource } from '@/lib/types/ipc';

const cardClass =
  'flex w-full cursor-pointer items-start gap-2.25 rounded-control border border-outline-variant bg-surface-container-low px-2.25 py-1.75 text-left hover:bg-surface-container focus-visible:outline-2 focus-visible:outline-primary dark:border-dark-outline-variant dark:bg-dark-surface-container-low dark:hover:bg-dark-surface-container';

const numberClass =
  'w-ai-cite shrink-0 rounded-sm bg-primary-fixed py-0.5 text-center font-mono text-label-sm text-primary dark:bg-dark-primary-fixed dark:text-dark-primary';

export function sourceDateLabel(sentAtMillis: number, now: Date) {
  const sentAt = toDate(sentAtMillis);
  return format(sentAt, isSameYear(sentAt, now) ? 'MMM d' : 'MMM d, yyyy');
}

export function AssistantSources({
  sources,
  onActivate,
}: {
  sources: AiChatSource[];
  onActivate: (source: AiChatSource) => void;
}) {
  if (sources.length === 0) return null;
  const now = new Date();
  return (
    <div className="mt-1 grid gap-1.5">
      <span className="font-mono text-label-sm uppercase tracking-widest text-outline dark:text-dark-outline">
        Sources
      </span>
      {sources.map((source) => (
        <button
          key={`${source.number}-${source.messageId}`}
          type="button"
          onClick={() => onActivate(source)}
          className={cardClass}
        >
          <span className={numberClass}>{source.number}</span>
          <span className="grid min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5 text-label-sm font-semibold leading-4.5">
              <span className="truncate">{source.senderName || source.senderAddress}</span>
              <span className="ml-auto shrink-0 font-normal text-outline dark:text-dark-outline">
                {sourceDateLabel(source.sentAtMillis, now)}
              </span>
            </span>
            <span
              title={source.subject}
              className="truncate text-label-sm leading-4.5 text-on-surface-variant dark:text-dark-on-surface-variant"
            >
              {source.subject}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
