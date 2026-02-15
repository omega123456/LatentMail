import { ipcMain } from 'electron';
import log from 'electron-log/main';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';
import { DatabaseService } from '../services/database-service';
import { ImapService } from '../services/imap-service';
import { SyncService } from '../services/sync-service';
import { buildDraftMime } from '../services/draft-mime';

const GMAIL_DRAFTS_FOLDER = '[Gmail]/Drafts';

export function registerComposeIpcHandlers(): void {
  const db = DatabaseService.getInstance();

  // Save or update a draft (local DB + Gmail IMAP APPEND)
  ipcMain.handle(IPC_CHANNELS.COMPOSE_SAVE_DRAFT, async (_event, draft: {
    id?: number;
    accountId: number;
    /** UID of server draft to delete before first APPEND (when editing a draft opened from Gmail) */
    serverDraftUid?: number;
    gmailThreadId?: string;
    subject: string;
    to: string;
    cc: string;
    bcc: string;
    htmlBody: string;
    textBody: string;
    inReplyTo?: string;
    references?: string;
    attachmentsJson?: string;
    signature?: string;
  }) => {
    try {
      // 1. Resolve account for From address
      const account = db.getAccountById(draft.accountId);
      if (!account) {
        return ipcError('COMPOSE_ACCOUNT_NOT_FOUND', 'Account not found');
      }

      // 2. If updating an existing draft that has an IMAP UID, delete old message from Gmail
      let oldImapUid: number | null = null;
      let oldImapUidValidity: number | null = null;
      if (draft.id) {
        const existingDraft = db.getDraftById(draft.id);
        if (existingDraft) {
          const raw = existingDraft['imapUid'] as number | null | undefined;
          oldImapUid = raw != null && raw > 0 ? raw : null;
          oldImapUidValidity = (existingDraft['imapUidValidity'] as number | null | undefined) ?? null;
        }
      }

      // 3. Build MIME from draft content
      let imapUid: number | null = null;
      let imapUidValidity: number | null = null;

      try {
        // Parse attachments from JSON
        const attachments: Array<{ filename: string; content: Buffer | string; contentType?: string }> = [];
        if (draft.attachmentsJson) {
          const parsed = JSON.parse(draft.attachmentsJson) as Array<{
            filename: string;
            mimeType: string;
            data?: string;
          }>;
          for (const att of parsed) {
            if (att.data) {
              attachments.push({
                filename: att.filename,
                content: Buffer.from(att.data, 'base64'),
                contentType: att.mimeType,
              });
            }
          }
        }

        const mimeBuffer = await buildDraftMime({
          from: `${account.display_name} <${account.email}>`,
          to: draft.to,
          cc: draft.cc || undefined,
          bcc: draft.bcc || undefined,
          subject: draft.subject,
          html: draft.htmlBody || undefined,
          text: draft.textBody || undefined,
          inReplyTo: draft.inReplyTo || undefined,
          references: draft.references || undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
        });

        // 4. If editing a server draft (no local id yet), delete the original from Gmail before APPEND
        if (!draft.id && draft.serverDraftUid) {
          try {
            const imapService = ImapService.getInstance();
            await imapService.deleteDraftByUid(
              String(draft.accountId),
              GMAIL_DRAFTS_FOLDER,
              draft.serverDraftUid,
              null
            );
          } catch (err) {
            log.warn('Failed to delete server draft from Gmail before append (continuing):', err);
          }
        }

        // 5. Delete old draft from Gmail if updating an existing local draft with IMAP UID
        if (oldImapUid) {
          try {
            const imapService = ImapService.getInstance();
            await imapService.deleteDraftByUid(
              String(draft.accountId),
              GMAIL_DRAFTS_FOLDER,
              oldImapUid,
              oldImapUidValidity
            );
          } catch (err) {
            log.warn('Failed to delete old draft from Gmail (continuing):', err);
          }
        }

        // 6. Append new draft to Gmail
        const imapService = ImapService.getInstance();
        const appendResult = await imapService.appendDraft(
          String(draft.accountId),
          mimeBuffer
        );
        imapUid = appendResult.uid;
        imapUidValidity = appendResult.uidValidity;

        // 7. Trigger sync so the Drafts folder updates in the UI
        const syncService = SyncService.getInstance();
        syncService.syncAccount(String(draft.accountId)).catch(err => {
          log.warn('Post-draft-save sync failed:', err);
        });

      } catch (err) {
        // If IMAP fails (e.g. offline), continue saving locally only
        log.warn('Draft IMAP append failed (saving locally only):', err);
      }

      // 8. Save to local DB with IMAP UID
      const id = db.saveDraft({
        ...draft,
        imapUid,
        imapUidValidity,
      });

      return ipcSuccess({ id });
    } catch (err) {
      log.error('Failed to save draft:', err);
      return ipcError('COMPOSE_SAVE_DRAFT_FAILED', 'Failed to save draft');
    }
  });

  // Get all drafts for an account
  ipcMain.handle(IPC_CHANNELS.COMPOSE_GET_DRAFTS, async (_event, accountId: number) => {
    try {
      const drafts = db.getDraftsByAccount(accountId);
      return ipcSuccess(drafts);
    } catch (err) {
      log.error('Failed to get drafts:', err);
      return ipcError('COMPOSE_GET_DRAFTS_FAILED', 'Failed to get drafts');
    }
  });

  // Get a single draft by ID
  ipcMain.handle(IPC_CHANNELS.COMPOSE_GET_DRAFT, async (_event, draftId: number) => {
    try {
      const draft = db.getDraftById(draftId);
      if (!draft) return ipcError('COMPOSE_DRAFT_NOT_FOUND', 'Draft not found');
      return ipcSuccess(draft);
    } catch (err) {
      log.error('Failed to get draft:', err);
      return ipcError('COMPOSE_GET_DRAFT_FAILED', 'Failed to get draft');
    }
  });

  // Delete a draft (local + Gmail)
  ipcMain.handle(IPC_CHANNELS.COMPOSE_DELETE_DRAFT, async (_event, draftId: number) => {
    try {
      // Check if draft has an IMAP UID — if so, delete from Gmail too (with UIDVALIDITY check)
      const draft = db.getDraftById(draftId);
      if (draft) {
        const imapUid = draft['imapUid'] as number | null | undefined;
        const imapUidValidity = draft['imapUidValidity'] as number | null | undefined;
        const accountId = draft['accountId'] as number;
        if (imapUid != null && imapUid > 0 && accountId) {
          try {
            const imapService = ImapService.getInstance();
            await imapService.deleteDraftByUid(
              String(accountId),
              GMAIL_DRAFTS_FOLDER,
              imapUid,
              imapUidValidity ?? null
            );
          } catch (err) {
            log.warn('Failed to delete draft from Gmail (continuing with local delete):', err);
          }
        }
      }
      db.deleteDraft(draftId);
      return ipcSuccess(null);
    } catch (err) {
      log.error('Failed to delete draft:', err);
      return ipcError('COMPOSE_DELETE_DRAFT_FAILED', 'Failed to delete draft');
    }
  });

  // Delete a draft message from Gmail by UID (for server drafts opened from Drafts folder)
  ipcMain.handle(IPC_CHANNELS.COMPOSE_DELETE_DRAFT_ON_SERVER, async (_event, accountId: number, uid: number) => {
    try {
      const imapService = ImapService.getInstance();
      await imapService.deleteDraftByUid(String(accountId), GMAIL_DRAFTS_FOLDER, uid);
      return ipcSuccess(null);
    } catch (err) {
      log.error('Failed to delete server draft:', err);
      return ipcError('COMPOSE_DELETE_SERVER_DRAFT_FAILED', 'Failed to delete server draft');
    }
  });

  // Search contacts for autocomplete
  ipcMain.handle(IPC_CHANNELS.COMPOSE_SEARCH_CONTACTS, async (_event, query: string) => {
    try {
      const contacts = db.searchContacts(query);
      return ipcSuccess(contacts);
    } catch (err) {
      log.error('Failed to search contacts:', err);
      return ipcError('COMPOSE_SEARCH_CONTACTS_FAILED', 'Failed to search contacts');
    }
  });

  // Get signatures (stored as JSON in settings)
  ipcMain.handle(IPC_CHANNELS.COMPOSE_GET_SIGNATURES, async () => {
    try {
      const raw = db.getSetting('signatures');
      const signatures = raw ? JSON.parse(raw) : [];
      return ipcSuccess(signatures);
    } catch (err) {
      log.error('Failed to get signatures:', err);
      return ipcError('COMPOSE_GET_SIGNATURES_FAILED', 'Failed to get signatures');
    }
  });

  // Save a signature
  ipcMain.handle(IPC_CHANNELS.COMPOSE_SAVE_SIGNATURE, async (_event, signatures: Array<{ id: string; name: string; html: string; isDefault: boolean }>) => {
    try {
      db.setSetting('signatures', JSON.stringify(signatures));
      return ipcSuccess(null);
    } catch (err) {
      log.error('Failed to save signature:', err);
      return ipcError('COMPOSE_SAVE_SIGNATURE_FAILED', 'Failed to save signature');
    }
  });

  // Delete a signature
  ipcMain.handle(IPC_CHANNELS.COMPOSE_DELETE_SIGNATURE, async (_event, signatureId: string) => {
    try {
      const raw = db.getSetting('signatures');
      const signatures = raw ? JSON.parse(raw) : [];
      const filtered = signatures.filter((s: { id: string }) => s.id !== signatureId);
      db.setSetting('signatures', JSON.stringify(filtered));
      return ipcSuccess(null);
    } catch (err) {
      log.error('Failed to delete signature:', err);
      return ipcError('COMPOSE_DELETE_SIGNATURE_FAILED', 'Failed to delete signature');
    }
  });

  log.info('Compose IPC handlers registered');
}
