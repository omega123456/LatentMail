import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Paperclip } from 'lucide-react';
import {
  MessageActionRibbon,
  type MessageActionRibbonProps,
} from '@/components/actions/MessageActionRibbon';
import { ICON_SIZE } from '@/components/shared/icon-size';
import type { Participant } from '@/lib/format/participants';
import type { MessageBadge } from '@/lib/labels/badges';
import { useMessageBodyQuery } from '@/lib/query/hooks';
import { mergeMessageBody } from '@/lib/query/mappers';
import { MessageCardBody, type ReaderMessage } from './MessageBodyContent';
import { MessageHeader } from './MessageHeader';

export type { ReaderMessage };
export type MessageRibbonProps = Omit<MessageActionRibbonProps, 'unread' | 'starred'>;

function shouldFetchCachedBody(open: boolean, message: ReaderMessage): boolean {
  if (!open || message.htmlPresence === 'tooLarge') return false;
  return message.inlineImagesPending === true || (!message.html && !message.text);
}

function shouldFetchGmailBody(message: ReaderMessage): boolean {
  if (message.htmlPresence === 'tooLarge') return false;
  return message.htmlPresence === 'neverFetched' || message.inlineImagesPending === true;
}

function MessageExpandControl({
  newest,
  open,
  senderLabel,
  onToggleExpand,
}: {
  newest: boolean;
  open: boolean;
  senderLabel: string;
  onToggleExpand: () => void;
}) {
  if (newest) return <span className="w-6 shrink-0" />;
  return (
    <button
      aria-expanded={open}
      aria-label={`${open ? 'Collapse' : 'Expand'} message from ${senderLabel}`}
      onClick={onToggleExpand}
      className="mt-3 shrink-0 cursor-pointer rounded-sm p-1 text-secondary focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary"
    >
      {open ? <ChevronDown size={ICON_SIZE.base} /> : <ChevronRight size={ICON_SIZE.base} />}
    </button>
  );
}

function MessageCardHeader({
  message,
  open,
  newest,
  badges,
  hasAttachments,
  onToggleExpand,
  onHeaderClick,
  onComposeTo,
}: {
  message: ReaderMessage;
  open: boolean;
  newest: boolean;
  badges?: MessageBadge[];
  hasAttachments: boolean;
  onToggleExpand: () => void;
  onHeaderClick: (event: React.MouseEvent) => void;
  onComposeTo?: (participant: Participant) => void;
}) {
  const senderLabel = message.sender.name || message.sender.address;
  const openClass = open
    ? 'mb-2 border-b border-outline-variant/30 pb-6 dark:border-dark-outline-variant/50'
    : 'pb-4';
  const hoverClass = newest
    ? ''
    : 'cursor-pointer transition-colors hover:bg-surface-container-low dark:hover:bg-dark-surface-container-low';
  return (
    <div
      role="presentation"
      onClick={onHeaderClick}
      className={`flex items-start gap-2 rounded px-4 pt-4 ${openClass} ${hoverClass}`}
    >
      <MessageExpandControl
        newest={newest}
        open={open}
        senderLabel={senderLabel}
        onToggleExpand={onToggleExpand}
      />
      <div className="min-w-0 flex-1">
        <MessageHeader
          sender={message.sender}
          recipients={message.recipients}
          sentAt={message.sentAt}
          badges={badges}
          onComposeTo={onComposeTo}
        />
        {!open && (
          <div className="ml-16 mt-stack-gap-sm flex items-center gap-2 text-body-sm text-secondary dark:text-dark-secondary">
            <p className="min-w-0 flex-1 truncate">{message.snippet}</p>
            {hasAttachments && (
              <Paperclip aria-label="Has attachment" className="shrink-0" size={ICON_SIZE.md} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function isRemoteImagesLocked(message: ReaderMessage): boolean {
  return (message.labelIds ?? []).some((label) => label === 'SPAM' || label === 'TRASH');
}

function useAutoFetchMessageBody({
  open,
  needsGmailBody,
  messageId,
  onFetchBody,
}: {
  open: boolean;
  needsGmailBody: boolean;
  messageId: string;
  onFetchBody?: (messageId: string) => void;
}) {
  const requested = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !needsGmailBody || requested.current === messageId) return;
    requested.current = messageId;
    onFetchBody?.(messageId);
  }, [messageId, needsGmailBody, onFetchBody, open]);
}

function MessageCardFooterRibbon({
  ribbon,
  unread,
  starred,
}: {
  ribbon: MessageRibbonProps | undefined;
  unread: boolean | undefined;
  starred: boolean | undefined;
}) {
  if (!ribbon) return null;
  return (
    <div className="mt-stack-gap-md flex justify-end px-4 pb-4">
      <MessageActionRibbon {...ribbon} unread={unread ?? false} starred={starred ?? false} />
    </div>
  );
}

function shouldToggleOnHeaderClick(newest: boolean, event: React.MouseEvent): boolean {
  if (newest || (event.target as HTMLElement).closest('button')) return false;
  return window.getSelection()?.isCollapsed ?? true;
}

type MessageCardProps = {
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
  gmailThreadUrl?: string | null;
  accountId?: string | null;
};

function resolveBodyViewProps({
  props,
  renderedMessage,
  waitingForCache,
  hasAttachments,
}: {
  props: MessageCardProps;
  renderedMessage: ReaderMessage;
  waitingForCache: boolean;
  hasAttachments: boolean;
}) {
  return {
    message: props.message,
    renderedMessage: renderedMessage,
    remoteImagesLocked: isRemoteImagesLocked(props.message),
    loadingBody: props.loadingBody ?? false,
    bodyError: props.bodyError ?? false,
    waitingForCache: waitingForCache,
    gmailThreadUrl: props.gmailThreadUrl ?? null,
    accountId: props.accountId ?? null,
    hasAttachments: hasAttachments,
    onLoadImages: props.onLoadImages,
    onTrustSender: props.onTrustSender,
    onFetchBody: props.onFetchBody,
  };
}

export function MessageCard(props: MessageCardProps) {
  const { message, expanded, newest } = props;
  const accountId = props.accountId ?? null;
  const [isExpanded, setExpanded] = useState(expanded);
  const open = newest || isExpanded;
  const needsCachedBody = shouldFetchCachedBody(open, message);
  const cachedBody = useMessageBodyQuery(accountId, message.id, needsCachedBody);
  const renderedMessage = cachedBody.data ? mergeMessageBody(message, cachedBody.data) : message;
  const hasAttachments = Boolean(message.attachments?.length);
  const waitingForCache = needsCachedBody && accountId !== null && cachedBody.isPending;

  useAutoFetchMessageBody({
    open: open,
    needsGmailBody: shouldFetchGmailBody(renderedMessage),
    messageId: message.id,
    onFetchBody: props.onFetchBody,
  });

  const handleHeaderClick = (event: React.MouseEvent) => {
    if (!shouldToggleOnHeaderClick(newest, event)) return;
    setExpanded((wasExpanded) => !wasExpanded);
  };

  return (
    <article
      className={`relative rounded-md border border-outline-variant/30 dark:border-dark-outline-variant/50 ${newest ? '' : 'mb-4'}`}
      data-testid={`message-${message.id}`}
    >
      <MessageCardHeader
        message={message}
        open={open}
        newest={newest}
        badges={props.badges}
        hasAttachments={hasAttachments}
        onToggleExpand={() => setExpanded((wasExpanded) => !wasExpanded)}
        onHeaderClick={handleHeaderClick}
        onComposeTo={props.onComposeTo}
      />
      {open && (
        <MessageCardBody
          {...resolveBodyViewProps({ props, renderedMessage, waitingForCache, hasAttachments })}
        />
      )}
      <MessageCardFooterRibbon
        ribbon={props.ribbon}
        unread={message.unread}
        starred={message.starred}
      />
    </article>
  );
}
