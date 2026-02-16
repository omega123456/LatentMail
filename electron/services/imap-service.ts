import { ImapFlow, FetchMessageObject } from 'imapflow';
import log from 'electron-log/main';
import { simpleParser } from 'mailparser';
import { OAuthService } from './oauth-service';
import { DatabaseService } from './database-service';

interface FetchedEmail {
  uid: number;
  gmailMessageId: string;
  gmailThreadId: string;
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
  snippet: string;
  size: number;
  hasAttachments: boolean;
  labels: string;
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
        size: true,
      }, { uid: true })) {
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

      if (!msg || !msg.source) return null;

      const sourceBuffer = Buffer.isBuffer(msg.source) ? msg.source : Buffer.from(msg.source);
      const parsed = await simpleParser(sourceBuffer);
      return {
        textBody: (parsed.text || '').trim(),
        htmlBody: (parsed.html || '').trim(),
      };
    } finally {
      lock.release();
    }
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
        size: true,
      }, { uid: true });

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
          email.textBody = (parsed.text || '').trim();
          email.htmlBody = (parsed.html || '').trim();
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
   * Fetch all messages in a Gmail thread.
   */
  async fetchThread(
    accountId: string,
    gmailThreadId: string
  ): Promise<FetchedEmail[]> {
    const client = await this.connect(accountId);

    // Search across all mail for this thread ID
    const lock = await client.getMailboxLock('[Gmail]/All Mail');
    try {
      // Gmail-specific: search by thread ID using X-GM-THRID
      const searchResult = await client.search({ threadId: gmailThreadId }, { uid: true }) as number[] | false;

      if (!searchResult || searchResult.length === 0) return [];

      const uids = Array.from(searchResult);
      const emails: FetchedEmail[] = [];
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
        size: true,
      }, { uid: true })) {
        if (!msg) continue;
        const fetchMsg = msg as FetchMessageObject;
        const email = this.parseMessage(fetchMsg, '[Gmail]/All Mail');
        if (email) {
          if (fetchMsg.source) {
            try {
              const sourceBuffer = Buffer.isBuffer(fetchMsg.source)
                ? fetchMsg.source
                : Buffer.from(fetchMsg.source);
              const parsed = await simpleParser(sourceBuffer);
              email.textBody = (parsed.text || '').trim();
              email.htmlBody = (parsed.html || '').trim();
            } catch (err) {
              log.warn('Failed to parse thread message body:', err);
            }
          }
          emails.push(email);
        }
      }

      // Sort by date ascending (oldest first in thread)
      emails.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      return emails;
    } finally {
      lock.release();
    }
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
        size: true,
      }, { uid: true })) {
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
    });

    client.on('error', (err: Error) => {
      log.error(`IDLE connection error for account ${accountId}:`, err);
      this.idleConnections.delete(accountId);
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
    await client.getMailboxLock(folder);

    client.on('exists', () => {
      log.info(`[IDLE] New message detected in ${folder} for account ${accountId}`);
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
   * Delete messages by UID from a folder.
   * For Gmail, moving to Trash is done via IMAP MOVE. Permanent deletion
   * (from Trash) uses STORE \Deleted + EXPUNGE.
   *
   * @param permanent If true, uses STORE \Deleted + EXPUNGE (permanent delete).
   *                  If false, moves messages to [Gmail]/Trash.
   */
  async deleteMessages(
    accountId: string,
    folder: string,
    uids: number[],
    permanent: boolean = false,
  ): Promise<void> {
    const client = await this.connect(accountId);
    const lock = await client.getMailboxLock(folder);
    try {
      const uidRange = uids.join(',');
      if (permanent) {
        // Permanent delete: flag as deleted then expunge
        await client.messageFlagsAdd(uidRange, ['\\Deleted'], { uid: true });
        await client.messageDelete(uidRange, { uid: true });
      } else {
        // Move to Trash
        await client.messageMove(uidRange, '[Gmail]/Trash', { uid: true });
      }
      log.info(`Deleted ${uids.length} message(s) from ${folder} for account ${accountId} (permanent=${permanent})`);
    } finally {
      lock.release();
    }
  }

  // ---- Private helpers ----

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

      const toAddresses = (envelope.to || []).map(a => a.address || '').filter(Boolean).join(', ');
      const ccAddresses = (envelope.cc || []).map(a => a.address || '').filter(Boolean).join(', ');
      const bccAddresses = (envelope.bcc || []).map(a => a.address || '').filter(Boolean).join(', ');

      const hasAttachments = this.checkHasAttachments(msg.bodyStructure);
      const subject = envelope.subject || '(no subject)';
      const snippet = subject.substring(0, 100);

      // Use Message-ID header as stable identifier (same across all folders).
      // Fall back to raw headers parse, then to UID string for malformed messages.
      // Normalize to <...> format for consistency.
      let messageId = (envelope.messageId ?? '').trim();
      if (messageId) {
        // Ensure we extract just the <...> token
        const angleMatch = messageId.match(/<[^>]+>/);
        if (angleMatch) {
          messageId = angleMatch[0];
        }
      }
      if (!messageId && msg.headers) {
        messageId = this.parseMessageIdFromHeaders(msg.headers);
      }
      if (!messageId) {
        messageId = String(msg.uid);
      }

      return {
        uid: msg.uid,
        gmailMessageId: messageId,
        gmailThreadId: msg.threadId || '',
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
        snippet,
        size: msg.size || 0,
        hasAttachments,
        labels: labels.join(','),
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
