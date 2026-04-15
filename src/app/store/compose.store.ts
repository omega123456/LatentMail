import { computed, inject } from '@angular/core';
import { DateTime } from 'luxon';

/** Extracts the raw email address from a "Name <email>" or plain email string. */
function extractEmailFromParticipant(participant: string): string {
  const match = participant.match(/<([^>]+)>/);
  if (match) {
    return match[1].trim();
  }
  return participant.trim();
}
import { signalStore, withState, withMethods, withComputed, patchState } from '@ngrx/signals';
import { ElectronService } from '../core/services/electron.service';
import {
  ComposeMode, ComposeContext, Draft, DraftAttachment, Contact, Email, Thread,
} from '../core/models/email.model';

export interface Signature {
  id: string;
  name: string;
  html: string;
  isDefault: boolean;
}

interface ComposeState {
  isOpen: boolean;
  mode: ComposeMode;
  accountId: number | null;
  accountEmail: string;
  accountDisplayName: string;
  /** UUID of the current draft's queue entry (null if not yet saved). */
  queueId: string | null;
  /** Whether the server has confirmed the draft exists (queue completed). */
  serverConfirmed: boolean;
  /** Server-confirmed xGmMsgId of the draft (for delete on discard). */
  serverXGmMsgId: string | null;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  inReplyTo: string;
  references: string;
  attachments: DraftAttachment[];
  showCc: boolean;
  showBcc: boolean;
  sending: boolean;
  saving: boolean;
  error: string | null;
  lastSavedAt: string | null;
  signatures: Signature[];
  activeSignatureId: string | null;
  /** Read-only quoted block HTML for reply/reply-all/forward (not parsed by TipTap). */
  quotedHtml: string;
  /** Plain-text version of quoted block for MIME text part. */
  quotedText: string;
}

const initialState: ComposeState = {
  isOpen: false,
  mode: 'new',
  accountId: null,
  accountEmail: '',
  accountDisplayName: '',
  queueId: null,
  serverConfirmed: false,
  serverXGmMsgId: null,
  to: '',
  cc: '',
  bcc: '',
  subject: '',
  htmlBody: '',
  textBody: '',
  inReplyTo: '',
  references: '',
  attachments: [],
  showCc: false,
  showBcc: false,
  sending: false,
  saving: false,
  error: null,
  lastSavedAt: null,
  signatures: [],
  activeSignatureId: null,
  quotedHtml: '',
  quotedText: '',
};

function splitDraftBody(fullHtml: string): {
  editableHtml: string;
  quotedHtml: string;
  quotedText: string;
} {
  if (!fullHtml || typeof fullHtml !== 'string') {
    return { editableHtml: fullHtml || '', quotedHtml: '', quotedText: '' };
  }
  const wrap = document.createElement('div');
  wrap.innerHTML = fullHtml;
  const quoted = wrap.querySelector('.quoted-block');
  if (!quoted) {
    return { editableHtml: fullHtml, quotedHtml: '', quotedText: '' };
  }
  const quotedHtml = quoted.outerHTML;
  const quotedText = (quoted as HTMLElement).innerText.replace(/\s+/g, ' ').trim();
  quoted.remove();
  const editableHtml = wrap.innerHTML.trimEnd();
  return { editableHtml, quotedHtml, quotedText };
}

export const ComposeStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),

  withComputed((store) => ({
    hasRecipients: computed(() => store.to().trim().length > 0),
    canSend: computed(() =>
      store.to().trim().length > 0 && !store.sending()
    ),
    isDirty: computed(() =>
      store.to().length > 0 || store.subject().length > 0 || store.htmlBody().length > 0
    ),
    activeSignature: computed(() =>
      store.signatures().find(s => s.id === store.activeSignatureId()) ?? null
    ),
    defaultSignature: computed(() =>
      store.signatures().find(s => s.isDefault) ?? null
    ),
  })),

  withMethods((store) => {
    const electronService = inject(ElectronService);
    let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
    /** Guard: prevents duplicate enqueues from rapid timer fires. */
    let enqueueInFlight = false;
    /** Subscription cleanup for queue:update events. */
    let queueUpdateUnsub: (() => void) | null = null;

    /**
     * Fetches attachment content from the server for a server draft and patches compose state.
     * Called after opening a server draft to restore attachment data for re-send.
     */
    async function fetchAndRestoreAttachments(): Promise<void> {
      const xGmMsgId = store.serverXGmMsgId();
      const accountId = store.accountId();
      if (!xGmMsgId || !accountId) {
        return;
      }
      try {
        const response = await electronService.fetchDraftAttachments(String(accountId), xGmMsgId);
        if (response.success && response.data) {
          const restored = response.data as DraftAttachment[];
          if (restored.length > 0) {
            // Merge with any attachments the user may have already added in this session
            patchState(store, state => ({ attachments: [...state.attachments, ...restored] }));
          }
        }
      } catch {
        // Non-critical — user can re-attach manually
      }
    }

    function clearAutoSave(): void {
      if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
      }
    }

    function scheduleAutoSave(): void {
      clearAutoSave();
      autoSaveTimer = setTimeout(async () => {
        if (store.isOpen() && store.isDirty()) {
          await saveDraft();
        }
      }, 5000);
    }

    /**
     * Subscribe to queue:update events to track server confirmation.
     * Filtered by the current queueId.
     */
    function subscribeToQueueUpdates(): void {
      unsubscribeFromQueueUpdates();

      const sub = electronService.onEvent<{
        queueId: string;
        status: string;
        error?: string;
        result?: { xGmMsgId?: string };
      }>('queue:update').subscribe((update) => {
        const currentQueueId = store.queueId();
        if (!currentQueueId || update.queueId !== currentQueueId) return;

        if (update.status === 'completed') {
          patchState(store, {
            serverConfirmed: true,
            saving: false,
            lastSavedAt: DateTime.utc().toISO(),
            serverXGmMsgId: update.result?.xGmMsgId || store.serverXGmMsgId(),
          });
        } else if (update.status === 'failed') {
          patchState(store, {
            saving: false,
            error: update.error || 'Draft save failed',
          });
        } else if (update.status === 'cancelled') {
          patchState(store, { saving: false });
        }
      });

      queueUpdateUnsub = () => sub.unsubscribe();
    }

    function unsubscribeFromQueueUpdates(): void {
      if (queueUpdateUnsub) {
        queueUpdateUnsub();
        queueUpdateUnsub = null;
      }
    }

    async function saveDraft(): Promise<void> {
      if (!store.accountId() || enqueueInFlight) return;

      // Determine if this is an update or a new draft
      const currentQueueId = store.queueId();
      const currentServerXGmMsgId = store.serverXGmMsgId();
      
      // Three paths:
      // 1. Update via queueId (draft created this session)
      // 2. Update via serverXGmMsgId (draft opened from server)
      // 3. Create new draft (neither queueId nor serverXGmMsgId)
      const isUpdateViaQueueId = !!currentQueueId;
      const isUpdateViaServerXGmMsgId = !currentQueueId && !!currentServerXGmMsgId;
      const isUpdate = isUpdateViaQueueId || isUpdateViaServerXGmMsgId;

      // Block draft-update until the initial draft-create is server-confirmed.
      // This prevents enqueuing an update before the server IDs are available,
      // which would fall back to a duplicate draft-create.
      // (Only applies to updates via queueId; updates via serverXGmMsgId don't need confirmation)
      if (isUpdateViaQueueId && !store.serverConfirmed()) return;

      enqueueInFlight = true;
      patchState(store, { saving: true });

      try {
        const fullHtml = store.htmlBody() + (store.quotedHtml() || '');
        const fullText = store.textBody() + (store.quotedText() ? '\n\n' + store.quotedText() : '');
        const basePayload = {
          subject: store.subject(),
          to: store.to(),
          cc: store.cc() || undefined,
          bcc: store.bcc() || undefined,
          htmlBody: fullHtml || undefined,
          textBody: fullText || undefined,
          inReplyTo: store.inReplyTo() || undefined,
          references: store.references() || undefined,
          attachments: store.attachments().length > 0
            ? store.attachments().map(a => ({
                filename: a.filename,
                data: a.data || '',
                mimeType: a.mimeType,
              }))
            : undefined,
        };

        const type = isUpdate ? 'draft-update' : 'draft-create';
        const payload = isUpdate
          ? {
              ...basePayload,
              originalQueueId: currentQueueId || undefined,
              serverDraftXGmMsgId: currentServerXGmMsgId || undefined,
            }
          : basePayload;

        const description = `Save draft: ${store.subject() || '(no subject)'}`;

        const response = await electronService.enqueueOperation({
          type,
          accountId: store.accountId()!,
          payload,
          description,
        });

        if (response.success && response.data) {
          const { queueId: returnedQueueId } = response.data as { queueId: string };

          // On first save, store the queueId and subscribe to updates
          if (!currentQueueId) {
            patchState(store, { queueId: returnedQueueId });
            subscribeToQueueUpdates();
          }
        } else {
          patchState(store, { saving: false });
        }
      } catch {
        patchState(store, { saving: false });
      } finally {
        enqueueInFlight = false;
      }
    }

    return {
      openCompose(context: ComposeContext): void {
        let to = '';
        let cc = '';
        let bcc = '';
        let subject = '';
        let htmlBody = '';
        let quotedHtml = '';
        let quotedText = '';
        let inReplyTo = '';
        let references = '';
        let showCc = false;
        let showBcc = false;

        if (context.originalMessage && context.mode !== 'new') {
          const msg = context.originalMessage;

          if (context.mode === 'reply') {
            to = msg.fromAddress;
            subject = msg.subject?.startsWith('Re:') ? msg.subject : `Re: ${msg.subject || ''}`;
          } else if (context.mode === 'reply-all') {
            to = msg.fromAddress;
            // Add other recipients, excluding the sender's own address
            const otherTo = (msg.toAddresses || '').split(',')
              .map(participantEntry => participantEntry.trim())
              .filter(participantEntry => participantEntry && extractEmailFromParticipant(participantEntry).toLowerCase() !== context.accountEmail.toLowerCase());
            const ccAddresses = (msg.ccAddresses || '').split(',')
              .map(participantEntry => participantEntry.trim())
              .filter(participantEntry => participantEntry && extractEmailFromParticipant(participantEntry).toLowerCase() !== context.accountEmail.toLowerCase());
            if (otherTo.length > 0) {
              to = [to, ...otherTo].join(', ');
            }
            if (ccAddresses.length > 0) {
              cc = ccAddresses.join(', ');
              showCc = true;
            }
            subject = msg.subject?.startsWith('Re:') ? msg.subject : `Re: ${msg.subject || ''}`;
          } else if (context.mode === 'forward') {
            subject = msg.subject?.startsWith('Fwd:') ? msg.subject : `Fwd: ${msg.subject || ''}`;
            to = '';
          }

          inReplyTo = msg.messageId || msg.xGmMsgId;
          references = msg.messageId || msg.xGmMsgId;

          // Build quoted block for read-only display (not put through TipTap)
          const date = DateTime.fromISO(msg.date).toLocaleString(DateTime.DATETIME_SHORT);
          const from = msg.fromName ? `${msg.fromName} &lt;${msg.fromAddress}&gt;` : msg.fromAddress;
          quotedHtml = `<div class="quoted-block" style="border-left: 2px solid #ccc; padding-left: 12px; margin-left: 0; color: #666;">` +
            `<p>On ${date}, ${from} wrote:</p>` +
            `${msg.htmlBody || msg.textBody?.replace(/\n/g, '<br>') || ''}` +
            `</div>`;
          quotedText = msg.textBody || (msg.htmlBody ? msg.htmlBody.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '');
        }

        if (context.mode === 'new') {
          if (context.to != null && context.to !== '') {
            to = context.to;
          }
          if (context.cc != null && context.cc !== '') {
            cc = context.cc;
            showCc = true;
          }
          if (context.bcc != null && context.bcc !== '') {
            bcc = context.bcc;
            showBcc = true;
          }
          if (context.subject != null && context.subject !== '') {
            subject = context.subject;
          }
        }

        if (context.draft) {
          const d = context.draft;
          const { editableHtml, quotedHtml: splitQuotedHtml, quotedText: splitQuotedText } = splitDraftBody(d.htmlBody);
          patchState(store, {
            isOpen: true,
            mode: context.mode,
            accountId: context.accountId,
            accountEmail: context.accountEmail,
            accountDisplayName: context.accountDisplayName,
            queueId: null,
            serverConfirmed: context.serverDraftXGmMsgId ? true : false,
            serverXGmMsgId: context.serverDraftXGmMsgId ?? null,
            to: d.to,
            cc: d.cc,
            bcc: d.bcc,
            subject: d.subject,
            htmlBody: editableHtml,
            textBody: d.textBody,
            inReplyTo: d.inReplyTo || '',
            references: d.references || '',
          attachments: d.attachments || [],
            showCc: !!d.cc,
            showBcc: !!d.bcc,
            error: null,
            quotedHtml: splitQuotedHtml,
            quotedText: splitQuotedText,
          });

          // Restore attachments from server if this is a server draft (fire-and-forget background fetch)
          if (context.serverDraftXGmMsgId) {
            void fetchAndRestoreAttachments();
          }
          return;
        }

        // Build editable part only (prefill + signature); quoted block is in quotedHtml
        const defaultSig = store.signatures().find(s => s.isDefault);
        if (defaultSig && context.mode === 'new') {
          htmlBody = `<br><br><div class="signature">${defaultSig.html}</div>`;
        } else if (defaultSig && quotedHtml) {
          htmlBody = `<br><br><div class="signature">${defaultSig.html}</div>`;
        } else if (defaultSig) {
          htmlBody = `<br><br><div class="signature">${defaultSig.html}</div>`;
        }

        // Prepend prefill body (e.g. AI smart reply) before signature
        let textBody = '';
        if (context.prefillBody) {
          textBody = context.prefillBody;
          const escaped = context.prefillBody
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
          htmlBody = `<p>${escaped}</p>` + htmlBody;
        }

        patchState(store, {
          isOpen: true,
          mode: context.mode,
          accountId: context.accountId,
          accountEmail: context.accountEmail,
          accountDisplayName: context.accountDisplayName,
          queueId: null,
          serverConfirmed: false,
          serverXGmMsgId: null,
          to,
          cc,
          bcc,
          subject,
          htmlBody,
          textBody,
          inReplyTo,
          references,
          attachments: [],
          showCc,
          showBcc,
          error: null,
          lastSavedAt: null,
          activeSignatureId: defaultSig?.id || null,
          quotedHtml,
          quotedText,
        });
      },

      async closeCompose(): Promise<void> {
        clearAutoSave();
        // Save the draft before closing if there's content worth saving
        if (store.isOpen() && store.isDirty() && store.accountId()) {
          await saveDraft();
        }
        unsubscribeFromQueueUpdates();
        patchState(store, initialState);
      },

      updateField(field: keyof ComposeState, value: unknown): void {
        patchState(store, { [field]: value } as Partial<ComposeState>);
        scheduleAutoSave();
      },

      toggleCc(): void {
        patchState(store, { showCc: !store.showCc() });
      },

      toggleBcc(): void {
        patchState(store, { showBcc: !store.showBcc() });
      },

      addAttachment(attachment: DraftAttachment): void {
        patchState(store, { attachments: [...store.attachments(), attachment] });
        scheduleAutoSave();
      },

      removeAttachment(index: number): void {
        const atts = [...store.attachments()];
        atts.splice(index, 1);
        patchState(store, { attachments: atts });
        scheduleAutoSave();
      },

      async saveDraft(): Promise<void> {
        await saveDraft();
      },

      async send(): Promise<boolean> {
        if (!store.accountId() || !store.canSend()) return false;
        patchState(store, { sending: true, error: null });
        try {
          const fullHtml = store.htmlBody() + (store.quotedHtml() || '');
          const fullText = store.textBody() + (store.quotedText() ? '\n\n' + store.quotedText() : '');
          const message = {
            to: store.to(),
            cc: store.cc() || undefined,
            bcc: store.bcc() || undefined,
            subject: store.subject(),
            html: fullHtml,
            text: fullText || undefined,
            inReplyTo: store.inReplyTo() || undefined,
            references: store.references() || undefined,
            attachments: store.attachments().length > 0
              ? store.attachments().map(a => ({
                  filename: a.filename,
                  content: a.data,
                  contentType: a.mimeType,
                }))
              : undefined,
            // Pass the draft's queueId so the send worker can delete the server draft
            // via in-memory mapping (draft created this session)
            originalQueueId: store.queueId() || undefined,
            // Also pass server xGmMsgId for drafts opened from server
            // (fallback when queueId mapping is unavailable)
            serverDraftXGmMsgId: store.serverXGmMsgId() || undefined,
          };

          const response = await electronService.sendMail(String(store.accountId()), message);
          if (response.success) {
            // Send is now queued — close compose immediately.
            // The queue worker will handle SMTP send and draft cleanup.
            clearAutoSave();
            unsubscribeFromQueueUpdates();
            patchState(store, initialState);
            return true;
          } else {
            patchState(store, {
              sending: false,
              error: response.error?.message || 'Failed to send email',
            });
            return false;
          }
        } catch (err: unknown) {
          patchState(store, {
            sending: false,
            error: err instanceof Error ? err.message : 'Failed to send email',
          });
          return false;
        }
      },

      /**
       * Restores draft attachments from the server when opening a server draft.
       * Called automatically after openCompose() when serverDraftXGmMsgId is present.
       * Can also be invoked manually to retry restoration after a failure.
       */
      async restoreDraftAttachments(): Promise<void> {
        await fetchAndRestoreAttachments();
      },

      async loadSignatures(): Promise<void> {
        try {
          const response = await electronService.getSignatures();
          if (response.success && response.data) {
            patchState(store, { signatures: response.data as Signature[] });
          }
        } catch {
          // Non-critical
        }
      },

      async saveSignatures(signatures: Signature[]): Promise<void> {
        try {
          await electronService.saveSignatures(signatures);
          patchState(store, { signatures });
        } catch {
          // Non-critical
        }
      },

      setActiveSignature(signatureId: string | null): void {
        patchState(store, { activeSignatureId: signatureId });
      },

      async discardDraft(): Promise<void> {
        clearAutoSave();
        unsubscribeFromQueueUpdates();
        // If the server has confirmed the draft exists, enqueue a delete operation
        // to remove it from the server's [Gmail]/Drafts folder.
        const xGmMsgId = store.serverXGmMsgId();
        if (store.serverConfirmed() && xGmMsgId && store.accountId()) {
          try {
            await electronService.deleteEmails(
              String(store.accountId()),
              [xGmMsgId],
              '[Gmail]/Drafts',
            );
          } catch {
            // Best-effort: if delete fails, draft remains on server until next sync
          }
        }
        patchState(store, initialState);
      },
    };
  })
);
