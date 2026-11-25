import { useEffect, useState } from 'react';
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

export class DraftAutosaveScheduler {
  private timerId: number | null = null;
  private readonly delayMs: number;

  constructor(delayMs = AUTOSAVE_DELAY_MS) {
    this.delayMs = delayMs;
  }

  schedule(): void {
    this.cancel();
    this.timerId = window.setTimeout(() => {
      this.timerId = null;
      void this.saveNow();
    }, this.delayMs);
  }

  cancel(): void {
    if (this.timerId === null) return;
    window.clearTimeout(this.timerId);
    this.timerId = null;
  }

  async saveNow(): Promise<void> {
    const store = useComposeStore.getState();
    const current = store.session;
    if (!current || !qualifiesForDraft(current)) return;
    store.setDraftStatus('saving');
    try {
      const accepted = await invoke('save_compose_draft', { draft: toDraftRequest(current) });
      if (accepted.draftId) store.setDraftId(accepted.draftId);
      store.markSaved();
    } catch {
      store.setDraftStatus('failed', 'Couldn’t save draft.');
    }
  }
}

export function useComposeAutosave() {
  const session = useComposeStore((compose) => compose.session);
  const qualifies = useComposeStore(selectQualifiesForDraft);
  const [scheduler] = useState(() => new DraftAutosaveScheduler());

  useEffect(() => {
    if (!session?.dirty || !qualifies) return;
    scheduler.schedule();
    return () => scheduler.cancel();
  }, [
    scheduler,
    session?.id,
    session?.dirty,
    session?.subject,
    session?.html,
    session?.recipients,
    session?.attachments,
    qualifies,
  ]);

  return { saveNow: () => scheduler.saveNow() };
}
