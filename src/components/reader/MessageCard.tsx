import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ImageOff } from 'lucide-react';
import {
  MessageActionRibbon,
  type MessageActionRibbonProps,
} from '@/components/actions/MessageActionRibbon';
import { BodyFrame } from './BodyFrame';
import { MessageHeader, type MessageSender } from './MessageHeader';
import type { Participant } from '@/lib/format/participants';

export type ReaderMessage = {
  id: string;
  sender: MessageSender;
  recipients: Participant[];
  toRecipients?: Participant[];
  ccRecipients?: Participant[];
  bccRecipients?: Participant[];
  sentAt: Date;
  snippet: string;
  html: string | null;
  htmlPresence?: 'neverFetched' | 'present' | 'absent';
  text: string | null;
  labels?: string[];
  labelIds?: string[];
  unread?: boolean;
  starred?: boolean;
  remoteImagesBlocked?: boolean;
  isDraft?: boolean;
  draftId?: string | null;
};

export type MessageRibbonProps = Omit<MessageActionRibbonProps, 'unread' | 'starred'>;

export function MessageCard({
  message,
  expanded,
  newest,
  ribbon,
  onFetchBody,
  loadingBody = false,
  bodyError = false,
  onComposeTo,
}: {
  message: ReaderMessage;
  expanded: boolean;
  newest: boolean;
  ribbon?: MessageRibbonProps;
  onFetchBody?: (messageId: string) => void;
  loadingBody?: boolean;
  bodyError?: boolean;
  onComposeTo?: (participant: Participant) => void;
}) {
  const [isExpanded, setExpanded] = useState(expanded);
  const open = newest || isExpanded;
  const requested = useRef<string | null>(null);
  const needsBody = message.htmlPresence === 'neverFetched' || (!message.html && !message.text);
  useEffect(() => {
    if (!open || !needsBody || requested.current === message.id) return;
    requested.current = message.id;
    onFetchBody?.(message.id);
  }, [message.id, needsBody, onFetchBody, open]);
  return (
    <article
      className={`relative pb-6 ${newest ? '' : 'mb-6 border-b border-outline-variant/30 dark:border-dark-outline-variant/50'}`}
      data-testid={`message-${message.id}`}
    >
      <div
        role="presentation"
        onClick={(event) => {
          if (newest || (event.target as HTMLElement).closest('button')) return;
          setExpanded((value) => !value);
        }}
        className={`-mx-3 flex items-start gap-2 rounded px-3 pt-3 ${open ? 'mb-2 border-b border-outline-variant/30 pb-6 dark:border-dark-outline-variant/50' : 'pb-3'} ${newest ? '' : 'cursor-pointer transition-colors hover:bg-surface-container-low dark:hover:bg-dark-surface-container-low'}`}
      >
        {newest ? (
          <span className="w-6 shrink-0" />
        ) : (
          <button
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} message from ${message.sender.name || message.sender.address}`}
            onClick={() => setExpanded((value) => !value)}
            className="mt-3 shrink-0 cursor-pointer rounded-sm p-1 text-secondary focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary"
          >
            {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        )}
        <div className="min-w-0 flex-1">
          <MessageHeader
            sender={message.sender}
            recipients={message.recipients}
            sentAt={message.sentAt}
            onComposeTo={onComposeTo}
          />
          {!open && (
            <p className="ml-16 mt-stack-gap-sm truncate text-body-sm text-secondary dark:text-dark-secondary">
              {message.snippet}
            </p>
          )}
        </div>
      </div>
      {open && (
        <div className="mx-auto mt-8 w-full max-w-4xl text-body-md">
          {message.remoteImagesBlocked && (
            <p className="mb-stack-gap-md flex items-center gap-stack-gap-sm rounded-sm bg-surface-container p-stack-gap-sm text-label-sm text-secondary dark:bg-dark-surface-container dark:text-dark-secondary">
              <ImageOff size={16} />
              Remote images are blocked.
            </p>
          )}
          {message.htmlPresence === 'neverFetched' ? (
            loadingBody ? (
              <p className="min-h-reader-body text-body-sm text-on-surface-variant dark:text-dark-on-surface-variant">
                Loading message…
              </p>
            ) : bodyError ? (
              <div className="min-h-reader-body text-body-sm text-error dark:text-dark-error">
                Couldn’t load this message.{' '}
                <button
                  onClick={() => onFetchBody?.(message.id)}
                  className="cursor-pointer underline focus-visible:outline-2 focus-visible:outline-primary"
                >
                  Retry
                </button>
              </div>
            ) : (
              <p className="min-h-reader-body text-body-sm text-on-surface-variant dark:text-dark-on-surface-variant">
                Loading message…
              </p>
            )
          ) : (
            <BodyFrame html={message.html} text={message.text} />
          )}
        </div>
      )}
      {ribbon && (
        <div className="mt-stack-gap-md flex justify-end">
          <MessageActionRibbon
            {...ribbon}
            unread={message.unread ?? false}
            starred={message.starred ?? false}
          />
        </div>
      )}
    </article>
  );
}
