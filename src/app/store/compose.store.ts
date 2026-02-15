import { computed, inject } from '@angular/core';
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
}

const initialState: ComposeState = {
  isOpen: false,
  mode: 'new',
  accountId: null,
  accountEmail: '',
  accountDisplayName: '',
  queueId: null,
  serverConfirmed: false,
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
};

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
        result?: unknown;
      }>('queue:update').subscribe((update) => {
        const currentQueueId = store.queueId();
        if (!currentQueueId || update.queueId !== currentQueueId) return;

        if (update.status === 'completed') {
          patchState(store, {
            serverConfirmed: true,
            saving: false,
            lastSavedAt: new Date().toISOString(),
          });
        } else if (update.status === 'failed') {
          patchState(store, {
            saving: false,
            error: update.error || 'Draft save failed',
          });
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

      // Block draft-update until the initial draft-create is server-confirmed.
      // This prevents enqueuing an update before the server IDs are available,
      // which would fall back to a duplicate draft-create.
      const currentQueueId = store.queueId();
      const isUpdate = !!currentQueueId;
      if (isUpdate && !store.serverConfirmed()) return;

      enqueueInFlight = true;
      patchState(store, { saving: true });

      try {
        const basePayload = {
          subject: store.subject(),
          to: store.to(),
          cc: store.cc() || undefined,
          bcc: store.bcc() || undefined,
          htmlBody: store.htmlBody() || undefined,
          textBody: store.textBody() || undefined,
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
          ? { ...basePayload, originalQueueId: currentQueueId }
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
        let subject = '';
        let htmlBody = '';
        let inReplyTo = '';
        let references = '';
        let showCc = false;

        if (context.originalMessage && context.mode !== 'new') {
          const msg = context.originalMessage;

          if (context.mode === 'reply') {
            to = msg.fromAddress;
            subject = msg.subject?.startsWith('Re:') ? msg.subject : `Re: ${msg.subject || ''}`;
          } else if (context.mode === 'reply-all') {
            to = msg.fromAddress;
            // Add other recipients, excluding the sender's own address
            const otherTo = (msg.toAddresses || '').split(',')
              .map(a => a.trim())
              .filter(a => a && a.toLowerCase() !== context.accountEmail.toLowerCase());
            const ccAddresses = (msg.ccAddresses || '').split(',')
              .map(a => a.trim())
              .filter(a => a && a.toLowerCase() !== context.accountEmail.toLowerCase());
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

          inReplyTo = msg.gmailMessageId;
          references = msg.gmailMessageId;

          // Build quoted body
          const date = new Date(msg.date).toLocaleString();
          const from = msg.fromName ? `${msg.fromName} &lt;${msg.fromAddress}&gt;` : msg.fromAddress;
          htmlBody = `<br><br><div style="border-left: 2px solid #ccc; padding-left: 12px; margin-left: 0; color: #666;">` +
            `<p>On ${date}, ${from} wrote:</p>` +
            `${msg.htmlBody || msg.textBody?.replace(/\n/g, '<br>') || ''}` +
            `</div>`;
        }

        if (context.draft) {
          const d = context.draft;
          patchState(store, {
            isOpen: true,
            mode: context.mode,
            accountId: context.accountId,
            accountEmail: context.accountEmail,
            accountDisplayName: context.accountDisplayName,
            queueId: null,
            serverConfirmed: false,
            to: d.to,
            cc: d.cc,
            bcc: d.bcc,
            subject: d.subject,
            htmlBody: d.htmlBody,
            textBody: d.textBody,
            inReplyTo: d.inReplyTo || '',
            references: d.references || '',
            attachments: d.attachments || [],
            showCc: !!d.cc,
            showBcc: !!d.bcc,
            error: null,
          });
          return;
        }

        // Apply default signature
        const defaultSig = store.signatures().find(s => s.isDefault);
        if (defaultSig && context.mode === 'new') {
          htmlBody = `<br><br><div class="signature">${defaultSig.html}</div>`;
        } else if (defaultSig && htmlBody) {
          htmlBody = `<br><br><div class="signature">${defaultSig.html}</div>` + htmlBody;
        }

        patchState(store, {
          isOpen: true,
          mode: context.mode,
          accountId: context.accountId,
          accountEmail: context.accountEmail,
          accountDisplayName: context.accountDisplayName,
          queueId: null,
          serverConfirmed: false,
          to,
          cc,
          bcc: '',
          subject,
          htmlBody,
          textBody: '',
          inReplyTo,
          references,
          attachments: [],
          showCc,
          showBcc: false,
          error: null,
          lastSavedAt: null,
          activeSignatureId: defaultSig?.id || null,
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
          const message = {
            to: store.to(),
            cc: store.cc() || undefined,
            bcc: store.bcc() || undefined,
            subject: store.subject(),
            html: store.htmlBody(),
            text: store.textBody() || undefined,
            inReplyTo: store.inReplyTo() || undefined,
            references: store.references() || undefined,
            attachments: store.attachments().map(a => ({
              filename: a.filename,
              content: a.data,
              contentType: a.mimeType,
            })),
          };

          const response = await electronService.sendMail(String(store.accountId()), message);
          if (response.success) {
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
        // If the server has confirmed the draft exists, we could enqueue a delete
        // operation. For now, the draft will remain on the server and be cleaned up
        // on next sync or manually. Phase 2 will add delete-via-queue.
        patchState(store, initialState);
      },
    };
  })
);
