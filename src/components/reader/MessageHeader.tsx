import { formatDistanceToNowStrict, format, formatISO } from 'date-fns';
import { Avatar } from '@/components/shared/Avatar';
import { formatParticipants, type Participant } from '@/lib/format/participants';
import { domainFor } from '@/lib/avatars/identity';
import { useSenderAvatarQuery } from '@/lib/query/hooks';
import { useLayoutStore } from '@/stores/layout';

export type MessageSender = Participant;

export function MessageHeader({
  sender,
  recipients,
  sentAt,
  onComposeTo,
}: {
  sender: MessageSender;
  recipients: Participant[];
  sentAt: Date;
  onComposeTo?: (participant: Participant) => void;
}) {
  const timestamp = formatDistanceToNowStrict(sentAt, { addSuffix: true });
  // FR "Preference": governs whether the reader's avatar renders (and is
  // looked up) too, not just the list's.
  const showSenderAvatars = useLayoutStore((state) => state.showSenderAvatars);
  const { data: avatarSrc } = useSenderAvatarQuery(
    showSenderAvatars ? domainFor(sender.address) : null,
  );
  // The label shown beside the sender doubles as the avatar's initial input
  // — a sender with no display name previously produced a blank circle
  // because only `sender.name` was read; it now falls back to the address
  // exactly like the visible text does.
  const senderLabel = sender.name || sender.address;
  // `select-text` opts the whole header back out of the app-wide
  // `select-none` (index.html): sender, address, recipients and timestamp are
  // all things a user legitimately copies out of a message.
  return (
    <header className="flex select-text items-start justify-between gap-4">
      <div className="flex min-w-0 items-center gap-4">
        {showSenderAvatars && <Avatar size={48} src={avatarSrc} label={senderLabel} ring />}
        <div className="flex min-w-0 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => onComposeTo?.(sender)}
              className="truncate text-left text-sender text-on-surface focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-surface"
            >
              {sender.name || sender.address}
            </button>
            <span className="truncate text-body-sm text-secondary dark:text-dark-secondary">
              &lt;{sender.address}&gt;
            </span>
          </div>
          <button
            type="button"
            onClick={() => recipients[0] && onComposeTo?.(recipients[0])}
            title={participantsTitle(recipients)}
            className="truncate text-left text-snippet text-secondary focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary"
          >
            to {formatParticipants(recipients)}
          </button>
        </div>
      </div>
      <time
        title={format(sentAt, 'PPpp')}
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
