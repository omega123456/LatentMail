import { format, formatISO } from 'date-fns';
import { Avatar } from '@/components/shared/Avatar';
import { Badge } from '@/components/shared/Badge';
import { CopyButton } from '@/components/shared/CopyButton';
import type { MessageBadge } from '@/lib/labels/badges';
import { formatParticipants, type Participant } from '@/lib/format/participants';
import { domainFor } from '@/lib/avatars/identity';
import { useSenderAvatarQuery } from '@/lib/query/hooks';
import { useLayoutStore } from '@/stores/layout';

export type MessageSender = Participant;

const participantButtonClass =
  'cursor-pointer truncate text-left focus-visible:outline-2 focus-visible:outline-primary';

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
    <header className="group flex select-text items-start justify-between gap-4">
      <div className="flex min-w-0 items-center gap-4">
        {showSenderAvatars && <Avatar size={48} src={avatarSrc} label={senderLabel} ring />}
        <div className="flex min-w-0 flex-col">
          <div className="flex min-w-0 flex-wrap items-baseline gap-2">
            <button
              type="button"
              onClick={() => onComposeTo?.(sender)}
              className={`${participantButtonClass} text-sender text-on-surface dark:text-dark-on-surface`}
            >
              {sender.name || sender.address}
            </button>
            <button
              type="button"
              onClick={() => onComposeTo?.(sender)}
              className={`${participantButtonClass} text-body-sm text-secondary dark:text-dark-secondary`}
            >
              &lt;{sender.address}&gt;
            </button>
            <CopyButton value={sender.address} label={`Copy ${sender.address}`} />
            {badges.length > 0 && (
              <ul aria-label="Labels" className="flex flex-wrap items-center gap-1">
                {badges.map((badge) => (
                  <Badge key={badge.id} badge={badge} />
                ))}
              </ul>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              onClick={() => recipients[0] && onComposeTo?.(recipients[0])}
              title={participantsTitle(recipients)}
              className={`${participantButtonClass} text-snippet text-secondary dark:text-dark-secondary`}
            >
              to {formatParticipants(recipients)}
            </button>
            {recipients.length > 0 && (
              <CopyButton
                value={recipients.map((participant) => participant.address).join(', ')}
                label={
                  recipients.length === 1
                    ? `Copy ${recipients[0].address}`
                    : 'Copy all recipient addresses'
                }
              />
            )}
          </div>
        </div>
      </div>
      <time
        className="shrink-0 cursor-text text-body-sm text-secondary dark:text-dark-secondary"
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
