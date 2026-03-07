/**
 * KeywordSearchService — streams keyword search results (local DB then IMAP)
 * using the same onBatch callback pattern as SemanticSearchService.
 *
 * Flow:
 * 1. Build a Gmail query string, optionally enriched by Ollama intent extraction.
 *    If Ollama is unavailable or extraction fails, the user's raw query is used as-is.
 * 2. Apply standard folder exclusions (trash, spam, drafts) via buildGmRawWithExclusions.
 * 3. Run a local DB search and emit the results as the 'local' phase batch.
 * 4. If local results reach MAX_RESULTS, skip IMAP entirely.
 * 5. Acquire the folder lock and run an IMAP search against [Gmail]/All Mail.
 *    Upsert fetched emails and threads into the local DB, then emit net-new
 *    message IDs (not already in the local batch) as the 'imap' phase batch.
 */

import { BaseSearchService, SearchBatchCallback } from './base-search-service';
import { DateTime } from 'luxon';
import { LoggerService } from './logger-service';
import { DatabaseService } from './database-service';
import { ImapService, FetchedEmail } from './imap-service';
import { OllamaService } from './ollama-service';
import { FolderLockManager } from './folder-lock-manager';
import { SearchIntent, SearchQueryGenerator } from '../utils/search-query-generator';
import { formatParticipantList } from '../utils/format-participant';
import { SearchOptions } from './search-options';

const log = LoggerService.getInstance();

export class KeywordSearchService extends BaseSearchService {
  private static instance: KeywordSearchService;

  protected constructor() {
    super();
  }

  static getInstance(): KeywordSearchService {
    if (!KeywordSearchService.instance) {
      KeywordSearchService.instance = new KeywordSearchService();
    }
    return KeywordSearchService.instance;
  }

  /**
   * Run a keyword search for the given natural language query and deliver results
   * incrementally via the onBatch callback.
   *
   * Emits at least one 'local' batch (possibly empty) before any IMAP work begins,
   * then emits one 'imap' batch with net-new results (or an empty array if IMAP fails).
   *
   * @param options - Search options including naturalQuery, accountId, userEmail, todayDate,
   *                  folders, and onBatch callback.
   * @returns 'complete' if all phases succeeded, 'partial' if local results were emitted
   *          but the IMAP phase failed, 'error' if the search failed entirely
   */
  async search(options: SearchOptions): Promise<'complete' | 'partial' | 'error'> {
    const { naturalQuery = '', accountId = 0, userEmail = '', todayDate = '', folders = [], onBatch } = options;
    if (!onBatch) {
      log.warn('[KeywordSearch] search called without onBatch callback');
      return 'error';
    }
    try {
      // ----- Step 1: Build Gmail query string -----
      // Use Ollama to extract structured search intent when available;
      // fall back to the raw query if Ollama is offline or intent extraction fails.
      const ollama = OllamaService.getInstance();
      const ollamaStatus = ollama.getStatus();
      let combinedQuery: string;

      if (ollamaStatus.connected && ollamaStatus.currentModel) {
        try {
          const intent: SearchIntent = await ollama.extractSearchIntent(
            naturalQuery,
            userEmail,
            todayDate,
            folders
          );
          const queries = SearchQueryGenerator.generate(intent);

          if (queries.length > 1) {
            combinedQuery = queries.map((query) => `(${query})`).join(' OR ');
          } else if (queries.length === 1) {
            combinedQuery = queries[0];
          } else {
            // Generator returned no variants — fall back to raw query.
            combinedQuery = naturalQuery;
          }

          log.info('[KeywordSearch] Built query from Ollama intent:', combinedQuery);
        } catch (intentError) {
          log.warn('[KeywordSearch] Ollama intent extraction failed, using raw query:', intentError);
          combinedQuery = naturalQuery;
        }
      } else {
        combinedQuery = naturalQuery;
        log.info('[KeywordSearch] Ollama unavailable, using raw query:', combinedQuery);
      }

      // ----- Step 2: Apply standard folder exclusions -----
      const gmRaw = this.buildGmRawWithExclusions(combinedQuery);

      // ----- Step 3: Local phase -----
      const localMsgIds = this.runLocalSearchByGmailQuery(accountId, gmRaw, this.MAX_RESULTS);
      const sortedLocalMsgIds = this.sortByDate(accountId, localMsgIds);

      log.info(`[KeywordSearch] Local phase: ${sortedLocalMsgIds.length} result(s)`);
      onBatch(sortedLocalMsgIds, 'local');

      // Cap check — if local results already hit the maximum, skip IMAP entirely.
      if (localMsgIds.length >= this.MAX_RESULTS) {
        log.info('[KeywordSearch] Local results hit cap — skipping IMAP phase');
        return 'complete';
      }

      // ----- Step 4: IMAP phase -----
      try {
        const imapService = ImapService.getInstance();
        const lockManager = FolderLockManager.getInstance();
        const db = DatabaseService.getInstance();
        const numAccountId = accountId;

        log.info('[KeywordSearch] IMAP phase: acquiring folder lock and searching');

        const release = await lockManager.acquire(this.ALL_MAIL_PATH, accountId);
        let emails: FetchedEmail[];
        try {
          const searchPromise = imapService.searchEmails(String(accountId), gmRaw, 100);
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('IMAP search timed out')), 30_000)
          );
          emails = await Promise.race([searchPromise, timeoutPromise]);
        } finally {
          release();
        }

        log.info(`[KeywordSearch] IMAP phase: received ${emails.length} email(s)`);

        if (emails.length === 0) {
          onBatch([], 'imap');
          return 'complete';
        }

        // Group emails by thread ID for thread upsert.
        const threadMap = new Map<string, FetchedEmail[]>();
        for (const email of emails) {
          const threadId = email.xGmThrid || email.xGmMsgId;
          if (!threadMap.has(threadId)) {
            threadMap.set(threadId, []);
          }
          threadMap.get(threadId)!.push(email);
        }

        // Upsert all fetched emails and threads in a single transaction.
        const rawDb = db.getDatabase();
        rawDb.transaction(() => {
          for (const email of emails) {
            db.upsertEmail({
              accountId: numAccountId,
              xGmMsgId: email.xGmMsgId,
              xGmThrid: email.xGmThrid,
              folder: this.ALL_MAIL_PATH,
              folderUid: email.uid,
              fromAddress: email.fromAddress,
              fromName: email.fromName,
              toAddresses: email.toAddresses,
              ccAddresses: email.ccAddresses,
              bccAddresses: email.bccAddresses,
              subject: email.subject,
              textBody: email.textBody,
              htmlBody: email.htmlBody,
              date: email.date,
              isRead: email.isRead,
              isStarred: email.isStarred,
              isImportant: email.isImportant,
              isDraft: email.isDraft,
              snippet: email.snippet,
              size: email.size,
              hasAttachments: email.hasAttachments,
              labels: email.labels,
              messageId: email.messageId,
            });

            if (email.fromAddress) {
              db.upsertContact(email.fromAddress, email.fromName);
            }
          }

          for (const [threadId, threadEmails] of threadMap) {
            const uniqueEmails = [
              ...new Map(threadEmails.map((email) => [email.xGmMsgId, email])).values(),
            ];
            const latest = uniqueEmails.reduce((accumulator, current) =>
              DateTime.fromISO(accumulator.date).toMillis() > DateTime.fromISO(current.date).toMillis()
                ? accumulator
                : current
            );
            const participants = formatParticipantList(uniqueEmails);
            const allRead = uniqueEmails.every((email) => email.isRead);
            const anyStarred = uniqueEmails.some((email) => email.isStarred);

            const existingThread = db.getThreadById(numAccountId, threadId);
            const existingMessageCount = (existingThread?.['messageCount'] as number) || 0;

            if (!existingThread || uniqueEmails.length >= existingMessageCount) {
              db.upsertThread({
                accountId: numAccountId,
                xGmThrid: threadId,
                subject: latest.subject,
                lastMessageDate: latest.date,
                participants,
                messageCount: Math.max(uniqueEmails.length, existingMessageCount),
                snippet: latest.snippet,
                isRead: allRead,
                isStarred: anyStarred,
              });
            }
          }
        })();

        // Collect only the net-new message IDs (not already emitted in the local phase).
        const localMsgIdSet = new Set(localMsgIds);
        const imapMsgIds = emails
          .map((email) => email.xGmMsgId)
          .filter((msgId) => msgId && !localMsgIdSet.has(msgId));

        const sortedImapBatch = this.sortByDate(accountId, imapMsgIds);

        log.info(`[KeywordSearch] IMAP phase: emitting ${sortedImapBatch.length} net-new result(s)`);
        onBatch(sortedImapBatch, 'imap');

        return 'complete';
      } catch (imapError) {
        log.warn('[KeywordSearch] IMAP phase failed:', imapError);
        onBatch([], 'imap');
        // Local results were already emitted — this is a partial success.
        return 'partial';
      }
    } catch (fatalError) {
      log.error('[KeywordSearch] search failed:', fatalError);
      return 'error';
    }
  }
}
