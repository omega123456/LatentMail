/**
 * ImapCrawlService — dedicated IMAP connection manager for the full-mailbox
 * vector indexing pipeline and on-demand search result resolution.
 *
 * Manages one dedicated ImapFlow connection per account (separate from the
 * shared pool in ImapService). Connection lifecycle is tied to the build
 * lifecycle: connected at build start, disconnected at build end or cancel.
 *
 * The existing FolderLockManager is NOT used here — each crawl connection
 * operates on its own ImapFlow client, so there is no contention with the
 * shared pool.
 */

import { ImapFlow, FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { LoggerService } from './logger-service';
import { ImapService } from './imap-service';

const log = LoggerService.getInstance();

const ALL_MAIL_PATH = '[Gmail]/All Mail';

// ---- Types ----

/** Parsed email result from a full-body IMAP crawl fetch. */
export interface CrawlFetchResult {
  /** Gmail X-GM-MSGID (globally unique, string form). */
  xGmMsgId: string;
  /** Gmail X-GM-THRID (thread identifier, string form). */
  xGmThrid: string;
  /** RFC 5322 Message-ID. */
  messageId: string;
  subject: string;
  /** Plain-text body parsed by simpleParser (empty string if not present). */
  textBody: string;
  /** HTML body parsed by simpleParser (empty string if not present). */
  htmlBody: string;
  /** Raw Gmail labels as folder paths (e.g. '[Gmail]/Spam', '\Important'). */
  rawLabels: string[];
  fromAddress: string;
  fromName: string;
  /** Comma-separated list of TO addresses. */
  toAddresses: string;
  /** ISO 8601 date string. */
  date: string;
  isRead: boolean;
  isStarred: boolean;
  isDraft: boolean;
  size: number;
}

// ---- Service ----

export class ImapCrawlService {
  private static instance: ImapCrawlService;
  /** Per-account dedicated crawl connections (separate from ImapService's pool). */
  private connections: Map<string, ImapFlow> = new Map();

  private constructor() {}

  static getInstance(): ImapCrawlService {
    if (!ImapCrawlService.instance) {
      ImapCrawlService.instance = new ImapCrawlService();
    }
    return ImapCrawlService.instance;
  }

  // ---- Connection lifecycle ----

  /**
   * Open a dedicated IMAP connection for an account.
   * Delegates connection creation to ImapService.createDedicatedConnection()
   * to avoid duplicating OAuth and ImapFlow configuration logic.
   */
  async connect(accountId: string): Promise<void> {
    const imapService = ImapService.getInstance();
    const client = await imapService.createDedicatedConnection(accountId);

    // Register error/close handlers so we clean up the connection map
    client.on('close', () => {
      log.info(`[ImapCrawlService] Connection closed for account ${accountId}`);
      this.connections.delete(accountId);
    });

    client.on('error', (err: Error) => {
      log.warn(`[ImapCrawlService] Connection error for account ${accountId}:`, err);
      this.connections.delete(accountId);
    });

    this.connections.set(accountId, client);
    log.info(`[ImapCrawlService] Connected for account ${accountId}`);
  }

  /**
   * Close the dedicated connection for an account and remove it from the map.
   */
  async disconnect(accountId: string): Promise<void> {
    const client = this.connections.get(accountId);
    if (client) {
      this.connections.delete(accountId);
      try {
        await client.logout();
      } catch {
        // Ignore logout errors (connection may already be gone)
      }
      log.info(`[ImapCrawlService] Disconnected for account ${accountId}`);
    }
  }

  /**
   * Disconnect and reconnect (gets a fresh OAuth token via createDedicatedConnection).
   * Used for reconnect-and-resume on IMAP connection failures during a build.
   */
  async reconnect(accountId: string): Promise<void> {
    await this.disconnect(accountId);
    await this.connect(accountId);
    log.info(`[ImapCrawlService] Reconnected for account ${accountId}`);
  }

  /** Whether there is an active connection for the given account. */
  isConnected(accountId: string): boolean {
    const client = this.connections.get(accountId);
    return client != null && client.usable;
  }

  // ---- Crawl operations ----

  /**
   * Run SEARCH ALL on [Gmail]/All Mail and return all UIDs.
   * UIDs are specific to the All Mail mailbox and may differ from UIDs
   * in other folders. Returns an empty array if the mailbox is empty.
   */
  async searchAllUids(accountId: string): Promise<number[]> {
    const client = this.getConnection(accountId);
    const lock = await client.getMailboxLock(ALL_MAIL_PATH);
    try {
      const result = await client.search({ all: true }, { uid: true }) as number[] | false;
      if (!result || result.length === 0) {
        return [];
      }
      return Array.from(result);
    } finally {
      lock.release();
    }
  }

  /**
   * Fetch a batch of emails from [Gmail]/All Mail by UID.
   * Fetches full source (body), parses via simpleParser, and returns structured results.
   * Any UIDs that fail to parse are silently skipped (logged at debug level).
   *
   * @param accountId - Account to fetch from
   * @param uids - Array of IMAP UIDs to fetch (from All Mail SEARCH ALL results)
   * @returns Array of parsed results (may be shorter than `uids` if some fail to parse)
   */
  async fetchBatch(accountId: string, uids: number[]): Promise<CrawlFetchResult[]> {
    if (uids.length === 0) {
      return [];
    }

    const client = this.getConnection(accountId);
    const uidRange = uids.join(',');
    const results: CrawlFetchResult[] = [];

    const lock = await client.getMailboxLock(ALL_MAIL_PATH);
    try {
      for await (const msg of client.fetch(uidRange, {
        uid: true,
        envelope: true,
        flags: true,
        source: true,
        labels: true,
        threadId: true,
        emailId: true,
        size: true,
      } as any, { uid: true })) {
        if (!msg) {
          continue;
        }
        try {
          const parsed = await this.parseMessageWithBody(msg as FetchMessageObject);
          if (parsed) {
            results.push(parsed);
          }
        } catch (err) {
          log.debug(`[ImapCrawlService] Failed to parse message uid=${msg.uid}:`, err);
        }
      }
    } finally {
      lock.release();
    }

    return results;
  }

  /**
   * Fetch envelope metadata (no body) for a list of X-GM-MSGID values.
   * Used by SemanticSearchService to resolve search results that are not in the local DB.
   *
   * Opens a temporary dedicated connection if none is active, fetches, then closes it.
   * Silently skips any xGmMsgIds that cannot be resolved on IMAP.
   *
   * @param accountId - Account to fetch from
   * @param xGmMsgIds - List of Gmail message IDs to resolve
   * @returns Array of envelope results (may be shorter than xGmMsgIds if some are unfetchable)
   */
  async fetchEnvelopes(accountId: string, xGmMsgIds: string[]): Promise<CrawlFetchResult[]> {
    if (xGmMsgIds.length === 0) {
      return [];
    }

    // Open a temporary connection if none is active for this account.
    // Set ownsConnection only AFTER connect() succeeds so the finally block
    // doesn't attempt to disconnect a connection that was never established.
    let ownsConnection = false;
    if (!this.connections.has(accountId)) {
      await this.connect(accountId);
      ownsConnection = true;
    }

    const results: CrawlFetchResult[] = [];
    try {
      const client = this.getConnection(accountId);
      const lock = await client.getMailboxLock(ALL_MAIL_PATH);
      try {
        // Resolve each xGmMsgId to a UID via SEARCH emailId
        const resolvedUids: number[] = [];
        for (const xGmMsgId of xGmMsgIds) {
          try {
            const searchResult = await client.search(
              { emailId: xGmMsgId } as Record<string, unknown>,
              { uid: true }
            ) as number[] | false;

            if (searchResult && searchResult.length > 0) {
              resolvedUids.push(searchResult[0]);
            } else {
              log.debug(`[ImapCrawlService] fetchEnvelopes: could not resolve xGmMsgId ${xGmMsgId}`);
            }
          } catch (err) {
            log.debug(`[ImapCrawlService] fetchEnvelopes: error resolving ${xGmMsgId}:`, err);
          }
        }

        if (resolvedUids.length === 0) {
          return [];
        }

        const uidRange = resolvedUids.join(',');
        for await (const msg of client.fetch(uidRange, {
          uid: true,
          envelope: true,
          flags: true,
          source: false,
          labels: true,
          threadId: true,
          emailId: true,
          size: true,
        } as any, { uid: true })) {
          if (!msg) {
            continue;
          }
          try {
            const envelope = this.parseEnvelopeOnly(msg as FetchMessageObject);
            if (envelope) {
              results.push(envelope);
            }
          } catch (err) {
            log.debug(`[ImapCrawlService] fetchEnvelopes: failed to parse envelope:`, err);
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      if (ownsConnection) {
        await this.disconnect(accountId);
      }
    }

    return results;
  }

  // ---- Private helpers ----

  /** Get the active connection or throw if not connected. */
  private getConnection(accountId: string): ImapFlow {
    const client = this.connections.get(accountId);
    if (!client) {
      throw new Error(`[ImapCrawlService] No active crawl connection for account ${accountId}`);
    }
    return client;
  }

  /**
   * Parse an ImapFlow message object that includes source (full body).
   * Uses simpleParser to extract text and HTML bodies.
   * Returns null if the message cannot be parsed (e.g. missing envelope or xGmMsgId).
   */
  private async parseMessageWithBody(msg: FetchMessageObject): Promise<CrawlFetchResult | null> {
    const envelope = msg.envelope;
    if (!envelope) {
      return null;
    }

    const xGmMsgId = (msg as unknown as { emailId?: string }).emailId || '';
    if (!xGmMsgId) {
      return null;
    }

    const flags = msg.flags ? Array.from(msg.flags) : [];
    const labels = msg.labels ? Array.from(msg.labels) : [];
    const xGmThrid = msg.threadId || '';

    let messageId = (envelope.messageId ?? '').trim();
    if (messageId) {
      const angleMatch = messageId.match(/<[^>]+>/);
      if (angleMatch) {
        messageId = angleMatch[0];
      }
    }

    const from = envelope.from?.[0];
    const fromAddress = from?.address || '';
    const fromName = from?.name || fromAddress;
    const toAddresses = (envelope.to || [])
      .map((recipient) => recipient.address || '')
      .filter(Boolean)
      .join(', ');

    let textBody = '';
    let htmlBody = '';

    if (msg.source) {
      try {
        const sourceBuffer = Buffer.isBuffer(msg.source)
          ? msg.source
          : Buffer.from(msg.source);
        const parsed = await simpleParser(sourceBuffer);
        textBody = (parsed.text || '').trim();
        htmlBody = (parsed.html || '').trim();
      } catch (err) {
        log.debug(`[ImapCrawlService] simpleParser error for ${xGmMsgId}:`, err);
        // Keep empty textBody/htmlBody — email may still be indexed by subject
      }
    }

    return {
      xGmMsgId,
      xGmThrid,
      messageId,
      subject: envelope.subject || '(no subject)',
      textBody,
      htmlBody,
      rawLabels: labels,
      fromAddress,
      fromName,
      toAddresses,
      date: envelope.date?.toISOString() || new Date().toISOString(),
      isRead: flags.includes('\\Seen'),
      isStarred: flags.includes('\\Flagged'),
      isDraft: flags.includes('\\Draft'),
      size: msg.size || 0,
    };
  }

  /**
   * Parse an ImapFlow message object that was fetched without source (envelope only).
   * Returns null if the message cannot be parsed.
   */
  private parseEnvelopeOnly(msg: FetchMessageObject): CrawlFetchResult | null {
    const envelope = msg.envelope;
    if (!envelope) {
      return null;
    }

    const xGmMsgId = (msg as unknown as { emailId?: string }).emailId || '';
    if (!xGmMsgId) {
      return null;
    }

    const flags = msg.flags ? Array.from(msg.flags) : [];
    const labels = msg.labels ? Array.from(msg.labels) : [];
    const xGmThrid = msg.threadId || '';

    let messageId = (envelope.messageId ?? '').trim();
    if (messageId) {
      const angleMatch = messageId.match(/<[^>]+>/);
      if (angleMatch) {
        messageId = angleMatch[0];
      }
    }

    const from = envelope.from?.[0];
    const fromAddress = from?.address || '';
    const fromName = from?.name || fromAddress;
    const toAddresses = (envelope.to || [])
      .map((recipient) => recipient.address || '')
      .filter(Boolean)
      .join(', ');

    return {
      xGmMsgId,
      xGmThrid,
      messageId,
      subject: envelope.subject || '(no subject)',
      textBody: '',
      htmlBody: '',
      rawLabels: labels,
      fromAddress,
      fromName,
      toAddresses,
      date: envelope.date?.toISOString() || new Date().toISOString(),
      isRead: flags.includes('\\Seen'),
      isStarred: flags.includes('\\Flagged'),
      isDraft: flags.includes('\\Draft'),
      size: msg.size || 0,
    };
  }
}
