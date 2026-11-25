import { useEffect, useRef, useState } from 'react';
import {
  AlignLeft,
  ChevronDown,
  ChevronRight,
  FileWarning,
  ImageOff,
  Paperclip,
} from 'lucide-react';
import {
  MessageActionRibbon,
  type MessageActionRibbonProps,
} from '@/components/actions/MessageActionRibbon';
import { invoke } from '@/lib/ipc/commands';
import { useMessageBodyQuery } from '@/lib/query/hooks';
import { mergeMessageBody } from '@/lib/query/mappers';
import { AttachmentSection } from './AttachmentSection';
import { BodyFrame } from './BodyFrame';
import { MessageHeader, type MessageSender } from './MessageHeader';
import type { MessageBadge } from '@/lib/labels/badges';
import type { Participant } from '@/lib/format/participants';
import type { MessageAttachment } from '@/lib/types/ipc';
import { ICON_SIZE } from '@/components/shared/icon-size';

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
  htmlPresence?: 'neverFetched' | 'present' | 'absent' | 'tooLarge';
  truncated?: boolean;
  text: string | null;
  labelIds?: string[];
  unread?: boolean;
  starred?: boolean;
  remoteImagesBlocked?: boolean;
  remoteImagesAllowed?: boolean;
  inlineImagesPending?: boolean;
  isDraft?: boolean;
  draftId?: string | null;
  attachments?: MessageAttachment[];
};

const remoteImageChipClass =
  'cursor-pointer whitespace-nowrap rounded-chip px-2.5 py-1.25 text-label-md font-semibold tracking-normal shadow-segment focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary';

const remoteImageChipQuiet = `${remoteImageChipClass} bg-surface-container-lowest text-on-surface dark:bg-dark-surface-container-lowest dark:text-dark-on-surface`;

const remoteImageChipPrimary = `${remoteImageChipClass} bg-primary text-on-primary dark:bg-dark-primary dark:text-dark-on-primary`;

const noticeBarClass =
  'flex flex-wrap items-center gap-2.5 rounded-control bg-surface-container px-3 py-2.5 text-label-sm text-secondary dark:bg-dark-surface-container dark:text-dark-secondary';

const openFullMessageLabel = 'View full message in Gmail';

export type MessageRibbonProps = Omit<MessageActionRibbonProps, 'unread' | 'starred'>;

function RemoteImagesNotice({
  message,
  locked,
  onLoadImages,
  onTrustSender,
}: {
  message: ReaderMessage;
  locked: boolean;
  onLoadImages?: (messageId: string) => void;
  onTrustSender?: (address: string) => void;
}) {
  return (
    <div className={`${noticeBarClass} mb-stack-gap-md`}>
      <ImageOff className="shrink-0" size={ICON_SIZE.base} />
      <span>Remote images are blocked.</span>
      {!locked && (
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
  );
}

function MessageBodyContent({
  renderedMessage,
  messageId,
  loadingBody,
  bodyError,
  waitingForCache,
  gmailThreadUrl,
  onFetchBody,
}: {
  renderedMessage: ReaderMessage;
  messageId: string;
  loadingBody: boolean;
  bodyError: boolean;
  waitingForCache: boolean;
  gmailThreadUrl: string | null;
  onFetchBody?: (messageId: string) => void;
}) {
  if (renderedMessage.htmlPresence === 'tooLarge') {
    return (
      <div
        data-testid="too-large-notice"
        className="flex min-h-reader-body flex-col items-center justify-center gap-2.5 px-4 text-center"
      >
        <FileWarning
          className="text-on-surface-variant dark:text-dark-on-surface-variant"
          size={ICON_SIZE.xl5}
        />
        <p
          role="status"
          className="text-body-md font-semibold text-on-surface dark:text-dark-on-surface"
        >
          This message is too big to open here.
        </p>
        <p className="text-body-sm text-on-surface-variant dark:text-dark-on-surface-variant">
          Gmail can show the full message in your browser.
        </p>
        {gmailThreadUrl && (
          <button
            type="button"
            onClick={() => void invoke('open_external_url', { url: gmailThreadUrl })}
            className={remoteImageChipPrimary}
          >
            {openFullMessageLabel}
          </button>
        )}
      </div>
    );
  }
  if (renderedMessage.htmlPresence === 'neverFetched') {
    if (!loadingBody && bodyError) {
      return (
        <div className="min-h-reader-body text-body-sm text-error dark:text-dark-error">
          Couldn’t load this message.{' '}
          <button
            onClick={() => onFetchBody?.(messageId)}
            className="cursor-pointer underline focus-visible:outline-2 focus-visible:outline-primary"
          >
            Retry
          </button>
        </div>
      );
    }
    return (
      <p className="min-h-reader-body text-body-sm text-on-surface-variant dark:text-dark-on-surface-variant">
        Loading message…
      </p>
    );
  }
  if (waitingForCache) return <div className="min-h-reader-body" />;
  return (
    <>
      <BodyFrame
        html={renderedMessage.html}
        text={renderedMessage.text}
        allowRemoteImages={renderedMessage.remoteImagesAllowed ?? false}
      />
      {renderedMessage.truncated && gmailThreadUrl && (
        <div data-testid="clipped-notice" className={`${noticeBarClass} mt-stack-gap-md`}>
          <AlignLeft className="shrink-0" size={ICON_SIZE.base} />
          <span role="status">This message is cut short.</span>
          <button
            type="button"
            onClick={() => void invoke('open_external_url', { url: gmailThreadUrl })}
            className={`${remoteImageChipPrimary} ml-auto`}
          >
            {openFullMessageLabel}
          </button>
        </div>
      )}
    </>
  );
}

function shouldFetchCachedBody(open: boolean, message: ReaderMessage): boolean {
  if (!open || message.htmlPresence === 'tooLarge') return false;
  return message.inlineImagesPending === true || (!message.html && !message.text);
}

function shouldFetchGmailBody(message: ReaderMessage): boolean {
  if (message.htmlPresence === 'tooLarge') return false;
  return message.htmlPresence === 'neverFetched' || message.inlineImagesPending === true;
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
      {newest ? (
        <span className="w-6 shrink-0" />
      ) : (
        <button
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} message from ${senderLabel}`}
          onClick={onToggleExpand}
          className="mt-3 shrink-0 cursor-pointer rounded-sm p-1 text-secondary focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary"
        >
          {open ? <ChevronDown size={ICON_SIZE.base} /> : <ChevronRight size={ICON_SIZE.base} />}
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

function MessageCardBody({
  message,
  renderedMessage,
  remoteImagesLocked,
  loadingBody,
  bodyError,
  waitingForCache,
  gmailThreadUrl,
  accountId,
  hasAttachments,
  onLoadImages,
  onTrustSender,
  onFetchBody,
}: {
  message: ReaderMessage;
  renderedMessage: ReaderMessage;
  remoteImagesLocked: boolean;
  loadingBody: boolean;
  bodyError: boolean;
  waitingForCache: boolean;
  gmailThreadUrl: string | null;
  accountId: string | null;
  hasAttachments: boolean;
  onLoadImages?: (messageId: string) => void;
  onTrustSender?: (address: string) => void;
  onFetchBody?: (messageId: string) => void;
}) {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-4 text-body-md">
      {renderedMessage.remoteImagesBlocked && (
        <RemoteImagesNotice
          message={message}
          locked={remoteImagesLocked}
          onLoadImages={onLoadImages}
          onTrustSender={onTrustSender}
        />
      )}
      <MessageBodyContent
        renderedMessage={renderedMessage}
        messageId={message.id}
        loadingBody={loadingBody}
        bodyError={bodyError}
        waitingForCache={waitingForCache}
        gmailThreadUrl={gmailThreadUrl}
        onFetchBody={onFetchBody}
      />
      {hasAttachments && message.attachments && (
        <div className="mt-stack-gap-md">
          <AttachmentSection
            accountId={accountId}
            messageId={message.id}
            attachments={message.attachments}
          />
        </div>
      )}
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
