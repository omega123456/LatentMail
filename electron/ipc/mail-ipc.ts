import { ipcMain } from 'electron';
import log from 'electron-log/main';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';

export function registerMailIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.MAIL_FETCH_EMAILS, async (_event, accountId: string, folderId: string, _options?: { limit?: number; offset?: number }) => {
    try {
      // TODO: Implement in Phase 3 with ImapService
      log.info(`Fetching emails for account ${accountId}, folder ${folderId}`);
      return ipcSuccess([]);
    } catch (err) {
      log.error('Failed to fetch emails:', err);
      return ipcError('MAIL_FETCH_FAILED', 'Failed to fetch emails');
    }
  });

  ipcMain.handle(IPC_CHANNELS.MAIL_FETCH_THREAD, async (_event, accountId: string, threadId: string) => {
    try {
      log.info(`Fetching thread ${threadId} for account ${accountId}`);
      return ipcSuccess(null);
    } catch (err) {
      log.error('Failed to fetch thread:', err);
      return ipcError('MAIL_FETCH_THREAD_FAILED', 'Failed to fetch thread');
    }
  });

  ipcMain.handle(IPC_CHANNELS.MAIL_SEND, async (_event, accountId: string, _message: unknown) => {
    try {
      log.info(`Sending email from account ${accountId}`);
      return ipcSuccess(null);
    } catch (err) {
      log.error('Failed to send email:', err);
      return ipcError('SMTP_SEND_FAILED', 'Failed to send email');
    }
  });

  ipcMain.handle(IPC_CHANNELS.MAIL_MOVE, async (_event, accountId: string, messageIds: string[], targetFolder: string) => {
    try {
      log.info(`Moving ${messageIds.length} messages to ${targetFolder} for account ${accountId}`);
      return ipcSuccess(null);
    } catch (err) {
      log.error('Failed to move emails:', err);
      return ipcError('MAIL_MOVE_FAILED', 'Failed to move emails');
    }
  });

  ipcMain.handle(IPC_CHANNELS.MAIL_FLAG, async (_event, accountId: string, messageIds: string[], flag: string, value: boolean) => {
    try {
      log.info(`Setting flag ${flag}=${value} on ${messageIds.length} messages for account ${accountId}`);
      return ipcSuccess(null);
    } catch (err) {
      log.error('Failed to update flags:', err);
      return ipcError('MAIL_FLAG_FAILED', 'Failed to update email flags');
    }
  });

  ipcMain.handle(IPC_CHANNELS.MAIL_SEARCH, async (_event, accountId: string, query: string) => {
    try {
      log.info(`Searching "${query}" for account ${accountId}`);
      return ipcSuccess([]);
    } catch (err) {
      log.error('Failed to search:', err);
      return ipcError('MAIL_SEARCH_FAILED', 'Failed to search emails');
    }
  });
}
