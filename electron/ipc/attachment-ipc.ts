import { ipcMain, dialog, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as iconv from 'iconv-lite';
import { LoggerService } from '../services/logger-service';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';
import { DatabaseService } from '../services/database-service';
import { ImapService } from '../services/imap-service';
import { simpleParser } from 'mailparser';
import { FolderLockManager } from '../services/folder-lock-manager';

const log = LoggerService.getInstance();

/**
 * Sanitize a filename to remove path separators and null bytes,
 * preventing path traversal attacks when saving attachments to disk.
 */
function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\0/g, '')
    .trim()
    || 'attachment';
}

/**
 * Get the local attachment cache directory for a given account + email.
 * Layout: {userData}/attachments/{accountId}/{emailId}/
 */
function getAttachmentCacheDir(accountId: number, emailId: number): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'attachments', String(accountId), String(emailId));
}

export function registerAttachmentIpcHandlers(): void {
  const db = DatabaseService.getInstance();

  /**
   * Get attachment metadata for a specific email (by xGmMsgId).
   * Returns an array of AttachmentRecord objects (no content).
   */
  ipcMain.handle(IPC_CHANNELS.ATTACHMENT_GET_FOR_EMAIL, async (
    _event,
    accountId: string,
    xGmMsgId: string
  ) => {
    try {
      const numAccountId = Number(accountId);
      if (!Number.isFinite(numAccountId)) {
        return ipcError('INVALID_ACCOUNT', `Invalid accountId: ${accountId}`);
      }
      if (!xGmMsgId || typeof xGmMsgId !== 'string') {
        return ipcError('INVALID_PARAMS', 'xGmMsgId is required');
      }
      const attachments = db.getAttachmentsForEmail(numAccountId, xGmMsgId);
      return ipcSuccess(attachments);
    } catch (err) {
      log.error('[AttachmentIPC] get-for-email failed:', err);
      return ipcError('ATTACHMENT_FETCH_FAILED', 'Failed to fetch attachment metadata');
    }
  });

  /**
   * Get the base64 content of a specific attachment for preview.
   * Fetches from local cache if available, otherwise fetches from IMAP and caches.
   */
  ipcMain.handle(IPC_CHANNELS.ATTACHMENT_GET_CONTENT, async (
    _event,
    attachmentId: number
  ) => {
    try {
      const att = db.getAttachmentById(attachmentId);
      if (!att) {
        return ipcError('ATTACHMENT_NOT_FOUND', `Attachment ${attachmentId} not found`);
      }

      // Try local cache first
      if (att.localPath && fs.existsSync(att.localPath)) {
        try {
          const content = fs.readFileSync(att.localPath);
          return ipcSuccess({
            filename: att.filename,
            mimeType: att.mimeType || 'application/octet-stream',
            size: att.size,
            content: content.toString('base64'),
          });
        } catch (cacheErr) {
          log.warn(`[AttachmentIPC] get-content: cache read failed for ${att.localPath}:`, cacheErr);
          // Fall through to IMAP fetch
        }
      }

      // Fetch from IMAP
      const emailInfo = db.getEmailInfoForAttachment(attachmentId);
      if (!emailInfo) {
        return ipcError('ATTACHMENT_EMAIL_NOT_FOUND', `Email for attachment ${attachmentId} not found`);
      }

      const content = await fetchAttachmentContent(emailInfo.accountId, emailInfo.xGmMsgId, att.filename, att.contentId);
      if (!content) {
        return ipcError('ATTACHMENT_CONTENT_NOT_FOUND', `Could not fetch content for attachment "${att.filename}"`);
      }

      // Cache to disk
      try {
        const cacheDir = getAttachmentCacheDir(emailInfo.accountId, att.emailId);
        if (!fs.existsSync(cacheDir)) {
          fs.mkdirSync(cacheDir, { recursive: true });
        }
        const safeName = sanitizeFilename(att.filename);
        const cachePath = path.join(cacheDir, `${attachmentId}_${safeName}`);
        fs.writeFileSync(cachePath, content);
        db.updateAttachmentLocalPath(attachmentId, cachePath);
      } catch (cacheErr) {
        log.warn(`[AttachmentIPC] get-content: failed to cache attachment ${attachmentId}:`, cacheErr);
      }

      return ipcSuccess({
        filename: att.filename,
        mimeType: att.mimeType || 'application/octet-stream',
        size: att.size,
        content: content.toString('base64'),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get attachment content';
      log.error('[AttachmentIPC] get-content failed:', err);
      return ipcError('ATTACHMENT_CONTENT_FAILED', message);
    }
  });

  /**
   * Get attachment content decoded as text (UTF-8 with Latin-1 fallback).
   * Uses iconv-lite for reliable decoding. For text preview only.
   */
  ipcMain.handle(IPC_CHANNELS.ATTACHMENT_GET_CONTENT_AS_TEXT, async (
    _event,
    attachmentId: number
  ) => {
    try {
      const att = db.getAttachmentById(attachmentId);
      if (!att) {
        return ipcError('ATTACHMENT_NOT_FOUND', `Attachment ${attachmentId} not found`);
      }

      let content: Buffer;
      if (att.localPath && fs.existsSync(att.localPath)) {
        try {
          content = fs.readFileSync(att.localPath);
        } catch (cacheErr) {
          log.warn(`[AttachmentIPC] get-content-as-text: cache read failed for ${att.localPath}:`, cacheErr);
          const emailInfo = db.getEmailInfoForAttachment(attachmentId);
          if (!emailInfo) {
            return ipcError('ATTACHMENT_EMAIL_NOT_FOUND', `Email for attachment ${attachmentId} not found`);
          }
          const fetched = await fetchAttachmentContent(emailInfo.accountId, emailInfo.xGmMsgId, att.filename, att.contentId);
          if (!fetched) {
            return ipcError('ATTACHMENT_CONTENT_NOT_FOUND', `Could not fetch content for attachment "${att.filename}"`);
          }
          content = fetched;
        }
      } else {
        const emailInfo = db.getEmailInfoForAttachment(attachmentId);
        if (!emailInfo) {
          return ipcError('ATTACHMENT_EMAIL_NOT_FOUND', `Email for attachment ${attachmentId} not found`);
        }
        const fetched = await fetchAttachmentContent(emailInfo.accountId, emailInfo.xGmMsgId, att.filename, att.contentId);
        if (!fetched) {
          return ipcError('ATTACHMENT_CONTENT_NOT_FOUND', `Could not fetch content for attachment "${att.filename}"`);
        }
        content = fetched;
      }

      let text = iconv.decode(content, 'utf8');
      if (text.includes('\uFFFD')) {
        text = iconv.decode(content, 'latin1');
      }
      return ipcSuccess({
        filename: att.filename,
        mimeType: att.mimeType || 'application/octet-stream',
        text,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get attachment text';
      log.error('[AttachmentIPC] get-content-as-text failed:', err);
      return ipcError('ATTACHMENT_CONTENT_FAILED', message);
    }
  });

  /**
   * Download an attachment and save to disk via native Save dialog.
   * Fetches from local cache if available, otherwise fetches from IMAP.
   */
  ipcMain.handle(IPC_CHANNELS.ATTACHMENT_DOWNLOAD, async (
    _event,
    attachmentId: number
  ) => {
    try {
      const att = db.getAttachmentById(attachmentId);
      if (!att) {
        return ipcError('ATTACHMENT_NOT_FOUND', `Attachment ${attachmentId} not found`);
      }

      const emailInfo = db.getEmailInfoForAttachment(attachmentId);
      if (!emailInfo) {
        return ipcError('ATTACHMENT_EMAIL_NOT_FOUND', `Email for attachment ${attachmentId} not found`);
      }

      // Try local cache first
      let content: Buffer | null = null;
      if (att.localPath && fs.existsSync(att.localPath)) {
        try {
          content = fs.readFileSync(att.localPath);
        } catch (cacheErr) {
          log.warn(`[AttachmentIPC] download: cache read failed for ${att.localPath}:`, cacheErr);
        }
      }

      // Fetch from IMAP if not cached
      if (!content) {
        content = await fetchAttachmentContent(emailInfo.accountId, emailInfo.xGmMsgId, att.filename, att.contentId);
        if (!content) {
          return ipcError('ATTACHMENT_CONTENT_NOT_FOUND', `Could not fetch content for "${att.filename}"`);
        }

        // Cache to disk
        try {
          const cacheDir = getAttachmentCacheDir(emailInfo.accountId, att.emailId);
          if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
          }
          const safeName = sanitizeFilename(att.filename);
          const cachePath = path.join(cacheDir, `${attachmentId}_${safeName}`);
          fs.writeFileSync(cachePath, content);
          db.updateAttachmentLocalPath(attachmentId, cachePath);
        } catch (cacheErr) {
          log.warn(`[AttachmentIPC] download: cache failed for ${attachmentId}:`, cacheErr);
        }
      }

      // Show native Save dialog
      const safeName = sanitizeFilename(att.filename);
      const result = await dialog.showSaveDialog({
        defaultPath: safeName,
        filters: [{ name: 'All Files', extensions: ['*'] }],
      });

      if (result.canceled || !result.filePath) {
        return ipcSuccess({ saved: false });
      }

      fs.writeFileSync(result.filePath, content);
      log.info(`[AttachmentIPC] download: saved "${att.filename}" to ${result.filePath}`);
      return ipcSuccess({ saved: true, filePath: result.filePath });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to download attachment';
      log.error('[AttachmentIPC] download failed:', err);
      return ipcError('ATTACHMENT_DOWNLOAD_FAILED', message);
    }
  });

  /**
   * Fetch attachments from a server draft for compose restoration.
   * Returns an array of { filename, mimeType, size, data (base64) } objects.
   */
  ipcMain.handle(IPC_CHANNELS.ATTACHMENT_FETCH_DRAFT_ATTACHMENTS, async (
    _event,
    accountId: string,
    xGmMsgId: string
  ) => {
    try {
      const numAccountId = Number(accountId);
      if (!Number.isFinite(numAccountId)) {
        return ipcError('INVALID_ACCOUNT', `Invalid accountId: ${accountId}`);
      }

      const db2 = DatabaseService.getInstance();
      const folderUids = db2.getFolderUidsForEmail(numAccountId, xGmMsgId);
      const draftsEntry = folderUids.find((fu) => fu.folder === '[Gmail]/Drafts');
      if (!draftsEntry) {
        return ipcError('DRAFT_NOT_FOUND', `Draft ${xGmMsgId} not found in Drafts folder`);
      }

      const imapService = ImapService.getInstance();
      const lockManager = FolderLockManager.getInstance();
      const GMAIL_DRAFTS_FOLDER = '[Gmail]/Drafts';

      let attachmentData: Array<{ filename: string; mimeType: string; size: number; data: string }> = [];

      const release = await lockManager.acquire(GMAIL_DRAFTS_FOLDER, numAccountId);
      try {
        const msg = await imapService['connect'](accountId);
        const mailboxLock = await msg.getMailboxLock(GMAIL_DRAFTS_FOLDER);
        try {
          const fetched = await msg.fetchOne(String(draftsEntry.uid), { source: true }, { uid: true });
          if (fetched && fetched.source) {
            const sourceBuffer = Buffer.isBuffer(fetched.source) ? fetched.source : Buffer.from(fetched.source);
            const parsed = await simpleParser(sourceBuffer);
            attachmentData = (parsed.attachments || [])
              .filter((att) => !att.contentId || att.contentDisposition === 'attachment')
              .map((att) => ({
                filename: att.filename || 'attachment',
                mimeType: att.contentType || 'application/octet-stream',
                size: att.size || (att.content ? att.content.length : 0),
                data: att.content ? att.content.toString('base64') : '',
              }));
          }
        } finally {
          mailboxLock.release();
        }
      } finally {
        release();
      }

      return ipcSuccess(attachmentData);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch draft attachments';
      log.error('[AttachmentIPC] fetch-draft-attachments failed:', err);
      return ipcError('ATTACHMENT_DRAFT_FETCH_FAILED', message);
    }
  });
}

/**
 * Fetch the raw content of a specific attachment from IMAP by re-fetching the email source.
 * Returns null if the email or attachment cannot be found.
 */
async function fetchAttachmentContent(
  accountId: number,
  xGmMsgId: string,
  filename: string,
  contentId: string | null
): Promise<Buffer | null> {
  const db = DatabaseService.getInstance();
  const imapService = ImapService.getInstance();
  const lockManager = FolderLockManager.getInstance();

  // Find a valid folder + UID for the email
  const folderUids = db.getFolderUidsForEmail(accountId, xGmMsgId);
  if (folderUids.length === 0) {
    log.warn(`[AttachmentIPC] fetchAttachmentContent: no folder UIDs found for msgid=${xGmMsgId}`);
    return null;
  }

  // Prefer non-All Mail folders (more likely to have the UID valid)
  const entry = folderUids.find((fu) => fu.folder !== '[Gmail]/All Mail') || folderUids[0];

  const release = await lockManager.acquire(entry.folder, accountId);
  try {
    const client = await imapService.connect(String(accountId));
    const mailboxLock = await client.getMailboxLock(entry.folder);
    try {
      const msg = await client.fetchOne(String(entry.uid), { source: true }, { uid: true });
      if (!msg || !msg.source) {
        return null;
      }

      const sourceBuffer = Buffer.isBuffer(msg.source) ? msg.source : Buffer.from(msg.source);
      const parsed = await simpleParser(sourceBuffer);

      // Find the matching attachment by filename or contentId
      const matchingAtt = (parsed.attachments || []).find((att) => {
        if (contentId) {
          const normalizedCid = att.contentId?.replace(/^<|>$/g, '') ?? '';
          if (normalizedCid === contentId) {
            return true;
          }
        }
        return att.filename === filename;
      });

      if (!matchingAtt || !matchingAtt.content) {
        log.warn(`[AttachmentIPC] fetchAttachmentContent: attachment "${filename}" not found in parsed email`);
        return null;
      }

      return matchingAtt.content;
    } finally {
      mailboxLock.release();
    }
  } finally {
    release();
  }
}
