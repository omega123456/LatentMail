import { ipcMain } from 'electron';
import log from 'electron-log/main';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';
import { DatabaseService } from '../services/database-service';

export function registerComposeIpcHandlers(): void {
  const db = DatabaseService.getInstance();

  // Save or update a draft
  ipcMain.handle(IPC_CHANNELS.COMPOSE_SAVE_DRAFT, async (_event, draft: {
    id?: number;
    accountId: number;
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
      const id = db.saveDraft(draft);
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

  // Delete a draft
  ipcMain.handle(IPC_CHANNELS.COMPOSE_DELETE_DRAFT, async (_event, draftId: number) => {
    try {
      db.deleteDraft(draftId);
      return ipcSuccess(null);
    } catch (err) {
      log.error('Failed to delete draft:', err);
      return ipcError('COMPOSE_DELETE_DRAFT_FAILED', 'Failed to delete draft');
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
