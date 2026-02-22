import { ipcMain } from 'electron';
import { LoggerService } from '../services/logger-service';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';

const log = LoggerService.getInstance();
import { DatabaseService } from '../services/database-service';

/**
 * Compose IPC handlers — signatures and contacts only.
 * Draft save/get/delete operations have been moved to the queue system
 * (see queue-ipc.ts and mail-queue-service.ts).
 */
export function registerComposeIpcHandlers(): void {
  const db = DatabaseService.getInstance();

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

  log.info('Compose IPC handlers registered (signatures & contacts only)');
}
