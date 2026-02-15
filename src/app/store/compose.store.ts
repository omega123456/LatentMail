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
  draftId: number | null;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  inReplyTo: string;
  references: string;
  gmailThreadId: string;
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
  draftId: null,
  to: '',
  cc: '',
  bcc: '',
  subject: '',
  htmlBody: '',
  textBody: '',
  inReplyTo: '',
  references: '',
  gmailThreadId: '',
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

    async function saveDraft(): Promise<void> {
      if (!store.accountId()) return;
      patchState(store, { saving: true });
      try {
        const draft = {
          id: store.draftId() || undefined,
          accountId: store.accountId()!,
          gmailThreadId: store.gmailThreadId() || undefined,
          subject: store.subject(),
          to: store.to(),
          cc: store.cc(),
          bcc: store.bcc(),
          htmlBody: store.htmlBody(),
          textBody: store.textBody(),
          inReplyTo: store.inReplyTo() || undefined,
          references: store.references() || undefined,
          attachmentsJson: store.attachments().length > 0 ? JSON.stringify(store.attachments()) : undefined,
          signature: store.activeSignatureId() || undefined,
        };
        const response = await electronService.saveDraft(draft);
        if (response.success && response.data) {
          const { id } = response.data as { id: number };
          patchState(store, {
            draftId: id,
            saving: false,
            lastSavedAt: new Date().toISOString(),
          });
        } else {
          patchState(store, { saving: false });
        }
      } catch {
        patchState(store, { saving: false });
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
        let gmailThreadId = '';
        let showCc = false;

        if (context.originalMessage && context.mode !== 'new') {
          const msg = context.originalMessage;
          gmailThreadId = msg.gmailThreadId;

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
            draftId: d.id || null,
            to: d.to,
            cc: d.cc,
            bcc: d.bcc,
            subject: d.subject,
            htmlBody: d.htmlBody,
            textBody: d.textBody,
            inReplyTo: d.inReplyTo || '',
            references: d.references || '',
            gmailThreadId: d.gmailThreadId || '',
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
          draftId: null,
          to,
          cc,
          bcc: '',
          subject,
          htmlBody,
          textBody: '',
          inReplyTo,
          references,
          gmailThreadId,
          attachments: [],
          showCc,
          showBcc: false,
          error: null,
          lastSavedAt: null,
          activeSignatureId: defaultSig?.id || null,
        });
      },

      closeCompose(): void {
        clearAutoSave();
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
            // Delete the draft if it was saved
            if (store.draftId()) {
              await electronService.deleteDraft(store.draftId()!);
            }
            clearAutoSave();
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
        if (store.draftId()) {
          await electronService.deleteDraft(store.draftId()!);
        }
        patchState(store, initialState);
      },
    };
  })
);
