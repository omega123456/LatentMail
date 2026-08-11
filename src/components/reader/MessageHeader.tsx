import { formatDistanceToNowStrict, format } from 'date-fns';
import { formatParticipants, type Participant } from '@/lib/format/participants';

export type MessageSender = Participant;

export function MessageHeader({
  sender,
  recipients,
  sentAt,
}: {
  sender: MessageSender;
  recipients: Participant[];
  sentAt: Date;
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
            <span className="truncate text-sender text-on-surface dark:text-dark-on-surface">
              {sender.name || sender.address}
            </span>
            <span className="truncate text-body-sm text-secondary dark:text-dark-secondary">
              &lt;{sender.address}&gt;
            </span>
          </div>
          <p
            title={participantsTitle(recipients)}
            className="truncate text-snippet text-secondary dark:text-dark-secondary"
          >
            to {formatParticipants(recipients)}
          </p>
        </div>
      </div>
      <time
        title={format(sentAt, 'PPpp')}
        className="shrink-0 text-body-sm text-secondary dark:text-dark-secondary"
        dateTime={sentAt.toISOString()}
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
