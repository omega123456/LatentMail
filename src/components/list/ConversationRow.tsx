import { Paperclip, Star } from 'lucide-react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { moveSource, type MoveDestinationId } from '@/components/actions/MoveToMenu';
import type { LabelMenuEntry } from '@/components/actions/LabelsMenu';
import { RowContextMenu } from '@/components/actions/RowContextMenu';
import { Avatar } from '@/components/shared/Avatar';
import { exactTime, relativeTime } from '@/lib/format/relative-time';
import { useSenderAvatarQuery } from '@/lib/query/hooks';
import { useLayoutStore } from '@/stores/layout';
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
  onCompose?: (action: 'reply' | 'reply-all' | 'forward' | 'edit-draft') => void;
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
  onCompose,
}: Props) {
  const compact = density === 'compact';
  const spacious = density === 'spacious';
  // No avatar at compact — no room, and D8 rejects shrinking one to fit
  // (FR "Presentation" / D8). Also skips issuing this row's own
  // sender-avatar query at compact, since nothing would render it.
  const showAvatarSlot = !compact;
  const showSenderAvatars = useLayoutStore((state) => state.showSenderAvatars);
  const { data: avatarSrc } = useSenderAvatarQuery(
    showAvatarSlot ? (conversation.avatarDomain ?? null) : null,
  );
  // The single-active (keyboard-cursor/open) highlight and the
  // multi-selection treatment must never render simultaneously.
  const showActive = active && !multiSelectActive;
  const stateClasses = selected
    ? 'border-primary/30 bg-primary/10 dark:border-dark-primary/30 dark:bg-dark-primary/10'
    : showActive
      ? 'border-primary/20 bg-surface-container-highest shadow-sm dark:border-dark-primary/20 dark:bg-dark-surface-container-highest'
      : 'border-transparent hover:border-outline-variant/30 hover:bg-surface-container-low dark:hover:border-dark-outline-variant/30 dark:hover:bg-dark-surface-container-low';
  const effectiveSelectionCount = selected && multiSelectActive ? selectionCount : 1;
  // The unread notch's ring must track the row's own current ground, not a
  // fixed color — otherwise it visibly mismatches on hover/selected rows
  // (the plan's single most likely screenshot-regression source). Resting
  // uses `group-hover:` so the ring follows real `:hover`, since the row's
  // hover background itself is CSS-only (no JS hover state).
  const notchRingClassName = selected
    ? 'ring-primary/10 dark:ring-dark-primary/10'
    : showActive
      ? 'ring-surface-container-highest dark:ring-dark-surface-container-highest'
      : 'ring-surface group-hover:ring-surface-container-low dark:ring-dark-surface-container dark:group-hover:ring-dark-surface-container-low';
  // FR "Preference": off means no avatar element renders at all, not merely
  // an un-queried one.
  const renderAvatar = showAvatarSlot && showSenderAvatars;
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
      onOpen={() => onOpen({ shiftKey: false, metaKey: false, ctrlKey: false } as ReactMouseEvent)}
      onToggleRead={() =>
        onTriage({
          add: conversation.unread ? [] : ['UNREAD'],
          remove: conversation.unread ? ['UNREAD'] : [],
        })
      }
      onToggleStar={onStar}
      onMoveTo={(destination: MoveDestinationId) =>
        onTriage({ add: [destination], remove: moveSource(mailboxId ?? 'INBOX', currentLabelName) })
      }
      onToggleLabel={(labelId, checked) =>
        onTriage({ add: checked ? [labelId] : [], remove: checked ? [] : [labelId] })
      }
      onToggleSpam={() =>
        onTriage({
          add: mailboxId === 'SPAM' ? [] : ['SPAM'],
          remove: mailboxId === 'SPAM' ? ['SPAM'] : [],
        })
      }
      onDelete={() => onTriage({ add: ['TRASH'], remove: [] })}
      onReply={onCompose ? () => onCompose('reply') : undefined}
      onReplyAll={onCompose ? () => onCompose('reply-all') : undefined}
      onForward={onCompose ? () => onCompose('forward') : undefined}
      onEditDraft={conversation.draft && onCompose ? () => onCompose('edit-draft') : undefined}
    >
      <article
        data-testid="conversation-row"
        data-density={density}
        data-active={showActive || undefined}
        data-selected={selected || undefined}
        className={`group relative mb-1 flex shrink-0 items-center gap-2 rounded border p-3 transition-colors ${stateClasses}`}
      >
        {selected && (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 w-accent-border rounded-l bg-primary dark:bg-dark-primary"
          />
        )}
        {/* The row's only programmatic read-state signal (D16) — always
            rendered at every density. At compact it's also the visible edge
            dot (unchanged); at comfortable/spacious the notch on the avatar
            carries that visual weight instead, so this becomes
            visually-hidden decoration-free markup that AT still reads. */}
        <span
          aria-label={compact ? (conversation.unread ? 'Unread' : 'Read') : undefined}
          className={
            compact
              ? `absolute left-2 top-4 h-2 w-2 rounded-full ${conversation.unread ? 'bg-primary dark:bg-dark-primary' : 'bg-transparent'}`
              : 'sr-only'
          }
        >
          {!compact && (conversation.unread ? 'Unread' : 'Read')}
        </span>
        {renderAvatar && (
          <Avatar
            size={spacious ? 40 : 32}
            src={avatarSrc}
            label={conversation.identityLabel}
            unread={conversation.unread}
            notchRingClassName={notchRingClassName}
          />
        )}
        {/* `after:inset-0` stretches the open control's hit area over the
            whole row while keeping one real button for keyboard/AT. */}
        <button
          aria-label={`Open ${conversation.subject}`}
          onClick={onOpen}
          className={`flex min-w-0 flex-1 flex-col gap-1 text-left after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-primary ${compact ? 'pl-4' : ''}`}
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
            className={`relative z-10 shrink-0 rounded-sm p-1 focus-visible:outline-2 focus-visible:outline-primary ${conversation.starred ? 'text-star dark:text-dark-star' : 'text-secondary dark:text-dark-secondary'}`}
          >
            <Star size={18} fill={conversation.starred ? 'currentColor' : 'none'} />
          </button>
        )}
      </article>
    </RowContextMenu>
  );
}
