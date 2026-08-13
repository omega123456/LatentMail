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
import { useAttachmentPipeline } from './useAttachmentPipeline';
import {
  selectHasCommittedRecipient,
  selectHasReadingAttachment,
  selectQualifiesForDraft,
  useComposeStore,
} from '@/stores/compose';
import { toDraftRequest, useComposeAutosave } from '@/lib/compose/autosave';
import { invoke } from '@/lib/ipc/commands';

/** The composer panel: a Radix Dialog in non-modal mode, anchored
 * bottom-right over the mailbox (D8). The backdrop tints but never blocks
 * pointer access, focus is never trapped, and focus returns to whatever was
 * focused before the panel opened. */
export function ComposeOverlay() {
  const session = useComposeStore((state) => state.session);
  const close = useComposeStore((state) => state.close);
  const setHtml = useComposeStore((state) => state.setHtml);
  const setSubject = useComposeStore((state) => state.setSubject);
  const revealCcBcc = useComposeStore((state) => state.revealCcBcc);
  const toggleQuote = useComposeStore((state) => state.toggleQuote);
  const setDimensions = useComposeStore((state) => state.setDimensions);
  const ready = useComposeStore(selectHasCommittedRecipient);
  const readingAttachment = useComposeStore(selectHasReadingAttachment);
  const qualifies = useComposeStore(selectQualifiesForDraft);
  const setStatus = useComposeStore((state) => state.setDraftStatus);
  const { saveNow } = useComposeAutosave();

  const toInputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<BodyEditorHandle>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const titleId = useId();
  const { onAttach, onInsertImage, onRemoveAttachment } = useAttachmentPipeline(bodyRef);

  // Captured once per session (keyed on its stable id, not the whole object,
  // which is replaced on every keystroke) — the control to hand focus back
  // to when the panel closes.
  const sessionId = session?.id ?? null;
  useEffect(() => {
    if (sessionId) previousFocusRef.current = document.activeElement as HTMLElement | null;
  }, [sessionId]);

  if (!session) return null;

  const closeWithSave = () => {
    if (qualifies && session.dirty) void saveNow();
    close();
  };
  const discard = async () => {
    if (
      !discardOpen &&
      (session.subject.trim() || session.html.trim() || session.recipients.to.length)
    ) {
      setDiscardOpen(true);
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
    if (sending || readingAttachment || !ready) return;
    setSending(true);
    setStatus('saving');
    try {
      await invoke('send_compose_draft', { draft: toDraftRequest(session) });
      close();
    } catch (error) {
      setStatus('failed', error instanceof Error ? error.message : 'Couldn’t send message.');
    } finally {
      setSending(false);
    }
  };

  const bodyFocusMode = session.mode === 'reply' || session.mode === 'reply-all';
  const onLink = () => {
    if (!editor) return;
    if (editor.isActive('link')) editor.chain().focus().unsetLink().run();
    else setLinkOpen(true);
  };

  return (
    <Dialog.Root
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) closeWithSave();
      }}
    >
      <Dialog.Portal>
        <div
          aria-hidden="true"
          className="fixed inset-0 z-40 bg-on-background/20 pointer-events-none dark:bg-dark-on-background/20"
        />
        <Dialog.Content
          data-testid="compose-overlay"
          aria-labelledby={titleId}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (bodyFocusMode) bodyRef.current?.focus();
            else toInputRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            previousFocusRef.current?.focus();
          }}
          onInteractOutside={(event) => event.preventDefault()}
          // Radix's `Dialog.Content` hardcodes `loop: true` on its internal
          // `FocusScope` unconditionally — even in non-modal mode — so Tab
          // from the last focusable control cycles back to the first
          // control *inside the panel* rather than leaving it. That is a
          // keyboard trap (WCAG 2.1.2), which D8 explicitly forbids for
          // this persistent floating panel. Stopping propagation of Tab
          // during the capture phase, before FocusScope's own bubble-phase
          // handler on the same node runs, disables the loop while leaving
          // the browser's native Tab default (which we never preventDefault)
          // free to move focus normally, including out of the panel.
          onKeyDownCapture={(event) => {
            if (event.key === 'Tab') event.stopPropagation();
          }}
          style={
            {
              '--compose-w': `${session.dimensions.width}px`,
              '--compose-h': `${session.dimensions.height}px`,
              width: 'var(--compose-w)',
              height: 'var(--compose-h)',
            } as CSSProperties
          }
          className="fixed bottom-container-padding right-container-padding z-50 flex flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container-lowest shadow-lg dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest"
        >
          <Dialog.Description className="sr-only">
            Compose panel. The mailbox behind it stays interactive.
          </Dialog.Description>
          <ComposeResizeHandles dimensions={session.dimensions} onResize={setDimensions} />
          <ComposeHeader
            mode={session.mode}
            titleId={titleId}
            onClose={closeWithSave}
            onDiscard={() => void discard()}
          />
          {discardOpen && (
            <DiscardConfirm
              onCancel={() => setDiscardOpen(false)}
              onDiscard={() => void discard()}
            />
          )}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <div data-testid="recipient-field" className="flex flex-col">
              <div className="flex items-start gap-2 border-b border-outline-variant px-stack-gap-md py-stack-gap-sm focus-within:border-b-2 focus-within:border-primary dark:border-dark-outline-variant dark:focus-within:border-dark-primary">
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
                    onClick={revealCcBcc}
                    className="shrink-0 pt-1 text-label-sm text-secondary hover:text-on-surface dark:text-dark-secondary dark:hover:text-dark-on-surface"
                  >
                    Cc/Bcc
                  </button>
                )}
              </div>
              {session.ccBccRevealed && (
                <>
                  <div className="flex items-start gap-2 border-b border-outline-variant px-stack-gap-md py-stack-gap-sm focus-within:border-b-2 focus-within:border-primary dark:border-dark-outline-variant dark:focus-within:border-dark-primary">
                    <RecipientField
                      fieldRole="cc"
                      label="Cc"
                      accountId={session.accountId}
                      placeholder="Email addresses…"
                    />
                  </div>
                  <div className="flex items-start gap-2 border-b border-outline-variant px-stack-gap-md py-stack-gap-sm focus-within:border-b-2 focus-within:border-primary dark:border-dark-outline-variant dark:focus-within:border-dark-primary">
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
            <div className="flex items-center gap-2 border-b border-outline-variant px-stack-gap-md py-stack-gap-sm focus-within:border-b-2 focus-within:border-primary dark:border-dark-outline-variant dark:focus-within:border-dark-primary">
              <span className="w-13 shrink-0 text-label-md text-secondary dark:text-dark-secondary">
                Subject
              </span>
              <input
                value={session.subject}
                onChange={(event) => setSubject(event.target.value)}
                placeholder="Message subject"
                aria-label="Subject"
                className="min-w-0 flex-1 bg-transparent text-body-md text-on-surface outline-none placeholder:text-outline dark:text-dark-on-surface dark:placeholder:text-dark-outline"
              />
            </div>
            <BodyEditor
              ref={bodyRef}
              value={session.html}
              onChange={setHtml}
              onSelectionChange={setEditor}
            />
            {linkOpen && editor && (
              <LinkDialog editor={editor} onClose={() => setLinkOpen(false)} />
            )}
            {session.quote && (
              <div className="px-stack-gap-md py-stack-gap-sm">
                <QuoteDisclosure
                  html={session.quote.html}
                  attribution={session.quote.attribution}
                  open={session.quoteOpen}
                  onOpenChange={toggleQuote}
                />
              </div>
            )}
          </div>
          <AttachmentStrip attachments={session.attachments} onRemove={onRemoveAttachment} />
          <ComposeFooter
            editor={editor}
            onLink={onLink}
            onAttach={onAttach}
            onInsertImage={onInsertImage}
            ready={ready}
            status={
              session.lifecycleError ??
              (session.draftStatus === 'idle'
                ? ''
                : session.draftStatus === 'saving'
                  ? 'Saving…'
                  : session.draftStatus === 'saved'
                    ? 'Saved'
                    : 'Couldn’t save draft')
            }
            onSend={() => void send()}
            sending={sending}
            blocked={readingAttachment}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
