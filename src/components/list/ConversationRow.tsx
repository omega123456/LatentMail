import { Paperclip, Star } from 'lucide-react';
import { exactTime, relativeTime } from '@/lib/format/relative-time';
import type { Conversation } from '@/lib/types/conversation';
import type { Density } from '@/lib/types/ipc';

type Props = {
  conversation: Conversation;
  density: Density;
  active: boolean;
  mailboxId: string | null;
  onOpen: () => void;
  onStar: () => void;
};

export function ConversationRow({
  conversation,
  density,
  active,
  mailboxId,
  onOpen,
  onStar,
}: Props) {
  const compact = density === 'compact';
  const spacious = density === 'spacious';
  const height = compact ? 'h-row-compact' : spacious ? 'h-row-spacious' : 'h-row-comfortable';
  return (
    <article
      data-testid="conversation-row"
      data-density={density}
      data-active={active || undefined}
      className={`relative mb-1 flex shrink-0 items-center gap-2 rounded border p-3 transition-colors ${height} ${active ? 'border-primary/20 bg-surface-container-highest shadow-sm dark:border-dark-primary/20 dark:bg-dark-surface-container-highest' : 'border-transparent hover:border-outline-variant/30 hover:bg-surface-container-low dark:hover:border-dark-outline-variant/30 dark:hover:bg-dark-surface-container-low'}`}
    >
      <span
        aria-label={conversation.unread ? 'Unread' : 'Read'}
        className={`absolute left-2 top-4 h-2 w-2 rounded-full ${conversation.unread ? 'bg-primary dark:bg-dark-primary' : 'bg-transparent'}`}
      />
      <button
        aria-label={`Open ${conversation.subject}`}
        onClick={onOpen}
        className="flex min-w-0 flex-1 flex-col gap-1 pl-4 text-left focus-visible:outline-2 focus-visible:outline-primary"
      >
        <span className="flex w-full min-w-0 items-baseline justify-between">
          <span
            className={`truncate pr-2 text-label-md text-on-surface dark:text-dark-on-surface ${conversation.unread ? 'font-bold' : ''}`}
          >
            {conversation.sender}
            {compact && ` — ${conversation.subject}`}
          </span>
          <time
            title={exactTime(conversation.date)}
            className={`shrink-0 text-label-sm ${conversation.unread || active ? 'text-primary dark:text-dark-primary' : 'text-secondary dark:text-dark-secondary'}`}
          >
            {relativeTime(conversation.date)}
          </time>
        </span>
        {!compact && (
          <span className="w-full min-w-0 pr-1">
            <span
              className={`mb-0.5 block truncate text-row text-on-surface dark:text-dark-on-surface ${conversation.unread ? 'font-semibold' : ''}`}
            >
              {conversation.subject}
              {conversation.messageCount && conversation.messageCount > 1
                ? ` (${conversation.messageCount})`
                : ''}
              {conversation.draft ? ' · Draft' : ''}
            </span>
            {spacious && (
              <span
                className={`block truncate text-snippet ${conversation.unread ? 'text-on-surface-variant opacity-90 dark:text-dark-on-surface-variant' : 'text-secondary dark:text-dark-secondary'}`}
              >
                {conversation.snippet}
              </span>
            )}
          </span>
        )}
      </button>
      {!compact && (
        <span className="flex shrink-0 items-center gap-2 text-secondary dark:text-dark-secondary">
          {conversation.hasAttachment && <Paperclip aria-label="Has attachment" size={15} />}
          {conversation.labels?.map((label) => (
            <span
              key={label}
              title={label}
              className={
                spacious
                  ? 'rounded-sm bg-tertiary-container px-2 py-0.5 text-label-sm text-on-tertiary-container dark:bg-dark-tertiary-container dark:text-dark-on-tertiary-container'
                  : 'size-chip-dot rounded-full bg-tertiary-container dark:bg-dark-tertiary-container'
              }
            >
              {spacious ? label : null}
            </span>
          ))}
        </span>
      )}
      {mailboxId !== 'TRASH' && (
        <button
          aria-label={
            conversation.starred ? `Unstar ${conversation.subject}` : `Star ${conversation.subject}`
          }
          onClick={onStar}
          className={`shrink-0 rounded-sm p-1 focus-visible:outline-2 focus-visible:outline-primary ${conversation.starred ? 'text-star dark:text-dark-star' : 'text-secondary dark:text-dark-secondary'}`}
        >
          <Star size={18} fill={conversation.starred ? 'currentColor' : 'none'} />
        </button>
      )}
    </article>
  );
}
