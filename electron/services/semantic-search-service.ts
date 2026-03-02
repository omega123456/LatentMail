/**
 * SemanticSearchService — orchestrates vector similarity searches for the AI search pipeline.
 *
 * Flow:
 * 1. Extract structured semantic intent via OllamaService (splits query into topic + filters)
 * 2. Embed the semantic topic query via OllamaService (single string, fast, runs on main thread)
 * 3. Run cosine similarity search via VectorDbService, filtered by account_id
 * 4. Deduplicate by x_gm_msgid (multiple chunks from the same email → keep highest score)
 * 5. Filter by similarity threshold, then sort by similarity descending.
 * 6. Filter out emails whose ONLY folder associations are Trash, Spam, or Drafts (local DB check).
 *    Un-synced emails (no email_folders rows) pass through here and are re-checked after IMAP fetch.
 * 7. Resolve and filter via filterAndResolve (batch-and-iterate):
 *    - Upfront: partition all candidates into local vs missing, SQL-filter local candidates
 *      once, pre-filter out local items that failed the SQL filter to build eligibleCandidates.
 *    - Iterative loop: each round takes a deficit-sized batch from eligibleCandidates,
 *      splits into local-confirmed (instant) and missing (single batched IMAP SEARCH
 *      with OR'd X-GM-MSGIDs + X-GM-RAW filter, then FETCH for surviving UIDs),
 *      merges confirmed results, and repeats until MAX_RESULTS are confirmed or
 *      candidates are exhausted.
 *    - Single FETCH after the loop for all IMAP-confirmed items across all rounds.
 *    - Final result preserves similarity order, then sorted by date descending for display.
 *
 * Returns empty array only when VectorDbService is unavailable, no embedding model is
 * configured, or the similarity search returns no raw results. No fallback to keyword search.
 */

import { FetchQueryObject } from 'imapflow';
import { LoggerService } from './logger-service';
import { OllamaService } from './ollama-service';
import { VectorDbService } from './vector-db-service';
import { DatabaseService } from './database-service';
import { ImapCrawlService, CrawlFetchResult } from './imap-crawl-service';
import {
  SemanticSearchFilters,
  SemanticSearchIntent,
  translateFiltersToGmailQuery,
  hasFilters,
} from '../utils/search-filter-translator';

const log = LoggerService.getInstance();

/** Minimum cosine similarity score for a result to be considered relevant. */
const SIMILARITY_THRESHOLD = 0.5;

/** Maximum number of results returned after deduplication and filtering. */
const MAX_RESULTS = 50;

/** Spam folder path (static, same across Gmail accounts). */
const SPAM_FOLDER = '[Gmail]/Spam';

/** Drafts folder path (static, same across Gmail accounts). */
const DRAFTS_FOLDER = '[Gmail]/Drafts';

/** Maximum number of results returned from vector search. */
const MAX_VECTOR_SEARCH_RESULTS = 450;

/** Mailbox path used for all IMAP resolution operations. */
const ALL_MAIL_PATH = '[Gmail]/All Mail';

export class SemanticSearchService {
  private static instance: SemanticSearchService;

  private constructor() {}

  static getInstance(): SemanticSearchService {
    if (!SemanticSearchService.instance) {
      SemanticSearchService.instance = new SemanticSearchService();
    }
    return SemanticSearchService.instance;
  }

  /**
   * Run a semantic similarity search for the given natural language query.
   *
   * Extracts structured intent (topic query + filters) from the natural language query,
   * embeds the topic query, runs vector search, then applies filterAndResolve to handle
   * both the filter and no-filter paths in a unified way.
   *
   * @param naturalQuery - The user's search query (natural language)
   * @param accountId - The account to search within
   * @param userEmail - The account's email address (for LLM context)
   * @param todayDate - Today's date as YYYY-MM-DD (for LLM relative-date resolution)
   * @param folders - List of folder names for LLM context
   * @returns Array of x_gm_msgid values sorted by relevance or date,
   *          or empty array only if semantic search is unavailable or returns no raw results.
   */
  async search(
    naturalQuery: string,
    accountId: number,
    userEmail: string,
    todayDate: string,
    folders: string[]
  ): Promise<string[]> {
    const vectorDb = VectorDbService.getInstance();

    if (!vectorDb.vectorsAvailable) {
      log.debug('[SemanticSearch] Vector DB unavailable — skipping semantic search');
      return [];
    }

    const ollama = OllamaService.getInstance();
    const embeddingModel = ollama.getEmbeddingModel();

    if (!embeddingModel) {
      log.debug('[SemanticSearch] No embedding model configured — skipping semantic search');
      return [];
    }

    if (!vectorDb.getVectorDimension()) {
      log.debug('[SemanticSearch] Vector dimension not configured — skipping semantic search');
      return [];
    }

    // Step 1: Extract structured semantic intent (topic query + structured filters).
    // Fall back to treating the raw query as the semantic query if LLM extraction fails.
    let intent: SemanticSearchIntent;
    try {
      intent = await ollama.extractSemanticIntent(naturalQuery, userEmail, todayDate, folders);
    } catch (intentError) {
      log.warn('[SemanticSearch] Intent extraction failed, using raw query as semantic query:', intentError);
      intent = { semanticQuery: naturalQuery, filters: {} };
    }

    log.info('[SemanticSearch] Extracted intent:', JSON.stringify(intent));

    // Step 2: Embed the semantic topic query (strip filter qualifiers, embed topic only).
    let queryEmbedding: number[];
    try {
      const embeddings = await ollama.embed([intent.semanticQuery]);
      if (!embeddings[0] || embeddings[0].length === 0) {
        log.warn('[SemanticSearch] Empty embedding returned for query');
        return [];
      }
      queryEmbedding = embeddings[0];
    } catch (embedError) {
      log.warn('[SemanticSearch] Failed to embed query:', embedError);
      return [];
    }

    // Step 3: Run similarity search — fetch more candidates than needed to allow for filtering.
    const rawResults = vectorDb.search(queryEmbedding, accountId, MAX_VECTOR_SEARCH_RESULTS);

    if (rawResults.length === 0) {
      log.info('[SemanticSearch] No vector search results');
      return [];
    }

    // Step 4: Deduplicate by x_gm_msgid: keep the highest similarity score per email.
    const bestScoreByMsgId = new Map<string, number>();
    for (const result of rawResults) {
      const existing = bestScoreByMsgId.get(result.xGmMsgId);
      if (existing === undefined || result.similarity > existing) {
        bestScoreByMsgId.set(result.xGmMsgId, result.similarity);
      }
    }

    // Step 5: Filter by similarity threshold, then sort by similarity descending.
    const sortedBySimilarity = Array.from(bestScoreByMsgId.entries())
      .filter(([, score]) => score >= SIMILARITY_THRESHOLD)
      .sort((a, b) => b[1] - a[1])
      .map(([xGmMsgId]) => xGmMsgId);

    // Step 6: Filter out emails whose ONLY folder associations are Trash, Spam, or Drafts.
    const db = DatabaseService.getInstance();

    // Resolve the trash folder dynamically (supports [Gmail]/Bin and other locales).
    // Per codebase conventions, never hardcode '[Gmail]/Trash'.
    const trashFolder = db.getTrashFolder(accountId);
    const excludedFolders = [trashFolder, SPAM_FOLDER, DRAFTS_FOLDER];

    const folderFilteredCandidates = this.filterExcludedFolders(db, accountId, sortedBySimilarity, excludedFolders);

    // Step 7: Unified resolve + filter path (handles both filter and no-filter cases).
    log.info(
      `[SemanticSearch] filterAndResolve: ${folderFilteredCandidates.length} candidates ` +
      `(${sortedBySimilarity.length} before folder filter)`
    );

    const finalResults = await this.filterAndResolve(
      accountId,
      folderFilteredCandidates,
      intent.filters,
      excludedFolders
    );

    log.info(`[SemanticSearch] ${finalResults.length} final results`);
    return finalResults;
  }

  /**
   * Unified resolution and filtering method that handles both the structured-filter
   * and no-filter paths using a batch-and-iterate algorithm.
   *
   * Upfront work (before the loop):
   *   - Partition ALL candidates into local vs missing (single DB call).
   *   - SQL-filter local candidates once (single DB call, only when filters are active).
   *   - Pre-filter candidates to build eligibleCandidates: removes local items that
   *     failed the SQL filter so they never consume batch slots during the loop.
   *   - Build the X-GM-RAW query string once (filter query + folder exclusions).
   *   - Open IMAP connection only if missing candidates exist.
   *
   * Iterative loop:
   *   Each round takes a deficit-sized batch (deficit = MAX_RESULTS - confirmed.size)
   *   from the eligibleCandidates array via a cursor. Items in filteredLocalMsgIds are
   *   confirmed instantly; missing items are resolved via a single batched IMAP SEARCH
   *   that OR's all candidate X-GM-MSGIDs together with the X-GM-RAW filter query.
   *   Surviving UIDs are then FETCHed for envelopes and upserted, all within a single
   *   mailbox lock per round. Confirmed results are merged across rounds. The loop exits
   *   when MAX_RESULTS are confirmed or all eligible candidates are exhausted.
   *
   * Post-loop:
   *   Final result is built by walking eligibleCandidates in order (preserving similarity
   *   rank), picking confirmed items up to MAX_RESULTS, then sorting by date descending.
   *
   * @param accountId - Account ID to scope queries
   * @param candidates - Candidate message IDs (similarity-ordered, already folder-filtered)
   * @param filters - Structured filter constraints from LLM intent extraction (may be empty)
   * @param excludedFolders - Folders to exclude (Trash, Spam, Drafts — resolved for this account)
   * @returns Ordered list of x_gm_msgid strings (top MAX_RESULTS, date-sorted for display)
   */
  private async filterAndResolve(
    accountId: number,
    candidates: string[],
    filters: SemanticSearchFilters | undefined,
    excludedFolders: string[]
  ): Promise<string[]> {
    const db = DatabaseService.getInstance();

    // --- Upfront Step 1: Partition candidates into local (in DB) vs missing (not in DB) ---
    let localCandidateSet: Set<string>;
    try {
      localCandidateSet = db.getEmailsExistingInLocalDb(accountId, candidates);
    } catch (partitionError) {
      log.warn('[SemanticSearch] filterAndResolve: failed to partition local/missing candidates:', partitionError);
      localCandidateSet = new Set<string>();
    }

    const localCandidates = candidates.filter((msgId) => localCandidateSet.has(msgId));
    const missingCount = candidates.length - localCandidates.length;

    log.info(
      `[SemanticSearch] filterAndResolve: ${localCandidates.length} local, ` +
      `${missingCount} missing candidates`
    );

    // --- Upfront Step 2: SQL-filter local candidates (single call, only when filters active) ---
    const filtersActive = filters !== undefined && hasFilters(filters);
    let filteredLocalMsgIds: Set<string>;

    if (filtersActive && filters !== undefined) {
      try {
        filteredLocalMsgIds = db.filterEmailsByMsgIds(accountId, localCandidates, filters);
      } catch (sqlFilterError) {
        log.warn('[SemanticSearch] filterAndResolve: SQL filter failed, using unfiltered local candidates:', sqlFilterError);
        filteredLocalMsgIds = localCandidateSet;
      }
    } else {
      filteredLocalMsgIds = new Set<string>(localCandidates);
    }

    // --- Upfront Step 3: Build eligible candidates (remove local-but-failed items) ---
    // Items that are in localCandidateSet but NOT in filteredLocalMsgIds failed the SQL filter
    // and should never consume batch slots. The resulting array preserves similarity order.
    const eligibleCandidates = candidates.filter(
      (msgId) => filteredLocalMsgIds.has(msgId) || !localCandidateSet.has(msgId)
    );

    // --- Upfront Step 4: Build X-GM-RAW query string once ---
    const filterQuery = filters !== undefined ? translateFiltersToGmailQuery(filters).trim() : '';
    const folderExclusionClause = '-in:trash -in:spam -in:drafts';
    const gmRaw = [filterQuery, folderExclusionClause]
      .filter((part) => part.length > 0)
      .join(' ');

    // --- Upfront Step 5: Open IMAP connection (only if missing candidates exist) ---
    const crawlService = ImapCrawlService.getInstance();
    const accountIdStr = String(accountId);
    let connectionOpened = false;
    let imapAvailable = false;

    if (missingCount > 0) {
      try {
        if (!crawlService.isConnected(accountIdStr)) {
          await crawlService.connect(accountIdStr);
          connectionOpened = true;
        }
        imapAvailable = true;
      } catch (connectError) {
        log.warn('[SemanticSearch] Failed to open crawl connection for IMAP resolution:', connectError);
      }
    }

    // --- State persisted across all rounds ---
    const confirmed = new Set<string>();
    let imapConfirmedCount = 0;
    let cursor = 0;
    let roundCounter = 0;

    try {
      // --- Iterative loop: process candidates in deficit-sized rounds ---
      while (confirmed.size < MAX_RESULTS && cursor < eligibleCandidates.length) {
        const deficit = MAX_RESULTS;
        const batch = eligibleCandidates.slice(cursor, cursor + deficit);
        cursor += batch.length;
        roundCounter += 1;

        // Split batch into local-confirmed and missing
        const missingBatch: string[] = [];
        for (const msgId of batch) {
          if (filteredLocalMsgIds.has(msgId)) {
            confirmed.add(msgId);
          } else {
            missingBatch.push(msgId);
          }
        }

        // IMAP SEARCH + FETCH for missing items in this round
        if (missingBatch.length > 0 && imapAvailable) {
          log.info(
            `[SemanticSearch] Round ${roundCounter}: IMAP resolving ` +
            `${missingBatch.length} missing candidates`
          );

          try {
            await crawlService.withMailboxLock(
              accountIdStr,
              ALL_MAIL_PATH,
              async (client) => {
                // Batch SEARCH: OR all candidate emailIds together with the gmRaw filter.
                // One IMAP command resolves + filters all missing candidates at once.
                const orCriteria = missingBatch.map((msgId) => ({ emailId: msgId }));
                let survivingUids: number[];

                try {
                  const searchResult = await client.search(
                    { or: orCriteria, gmraw: gmRaw } as Record<string, unknown>,
                    { uid: true }
                  ) as number[] | false;

                  survivingUids = searchResult ? Array.from(searchResult) : [];
                } catch (searchError) {
                  log.warn(
                    `[SemanticSearch] Round ${roundCounter}: batch SEARCH failed:`,
                    searchError
                  );
                  return;
                }

                log.info(
                  `[SemanticSearch] Round ${roundCounter}: ` +
                  `${survivingUids.length}/${missingBatch.length} candidates survived SEARCH`
                );

                if (survivingUids.length === 0) {
                  return;
                }

                // FETCH surviving UIDs to get envelopes + xGmMsgId mapping.
                // This identifies which msgIds survived and upserts their data in one step.
                const fetchedEnvelopes = await this.fetchEnvelopesForUids(client, survivingUids);

                log.info(
                  `[SemanticSearch] Round ${roundCounter}: ` +
                  `fetched ${fetchedEnvelopes.length}/${survivingUids.length} envelopes`
                );

                for (const envelope of fetchedEnvelopes) {
                  if (envelope.xGmMsgId) {
                    confirmed.add(envelope.xGmMsgId);
                    imapConfirmedCount += 1;

                    try {
                      db.upsertEmailFromEnvelope(accountId, {
                        xGmMsgId: envelope.xGmMsgId,
                        xGmThrid: envelope.xGmThrid,
                        messageId: envelope.messageId,
                        subject: envelope.subject,
                        fromAddress: envelope.fromAddress,
                        fromName: envelope.fromName,
                        toAddresses: envelope.toAddresses,
                        date: envelope.date,
                        isRead: envelope.isRead,
                        isStarred: envelope.isStarred,
                        isDraft: envelope.isDraft,
                        size: envelope.size,
                        rawLabels: envelope.rawLabels,
                      });
                    } catch (upsertError) {
                      log.warn(
                        `[SemanticSearch] Round ${roundCounter}: failed to upsert envelope ` +
                        `for ${envelope.xGmMsgId}:`,
                        upsertError
                      );
                    }
                  }
                }
              }
            );
          } catch (roundError) {
            log.warn(
              `[SemanticSearch] Round ${roundCounter} failed, ` +
              `skipping ${missingBatch.length} candidates:`,
              roundError
            );
          }
        }
      }

      log.info(
        `[SemanticSearch] Loop complete: ${confirmed.size} confirmed ` +
        `(${confirmed.size - imapConfirmedCount} local + ${imapConfirmedCount} IMAP) ` +
        `across ${roundCounter} round(s), cursor at ${cursor}/${eligibleCandidates.length}`
      );

      // --- Final result construction ---
      // Walk eligibleCandidates in order (preserves similarity rank), pick confirmed, take MAX_RESULTS.
      const topSelected = eligibleCandidates
        .filter((msgId) => confirmed.has(msgId))
        .slice(0, MAX_RESULTS);

      // Sort by date descending for display.
      const dateSortedResults = this.sortByDate(accountId, topSelected);
      return dateSortedResults;

    } finally {
      if (connectionOpened) {
        try {
          await crawlService.disconnect(accountIdStr);
        } catch (disconnectError) {
          log.warn('[SemanticSearch] filterAndResolve: failed to disconnect crawl connection:', disconnectError);
        }
      }
    }
  }

  /**
   * Fetch envelopes (no body) for a list of UIDs from the currently-open mailbox.
   * Issues a single FETCH command for all UIDs at once.
   * Any messages that fail to parse are silently skipped.
   *
   * The caller is responsible for holding the mailbox lock before calling this method.
   *
   * @param client - ImapFlow client with an open mailbox lock
   * @param uids - IMAP UIDs to fetch (from [Gmail]/All Mail)
   * @returns Array of parsed envelopes (may be shorter than uids if some fail to parse)
   */
  private async fetchEnvelopesForUids(
    client: import('imapflow').ImapFlow,
    uids: number[]
  ): Promise<CrawlFetchResult[]> {
    if (uids.length === 0) {
      return [];
    }

    const uidRange = uids.join(',');
    const fetchedEnvelopes: CrawlFetchResult[] = [];

    // Fix 3b: Use the proper FetchQueryObject type instead of `as any`.
    // emailId is not a valid FetchQueryObject field — it is populated in the response
    // automatically by the X-GM-EXT-1 extension when labels are requested.
    const fetchQuery: FetchQueryObject = {
      uid: true,
      envelope: true,
      flags: true,
      source: false,
      labels: true,
      threadId: true,
      size: true,
    };

    for await (const msg of client.fetch(uidRange, fetchQuery, { uid: true })) {
      if (!msg) {
        continue;
      }
      try {
        const envelope = this.parseEnvelopeFromMessage(msg);
        if (envelope) {
          fetchedEnvelopes.push(envelope);
        }
      } catch (parseError) {
        log.debug('[SemanticSearch] fetchEnvelopesForUids: failed to parse envelope:', parseError);
      }
    }

    return fetchedEnvelopes;
  }

  /**
   * Parse an ImapFlow message object (fetched without source) into a CrawlFetchResult.
   * Mirrors the logic in ImapCrawlService.parseEnvelopeOnly() since that method is private.
   * Returns null if the message is missing required fields (envelope or xGmMsgId).
   *
   * @param msg - ImapFlow message object from a fetch without source
   * @returns Parsed CrawlFetchResult or null if parsing failed
   */
  private parseEnvelopeFromMessage(msg: import('imapflow').FetchMessageObject): CrawlFetchResult | null {
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

  /**
   * Sort x_gm_msgid values by their email date, newest first.
   * Message IDs with no date record in the local DB are placed at the end.
   *
   * @param accountId - Account ID to scope the date lookup
   * @param msgIds - Message IDs to sort
   * @returns Sorted array (date descending, un-dated entries last)
   */
  private sortByDate(accountId: number, msgIds: string[]): string[] {
    if (msgIds.length === 0) {
      return [];
    }

    const db = DatabaseService.getInstance();
    const dateMap = db.getEmailDatesByMsgIds(accountId, msgIds);

    const sorted = [...msgIds].sort((idA, idB) => {
      const dateA = dateMap.get(idA);
      const dateB = dateMap.get(idB);

      // Entries without a date record go to the end of the sorted array.
      if (!dateA && !dateB) {
        return 0;
      }
      if (!dateA) {
        return 1;
      }
      if (!dateB) {
        return -1;
      }

      // Sort newest first (descending).
      return dateB.localeCompare(dateA);
    });

    return sorted;
  }

  /**
   * Filter out x_gm_msgid values that are ONLY in excluded folders (Trash, Spam, Drafts).
   * An email is included in results if it has at least one folder association that is
   * NOT in the excluded set.
   *
   * Emails with NO folder associations in email_folders (un-synced emails from the
   * full-mailbox crawl) are always included here — they have no local folder data.
   * These un-synced emails are subsequently re-checked after fetching from IMAP using
   * their server-side rawLabels (via the X-GM-RAW filter in filterAndResolve).
   *
   * @param db - DatabaseService instance
   * @param accountId - Account ID
   * @param xGmMsgIds - Candidate message IDs (sorted by relevance)
   * @param excludedFolders - Folders to exclude (resolved dynamically for this account)
   * @returns Filtered list preserving the original ordering
   */
  private filterExcludedFolders(
    db: DatabaseService,
    accountId: number,
    xGmMsgIds: string[],
    excludedFolders: string[]
  ): string[] {
    if (xGmMsgIds.length === 0) {
      return [];
    }

    try {
      const includedSet = db.getMsgIdsWithNonExcludedFolders(accountId, xGmMsgIds, excludedFolders);
      // For results with no email_folders entries (un-synced emails from full-mailbox crawl),
      // getMsgIdsWithNonExcludedFolders will return nothing. We need to identify which msgIds
      // have NO folder records at all (distinct from having only excluded-folder records) so
      // they can be passed through. Use a single batched query for this.
      const hasAnyFolder = db.getMsgIdsWithAnyFolder(accountId, xGmMsgIds);
      return xGmMsgIds.filter((msgId) => includedSet.has(msgId) || !hasAnyFolder.has(msgId));
    } catch (filterError) {
      log.warn('[SemanticSearch] Failed to filter by folder exclusions, returning unfiltered results:', filterError);
      // Return unfiltered rather than throwing — better to show some results than none
      return xGmMsgIds;
    }
  }
}
