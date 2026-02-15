import { ipcMain } from 'electron';
import log from 'electron-log/main';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';
import { DatabaseService } from '../services/database-service';
import { ImapService } from '../services/imap-service';
import { buildDraftMime } from '../services/draft-mime';
import { randomUUID } from 'crypto';

const GMAIL_DRAFTS_FOLDER = '[Gmail]/Drafts';

export function registerComposeIpcHandlers(): void {
  const db = DatabaseService.getInstance();

  // Save or update a draft (local DB + Gmail IMAP APPEND)
  ipcMain.handle(IPC_CHANNELS.COMPOSE_SAVE_DRAFT, async (_event, draft: {
    id?: number;
    accountId: number;
    /** gmailMessageId of server draft to delete before first APPEND (when editing a draft opened from Gmail) */
    serverDraftGmailMessageId?: string;
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

      // Generate a stable Message-ID for this draft (used in both MIME and local DB).
      // Nodemailer stores Message-ID with angle brackets as-is.
      const domain = account.email.split('@')[1] || 'local';
      const draftMessageId = `<draft-${randomUUID()}@${domain}>`;

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
          messageId: draftMessageId,
          attachments: attachments.length > 0 ? attachments : undefined,
        });

        // 4. If editing a server draft (no local id yet), delete the original from Gmail before APPEND
        if (!draft.id && draft.serverDraftGmailMessageId) {
          try {
            const imapService = ImapService.getInstance();
            // Resolve the UID from email_folders for this message in Drafts
            const folderUids = db.getFolderUidsForEmail(draft.accountId, draft.serverDraftGmailMessageId);
            const draftsEntry = folderUids.find(fu => fu.folder === GMAIL_DRAFTS_FOLDER);
            if (draftsEntry) {
              await imapService.deleteDraftByUid(
                String(draft.accountId),
                GMAIL_DRAFTS_FOLDER,
                draftsEntry.uid,
                null
              );
            } else {
              log.warn(`No UID found for server draft gmailMessageId=${draft.serverDraftGmailMessageId} — cannot delete from server`);
            }
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

        // 7. Update local emails/threads/folder tables so Drafts folder view reflects the draft
        //    without needing a full sync. Only do this when APPEND returned a valid UID.
        if (imapUid != null) {
          try {
            const gmailThreadId = draft.gmailThreadId || `draft-${randomUUID()}`;

            // If we deleted an old IMAP UID, clean up its email/thread/folder entries.
            // The old draft's gmailMessageId was stored in the drafts table's companion
            // email row — look it up by searching for email_folders with the old UID.
            if (oldImapUid) {
              // Find the email row that had this old UID in the Drafts folder
              const oldFolderUids = db.getEmailFolderUids(draft.accountId, GMAIL_DRAFTS_FOLDER);
              const oldEntry = oldFolderUids.find(e => e.uid === oldImapUid);
              if (oldEntry) {
                db.removeEmailFolderAssociation(draft.accountId, oldEntry.gmailMessageId, GMAIL_DRAFTS_FOLDER);

                // Check if the old thread still has emails in Drafts; if not, remove thread-folder link
                const oldEmail = db.getEmailByGmailMessageId(draft.accountId, oldEntry.gmailMessageId);
                if (oldEmail) {
                  const oldThreadId = String(oldEmail['gmailThreadId'] || '');
                  if (oldThreadId && !db.threadHasEmailsInFolder(draft.accountId, oldThreadId, GMAIL_DRAFTS_FOLDER)) {
                    const oldInternalThreadId = db.getThreadInternalId(draft.accountId, oldThreadId);
                    if (oldInternalThreadId != null) {
                      db.removeThreadFolderAssociation(oldInternalThreadId, GMAIL_DRAFTS_FOLDER);
                    }
                  }
                }
              }
            }

            // Upsert the new draft as an email in the emails table
            db.upsertEmail({
              accountId: draft.accountId,
              gmailMessageId: draftMessageId,
              gmailThreadId,
              folder: GMAIL_DRAFTS_FOLDER,
              folderUid: imapUid,
              fromAddress: account.email,
              fromName: account.display_name,
              toAddresses: draft.to || '',
              ccAddresses: draft.cc || '',
              bccAddresses: draft.bcc || '',
              subject: draft.subject || '',
              textBody: draft.textBody || '',
              htmlBody: draft.htmlBody || '',
              date: new Date().toISOString(),
              isRead: true,
              isStarred: false,
              isImportant: false,
              snippet: (draft.textBody || '').substring(0, 100),
              hasAttachments: !!draft.attachmentsJson,
            });

            // Upsert thread entry for the draft.
            // If a thread already exists (e.g. reply draft in an existing conversation),
            // preserve its metadata to avoid clobbering real thread info.
            const existingThread = db.getThreadById(draft.accountId, gmailThreadId);
            let dbThreadId: number;
            if (existingThread) {
              // Thread exists — keep existing metadata, just ensure folder association
              dbThreadId = existingThread['id'] as number;
            } else {
              // New thread — create with draft info
              dbThreadId = db.upsertThread({
                accountId: draft.accountId,
                gmailThreadId,
                subject: draft.subject || '',
                lastMessageDate: new Date().toISOString(),
                participants: account.email,
                messageCount: 1,
                snippet: (draft.textBody || '').substring(0, 100),
                folder: GMAIL_DRAFTS_FOLDER,
                isRead: true,
                isStarred: false,
              });
            }

            // Associate thread with [Gmail]/Drafts folder
            db.upsertThreadFolder(dbThreadId, draft.accountId, GMAIL_DRAFTS_FOLDER);

            log.info(`Draft saved to local emails/threads with UID ${imapUid}`);
          } catch (dbErr) {
            log.warn('Failed to upsert draft into emails/threads tables (draft saved to drafts table):', dbErr);
          }
        } else {
          log.warn('IMAP APPEND did not return a UID — draft will appear in Drafts folder on next sync');
        }

      } catch (err) {
        // If IMAP fails (e.g. offline), continue saving locally only
        log.warn('Draft IMAP append failed (saving locally only):', err);
      }

      // 8. Save to local DB drafts table with IMAP UID
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

  // Delete a draft message from Gmail by gmailMessageId (resolves UID from email_folders)
  ipcMain.handle(IPC_CHANNELS.COMPOSE_DELETE_DRAFT_ON_SERVER, async (_event, accountId: number, gmailMessageId: string) => {
    try {
      const folderUids = db.getFolderUidsForEmail(accountId, gmailMessageId);
      const draftsEntry = folderUids.find(fu => fu.folder === GMAIL_DRAFTS_FOLDER);
      if (draftsEntry) {
        const imapService = ImapService.getInstance();
        await imapService.deleteDraftByUid(String(accountId), GMAIL_DRAFTS_FOLDER, draftsEntry.uid);
      } else {
        log.warn(`No UID found for draft gmailMessageId=${gmailMessageId} in ${GMAIL_DRAFTS_FOLDER} — cannot delete from server`);
      }
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
