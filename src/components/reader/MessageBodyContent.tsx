import { AlignLeft, FileWarning, ImageOff } from 'lucide-react';
import { ICON_SIZE } from '@/components/shared/icon-size';
import type { Participant } from '@/lib/format/participants';
import { invoke } from '@/lib/ipc/commands';
import type { MessageAttachment } from '@/lib/types/ipc';
import { AttachmentSection } from './AttachmentSection';
import { BodyFrame } from './BodyFrame';
import type { MessageSender } from './MessageHeader';

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

function TooLargeMessageNotice({ gmailThreadUrl }: { gmailThreadUrl: string | null }) {
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

function NeverFetchedBodyNotice({
  loadingBody,
  bodyError,
  messageId,
  onFetchBody,
}: {
  loadingBody: boolean;
  bodyError: boolean;
  messageId: string;
  onFetchBody?: (messageId: string) => void;
}) {
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
    return <TooLargeMessageNotice gmailThreadUrl={gmailThreadUrl} />;
  }
  if (renderedMessage.htmlPresence === 'neverFetched') {
    return (
      <NeverFetchedBodyNotice
        loadingBody={loadingBody}
        bodyError={bodyError}
        messageId={messageId}
        onFetchBody={onFetchBody}
      />
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

export function MessageCardBody({
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
