import { Paperclip, Star } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { RowContextMenu } from '@/components/actions/RowContextMenu';
import { Avatar, AVATAR_SIZE } from '@/components/shared/Avatar';
import { Badge } from '@/components/shared/Badge';
import { ICON_SIZE } from '@/components/shared/icon-size';
import { exactTime, relativeTime } from '@/lib/format/relative-time';
import type { sourceBadge, userBadgesByName } from '@/lib/labels/badges';
import { useSenderAvatarQuery } from '@/lib/query/hooks';
import { useLayoutStore } from '@/stores/layout';
import type { Conversation } from '@/lib/types/conversation';
import {
  formatRowSubject,
  NOTCH_RING_CLASSES,
  resolveRowContextProps,
  resolveRowPresentation,
  ROW_STATE_CLASSES,
  type ConversationRowProps,
} from './conversation-row-context';

const ROW_BADGE_LIMIT = 2;

function RowBadges({
  source,
  showSource,
  rowBadges,
  spacious,
}: {
  source: ReturnType<typeof sourceBadge>;
  showSource: boolean;
  rowBadges: ReturnType<typeof userBadgesByName>;
  spacious: boolean;
}) {
  if (rowBadges.length === 0 && !showSource) return null;
  const overflowCount = rowBadges.length - ROW_BADGE_LIMIT;
  return (
    <ul aria-label="Labels and source mailbox" className="flex items-center gap-1">
      {showSource && source && (
        <Badge key={`source-${source.id}`} badge={source} iconOnly={!spacious} />
      )}
      {rowBadges.slice(0, ROW_BADGE_LIMIT).map((badge) => (
        <Badge key={badge.id} badge={badge} iconOnly={!spacious} />
      ))}
      {overflowCount > 0 && (
        <li
          title={`${overflowCount} more labels`}
          className="shrink-0 rounded-sm bg-surface-container px-1.5 py-0.5 text-label-sm font-normal text-secondary dark:bg-dark-surface-container dark:text-dark-secondary"
        >
          +{overflowCount}
        </li>
      )}
    </ul>
  );
}

function UnreadIndicator({ compact, unread }: { compact: boolean; unread: boolean }) {
  const statusText = unread ? 'Unread' : 'Read';
  if (!compact) return <span className="sr-only">{statusText}</span>;
  const dotColor = unread ? 'bg-primary dark:bg-dark-primary' : 'bg-transparent';
  return (
    <span
      aria-label={statusText}
      className={`absolute left-2 top-4 h-2 w-2 rounded-full ${dotColor}`}
    />
  );
}

function RowStarButton({
  hidden,
  starred,
  subject,
  onStar,
}: {
  hidden: boolean;
  starred: boolean;
  subject: string;
  onStar: () => void;
}) {
  if (hidden) return null;
  const label = starred ? `Unstar ${subject}` : `Star ${subject}`;
  const colorClass = starred
    ? 'text-star dark:text-dark-star'
    : 'text-secondary dark:text-dark-secondary';
  return (
    <button
      aria-label={label}
      onClick={onStar}
      className={`relative z-10 shrink-0 cursor-pointer rounded-sm p-1 focus-visible:outline-2 focus-visible:outline-primary ${colorClass}`}
    >
      <Star size={ICON_SIZE.lg} fill={starred ? 'currentColor' : 'none'} />
    </button>
  );
}

function RowSubjectDetails({
  conversation,
  spacious,
  unreadTextClass,
  source,
  showSource,
  rowBadges,
}: {
  conversation: Conversation;
  spacious: boolean;
  unreadTextClass: string;
  source: ReturnType<typeof sourceBadge>;
  showSource: boolean;
  rowBadges: ReturnType<typeof userBadgesByName>;
}) {
  return (
    <>
      <span className="flex w-full min-w-0 items-center gap-2">
        <span className={`min-w-0 flex-1 truncate text-row ${unreadTextClass}`}>
          {formatRowSubject(conversation)}
        </span>
        <span className="relative z-10 flex shrink-0 items-center gap-2 text-secondary dark:text-dark-secondary">
          {conversation.hasAttachment && (
            <Paperclip aria-label="Has attachment" size={ICON_SIZE.md} />
          )}
          <RowBadges
            source={source}
            showSource={showSource}
            rowBadges={rowBadges}
            spacious={spacious}
          />
        </span>
      </span>
      {spacious && (
        <span className={`block truncate text-snippet ${unreadTextClass}`}>
          {conversation.snippet}
        </span>
      )}
    </>
  );
}

function RowTextColumns({
  conversation,
  compact,
  spacious,
  showActive,
  source,
  showSource,
  rowBadges,
}: {
  conversation: Conversation;
  compact: boolean;
  spacious: boolean;
  showActive: boolean;
  source: ReturnType<typeof sourceBadge>;
  showSource: boolean;
  rowBadges: ReturnType<typeof userBadgesByName>;
}) {
  const unreadTextClass = conversation.unread
    ? 'font-semibold text-on-surface dark:text-dark-on-surface'
    : 'font-normal text-secondary dark:text-dark-secondary';
  const senderClass = conversation.unread
    ? 'font-bold text-on-surface dark:text-dark-on-surface'
    : 'font-normal text-secondary dark:text-dark-secondary';
  const timeClass =
    conversation.unread || showActive
      ? 'text-primary dark:text-dark-primary'
      : 'text-secondary dark:text-dark-secondary';
  return (
    <div className={`flex min-w-0 flex-1 flex-col gap-1 ${compact ? 'pl-4' : ''}`}>
      <span className="flex w-full min-w-0 items-baseline justify-between gap-2">
        <span className={`truncate text-label-md ${senderClass}`}>
          {conversation.sender}
          {compact && ` — ${conversation.subject}`}
        </span>
        <time
          title={exactTime(conversation.date)}
          className={`relative z-10 shrink-0 text-label-sm ${timeClass}`}
        >
          {relativeTime(conversation.date)}
        </time>
      </span>
      {!compact && (
        <RowSubjectDetails
          conversation={conversation}
          spacious={spacious}
          unreadTextClass={unreadTextClass}
          source={source}
          showSource={showSource}
          rowBadges={rowBadges}
        />
      )}
    </div>
  );
}

function useFlashAnimation(
  flashRef: React.RefObject<HTMLElement | null>,
  flash: boolean,
  onFlashComplete?: () => void,
) {
  useEffect(() => {
    const row = flashRef.current;
    if (!flash || !row || !onFlashComplete) return;
    row.addEventListener('animationend', onFlashComplete, { once: true });
    return () => row.removeEventListener('animationend', onFlashComplete);
  }, [flashRef, flash, onFlashComplete]);
}

function RowAvatarSlot({
  visible,
  spacious,
  avatarSrc,
  identityLabel,
  unread,
  notchRingClassName,
}: {
  visible: boolean;
  spacious: boolean;
  avatarSrc: string | null | undefined;
  identityLabel: string | null | undefined;
  unread: boolean;
  notchRingClassName: string;
}) {
  if (!visible) return null;
  return (
    <Avatar
      size={spacious ? AVATAR_SIZE.xl : AVATAR_SIZE.md}
      src={avatarSrc}
      label={identityLabel}
      unread={unread}
      notchRingClassName={notchRingClassName}
    />
  );
}

export function ConversationRow(props: ConversationRowProps) {
  const { conversation, density, onOpen, onStar } = props;
  const flashRef = useRef<HTMLElement>(null);
  const view = resolveRowPresentation(props);
  useFlashAnimation(flashRef, view.flash, props.onFlashComplete);
  const showSenderAvatars = useLayoutStore((layout) => layout.showSenderAvatars);
  const { data: avatarSrc } = useSenderAvatarQuery(
    view.compact ? null : (conversation.avatarDomain ?? null),
  );
  const contextMenuProps = resolveRowContextProps(props, view.selected);
  return (
    <RowContextMenu {...contextMenuProps}>
      <article
        ref={flashRef}
        data-testid="conversation-row"
        data-density={density}
        data-active={view.showActive || undefined}
        data-selected={view.selected || undefined}
        className={`group relative mb-1 flex shrink-0 items-center gap-2 rounded border p-3 transition-colors ${view.flashClass} ${ROW_STATE_CLASSES[view.visualState]}`}
      >
        {view.selected && (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 w-accent-border rounded-l bg-primary dark:bg-dark-primary"
          />
        )}
        <UnreadIndicator compact={view.compact} unread={conversation.unread} />
        <RowAvatarSlot
          visible={!view.compact && showSenderAvatars}
          spacious={view.spacious}
          avatarSrc={avatarSrc}
          identityLabel={conversation.identityLabel}
          unread={conversation.unread}
          notchRingClassName={NOTCH_RING_CLASSES[view.visualState]}
        />
        <RowTextColumns
          conversation={conversation}
          compact={view.compact}
          spacious={view.spacious}
          showActive={view.showActive}
          source={view.source}
          showSource={view.showSource}
          rowBadges={view.rowBadges}
        />
        <button
          aria-label={`Open ${conversation.subject}`}
          onClick={onOpen}
          className="absolute inset-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-primary"
        />
        <RowStarButton
          hidden={view.systemLabelIds.includes('TRASH')}
          starred={conversation.starred}
          subject={conversation.subject}
          onStar={onStar}
        />
      </article>
    </RowContextMenu>
  );
}
