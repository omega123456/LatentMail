import type { Editor } from '@tiptap/react';
import { Image, Paperclip, Send } from 'lucide-react';
import { EditorToolbar } from './EditorToolbar';

const iconButtonClass =
  'inline-flex items-center justify-center rounded p-2 text-secondary disabled:cursor-not-allowed disabled:opacity-40 dark:text-dark-secondary';

export function ComposeFooter({
  editor,
  onLink,
  onAttach,
  onInsertImage,
  ready,
  status,
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
  onSend?: () => void;
  sending?: boolean;
  blocked?: boolean;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-stack-gap-sm border-t border-outline-variant px-stack-gap-md py-stack-gap-sm dark:border-dark-outline-variant">
      <div className="rounded-md bg-surface-container-low px-stack-gap-sm py-1 dark:bg-dark-surface-container-low">
        <EditorToolbar editor={editor} onLink={onLink} />
      </div>
      <div className="flex items-center justify-between">
        <span
          className="w-compose-status-w truncate text-label-md text-secondary dark:text-dark-secondary"
          aria-live="polite"
        >
          {status}
        </span>
        <div className="flex items-center gap-1">
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
            className="ml-1 inline-flex items-center gap-1 rounded-full bg-primary-container px-4 py-1.5 text-label-md text-on-primary-container hover:bg-primary hover:text-on-primary disabled:cursor-not-allowed disabled:opacity-40 dark:bg-dark-primary-container dark:text-dark-on-primary-container dark:hover:bg-dark-primary dark:hover:text-dark-on-primary"
          >
            <Send aria-hidden="true" size={18} />
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
