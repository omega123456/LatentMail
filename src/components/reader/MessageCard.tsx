import { useState } from 'react';
import { ChevronDown, ChevronRight, ImageOff } from 'lucide-react';
import { BodyFrame } from './BodyFrame';
import { MessageHeader, type MessageSender } from './MessageHeader';
import type { Participant } from '@/lib/format/participants';

export type ReaderMessage = {
  id: string;
  sender: MessageSender;
  recipients: Participant[];
  sentAt: Date;
  snippet: string;
  html: string | null;
  text: string | null;
  labels?: string[];
  remoteImagesBlocked?: boolean;
};

export function MessageCard({
  message,
  expanded,
  newest,
}: {
  message: ReaderMessage;
  expanded: boolean;
  newest: boolean;
}) {
  const [isExpanded, setExpanded] = useState(expanded);
  const open = newest || isExpanded;
  return (
    <article
      className={`relative pb-6 ${newest ? '' : 'mb-6 border-b border-outline-variant/30 dark:border-dark-outline-variant/50'}`}
      data-testid={`message-${message.id}`}
    >
      {!newest && (
        <button
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} message from ${message.sender.name || message.sender.address}`}
          onClick={() => setExpanded((value) => !value)}
          className="absolute -left-6 top-4 rounded-sm text-secondary focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary"
        >
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
      )}
      <div
        className={
          open ? 'border-b border-outline-variant/30 pb-6 dark:border-dark-outline-variant/50' : ''
        }
      >
        <MessageHeader
          sender={message.sender}
          recipients={message.recipients}
          sentAt={message.sentAt}
        />
      </div>
      {open ? (
        <div className="mt-8 text-body-md">
          {message.remoteImagesBlocked && (
            <p className="mb-stack-gap-md flex items-center gap-stack-gap-sm rounded-sm bg-surface-container p-stack-gap-sm text-label-sm text-secondary dark:bg-dark-surface-container dark:text-dark-secondary">
              <ImageOff size={16} />
              Remote images are blocked.
            </p>
          )}
          <BodyFrame html={message.html} text={message.text} />
        </div>
      ) : (
        <p className="ml-16 mt-stack-gap-sm truncate text-body-sm text-secondary dark:text-dark-secondary">
          {message.snippet}
        </p>
      )}
    </article>
  );
}
