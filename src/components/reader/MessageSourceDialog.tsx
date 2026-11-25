import { useState } from 'react';
import { format } from 'date-fns';
import { Copy, Download, FileWarning, Loader2 } from 'lucide-react';
import { formatFileSize } from '@/lib/format/file-size';
import { saveMessageAs } from '@/lib/messages/save';
import { useMessageSourceQuery } from '@/lib/query/hooks';
import { useMessageSourceStore, type MessageSourceTarget } from '@/stores/message-source';
import { useToastStore } from '@/stores/toast';
import type { MessageSource } from '@/lib/types/ipc';
import {
  dialogPrimaryButtonClass,
  dialogQuietButtonClass,
  ReaderDialogFrame,
  ReaderDialogStatus,
} from './ReaderDialogFrame';
import { ICON_SIZE } from '@/components/shared/icon-size';
import { DATE_FORMAT } from '@/lib/format/date-formats';

export function MessageSourceDialog() {
  const target = useMessageSourceStore((messageSource) => messageSource.target);
  const close = useMessageSourceStore((messageSource) => messageSource.close);
  if (!target) return null;
  return <MessageSourceContent key={target.messageId} target={target} onClose={close} />;
}

function MessageSourceActions({
  hasData,
  onCopy,
  onDownload,
}: {
  hasData: boolean;
  onCopy: () => void;
  onDownload: () => void;
}) {
  return (
    <>
      {hasData && (
        <button type="button" onClick={onCopy} className={dialogQuietButtonClass}>
          <Copy size={ICON_SIZE.sm} aria-hidden="true" />
          Copy
        </button>
      )}
      <button
        type="button"
        onClick={onDownload}
        disabled={!hasData}
        className={`${dialogPrimaryButtonClass} disabled:cursor-default disabled:opacity-60`}
      >
        <Download size={ICON_SIZE.sm} aria-hidden="true" />
        Download .eml
      </button>
    </>
  );
}

function MessageSourceContent({
  target,
  onClose,
}: {
  target: MessageSourceTarget;
  onClose: () => void;
}) {
  const source = useMessageSourceQuery(target.accountId, target.messageId);
  const showSuccess = useToastStore((toaster) => toaster.showSuccess);
  const showError = useToastStore((toaster) => toaster.showError);
  const data = source.data;
  const reason: unknown = source.error;
  const failure = typeof reason === 'string' ? reason : 'Check your connection, then try again.';
  const copy = () => {
    if (!data) return;
    void navigator.clipboard.writeText(data.raw).then(
      () => showSuccess('Copied original message'),
      () => showError("Couldn't copy the original message"),
    );
  };
  const download = () => {
    if (!data) return;
    void saveMessageAs('eml', {
      ...target,
      subject: data.subject,
      sender: data.sender,
      sentAt: new Date(data.sentAt),
    });
  };
  return (
    <ReaderDialogFrame
      title={data ? `Original message · ${data.subject}` : 'Original message'}
      testId="message-source-modal"
      closeLabel="Close original message"
      onClose={onClose}
      actions={<MessageSourceActions hasData={Boolean(data)} onCopy={copy} onDownload={download} />}
    >
      <MessageSourceDialogBody
        data={data}
        isError={source.isError}
        failure={failure}
        onRetry={() => void source.refetch()}
      />
    </ReaderDialogFrame>
  );
}

function MessageSourceDialogBody({
  data,
  isError,
  failure,
  onRetry,
}: {
  data: MessageSource | undefined;
  isError: boolean;
  failure: string;
  onRetry: () => void;
}) {
  if (data) return <MessageSourceBody source={data} />;
  if (isError) {
    return (
      <ReaderDialogStatus>
        <FileWarning
          size={ICON_SIZE.xl4}
          aria-hidden="true"
          className="text-outline dark:text-dark-outline"
        />
        <p className="font-semibold text-on-surface dark:text-dark-on-surface">
          Couldn&apos;t load the original message.
        </p>
        <p>{failure}</p>
        <button type="button" onClick={onRetry} className={dialogQuietButtonClass}>
          Retry
        </button>
      </ReaderDialogStatus>
    );
  }
  return (
    <ReaderDialogStatus>
      <Loader2 className="animate-spin" size={ICON_SIZE.xl2} aria-hidden="true" />
      <span>Loading source…</span>
    </ReaderDialogStatus>
  );
}

function MessageSourceBody({ source }: { source: MessageSource }) {
  const [wrap, setWrap] = useState(true);
  const rows: [string, string | null][] = [
    ['Message ID', source.messageId],
    ['Created', format(new Date(source.sentAt), DATE_FORMAT.longDateTime)],
    ['From', source.sender],
    ['To', source.to],
    ['Cc', source.cc],
    ['Subject', source.subject],
    ['Authentication', source.authenticationResults],
  ];
  return (
    <div className="flex min-h-full flex-col">
      <dl className="flex flex-col gap-1.5 border-b border-outline-variant px-5 py-4 text-body-sm dark:border-dark-outline-variant">
        {rows
          .filter((row): row is [string, string] => Boolean(row[1]))
          .map(([label, value]) => (
            <div key={label} className="flex gap-5">
              <dt className="w-28 shrink-0 text-secondary dark:text-dark-secondary">{label}</dt>
              <dd className="min-w-0 select-text break-words text-on-surface dark:text-dark-on-surface">
                {value}
              </dd>
            </div>
          ))}
      </dl>
      <div className="flex items-center justify-between gap-3 px-5 py-2 text-label-sm text-secondary dark:text-dark-secondary">
        <span>Raw source · {formatFileSize(source.sizeBytes)}</span>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={wrap}
            onChange={(event) => setWrap(event.target.checked)}
            className="cursor-pointer accent-primary dark:accent-dark-primary"
          />
          Wrap lines
        </label>
      </div>
      <div
        role="textbox"
        aria-readonly="true"
        aria-multiline="true"
        tabIndex={0}
        aria-label="Raw message source"
        className={`mx-3 mb-3 flex-1 select-text overflow-auto rounded-md border border-code-block-line bg-code-block p-stack-gap-md font-mono text-body-sm text-on-code-block focus-visible:outline-2 focus-visible:outline-primary ${wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}
      >
        {source.display}
      </div>
    </div>
  );
}
