import { useEffect, useRef } from 'react';
import { invoke } from '@/lib/ipc/commands';
import type { ComposeDraftRequest } from '@/lib/types/ipc';
import { selectQualifiesForDraft, useComposeStore, type ComposeSession } from '@/stores/compose';

export const AUTOSAVE_DELAY_MS = 5_000;

export function qualifiesForDraft(
  session: Pick<ComposeSession, 'recipients' | 'subject' | 'html'>,
): boolean {
  return (
    session.recipients.to.length > 0 ||
    session.subject.trim().length > 0 ||
    session.html.trim().length > 0
  );
}

export function toDraftRequest(session: ComposeSession): ComposeDraftRequest {
  return {
    sessionId: session.id,
    accountId: session.accountId,
    draftId: session.draftId,
    from: session.from,
    to: session.recipients.to,
    cc: session.recipients.cc,
    bcc: session.recipients.bcc,
    subject: session.subject,
    // Preview asset URLs are display-only.  The RFC document must only
    // reference the persisted CID, never an app-local staging URL.
    html: session.attachments.reduce(
      (html, attachment) =>
        attachment.contentId && attachment.staged
          ? html.split(attachment.staged.assetUrl).join(`cid:${attachment.contentId}`)
          : html,
      session.html,
    ),
    mode: session.mode,
    threadId: session.threadId,
    inReplyTo: session.inReplyTo,
    references: session.references,
    originalMessageId: session.originalMessageId,
    originalGmailMessageId: session.originalGmailMessageId,
    quoteHtml: session.quote?.html ?? null,
    quotePlain: null,
    // Exact editable snapshot is a stable boundary fingerprint without a
    // second, subtly different HTML serialization on either side of IPC.
    editableBodyFingerprint: session.html,
    attachments: session.attachments.flatMap((attachment) =>
      attachment.staged
        ? [
            {
              id: attachment.staged.id,
              filename: attachment.filename,
              mimeType: attachment.mimeType,
              contentId: attachment.contentId,
            },
          ]
        : [],
    ),
  };
}

/** One session has one timer. A newer change replaces that timer; if a save
 * is already admitted Rust's durable keyed coalescer owns the race. */
export function useComposeAutosave() {
  const session = useComposeStore((state) => state.session);
  const qualifies = useComposeStore(selectQualifiesForDraft);
  const setStatus = useComposeStore((state) => state.setDraftStatus);
  const setDraftId = useComposeStore((state) => state.setDraftId);
  const markSaved = useComposeStore((state) => state.markSaved);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!session?.dirty || !qualifies) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const current = useComposeStore.getState().session;
      if (!current || !qualifiesForDraft(current)) return;
      setStatus('saving');
      void invoke('save_compose_draft', { draft: toDraftRequest(current) })
        .then((accepted) => {
          if (accepted.draftId) setDraftId(accepted.draftId);
          markSaved();
        })
        .catch(() =>
          setStatus('failed', 'Couldn’t save draft.'),
        );
    }, AUTOSAVE_DELAY_MS);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [
    session?.id,
    session?.dirty,
    session?.subject,
    session?.html,
    session?.recipients,
    session?.attachments,
    qualifies,
    setStatus,
    setDraftId,
    markSaved,
  ]);

  return {
    saveNow: async () => {
      const current = useComposeStore.getState().session;
      if (!current || !qualifiesForDraft(current)) return;
      setStatus('saving');
      try {
        const accepted = await invoke('save_compose_draft', { draft: toDraftRequest(current) });
        if (accepted.draftId) setDraftId(accepted.draftId);
        markSaved();
      } catch {
        setStatus('failed', 'Couldn’t save draft.');
      }
    },
  };
}
