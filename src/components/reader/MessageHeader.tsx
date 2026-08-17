import { format, formatISO } from 'date-fns';
import { Avatar } from '@/components/shared/Avatar';
import { Badge } from '@/components/shared/Badge';
import type { MessageBadge } from '@/lib/labels/badges';
import { formatParticipants, type Participant } from '@/lib/format/participants';
import { domainFor } from '@/lib/avatars/identity';
import { useSenderAvatarQuery } from '@/lib/query/hooks';
import { useLayoutStore } from '@/stores/layout';

export type MessageSender = Participant;

export function MessageHeader({
  sender,
  recipients,
  sentAt,
  badges = [],
  onComposeTo,
}: {
  sender: MessageSender;
  recipients: Participant[];
  sentAt: Date;
  badges?: MessageBadge[];
  onComposeTo?: (participant: Participant) => void;
}) {
  const timestamp = format(sentAt, 'PPpp');
  const showSenderAvatars = useLayoutStore((state) => state.showSenderAvatars);
  const { data: avatarSrc } = useSenderAvatarQuery(
    showSenderAvatars ? domainFor(sender.address) : null,
  );
  const senderLabel = sender.name || sender.address;
  return (
    <header className="flex select-text items-start justify-between gap-4">
      <div className="flex min-w-0 items-center gap-4">
        {showSenderAvatars && <Avatar size={48} src={avatarSrc} label={senderLabel} ring />}
        <div className="flex min-w-0 flex-col">
          <div className="flex min-w-0 flex-wrap items-baseline gap-2">
            <button
              type="button"
              onClick={() => onComposeTo?.(sender)}
              className="cursor-pointer truncate text-left text-sender text-on-surface focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-surface"
            >
              {sender.name || sender.address}
            </button>
            <span className="truncate text-body-sm text-secondary dark:text-dark-secondary">
              &lt;{sender.address}&gt;
            </span>
            {badges.length > 0 && (
              <ul aria-label="Labels" className="flex flex-wrap items-center gap-1">
                {badges.map((badge) => (
                  <Badge key={badge.id} badge={badge} />
                ))}
              </ul>
            )}
          </div>
          <button
            type="button"
            onClick={() => recipients[0] && onComposeTo?.(recipients[0])}
            title={participantsTitle(recipients)}
            className="cursor-pointer truncate text-left text-snippet text-secondary focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary"
          >
            to {formatParticipants(recipients)}
          </button>
        </div>
      </div>
      <time
        className="shrink-0 text-body-sm text-secondary dark:text-dark-secondary"
        dateTime={formatISO(sentAt)}
      >
        {timestamp}
      </time>
    </header>
  );
}

function participantsTitle(participants: Participant[]) {
  return participants
    .map(({ name, address }) => (name ? `${name} <${address}>` : address))
    .join(', ');
}
