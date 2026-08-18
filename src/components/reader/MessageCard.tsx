import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ImageOff } from 'lucide-react';
import {
  MessageActionRibbon,
  type MessageActionRibbonProps,
} from '@/components/actions/MessageActionRibbon';
import { BodyFrame } from './BodyFrame';
import { MessageHeader, type MessageSender } from './MessageHeader';
import type { MessageBadge } from '@/lib/labels/badges';
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
  labelIds?: string[];
  unread?: boolean;
  starred?: boolean;
  remoteImagesBlocked?: boolean;
  remoteImagesAllowed?: boolean;
  isDraft?: boolean;
  draftId?: string | null;
};

const remoteImageChipClass =
  'cursor-pointer whitespace-nowrap rounded-chip px-2.5 py-1.25 text-label-md font-semibold tracking-normal shadow-segment focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary';

const remoteImageChipQuiet = `${remoteImageChipClass} bg-surface-container-lowest text-on-surface dark:bg-dark-surface-container-lowest dark:text-dark-on-surface`;

const remoteImageChipPrimary = `${remoteImageChipClass} bg-primary text-on-primary dark:bg-dark-primary dark:text-dark-on-primary`;

export type MessageRibbonProps = Omit<MessageActionRibbonProps, 'unread' | 'starred'>;

export function MessageCard({
  message,
  expanded,
  newest,
  badges,
  ribbon,
  onFetchBody,
  loadingBody = false,
  bodyError = false,
  onComposeTo,
  onLoadImages,
  onTrustSender,
}: {
  message: ReaderMessage;
  expanded: boolean;
  newest: boolean;
  badges?: MessageBadge[];
  ribbon?: MessageRibbonProps;
  onFetchBody?: (messageId: string) => void;
  loadingBody?: boolean;
  bodyError?: boolean;
  onComposeTo?: (participant: Participant) => void;
  onLoadImages?: (messageId: string) => void;
  onTrustSender?: (address: string) => void;
}) {
  const [isExpanded, setExpanded] = useState(expanded);
  const open = newest || isExpanded;
  const requested = useRef<string | null>(null);
  const needsBody = message.htmlPresence === 'neverFetched' || (!message.html && !message.text);
  const isSpam = (message.labelIds ?? []).includes('SPAM');
  useEffect(() => {
    if (!open || !needsBody || requested.current === message.id) return;
    requested.current = message.id;
    onFetchBody?.(message.id);
  }, [message.id, needsBody, onFetchBody, open]);
  return (
    <article
      className={`relative rounded-md border border-outline-variant/30 dark:border-dark-outline-variant/50 ${newest ? '' : 'mb-4'}`}
      data-testid={`message-${message.id}`}
    >
      <div
        role="presentation"
        onClick={(event) => {
          if (newest || (event.target as HTMLElement).closest('button')) return;
          setExpanded((value) => !value);
        }}
        className={`flex items-start gap-2 rounded px-4 pt-4 ${open ? 'mb-2 border-b border-outline-variant/30 pb-6 dark:border-dark-outline-variant/50' : 'pb-4'} ${newest ? '' : 'cursor-pointer transition-colors hover:bg-surface-container-low dark:hover:bg-dark-surface-container-low'}`}
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
            badges={badges}
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
        <div className="mx-auto w-full max-w-4xl px-4 pb-4 text-body-md">
          {message.remoteImagesBlocked && (
            <div className="mb-stack-gap-md flex flex-wrap items-center gap-2.5 rounded-control bg-surface-container px-3 py-2.5 text-label-sm text-secondary dark:bg-dark-surface-container dark:text-dark-secondary">
              <ImageOff className="shrink-0" size={16} />
              <span>Remote images are blocked.</span>
              {!isSpam && (
                <span className="ml-auto flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => onLoadImages?.(message.id)}
                    className={remoteImageChipQuiet}
                  >
                    Load images
                  </button>
                  <button
                    type="button"
                    onClick={() => onTrustSender?.(message.sender.address)}
                    className={remoteImageChipPrimary}
                  >
                    Always allow from {message.sender.name || message.sender.address}
                  </button>
                </span>
              )}
            </div>
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
            <BodyFrame
              html={message.html}
              text={message.text}
              allowRemoteImages={message.remoteImagesAllowed ?? false}
            />
          )}
        </div>
      )}
      {ribbon && (
        <div className="mt-stack-gap-md flex justify-end px-4 pb-4">
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
