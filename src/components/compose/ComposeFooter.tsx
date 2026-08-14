import type { Editor } from '@tiptap/react';
import { AlertCircle, Image, Paperclip, Send } from 'lucide-react';
import { EditorToolbar } from './EditorToolbar';

const iconButtonClass =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-full text-secondary hover:bg-surface-container-high hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 dark:text-dark-secondary dark:hover:bg-dark-surface-container-high dark:hover:text-dark-primary';

export function ComposeFooter({
  editor,
  onLink,
  onAttach,
  onInsertImage,
  ready,
  status,
  failed = false,
  onRetry = () => undefined,
  onSend = () => undefined,
  sending = false,
  blocked = true,
}: {
  editor: Editor | null;
  onLink: () => void;
  onAttach: () => void;
  onInsertImage: () => void;
  /** Derived recipient readiness — exposed via `data-recipient-ready` so
   * Phase 5 can wire it to Send without re-deriving recipient semantics.
   * Send itself stays disabled throughout this phase regardless of value. */
  ready: boolean;
  status: string;
  /** Draft/send failures render in `error` with an inline retry, because
   * the message and its action are both still present here. */
  failed?: boolean;
  onRetry?: () => void;
  onSend?: () => void;
  sending?: boolean;
  blocked?: boolean;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-outline-variant px-stack-gap-md pb-3.5 pt-2.5 dark:border-dark-outline-variant">
      {/* A failure carries a message and an action, which together are
       * wider than the reserved status slot the toolbar leaves free at the
       * 512px default width — so it takes its own line rather than
       * squeezing the toolbar or truncating its own copy away. */}
      {failed && status && (
        <span className="flex min-w-0 items-center gap-1.5 text-label-md text-error dark:text-dark-error">
          <AlertCircle aria-hidden="true" size={18} className="shrink-0" />
          <span className="truncate">{status}</span>
          <button type="button" onClick={onRetry} className="shrink-0 underline hover:no-underline">
            Retry
          </button>
        </span>
      )}
      <div className="flex items-center justify-between gap-stack-gap-sm">
        <div className="flex shrink-0 items-center rounded-md bg-surface-container-low p-0.5 dark:bg-dark-surface-container-low">
          <EditorToolbar editor={editor} onLink={onLink} />
        </div>
        <div className="flex min-w-0 items-center gap-1">
          <span
            className="w-compose-status-w shrink-0 truncate text-label-md text-secondary dark:text-dark-secondary"
            aria-live="polite"
          >
            {failed ? '' : status}
          </span>
          <button
          type="button"
          aria-label="Attach files"
          title="Attach files"
          onClick={onAttach}
          className={iconButtonClass}
        >
          <Paperclip aria-hidden="true" size={18} />
        </button>
        <button
          type="button"
          aria-label="Insert image"
          title="Insert image"
          onClick={onInsertImage}
          className={iconButtonClass}
        >
          <Image aria-hidden="true" size={18} />
        </button>
        <button
          type="button"
          aria-label="Send"
          title="Send"
          disabled={!ready || blocked || sending}
          data-recipient-ready={ready}
          onClick={onSend}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary-container px-4 py-2 text-label-md text-on-primary-container hover:bg-primary hover:text-on-primary disabled:cursor-not-allowed disabled:opacity-40 dark:bg-dark-primary-container dark:text-dark-on-primary-container dark:hover:bg-dark-primary dark:hover:text-dark-on-primary"
        >
          Send
          <Send aria-hidden="true" size={18} />
        </button>
        </div>
      </div>
    </div>
  );
}
