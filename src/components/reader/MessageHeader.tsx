import { formatDistanceToNowStrict, format, formatISO } from 'date-fns';
import { formatParticipants, type Participant } from '@/lib/format/participants';

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
  return (
    <header className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 items-center gap-4">
        <div
          aria-hidden="true"
          className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary-fixed text-body-sm font-semibold text-on-primary-fixed ring-2 ring-surface-container dark:bg-dark-primary-fixed dark:text-dark-on-primary-fixed dark:ring-dark-surface-container"
        >
          {sender.name.slice(0, 1).toUpperCase()}
        </div>
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
