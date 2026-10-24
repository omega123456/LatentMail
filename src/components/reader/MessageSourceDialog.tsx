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

export function MessageSourceDialog() {
  const target = useMessageSourceStore((state) => state.target);
  const close = useMessageSourceStore((state) => state.close);
  if (!target) return null;
  return <MessageSourceContent key={target.messageId} target={target} onClose={close} />;
}

function MessageSourceContent({
  target,
  onClose,
}: {
  target: MessageSourceTarget;
  onClose: () => void;
}) {
  const source = useMessageSourceQuery(target.accountId, target.messageId);
  const showSuccess = useToastStore((state) => state.showSuccess);
  const showError = useToastStore((state) => state.showError);
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
      actions={
        <>
          {data && (
            <button type="button" onClick={copy} className={dialogQuietButtonClass}>
              <Copy size={14} aria-hidden="true" />
              Copy
            </button>
          )}
          <button
            type="button"
            onClick={download}
            disabled={!data}
            className={`${dialogPrimaryButtonClass} disabled:cursor-default disabled:opacity-60`}
          >
            <Download size={14} aria-hidden="true" />
            Download .eml
          </button>
        </>
      }
    >
      {data ? (
        <MessageSourceBody source={data} />
      ) : source.isError ? (
        <ReaderDialogStatus>
          <FileWarning
            size={26}
            aria-hidden="true"
            className="text-outline dark:text-dark-outline"
          />
          <p className="font-semibold text-on-surface dark:text-dark-on-surface">
            Couldn&apos;t load the original message.
          </p>
          <p>{failure}</p>
          <button
            type="button"
            onClick={() => void source.refetch()}
            className={dialogQuietButtonClass}
          >
            Retry
          </button>
        </ReaderDialogStatus>
      ) : (
        <ReaderDialogStatus>
          <Loader2 className="animate-spin" size={22} aria-hidden="true" />
          <span>Loading source…</span>
        </ReaderDialogStatus>
      )}
    </ReaderDialogFrame>
  );
}

function MessageSourceBody({ source }: { source: MessageSource }) {
  const [wrap, setWrap] = useState(true);
  const rows: [string, string | null][] = [
    ['Message ID', source.messageId],
    ['Created', format(new Date(source.sentAt), 'PPpp')],
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
