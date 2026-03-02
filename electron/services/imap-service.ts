import { ImapFlow, FetchMessageObject } from 'imapflow';
import { LoggerService } from './logger-service';
import { simpleParser } from 'mailparser';

const log = LoggerService.getInstance();
import { OAuthService } from './oauth-service';
import { DatabaseService } from './database-service';
import { FolderLockManager } from './folder-lock-manager';
import { formatParticipant } from '../utils/format-participant';

/**
 * RFC 6154 special-use attribute → IMAP mailbox path for SELECT.
 * Some servers (or DB legacy) may store the attribute (e.g. \Sent) instead of the
 * real path; SELECT requires the actual mailbox path (e.g. [Gmail]/Sent Mail).
 */
const SPECIAL_USE_TO_PATH: Record<string, string> = {
  '\\Inbox': 'INBOX',
  '\\Sent': '[Gmail]/Sent Mail',
  '\\Draft': '[Gmail]/Drafts',
  '\\Drafts': '[Gmail]/Drafts',
  '\\Junk': '[Gmail]/Spam',
  '\\Starred': '[Gmail]/Starred',
  '\\Important': '[Gmail]/Important',
};

/** Parsed attachment metadata from simpleParser (non-inline attachments). */
export interface ParsedAttachmentMeta {
  filename: string;
  mimeType: string | null;
  size: number | null;
  contentId: string | null;
}

export interface FetchedEmail {
  uid: number;
  /** Gmail X-GM-MSGID (globally unique message identifier, returned as string by ImapFlow) */
  xGmMsgId: string;
  /** Gmail X-GM-THRID (thread identifier, returned as string by ImapFlow) */
  xGmThrid: string;
  /** RFC 5322 Message-ID (for compose In-Reply-To/References) */
  messageId: string;
  folder: string;
  fromAddress: string;
  fromName: string;
  toAddresses: string;
  ccAddresses: string;
  bccAddresses: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  date: string;
  isRead: boolean;
  isStarred: boolean;
  isImportant: boolean;
  isDraft: boolean;
  snippet: string;
  size: number;
  hasAttachments: boolean;
  labels: string;
  /** Raw labels from ImapFlow's msg.labels Set (before CSV join). Used for All Mail label-to-folder mapping. */
  rawLabels: string[];
  /** CONDSTORE modseq value (string, from BigInt). Only present on CONDSTORE fetches. */
  modseq?: string;
  /** Parsed attachment metadata (non-inline). Populated when source is fetched. */
  attachments?: ParsedAttachmentMeta[];
}

interface MailboxInfo {
  path: string;
  name: string;
  specialUse: string;
  delimiter: string;
  listed: boolean;
  messages: number;
  unseen: number;
}

export class ImapService {
  private static instance: ImapService;
  private connections: Map<string, ImapFlow> = new Map();
  private connecting: Map<string, Promise<ImapFlow>> = new Map();
  /** Dedicated IDLE connections — separate from the shared pool */
  private idleConnections: Map<string, ImapFlow> = new Map();
  /** Held mailbox locks for dedicated IDLE connections. */
  private idleMailboxLocks: Map<string, { release: () => void }> = new Map();

  private constructor() {}

  static getInstance(): ImapService {
    if (!ImapService.instance) {
      ImapService.instance = new ImapService();
    }
    return ImapService.instance;
  }

  /**
   * Get or create an IMAP connection for the given account.
   */
  async connect(accountId: string): Promise<ImapFlow> {
    // Return existing connection if alive
    const existing = this.connections.get(accountId);
    if (existing && existing.usable) {
      return existing;
    }

    // Avoid duplicate connection attempts
    const pending = this.connecting.get(accountId);
    if (pending) {
      return pending;
    }

    const connectPromise = this.createConnection(accountId);
    this.connecting.set(accountId, connectPromise);

    try {
      const client = await connectPromise;
      this.connections.set(accountId, client);
      return client;
    } finally {
      this.connecting.delete(accountId);
    }
  }

  private async createConnection(accountId: string): Promise<ImapFlow> {
    const oauthService = OAuthService.getInstance();
    const db = DatabaseService.getInstance();
    const account = db.getAccountById(Number(accountId));

    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }

    const accessToken = await oauthService.getAccessToken(accountId);

    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: account.email,
        accessToken: accessToken,
      },
      logger: {
        debug: (msg: unknown) => log.debug(`[IMAP ${accountId}]`, msg),
        info: (msg: unknown) => log.info(`[IMAP ${accountId}]`, msg),
        warn: (msg: unknown) => log.warn(`[IMAP ${accountId}]`, msg),
        error: (msg: unknown) => log.error(`[IMAP ${accountId}]`, msg),
      },
      emitLogs: false,
    });

    // Handle connection close
    client.on('close', () => {
      log.info(`IMAP connection closed for account ${accountId}`);
      this.connections.delete(accountId);
    });

    client.on('error', (err: Error) => {
      log.error(`IMAP error for account ${accountId}:`, err);
      this.connections.delete(accountId);
    });

    await client.connect();
    log.info(`IMAP connected for account ${accountId} (${account.email})`);

    return client;
  }

  /**
   * Disconnect an account's IMAP connection.
   */
  async disconnect(accountId: string): Promise<void> {
    const client = this.connections.get(accountId);
    if (client) {
      try {
        await client.logout();
      } catch {
        // Ignore logout errors
      }
      this.connections.delete(accountId);
    }
  }

  /**
   * Disconnect all IMAP connections (shared + IDLE).
   */
  async disconnectAll(): Promise<void> {
    const promises = [
      ...Array.from(this.connections.keys()).map(id => this.disconnect(id)),
      ...Array.from(this.idleConnections.keys()).map(id => this.disconnectIdle(id)),
    ];
    await Promise.allSettled(promises);
  }

  /**
   * List all mailboxes (folders/labels) for an account.
   */
  async getMailboxes(accountId: string): Promise<MailboxInfo[]> {
    const client = await this.connect(accountId);
    const mailboxes: MailboxInfo[] = [];

    const list = await client.list();
    for (const mb of list) {
      // Get status for message counts
      let messages = 0;
      let unseen = 0;
      try {
        const status = await client.status(mb.path, { messages: true, unseen: true });
        messages = status.messages ?? 0;
        unseen = status.unseen ?? 0;
      } catch {
        // Some folders may not support STATUS
      }

      mailboxes.push({
        path: mb.path,
        name: mb.name,
        specialUse: mb.specialUse || '',
        delimiter: mb.delimiter || '/',
        listed: mb.listed,
        messages,
        unseen,
      });
    }

    return mailboxes;
  }

  /**
   * Create a new IMAP mailbox (Gmail label).
   * Uses FolderLockManager to serialize against other operations for this account.
   */
  async createMailbox(accountId: string, name: string): Promise<void> {
    const lockManager = FolderLockManager.getInstance();
    const release = await lockManager.acquire('__label_mgmt', accountId);
    try {
      const client = await this.connect(accountId);
      await client.mailboxCreate(name);
      log.info(`[IMAP] Created mailbox "${name}" for account ${accountId}`);
    } finally {
      release();
    }
  }

  /**
   * Delete an IMAP mailbox (Gmail label).
   * Uses FolderLockManager to serialize against other operations for this account.
   */
  async deleteMailbox(accountId: string, name: string): Promise<void> {
    const lockManager = FolderLockManager.getInstance();
    const release = await lockManager.acquire('__label_mgmt', accountId);
    try {
      const client = await this.connect(accountId);
      await client.mailboxDelete(name);
      log.info(`[IMAP] Deleted mailbox "${name}" for account ${accountId}`);
    } finally {
      release();
    }
  }

  /**
   * Fetch emails from a folder.
   */
  async fetchEmails(
    accountId: string,
    folder: string,
    options: { limit?: number; since?: Date } = {}
  ): Promise<FetchedEmail[]> {
    const client = await this.connect(accountId);
    const { limit = 50, since } = options;

    const lock = await client.getMailboxLock(folder);
    try {
      const emails: FetchedEmail[] = [];

      // Build search criteria
      const searchCriteria: Record<string, unknown> = {};
      if (since) {
        searchCriteria.since = since;
      }

      // Get UIDs in reverse order (newest first)
      let searchResult: number[] | false;
      if (Object.keys(searchCriteria).length > 0) {
        searchResult = await client.search(searchCriteria, { uid: true }) as number[] | false;
      } else {
        searchResult = await client.search({ all: true }, { uid: true }) as number[] | false;
      }

      if (!searchResult || searchResult.length === 0) return [];

      const uids = Array.from(searchResult);
      // Sort descending and limit
      uids.sort((a, b) => b - a);
      const fetchUids = uids.slice(0, limit);

      if (fetchUids.length === 0) return [];

      // Fetch messages
      const uidRange = fetchUids.join(',');
      for await (const msg of client.fetch(uidRange, {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true,
        headers: true,
        source: false,
        labels: true,
        threadId: true,
        emailId: true,
        size: true,
      } as any, { uid: true })) {
        if (!msg) continue;
        const email = this.parseMessage(msg as FetchMessageObject, folder);
        if (email) {
          emails.push(email);
        }
      }

      return emails;
    } finally {
      lock.release();
    }
  }

  /**
   * Fetch all UIDs in a folder (lightweight SEARCH ALL — no message content).
   * Used for sync reconciliation to get a complete picture of what exists on the server.
   */
  async fetchFolderUids(accountId: string, folder: string): Promise<number[]> {
    const client = await this.connect(accountId);
    const lock = await client.getMailboxLock(folder);
    try {
      const searchResult = await client.search({ all: true }, { uid: true }) as number[] | false;
      if (!searchResult || searchResult.length === 0) return [];
      return Array.from(searchResult);
    } finally {
      lock.release();
    }
  }

  /**
   * Fetch the full body of a single email by UID.
   */
  async fetchEmailBody(
    accountId: string,
    folder: string,
    uid: number
  ): Promise<{ textBody: string; htmlBody: string } | null> {
    const client = await this.connect(accountId);
    const lock = await client.getMailboxLock(folder);
    try {
      const msg = await client.fetchOne(String(uid), {
        source: true,
      }, { uid: true });

      if (!msg || !msg.source) {
        return null;
      }

      const sourceBuffer = Buffer.isBuffer(msg.source) ? msg.source : Buffer.from(msg.source);
      const parsed = await simpleParser(sourceBuffer);
      const { htmlBody } = this.resolveInlineImages(parsed.html || '', parsed.attachments || []);
      return {
        textBody: (parsed.text || '').trim(),
        htmlBody: htmlBody.trim(),
      };
    } finally {
      lock.release();
    }
  }

  /**
   * Resolve inline CID image references in HTML body by replacing cid: URLs with
   * base64 data URIs, and extract non-inline attachment metadata.
   *
   * @param rawHtml - Raw HTML body from simpleParser
   * @param parsedAttachments - Attachment list from simpleParser
   * @returns Resolved HTML body and array of non-inline attachment metadata
   */
  resolveInlineImages(
    rawHtml: string,
    parsedAttachments: Array<{
      filename?: string;
      contentType: string;
      size: number;
      contentId?: string | null;
      content: Buffer;
      contentDisposition?: string | null;
      headers?: unknown;
    }>
  ): { htmlBody: string; attachments: ParsedAttachmentMeta[] } {
    let htmlBody = rawHtml;
    const attachments: ParsedAttachmentMeta[] = [];

    // Build a map of contentId → base64 data URI for inline images
    const cidMap = new Map<string, string>();
    for (const att of parsedAttachments) {
      if (att.contentId) {
        // Normalize: strip angle brackets from content IDs (RFC 2392)
        const cid = att.contentId.replace(/^<|>$/g, '');
        if (cid && att.content && att.content.length > 0) {
          const mimeType = att.contentType || 'application/octet-stream';
          const base64 = att.content.toString('base64');
          cidMap.set(cid, `data:${mimeType};base64,${base64}`);
        }
      }
    }

    // Replace cid: references in HTML with data URIs
    if (cidMap.size > 0 && htmlBody) {
      htmlBody = htmlBody.replace(/cid:([^\s"'>]+)/gi, (_match, cidRef) => {
        const resolved = cidMap.get(cidRef);
        return resolved || `cid:${cidRef}`;
      });
    }

    // Collect non-inline attachment metadata
    for (const att of parsedAttachments) {
      // Skip inline images that are referenced in the HTML body
      const isInline = att.contentId && cidMap.has(att.contentId.replace(/^<|>$/g, ''));
      if (isInline) {
        continue;
      }
      // Skip attachments with no filename (usually inline content-type parts)
      const filename = att.filename || att.contentType?.split('/').pop() || 'attachment';
      attachments.push({
        filename,
        mimeType: att.contentType || null,
        size: att.size || (att.content ? att.content.length : null),
        contentId: att.contentId ? att.contentId.replace(/^<|>$/g, '') : null,
      });
    }

    return { htmlBody, attachments };
  }

  /**
   * Fetch a single message by UID from a specific folder.
   * Returns headers, flags, and body (via source parse). Used by the queue
   * worker after APPEND to retrieve server-confirmed data.
   * Does NOT acquire a mailbox lock — caller must hold the lock if needed.
   */
  async fetchMessageByUid(
    accountId: string,
    folder: string,
    uid: number,
  ): Promise<FetchedEmail | null> {
    const client = await this.connect(accountId);
    const lock = await client.getMailboxLock(folder);
    try {
      const msg = await client.fetchOne(String(uid), {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true,
        headers: true,
        source: true,
        labels: true,
        threadId: true,
        emailId: true,
        size: true,
      } as any, { uid: true });

      if (!msg) return null;

      const fetchMsg = msg as FetchMessageObject;
      const email = this.parseMessage(fetchMsg, folder);
      if (!email) return null;

      // Parse body from source
      if (fetchMsg.source) {
        try {
          const sourceBuffer = Buffer.isBuffer(fetchMsg.source)
            ? fetchMsg.source
            : Buffer.from(fetchMsg.source);
          const parsed = await simpleParser(sourceBuffer);
          const { htmlBody, attachments } = this.resolveInlineImages(
            parsed.html || '',
            parsed.attachments || []
          );
          email.textBody = (parsed.text || '').trim();
          email.htmlBody = htmlBody.trim();
          email.attachments = attachments;
        } catch (err) {
          log.warn('fetchMessageByUid: failed to parse message body:', err);
        }
      }

      return email;
    } finally {
      lock.release();
    }
  }

  /**
   * Resolve a folder name to the IMAP path used for SELECT.
   * If the folder is an RFC 6154 special-use attribute (e.g. \Sent) stored in DB or
   * returned by LIST, returns the actual mailbox path (e.g. [Gmail]/Sent Mail).
   * Prevents "BAD Could not parse command" when SELECT is given an attribute instead of a path.
   */
  private resolveFolderForSelect(folder: string, accountId: string): string {
    if (folder === '\\Trash') {
      return DatabaseService.getInstance().getTrashFolder(Number(accountId));
    }
    const resolved = SPECIAL_USE_TO_PATH[folder];
    return resolved ?? folder;
  }

  /**
   * Fetch all messages in a Gmail thread.
   * Always searches the thread's known folders first (to pick up drafts and folder-specific UIDs),
   * then searches [Gmail]/All Mail as an authoritative baseline to catch messages that may have
   * been moved out of their original folder.
   * Results are deduplicated by xGmMsgId.
   */
  async fetchThread(
    accountId: string,
    xGmThrid: string
  ): Promise<FetchedEmail[]> {
    if (!xGmThrid || typeof xGmThrid !== 'string' || xGmThrid.trim() === '') {
      log.warn('[IMAP] fetchThread: invalid or empty xGmThrid, skipping');
      return [];
    }

    const db = DatabaseService.getInstance();
    const numAccountId = Number(accountId);
    const ALL_MAIL_PATH = '[Gmail]/All Mail';

    // Known folders from DB (excludes All Mail; will be added explicitly below)
    const knownFolders = db.getFoldersForThread(numAccountId, xGmThrid).filter(
      (f) => f !== ALL_MAIL_PATH
    );

    // Always append All Mail as an authoritative baseline — finds messages that
    // were moved to a folder we don't have in thread_folders, or archived threads.
    // De-duplication by xGmMsgId prevents double-counting.
    const folders = knownFolders.length > 0
      ? [...knownFolders, ALL_MAIL_PATH]
      : [ALL_MAIL_PATH];

    const client = await this.connect(accountId);
    const byMessageId = new Map<string, FetchedEmail>();

    for (const folder of folders) {
      const pathForSelect = this.resolveFolderForSelect(folder, accountId);
      const lock = await client.getMailboxLock(pathForSelect);
      try {
        const searchResult = await client.search({ threadId: xGmThrid }, { uid: true }) as number[] | false;
        if (!searchResult || searchResult.length === 0) continue;

        const uids = Array.from(searchResult);
        const uidRange = uids.join(',');
        for await (const msg of client.fetch(uidRange, {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          headers: true,
          source: true,
          labels: true,
          threadId: true,
          emailId: true,
          size: true,
        } as any, { uid: true })) {
          if (!msg) continue;
          const fetchMsg = msg as FetchMessageObject;
          const email = this.parseMessage(fetchMsg, pathForSelect);
            if (email) {
              if (fetchMsg.source) {
                try {
                  const sourceBuffer = Buffer.isBuffer(fetchMsg.source)
                    ? fetchMsg.source
                    : Buffer.from(fetchMsg.source);
                  const parsed = await simpleParser(sourceBuffer);
                  const { htmlBody, attachments } = this.resolveInlineImages(
                    parsed.html || '',
                    parsed.attachments || []
                  );
                  email.textBody = (parsed.text || '').trim();
                  email.htmlBody = htmlBody.trim();
                  email.attachments = attachments;
                } catch (err) {
                  log.warn('Failed to parse thread message body:', err);
                }
              }
              byMessageId.set(email.xGmMsgId, email);
            }
        }
      } finally {
        lock.release();
      }
    }

    const emails = Array.from(byMessageId.values());
    emails.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    return emails;
  }

  /**
   * Fetch emails older than a given date from a folder.
   * Uses IMAP SEARCH with BEFORE criterion for scroll-to-load pagination.
   * Returns emails sorted newest-first (descending by UID), limited to `limit`.
   */
  async fetchOlderEmails(
    accountId: string,
    folder: string,
    beforeDate: Date,
    limit: number = 50
  ): Promise<{ emails: FetchedEmail[]; hasMore: boolean }> {
    const client = await this.connect(accountId);
    const lock = await client.getMailboxLock(folder);
    try {
      // IMAP BEFORE is date-only (not datetime). To avoid missing same-day
      // messages that are older by time-of-day, add 1 day to the search date.
      // Overlap is handled by deduplication in the DB upsert and renderer.
      const adjustedDate = new Date(beforeDate);
      adjustedDate.setDate(adjustedDate.getDate() + 1);

      const searchResult = await client.search(
        { before: adjustedDate },
        { uid: true }
      ) as number[] | false;

      if (!searchResult || searchResult.length === 0) {
        return { emails: [], hasMore: false };
      }

      const uids = Array.from(searchResult);
      // Sort descending (newest first) to get the most recent older emails
      uids.sort((a, b) => b - a);

      // Fetch one extra to determine if there are more beyond the limit
      const fetchUids = uids.slice(0, limit);
      const hasMore = uids.length > limit;

      if (fetchUids.length === 0) {
        return { emails: [], hasMore: false };
      }

      const emails: FetchedEmail[] = [];
      const uidRange = fetchUids.join(',');
      for await (const msg of client.fetch(uidRange, {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true,
        headers: true,
        source: false,
        labels: true,
        threadId: true,
        emailId: true,
        size: true,
      } as any, { uid: true })) {
        if (!msg) continue;
        const email = this.parseMessage(msg as FetchMessageObject, folder);
        if (email) {
          emails.push(email);
        }
      }

      return { emails, hasMore };
    } finally {
      lock.release();
    }
  }

  /**
   * Search emails on the IMAP server using Gmail's X-GM-RAW extension.
   * Searches across [Gmail]/All Mail to cover all folders in one search.
   * Returns metadata-only results (no bodies) for fast search listing.
   *
   * @param accountId - Account to search
   * @param query - Gmail search query string (e.g., "from:james subject:project")
   * @param limit - Maximum number of results (default 100)
   * @returns Array of parsed email metadata
   */
  async searchEmails(
    accountId: string,
    query: string,
    limit: number = 100
  ): Promise<FetchedEmail[]> {
    const client = await this.connect(accountId);
    const folder = '[Gmail]/All Mail';
    const lock = await client.getMailboxLock(folder);

    try {
      // Use X-GM-RAW for Gmail-specific full search syntax
      const searchResult = await client.search(
        { gmraw: query } as Record<string, unknown>,
        { uid: true }
      ) as number[] | false;

      if (!searchResult || searchResult.length === 0) {
        log.info(`[IMAP] searchEmails: no results for query "${query}" in account ${accountId}`);
        return [];
      }

      const uids = Array.from(searchResult);
      // Sort descending (newest first) and limit
      uids.sort((a, b) => b - a);
      const fetchUids = uids.slice(0, limit);

      log.info(`[IMAP] searchEmails: found ${uids.length} UIDs, fetching top ${fetchUids.length} for account ${accountId}`);

      if (fetchUids.length === 0) {
        return [];
      }

      const emails: FetchedEmail[] = [];
      const uidRange = fetchUids.join(',');

      // 30-second timeout for the fetch operation
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);

      try {
        for await (const msg of client.fetch(uidRange, {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          headers: true,
          source: false,
          labels: true,
          threadId: true,
          emailId: true,
          size: true,
        } as any, { uid: true })) {
          if (controller.signal.aborted) {
            log.warn(`[IMAP] searchEmails: fetch aborted due to timeout for account ${accountId}`);
            break;
          }
          if (!msg) {
            continue;
          }
          const email = this.parseMessage(msg as FetchMessageObject, folder);
          if (email) {
            emails.push(email);
          }
        }
      } finally {
        clearTimeout(timeout);
      }

      log.info(`[IMAP] searchEmails: fetched ${emails.length} emails for account ${accountId}`);
      return emails;
    } finally {
      lock.release();
    }
  }

  /**
   * Set flags on messages.
   */
  async setFlags(
    accountId: string,
    folder: string,
    uids: number[],
    flags: { read?: boolean; starred?: boolean }
  ): Promise<void> {
    const client = await this.connect(accountId);
    const lock = await client.getMailboxLock(folder);
    try {
      const uidRange = uids.join(',');

      if (flags.read !== undefined) {
        if (flags.read) {
          await client.messageFlagsAdd(uidRange, ['\\Seen'], { uid: true });
        } else {
          await client.messageFlagsRemove(uidRange, ['\\Seen'], { uid: true });
        }
      }

      if (flags.starred !== undefined) {
        if (flags.starred) {
          await client.messageFlagsAdd(uidRange, ['\\Flagged'], { uid: true });
        } else {
          await client.messageFlagsRemove(uidRange, ['\\Flagged'], { uid: true });
        }
      }
    } finally {
      lock.release();
    }
  }

  /**
   * Move messages to another folder.
   */
  async moveMessages(
    accountId: string,
    sourceFolder: string,
    uids: number[],
    targetFolder: string
  ): Promise<void> {
    const client = await this.connect(accountId);
    const lock = await client.getMailboxLock(sourceFolder);
    try {
      const uidRange = uids.join(',');
      await client.messageMove(uidRange, targetFolder, { uid: true });
    } finally {
      lock.release();
    }
  }

  /**
   * Copy messages (by UID) from a source folder to a target folder.
   * Used for Gmail label assignment — COPY places the message in the target label without
   * removing it from the source folder.
   */
  async copyMessages(
    accountId: string,
    sourceFolder: string,
    uids: number[],
    targetFolder: string
  ): Promise<void> {
    const client = await this.connect(accountId);
    const lock = await client.getMailboxLock(sourceFolder);
    try {
      const uidRange = uids.join(',');
      await client.messageCopy(uidRange, targetFolder, { uid: true });
      log.info(`[IMAP] Copied ${uids.length} message(s) from ${sourceFolder} to ${targetFolder} for account ${accountId}`);
    } finally {
      lock.release();
    }
  }

  /**
   * Remove messages from a label folder via STORE \Deleted + EXPUNGE.
   * In Gmail IMAP, this removes the label without deleting the message (which stays in All Mail).
   */
  async removeFromLabel(
    accountId: string,
    labelFolder: string,
    uids: number[]
  ): Promise<void> {
    const client = await this.connect(accountId);
    const lock = await client.getMailboxLock(labelFolder);
    try {
      const uidRange = uids.join(',');
      await client.messageFlagsAdd(uidRange, ['\\Deleted'], { uid: true });
      await client.messageDelete(uidRange, { uid: true });
      log.info(`[IMAP] Removed label "${labelFolder}" from ${uids.length} message(s) for account ${accountId}`);
    } finally {
      lock.release();
    }
  }

  /**
   * Create a dedicated (non-pooled) IMAP connection for the given account.
   * The connection is NOT registered in the shared connections pool — the caller
   * owns the connection lifecycle (connect, error handling, logout).
   * Used by ImapCrawlService for the full-mailbox vector indexing pipeline.
   */
  async createDedicatedConnection(accountId: string): Promise<ImapFlow> {
    const oauthService = OAuthService.getInstance();
    const db = DatabaseService.getInstance();
    const account = db.getAccountById(Number(accountId));

    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }

    const accessToken = await oauthService.getAccessToken(accountId);

    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: account.email,
        accessToken: accessToken,
      },
      logger: {
        debug: (msg: unknown) => log.debug(`[IMAP-CRAWL ${accountId}]`, msg),
        info: (msg: unknown) => log.info(`[IMAP-CRAWL ${accountId}]`, msg),
        warn: (msg: unknown) => log.warn(`[IMAP-CRAWL ${accountId}]`, msg),
        error: (msg: unknown) => log.error(`[IMAP-CRAWL ${accountId}]`, msg),
      },
      emitLogs: false,
    });

    await client.connect();
    log.info(`[IMAP] Dedicated crawl connection established for account ${accountId} (${account.email})`);
    return client;
  }

  /**
   * Create a dedicated IMAP connection for IDLE (separate from shared pool).
   */
  async connectIdle(accountId: string): Promise<ImapFlow> {
    // Tear down existing IDLE connection if any
    await this.disconnectIdle(accountId);

    const oauthService = OAuthService.getInstance();
    const db = DatabaseService.getInstance();
    const account = db.getAccountById(Number(accountId));

    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }

    const accessToken = await oauthService.getAccessToken(accountId);

    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: account.email,
        accessToken: accessToken,
      },
      logger: {
        debug: (msg: unknown) => log.debug(`[IMAP-IDLE ${accountId}]`, msg),
        info: (msg: unknown) => log.info(`[IMAP-IDLE ${accountId}]`, msg),
        warn: (msg: unknown) => log.warn(`[IMAP-IDLE ${accountId}]`, msg),
        error: (msg: unknown) => log.error(`[IMAP-IDLE ${accountId}]`, msg),
      },
      emitLogs: false,
    });

    // Handle close/error — clean up from idleConnections map
    client.on('close', () => {
      log.info(`IDLE connection closed for account ${accountId}`);
      this.idleConnections.delete(accountId);
      this.idleMailboxLocks.delete(accountId);
    });

    client.on('error', (err: Error) => {
      log.error(`IDLE connection error for account ${accountId}:`, err);
      this.idleConnections.delete(accountId);
      this.idleMailboxLocks.delete(accountId);
    });

    await client.connect();
    this.idleConnections.set(accountId, client);
    log.info(`IDLE connection established for account ${accountId} (${account.email})`);

    return client;
  }

  /**
   * Disconnect the IDLE connection for an account.
   */
  async disconnectIdle(accountId: string): Promise<void> {
    const lock = this.idleMailboxLocks.get(accountId);
    if (lock) {
      try {
        lock.release();
      } catch {
        // Ignore release errors
      }
      this.idleMailboxLocks.delete(accountId);
    }

    const client = this.idleConnections.get(accountId);
    if (client) {
      try {
        await client.logout();
      } catch {
        // Ignore logout errors
      }
      this.idleConnections.delete(accountId);
    }
  }

  /**
   * Start IDLE on a folder using a dedicated connection.
   * The mailbox lock is intentionally held (keeps mailbox selected for IDLE).
   * Returns callbacks for connection lifecycle events.
   */
  async startIdle(
    accountId: string,
    folder: string,
    onNewMail: () => void,
    onClose?: () => void,
    onError?: (err: Error) => void,
  ): Promise<void> {
    const client = await this.connectIdle(accountId);
    const lock = await client.getMailboxLock(folder);
    this.idleMailboxLocks.set(accountId, lock as { release: () => void });

    client.on('exists', (event: { path?: string; count?: number; prevCount?: number }) => {
      const path = event.path ?? folder;
      const count = Number(event.count ?? 0);
      const prevCount = Number(event.prevCount ?? 0);

      if (path !== folder) {
        return;
      }

      if (count <= prevCount) {
        log.debug(`[IDLE] EXISTS non-growth event on ${folder} for account ${accountId}: prev=${prevCount}, now=${count}`);
        return;
      }

      log.info(`[IDLE] New message detected in ${folder} for account ${accountId} (exists ${prevCount} -> ${count})`);
      onNewMail();
    });

    // Re-wire close/error to also call the provided callbacks
    if (onClose) {
      client.on('close', () => onClose());
    }
    if (onError) {
      client.on('error', (err: Error) => onError(err));
    }

    // The lock keeps the mailbox open for IDLE.
    // We intentionally do NOT release the lock here — it stays open.
    log.info(`[IDLE] Started on ${folder} for account ${accountId}`);
  }

  /**
   * Delete messages by UID from a folder by moving them to the account's trash folder.
   * This is a soft-delete — messages remain in Trash for 30 days before
   * Gmail automatically removes them. IMAP EXPUNGE is never performed here;
   * permanent deletion is not supported via this method.
   */
  async deleteMessages(
    accountId: string,
    folder: string,
    uids: number[],
    trashFolder: string,
  ): Promise<void> {
    const client = await this.connect(accountId);
    const lock = await client.getMailboxLock(folder);
    try {
      const uidRange = uids.join(',');
      // Move to Trash (soft-delete only)
      await client.messageMove(uidRange, trashFolder, { uid: true });
      log.info(`Moved ${uids.length} message(s) from ${folder} to ${trashFolder} for account ${accountId}`);
    } finally {
      lock.release();
    }
  }

  // ---- X-GM-MSGID Resolution ----

  /**
   * Resolve UIDs for multiple X-GM-MSGID values in a specific folder.
   * Uses IMAP SEARCH with emailId (X-GM-MSGID) for each message.
   * Returns a Map of X-GM-MSGID → UID (only entries where UID was found).
   */
  async resolveUidsByXGmMsgId(
    accountId: string,
    folder: string,
    xGmMsgIds: string[]
  ): Promise<Map<string, number>> {
    const client = await this.connect(accountId);
    const result = new Map<string, number>();

    const lock = await client.getMailboxLock(folder);
    try {
      for (const xGmMsgId of xGmMsgIds) {
        try {
          const searchResult = await client.search(
            { emailId: xGmMsgId } as Record<string, unknown>,
            { uid: true }
          ) as number[] | false;

          if (searchResult && searchResult.length > 0) {
            result.set(xGmMsgId, searchResult[0]);
          }
        } catch (err) {
          log.warn(`[IMAP] resolveUidsByXGmMsgId: failed to resolve ${xGmMsgId} in ${folder}:`, err);
        }
      }
    } finally {
      lock.release();
    }

    return result;
  }

  // ---- CONDSTORE ----

  /**
   * Fetch emails changed since a given modseq value using CONDSTORE.
   * Returns fetched emails plus mailbox metadata.
   */
  async fetchChangedSince(
    accountId: string,
    folder: string,
    changedSince: string,
  ): Promise<{
    emails: FetchedEmail[];
    highestModseq: string;
    uidValidity: string;
    noModseq: boolean;
  }> {
    const client = await this.connect(accountId);

    const lock = await client.getMailboxLock(folder);
    try {
      const emails: FetchedEmail[] = [];

      // Use changedSince option with UID FETCH
      const changedSinceBigInt = BigInt(changedSince);
      for await (const msg of client.fetch('1:*', {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true,
        headers: true,
        source: false,
        labels: true,
        threadId: true,
        emailId: true,
        size: true,
      } as any, { uid: true, changedSince: changedSinceBigInt })) {
        if (!msg) continue;
        const email = this.parseMessage(msg as FetchMessageObject, folder);
        if (email) {
          emails.push(email);
        }
      }

      const mailbox = client.mailbox as { highestModseq?: bigint; uidValidity?: bigint; noModseq?: boolean };
      return {
        emails,
        highestModseq: String(mailbox.highestModseq ?? '0'),
        uidValidity: String(mailbox.uidValidity ?? '0'),
        noModseq: mailbox.noModseq ?? false,
      };
    } finally {
      lock.release();
    }
  }

  /**
   * Lightweight mailbox status: get highestModseq and uidValidity without fetching messages.
   */
  async getMailboxStatus(
    accountId: string,
    folder: string
  ): Promise<{ highestModseq: string; uidValidity: string; messages: number; condstoreSupported: boolean }> {
    const client = await this.connect(accountId);
    const status = await client.status(folder, {
      messages: true,
      uidValidity: true,
      highestModseq: true,
    });
    const condstoreSupported = status.highestModseq != null;
    return {
      highestModseq: String(status.highestModseq ?? '0'),
      uidValidity: String(status.uidValidity ?? '0'),
      messages: status.messages ?? 0,
      condstoreSupported,
    };
  }

  // ---- Draft helpers ----

  /**
   * Append a raw RFC822 message to [Gmail]/Drafts with the \Draft flag.
   * Returns the UID assigned by the server (null if server did not return UID, e.g. no UIDPLUS)
   * and the mailbox UIDVALIDITY.
   */
  async appendDraft(
    accountId: string,
    rawMessage: Buffer
  ): Promise<{ uid: number | null; uidValidity: number }> {
    const client = await this.connect(accountId);
    const folder = '[Gmail]/Drafts';
    const lock = await client.getMailboxLock(folder);
    try {
      const result = await client.append(folder, rawMessage, ['\\Draft', '\\Seen']);
      const raw = result as { uid?: number; destination?: string; uidValidity?: bigint };
      const uid = raw.uid && raw.uid > 0 ? raw.uid : null;
      if (uid === null) {
        log.warn(
          `Draft appended to ${folder} for account ${accountId} but server did not return UID (UIDPLUS?). ` +
          'Deletions/updates of this draft on the server will not be possible.'
        );
      }
      const uidValidity = Number(
        raw.uidValidity ||
        (client.mailbox as { uidValidity?: bigint })?.uidValidity ||
        0
      );
      log.info(`Draft appended to ${folder} for account ${accountId}: uid=${uid ?? 'none'}, uidValidity=${uidValidity}`);
      return { uid, uidValidity };
    } finally {
      lock.release();
    }
  }

  /**
   * Delete a message by UID from a folder (used to remove old draft before re-appending).
   * If storedUidValidity is provided and does not match the current mailbox UIDVALIDITY,
   * deletion is skipped to avoid targeting the wrong message after a UIDVALIDITY reset.
   */
  async deleteDraftByUid(
    accountId: string,
    folder: string,
    uid: number,
    storedUidValidity?: number | null
  ): Promise<void> {
    const client = await this.connect(accountId);
    const lock = await client.getMailboxLock(folder);
    try {
      if (storedUidValidity != null) {
        const current = Number((client.mailbox as { uidValidity?: bigint })?.uidValidity ?? 0);
        if (current !== storedUidValidity) {
          log.warn(
            `Skipping delete of uid=${uid} in ${folder}: UIDVALIDITY mismatch (stored=${storedUidValidity}, current=${current}). ` +
            'Mailbox may have been recreated; stored UID could refer to a different message.'
          );
          return;
        }
      }
      await client.messageDelete(String(uid), { uid: true });
      log.info(`Deleted message uid=${uid} from ${folder} for account ${accountId}`);
    } finally {
      lock.release();
    }
  }

  // ---- Private parse helpers ----

  private parseMessage(msg: FetchMessageObject, folder: string): FetchedEmail | null {
    try {
      const envelope = msg.envelope;
      if (!envelope) return null;

      const flags = msg.flags ? Array.from(msg.flags) : [];
      const labels = msg.labels ? Array.from(msg.labels) : [];

      const from = envelope.from?.[0];
      const fromAddress = from?.address || '';
      const fromName = from?.name || fromAddress;

      const toAddresses = (envelope.to || [])
        .map(recipient => formatParticipant(recipient.address || '', recipient.name))
        .filter(Boolean)
        .join(', ');
      const ccAddresses = (envelope.cc || []).map(a => a.address || '').filter(Boolean).join(', ');
      const bccAddresses = (envelope.bcc || []).map(a => a.address || '').filter(Boolean).join(', ');

      const hasAttachments = this.checkHasAttachments(msg.bodyStructure);
      const subject = envelope.subject || '(no subject)';
      const snippet = subject.substring(0, 100);

      // X-GM-MSGID: ImapFlow maps Gmail's X-GM-MSGID to msg.emailId (string).
      // This is the primary message identifier.
      const xGmMsgId = (msg as unknown as { emailId?: string }).emailId || '';

      // X-GM-THRID: ImapFlow maps Gmail's X-GM-THRID to msg.threadId (string).
      const xGmThrid = msg.threadId || '';

      // RFC 5322 Message-ID: still needed for compose (In-Reply-To/References).
      // Fall back to raw headers parse, then to empty string for malformed messages.
      let messageId = (envelope.messageId ?? '').trim();
      if (messageId) {
        const angleMatch = messageId.match(/<[^>]+>/);
        if (angleMatch) {
          messageId = angleMatch[0];
        }
      }
      if (!messageId && msg.headers) {
        messageId = this.parseMessageIdFromHeaders(msg.headers);
      }

      // Extract modseq if present (CONDSTORE)
      const modseq = (msg as unknown as { modseq?: bigint }).modseq;
      const modseqStr = modseq != null ? String(modseq) : undefined;

      // If xGmMsgId is empty, fall back to message_id or uid for identification
      const effectiveXGmMsgId = xGmMsgId || messageId || String(msg.uid);

      return {
        uid: msg.uid,
        xGmMsgId: effectiveXGmMsgId,
        xGmThrid: xGmThrid,
        messageId,
        folder,
        fromAddress,
        fromName,
        toAddresses,
        ccAddresses,
        bccAddresses,
        subject,
        textBody: '',
        htmlBody: '',
        date: envelope.date?.toISOString() || new Date().toISOString(),
        isRead: flags.includes('\\Seen'),
        isStarred: flags.includes('\\Flagged'),
        isImportant: labels.includes('\\Important'),
        isDraft: flags.includes('\\Draft'),
        snippet,
        size: msg.size || 0,
        hasAttachments,
        labels: labels.join(','),
        rawLabels: labels,
        modseq: modseqStr,
      };
    } catch (err) {
      log.warn('Failed to parse message:', err);
      return null;
    }
  }

  private checkHasAttachments(bodyStructure: unknown): boolean {
    if (!bodyStructure) return false;
    const bs = bodyStructure as Record<string, unknown>;

    if (bs.disposition === 'attachment') return true;

    const childNodes = bs.childNodes as unknown[] | undefined;
    if (childNodes && Array.isArray(childNodes)) {
      for (const child of childNodes) {
        if (this.checkHasAttachments(child)) return true;
      }
    }

    return false;
  }

  /**
   * Extract Message-ID from raw headers buffer when envelope.messageId is missing.
   * Handles RFC 5322 folded headers by unfolding first, then extracting the <...> token.
   */
  private parseMessageIdFromHeaders(headers: Buffer | string): string {
    try {
      let headerStr = typeof headers === 'string' ? headers : headers.toString('utf-8');
      // Unfold headers: CRLF followed by whitespace is a continuation
      headerStr = headerStr.replace(/\r?\n[ \t]+/g, ' ');
      const match = headerStr.match(/^Message-ID:\s*(.+)/im);
      if (match) {
        const value = match[1].trim();
        // Extract the <...> token (standard Message-ID format)
        const angleMatch = value.match(/<[^>]+>/);
        if (angleMatch) {
          return angleMatch[0];
        }
        // If no angle brackets, use the raw value (non-standard but possible)
        return value;
      }
    } catch {
      // Ignore parse errors
    }
    return '';
  }

}
