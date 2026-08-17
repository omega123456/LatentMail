import { Paperclip, Star } from 'lucide-react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { MoveDestinationId } from '@/components/actions/MoveToMenu';
import type { LabelMenuEntry } from '@/components/actions/LabelsMenu';
import { RowContextMenu } from '@/components/actions/RowContextMenu';
import { Avatar } from '@/components/shared/Avatar';
import { Badge } from '@/components/shared/Badge';
import { sourceBadge, userBadgesByName } from '@/lib/labels/badges';
import { exactTime, relativeTime } from '@/lib/format/relative-time';
import { useSenderAvatarQuery, type ThreadTriageIntent } from '@/lib/query/hooks';
import { useLayoutStore } from '@/stores/layout';
import type { Conversation } from '@/lib/types/conversation';
import type { Density } from '@/lib/types/ipc';

const ROW_BADGE_LIMIT = 2;

type Props = {
  conversation: Conversation;
  density: Density;
  active: boolean;
  selected?: boolean;
  multiSelectActive?: boolean;
  allLabels?: LabelMenuEntry[];
  selectionCount?: number;
  selectionSystemLabelIds?: string[];
  currentFolderId?: string;
  onOpen: (event: ReactMouseEvent) => void;
  onStar: () => void;
  onTriage?: (intent: ThreadTriageIntent) => void;
  onCompose?: (action: 'reply' | 'reply-all' | 'forward' | 'edit-draft') => void;
};

export function ConversationRow({
  conversation,
  density,
  active,
  selected = false,
  multiSelectActive = false,
  allLabels = [],
  selectionCount = 1,
  selectionSystemLabelIds,
  currentFolderId,
  onOpen,
  onStar,
  onTriage = () => undefined,
  onCompose,
}: Props) {
  const systemLabelIds = conversation.systemLabelIds ?? [];
  const effectiveSelectionCount = selected && multiSelectActive ? selectionCount : 1;
  const contextMenuSystemLabelIds =
    effectiveSelectionCount > 1 ? (selectionSystemLabelIds ?? systemLabelIds) : systemLabelIds;
  const isSpam = contextMenuSystemLabelIds.includes('SPAM');
  const isTrash = systemLabelIds.includes('TRASH');
  const compact = density === 'compact';
  const spacious = density === 'spacious';
  const showAvatarSlot = !compact;
  const showSenderAvatars = useLayoutStore((state) => state.showSenderAvatars);
  const { data: avatarSrc } = useSenderAvatarQuery(
    showAvatarSlot ? (conversation.avatarDomain ?? null) : null,
  );
  const showActive = active && !multiSelectActive;
  const stateClasses = selected
    ? 'border-primary/30 bg-primary/10 dark:border-dark-primary/30 dark:bg-dark-primary/10'
    : showActive
      ? 'border-primary/20 bg-surface-container-highest shadow-sm dark:border-dark-primary/20 dark:bg-dark-surface-container-highest'
      : 'border-transparent hover:border-outline-variant/30 hover:bg-surface-container-low dark:hover:border-dark-outline-variant/30 dark:hover:bg-dark-surface-container-low';
  const notchRingClassName = selected
    ? 'ring-primary/10 dark:ring-dark-primary/10'
    : showActive
      ? 'ring-surface-container-highest dark:ring-dark-surface-container-highest'
      : 'ring-surface group-hover:ring-surface-container-low dark:ring-dark-surface-container dark:group-hover:ring-dark-surface-container-low';
  const renderAvatar = showAvatarSlot && showSenderAvatars;
  const rowLabels: LabelMenuEntry[] = allLabels.map((label) => ({
    ...label,
    membership: (conversation.labels ?? []).includes(label.name) ? 'checked' : 'unchecked',
  }));
  const rowBadges = userBadgesByName(conversation.labels ?? [], allLabels);
  const source = sourceBadge(conversation.systemLabelIds);
  const showSource = source && source.id !== currentFolderId;
  return (
    <RowContextMenu
      systemLabelIds={contextMenuSystemLabelIds}
      unread={conversation.unread}
      starred={conversation.starred}
      labels={rowLabels}
      selectionCount={effectiveSelectionCount}
      onOpen={() => onOpen({ shiftKey: false, metaKey: false, ctrlKey: false } as ReactMouseEvent)}
      onToggleRead={() =>
        onTriage({
          kind: 'label',
          add: conversation.unread ? [] : ['UNREAD'],
          remove: conversation.unread ? ['UNREAD'] : [],
        })
      }
      onToggleStar={onStar}
      onMoveTo={(destination: MoveDestinationId) => onTriage({ kind: 'move', destination })}
      onToggleLabel={(labelId, checked) =>
        onTriage({ kind: 'label', add: checked ? [labelId] : [], remove: checked ? [] : [labelId] })
      }
      onToggleSpam={() => onTriage({ kind: 'move', destination: isSpam ? 'INBOX' : 'SPAM' })}
      onDelete={() => onTriage({ kind: 'delete' })}
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
        <div className={`flex min-w-0 flex-1 flex-col gap-1 ${compact ? 'pl-4' : ''}`}>
          <span className="flex w-full min-w-0 items-baseline justify-between gap-2">
            <span
              className={`truncate text-label-md ${conversation.unread ? 'font-bold text-on-surface dark:text-dark-on-surface' : 'font-normal text-secondary dark:text-dark-secondary'}`}
            >
              {conversation.sender}
              {compact && ` — ${conversation.subject}`}
            </span>
            <time
              title={exactTime(conversation.date)}
              className={`relative z-10 shrink-0 text-label-sm ${conversation.unread || showActive ? 'text-primary dark:text-dark-primary' : 'text-secondary dark:text-dark-secondary'}`}
            >
              {relativeTime(conversation.date)}
            </time>
          </span>
          {!compact && (
            <>
              <span className="flex w-full min-w-0 items-center gap-2">
                <span
                  className={`min-w-0 flex-1 truncate text-row ${conversation.unread ? 'font-semibold text-on-surface dark:text-dark-on-surface' : 'font-normal text-secondary dark:text-dark-secondary'}`}
                >
                  {conversation.subject}
                  {conversation.messageCount && conversation.messageCount > 1
                    ? ` (${conversation.messageCount})`
                    : ''}
                  {conversation.draft ? ' · Draft' : ''}
                </span>
                <span className="relative z-10 flex shrink-0 items-center gap-2 text-secondary dark:text-dark-secondary">
                  {conversation.hasAttachment && <Paperclip aria-label="Has attachment" size={15} />}
                  {(rowBadges.length > 0 || showSource) && (
                    <ul aria-label="Labels and source mailbox" className="flex items-center gap-1">
                      {showSource && (
                        <Badge key={`source-${source.id}`} badge={source} iconOnly={!spacious} />
                      )}
                      {rowBadges.slice(0, ROW_BADGE_LIMIT).map((badge) => (
                        <Badge key={badge.id} badge={badge} iconOnly={!spacious} />
                      ))}
                      {rowBadges.length > ROW_BADGE_LIMIT && (
                        <li
                          title={`${rowBadges.length - ROW_BADGE_LIMIT} more labels`}
                          className="shrink-0 rounded-sm bg-surface-container px-1.5 py-0.5 text-label-sm font-normal text-secondary dark:bg-dark-surface-container dark:text-dark-secondary"
                        >
                          +{rowBadges.length - ROW_BADGE_LIMIT}
                        </li>
                      )}
                    </ul>
                  )}
                </span>
              </span>
              {spacious && (
                <span
                  className={`block truncate text-snippet ${conversation.unread ? 'font-semibold text-on-surface dark:text-dark-on-surface' : 'font-normal text-secondary dark:text-dark-secondary'}`}
                >
                  {conversation.snippet}
                </span>
              )}
            </>
          )}
        </div>
        <button
          aria-label={`Open ${conversation.subject}`}
          onClick={onOpen}
          className="absolute inset-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-primary"
        />
        {!isTrash && (
          <button
            aria-label={
              conversation.starred
                ? `Unstar ${conversation.subject}`
                : `Star ${conversation.subject}`
            }
            onClick={onStar}
            className={`relative z-10 shrink-0 cursor-pointer rounded-sm p-1 focus-visible:outline-2 focus-visible:outline-primary ${conversation.starred ? 'text-star dark:text-dark-star' : 'text-secondary dark:text-dark-secondary'}`}
          >
            <Star size={18} fill={conversation.starred ? 'currentColor' : 'none'} />
          </button>
        )}
      </article>
    </RowContextMenu>
  );
}
