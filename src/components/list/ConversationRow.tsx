import { Paperclip, Star } from 'lucide-react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { moveSource, type MoveDestinationId } from '@/components/actions/MoveToMenu';
import type { LabelMenuEntry } from '@/components/actions/LabelsMenu';
import { RowContextMenu } from '@/components/actions/RowContextMenu';
import { exactTime, relativeTime } from '@/lib/format/relative-time';
import type { Conversation } from '@/lib/types/conversation';
import type { Density } from '@/lib/types/ipc';

type Props = {
  conversation: Conversation;
  density: Density;
  active: boolean;
  /** Whether this row is checked for a bulk action. */
  selected?: boolean;
  /** Whether *any* row is currently multi-selected — the single-active-row
   * highlight is suppressed everywhere while this is true, even on rows
   * that aren't themselves selected. */
  multiSelectActive?: boolean;
  mailboxId: string | null;
  /** Every user label in the account, for the row context menu's Labels
   * submenu. */
  allLabels?: LabelMenuEntry[];
  /** Count of currently selected rows — relabels the context menu's entries
   * when >1 and this row is part of that selection. */
  selectionCount?: number;
  currentLabelName?: string;
  onOpen: (event: ReactMouseEvent) => void;
  onStar: () => void;
  onTriage?: (change: { add: string[]; remove: string[] }) => void;
};

export function ConversationRow({
  conversation,
  density,
  active,
  selected = false,
  multiSelectActive = false,
  mailboxId,
  allLabels = [],
  selectionCount = 1,
  currentLabelName,
  onOpen,
  onStar,
  onTriage = () => undefined,
}: Props) {
  const compact = density === 'compact';
  const spacious = density === 'spacious';
  const height = compact ? 'h-row-compact' : spacious ? 'h-row-spacious' : 'h-row-comfortable';
  // The single-active (keyboard-cursor/open) highlight and the
  // multi-selection treatment must never render simultaneously.
  const showActive = active && !multiSelectActive;
  const stateClasses = selected
    ? 'border-primary/30 bg-primary/10 dark:border-dark-primary/30 dark:bg-dark-primary/10'
    : showActive
      ? 'border-primary/20 bg-surface-container-highest shadow-sm dark:border-dark-primary/20 dark:bg-dark-surface-container-highest'
      : 'border-transparent hover:border-outline-variant/30 hover:bg-surface-container-low dark:hover:border-dark-outline-variant/30 dark:hover:bg-dark-surface-container-low';
  const effectiveSelectionCount = selected && multiSelectActive ? selectionCount : 1;
  const rowLabels: LabelMenuEntry[] = allLabels.map((label) => ({
    ...label,
    membership: (conversation.labels ?? []).includes(label.name) ? 'checked' : 'unchecked',
  }));
  return (
    <RowContextMenu
      mailboxId={mailboxId ?? 'INBOX'}
      unread={conversation.unread}
      starred={conversation.starred}
      labels={rowLabels}
      currentLabelName={currentLabelName}
      selectionCount={effectiveSelectionCount}
      // The context menu's "Open" entry always opens plainly (no
      // range/toggle modifiers) regardless of how the menu itself was
      // invoked.
      onOpen={() =>
        onOpen({ shiftKey: false, metaKey: false, ctrlKey: false } as ReactMouseEvent)
      }
      onToggleRead={() => onTriage({ add: conversation.unread ? [] : ['UNREAD'], remove: conversation.unread ? ['UNREAD'] : [] })}
      onToggleStar={onStar}
      onMoveTo={(destination: MoveDestinationId) => onTriage({ add: [destination], remove: moveSource(mailboxId ?? 'INBOX', currentLabelName) })}
      onToggleLabel={(labelId, checked) => onTriage({ add: checked ? [labelId] : [], remove: checked ? [] : [labelId] })}
      onToggleSpam={() => onTriage({ add: mailboxId === 'SPAM' ? [] : ['SPAM'], remove: mailboxId === 'SPAM' ? ['SPAM'] : [] })}
      onDelete={() => onTriage({ add: ['TRASH'], remove: [] })}
    >
      <article
        data-testid="conversation-row"
        data-density={density}
        data-active={showActive || undefined}
        data-selected={selected || undefined}
        className={`relative mb-1 flex shrink-0 items-center gap-2 rounded border p-3 transition-colors ${height} ${stateClasses}`}
      >
        {selected && (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 w-accent-border rounded-l bg-primary dark:bg-dark-primary"
          />
        )}
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
              className={`shrink-0 text-label-sm ${conversation.unread || showActive ? 'text-primary dark:text-dark-primary' : 'text-secondary dark:text-dark-secondary'}`}
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
              conversation.starred
                ? `Unstar ${conversation.subject}`
                : `Star ${conversation.subject}`
            }
            onClick={onStar}
            className={`shrink-0 rounded-sm p-1 focus-visible:outline-2 focus-visible:outline-primary ${conversation.starred ? 'text-star dark:text-dark-star' : 'text-secondary dark:text-dark-secondary'}`}
          >
            <Star size={18} fill={conversation.starred ? 'currentColor' : 'none'} />
          </button>
        )}
      </article>
    </RowContextMenu>
  );
}
