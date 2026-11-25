import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Dialog } from 'radix-ui';
import type { Editor } from '@tiptap/react';
import { AttachmentStrip } from './AttachmentStrip';
import { BodyEditor, type BodyEditorHandle } from './BodyEditor';
import { ComposeFooter } from './ComposeFooter';
import { ComposeHeader } from './ComposeHeader';
import { ComposeResizeHandles } from './ComposeResizeHandles';
import { LinkDialog } from './LinkDialog';
import { QuoteDisclosure } from './QuoteDisclosure';
import { DiscardConfirm } from './DiscardConfirm';
import { RecipientField } from './RecipientField';
import { TextInput } from '@/components/shared/TextInput';
import { useAttachmentPipeline } from './useAttachmentPipeline';
import {
  selectHasCommittedRecipient,
  selectHasReadingAttachment,
  selectQualifiesForDraft,
  useComposeStore,
  type ComposeSession,
  type DraftStatus,
} from '@/stores/compose';
import { toDraftRequest, useComposeAutosave } from '@/lib/compose/autosave';
import { invoke } from '@/lib/ipc/commands';

const fieldRow =
  'flex items-center gap-2 border-b border-outline-variant pt-field-row-y pb-field-row-y focus-within:border-b-2 focus-within:border-primary focus-within:pb-field-row-y-focus dark:border-dark-outline-variant dark:focus-within:border-dark-primary';

const DRAFT_STATUS_COPY: Record<DraftStatus, string> = {
  idle: '',
  saving: 'Saving…',
  saved: 'Draft saved',
  failed: 'Couldn’t save draft',
  superseded: 'Couldn’t save draft',
};

function hasDiscardableContent(session: ComposeSession): boolean {
  return Boolean(session.subject.trim() || session.html.trim() || session.recipients.to.length);
}

function footerStatusText(session: ComposeSession): string {
  return session.lifecycleError ?? DRAFT_STATUS_COPY[session.draftStatus];
}

function isBodyFocusMode(mode: ComposeSession['mode']): boolean {
  return mode === 'reply' || mode === 'reply-all';
}

function isFooterFailed(session: ComposeSession): boolean {
  return Boolean(session.lifecycleError) || session.draftStatus === 'failed';
}

function ComposeRecipients({
  session,
  toInputRef,
  onRevealCcBcc,
}: {
  session: ComposeSession;
  toInputRef: React.RefObject<HTMLInputElement | null>;
  onRevealCcBcc: () => void;
}) {
  return (
    <div data-testid="recipient-field" className="flex flex-col">
      <div className={fieldRow}>
        <RecipientField
          fieldRole="to"
          label="To"
          accountId={session.accountId}
          placeholder="Email addresses…"
          inputRef={toInputRef}
        />
        {!session.ccBccRevealed && (
          <button
            type="button"
            onClick={onRevealCcBcc}
            className="shrink-0 cursor-pointer rounded-sm px-1.5 py-1 text-label-sm text-secondary hover:text-primary dark:text-dark-secondary dark:hover:text-dark-primary"
          >
            Cc/Bcc
          </button>
        )}
      </div>
      {session.ccBccRevealed && (
        <>
          <div className={fieldRow}>
            <RecipientField
              fieldRole="cc"
              label="Cc"
              accountId={session.accountId}
              placeholder="Email addresses…"
            />
          </div>
          <div className={fieldRow}>
            <RecipientField
              fieldRole="bcc"
              label="Bcc"
              accountId={session.accountId}
              placeholder="Email addresses…"
            />
          </div>
        </>
      )}
    </div>
  );
}

function composeDialogStyle(dimensions: ComposeSession['dimensions']): CSSProperties {
  return {
    '--compose-w': `${dimensions.width}px`,
    '--compose-h': `${dimensions.height}px`,
    width: 'var(--compose-w)',
    height: 'var(--compose-h)',
  } as CSSProperties;
}

function useComposeLifecycle(session: ComposeSession | null) {
  const close = useComposeStore((compose) => compose.close);
  const ready = useComposeStore(selectHasCommittedRecipient);
  const readingAttachment = useComposeStore(selectHasReadingAttachment);
  const qualifies = useComposeStore(selectQualifiesForDraft);
  const setStatus = useComposeStore((compose) => compose.setDraftStatus);
  const { saveNow } = useComposeAutosave();
  const [confirmingFor, setConfirmingFor] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const discardOpen = session !== null && confirmingFor === session.id;

  const closeWithSave = () => {
    if (session && qualifies && session.dirty) void saveNow();
    close();
  };

  const discard = async () => {
    if (!session) return;
    if (!discardOpen && hasDiscardableContent(session)) {
      setConfirmingFor(session.id);
      return;
    }
    await invoke('discard_compose_draft', {
      accountId: session.accountId,
      draftId: session.draftId,
      sessionId: session.id,
    });
    close();
  };

  const send = async () => {
    if (!session || sending || readingAttachment || !ready) return;
    setSending(true);
    setStatus('saving');
    try {
      await invoke('send_compose_draft', { draft: toDraftRequest(session) });
      close();
    } catch {
      setStatus('failed', 'Couldn’t send.');
    } finally {
      setSending(false);
    }
  };

  return {
    ready: ready,
    readingAttachment: readingAttachment,
    sending: sending,
    discardOpen: discardOpen,
    cancelDiscard: () => setConfirmingFor(null),
    closeWithSave: closeWithSave,
    discard: discard,
    send: send,
    saveNow: saveNow,
  };
}

function ComposeScrollBody({
  session,
  toInputRef,
  bodyRef,
  editor,
  linkOpen,
  onCloseLink,
  onSelectEditor,
}: {
  session: ComposeSession;
  toInputRef: React.RefObject<HTMLInputElement | null>;
  bodyRef: React.RefObject<BodyEditorHandle | null>;
  editor: Editor | null;
  linkOpen: boolean;
  onCloseLink: () => void;
  onSelectEditor: (editor: Editor | null) => void;
}) {
  const setHtml = useComposeStore((compose) => compose.setHtml);
  const setSubject = useComposeStore((compose) => compose.setSubject);
  const revealCcBcc = useComposeStore((compose) => compose.revealCcBcc);
  const toggleQuote = useComposeStore((compose) => compose.toggleQuote);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-stack-gap-md pt-stack-gap-md">
      <ComposeRecipients session={session} toInputRef={toInputRef} onRevealCcBcc={revealCcBcc} />
      <div className={fieldRow}>
        <span className="w-13 shrink-0 text-label-md text-secondary dark:text-dark-secondary">
          Subject
        </span>
        <TextInput
          value={session.subject}
          onChange={(event) => setSubject(event.target.value)}
          placeholder="Message subject"
          aria-label="Subject"
          variant="bare"
          className="min-w-0 flex-1 text-body-md text-on-surface placeholder:text-outline dark:text-dark-on-surface dark:placeholder:text-dark-outline"
        />
      </div>
      <BodyEditor
        ref={bodyRef}
        value={session.html}
        onChange={setHtml}
        onSelectionChange={onSelectEditor}
      />
      {linkOpen && editor && <LinkDialog editor={editor} onClose={onCloseLink} />}
      {session.quote && (
        <div className="pb-stack-gap-md">
          <QuoteDisclosure
            html={session.quote.html}
            attribution={session.quote.attribution}
            open={session.quoteOpen}
            onOpenChange={toggleQuote}
          />
        </div>
      )}
    </div>
  );
}

function toggleLinkInEditor(editor: Editor | null, openLinkDialog: () => void) {
  if (!editor) return;
  if (editor.isActive('link')) {
    editor.chain().focus().unsetLink().run();
    return;
  }
  openLinkDialog();
}

type ComposeDialogBodyProps = {
  session: ComposeSession;
  titleId: string;
  lifecycle: ReturnType<typeof useComposeLifecycle>;
  toInputRef: React.RefObject<HTMLInputElement | null>;
  bodyRef: React.RefObject<BodyEditorHandle | null>;
};

function ComposeDialogBody(props: ComposeDialogBodyProps) {
  const { session, titleId, lifecycle } = props;
  const setDimensions = useComposeStore((compose) => compose.setDimensions);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const { onAttach, onInsertImage, onRemoveAttachment } = useAttachmentPipeline(props.bodyRef);

  return (
    <>
      <Dialog.Description className="sr-only">
        Compose panel. The mailbox behind it stays interactive.
      </Dialog.Description>
      <ComposeResizeHandles dimensions={session.dimensions} onResize={setDimensions} />
      {lifecycle.discardOpen && (
        <DiscardConfirm
          onCancel={lifecycle.cancelDiscard}
          onDiscard={() => void lifecycle.discard()}
        />
      )}
      <ComposeHeader
        mode={session.mode}
        titleId={titleId}
        onClose={lifecycle.closeWithSave}
        onDiscard={() => void lifecycle.discard()}
      />
      <ComposeScrollBody
        session={session}
        toInputRef={props.toInputRef}
        bodyRef={props.bodyRef}
        editor={editor}
        linkOpen={linkOpen}
        onCloseLink={() => setLinkOpen(false)}
        onSelectEditor={setEditor}
      />
      <AttachmentStrip attachments={session.attachments} onRemove={onRemoveAttachment} />
      <ComposeFooter
        editor={editor}
        onLink={() => toggleLinkInEditor(editor, () => setLinkOpen(true))}
        onAttach={onAttach}
        onInsertImage={onInsertImage}
        ready={lifecycle.ready}
        status={footerStatusText(session)}
        failed={isFooterFailed(session)}
        onRetry={() => void (session.lifecycleError ? lifecycle.send() : lifecycle.saveNow())}
        onSend={() => void lifecycle.send()}
        sending={lifecycle.sending}
        blocked={lifecycle.readingAttachment}
      />
    </>
  );
}

function ComposeDialogSurface({
  session,
  titleId,
  lifecycle,
  onFocusInitial,
  onRestoreFocus,
}: {
  session: ComposeSession;
  titleId: string;
  lifecycle: ReturnType<typeof useComposeLifecycle>;
  onFocusInitial: (
    toInputRef: React.RefObject<HTMLInputElement | null>,
    bodyRef: React.RefObject<BodyEditorHandle | null>,
  ) => void;
  onRestoreFocus: () => void;
}) {
  const toInputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<BodyEditorHandle>(null);

  return (
    <Dialog.Content
      data-testid="compose-overlay"
      aria-labelledby={titleId}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        onFocusInitial(toInputRef, bodyRef);
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        onRestoreFocus();
      }}
      onInteractOutside={(event) => event.preventDefault()}
      onKeyDownCapture={(event) => {
        if (event.key === 'Tab') event.stopPropagation();
      }}
      style={composeDialogStyle(session.dimensions)}
      className="fixed bottom-container-padding right-container-padding z-50 flex select-text flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container-lowest shadow-lg dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest"
    >
      <ComposeDialogBody
        session={session}
        titleId={titleId}
        lifecycle={lifecycle}
        toInputRef={toInputRef}
        bodyRef={bodyRef}
      />
    </Dialog.Content>
  );
}

export function ComposeOverlay() {
  const session = useComposeStore((compose) => compose.session);
  const lifecycle = useComposeLifecycle(session);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  const sessionId = session?.id ?? null;
  useEffect(() => {
    if (sessionId) previousFocusRef.current = document.activeElement as HTMLElement | null;
  }, [sessionId]);

  if (!session) return null;

  const focusInitialField = (
    toInputRef: React.RefObject<HTMLInputElement | null>,
    bodyRef: React.RefObject<BodyEditorHandle | null>,
  ) => {
    if (isBodyFocusMode(session.mode)) {
      bodyRef.current?.focus();
      return;
    }
    toInputRef.current?.focus();
  };

  return (
    <Dialog.Root open modal={false} onOpenChange={(open) => !open && lifecycle.closeWithSave()}>
      <Dialog.Portal>
        <div
          aria-hidden="true"
          className="fixed inset-0 z-40 bg-on-background/20 pointer-events-none dark:bg-dark-on-background/20"
        />
        <ComposeDialogSurface
          session={session}
          titleId={titleId}
          lifecycle={lifecycle}
          onFocusInitial={focusInitialField}
          onRestoreFocus={() => previousFocusRef.current?.focus()}
        />
      </Dialog.Portal>
    </Dialog.Root>
  );
}
