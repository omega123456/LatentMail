import { Star, X } from 'lucide-react';
import type { Conversation } from '@/lib/types/conversation';
import { ActionRibbon, type ActionRibbonProps } from './ActionRibbon';

export type BulkSelectionPanelProps = ActionRibbonProps & {
  count: number;
  selectedThreads: Conversation[];
  loadedThreadCount: number;
  onClearSelection: () => void;
  onSelectAll: () => void;
};

function selectionTally(threads: Conversation[]): string | null {
  const unread = threads.filter((thread) => thread.unread).length;
  const starred = threads.filter((thread) => thread.starred).length;
  const parts = [
    ...(unread > 0 ? [`${unread} unread`] : []),
    ...(starred > 0 ? [`${starred} starred`] : []),
  ];
  return parts.length > 0 ? parts.join(' · ') : null;
}

const textButtonClass =
  'cursor-pointer rounded px-2.5 py-1.5 text-body-sm focus-visible:outline-2 focus-visible:outline-primary dark:focus-visible:outline-dark-primary';

export function BulkSelectionPanel({
  count,
  selectedThreads,
  loadedThreadCount,
  onClearSelection,
  onSelectAll,
  ...ribbonProps
}: BulkSelectionPanelProps) {
  const tally = selectionTally(selectedThreads);
  return (
    <section
      aria-label="Bulk selection"
      data-testid="bulk-selection-panel"
      className="@container flex h-full flex-col gap-stack-gap-md bg-surface-bright p-stack-gap-md dark:bg-dark-surface-container-high"
    >
      <div className="flex flex-wrap items-start justify-between gap-stack-gap-sm">
        <div className="flex flex-col gap-1">
          <p role="status" className="text-title-lg text-on-surface dark:text-dark-on-surface">
            {count} conversation{count === 1 ? '' : 's'} selected
          </p>
          {tally && <p className="text-body-sm text-secondary dark:text-dark-secondary">{tally}</p>}
        </div>
        <div className="flex items-center gap-1">
          {count < loadedThreadCount && (
            <button
              type="button"
              onClick={onSelectAll}
              className={`${textButtonClass} text-secondary hover:bg-surface-container-low hover:text-on-surface dark:text-dark-secondary dark:hover:bg-dark-surface-container dark:hover:text-dark-on-surface`}
            >
              Select all {loadedThreadCount}
            </button>
          )}
          <button
            type="button"
            onClick={onClearSelection}
            className={`${textButtonClass} inline-flex items-center gap-1.5 border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 dark:border-dark-primary/30 dark:bg-dark-primary/10 dark:text-dark-primary dark:hover:bg-dark-primary/20`}
          >
            <X aria-hidden="true" size={14} />
            Clear
          </button>
        </div>
      </div>
      <div className="border-b border-outline-variant/50 pb-stack-gap-md dark:border-dark-outline-variant/50">
        <ActionRibbon {...ribbonProps} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
        <p className="text-label-md text-secondary dark:text-dark-secondary">In this selection</p>
        <ul className="flex flex-col gap-1">
          {selectedThreads.map((thread) => (
            <li
              key={thread.id}
              data-testid="bulk-selection-row"
              className="relative flex min-w-0 items-center gap-2 rounded border border-primary/30 bg-primary/10 px-3 py-2 dark:border-dark-primary/30 dark:bg-dark-primary/10"
            >
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 w-accent-border rounded-l bg-primary dark:bg-dark-primary"
              />
              <span className="w-32 shrink-0 truncate text-sender text-on-surface dark:text-dark-on-surface">
                {thread.sender}
              </span>
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="truncate text-row text-on-surface dark:text-dark-on-surface">
                  {thread.subject}
                </span>
                <span className="hidden min-w-0 flex-1 truncate text-snippet text-secondary @md:inline dark:text-dark-secondary">
                  {thread.snippet}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {thread.unread && (
                  <span
                    aria-label="Unread"
                    className="h-1.5 w-1.5 rounded-full bg-primary dark:bg-dark-primary"
                  />
                )}
                {thread.starred && (
                  <Star
                    aria-label="Starred"
                    size={14}
                    fill="currentColor"
                    className="text-star dark:text-dark-star"
                  />
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
