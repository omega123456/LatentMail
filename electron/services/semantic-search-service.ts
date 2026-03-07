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
import { DateTime } from 'luxon';
import { LoggerService } from './logger-service';
import { OllamaService } from './ollama-service';
import { VectorDbService } from './vector-db-service';
import { DatabaseService } from './database-service';
import { ImapCrawlService, CrawlFetchResult } from './imap-crawl-service';
import { BaseSearchService, SearchBatchCallback } from './base-search-service';
import {
  SemanticSearchFilters,
  SemanticSearchIntent,
  translateFiltersToGmailQuery,
  hasFilters,
} from '../utils/search-filter-translator';
import { SearchOptions } from './search-options';

const log = LoggerService.getInstance();

/** Minimum cosine similarity score for a result to be considered relevant. */
const SIMILARITY_THRESHOLD = 0.5;

/** Maximum number of results returned from vector search. */
const MAX_VECTOR_SEARCH_RESULTS = 450;

export class SemanticSearchService extends BaseSearchService {
  private static instance: SemanticSearchService;

  protected constructor() {
    super();
  }

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
   * Results are delivered incrementally via the onBatch callback rather than returned
   * as a single array. The callback is called at least once with the local-phase results
   * (which may be an empty array) and then once per IMAP round with newly confirmed IDs.
   *
   * @param options - Search options including naturalQuery, accountId, userEmail, todayDate,
   *                  folders, and onBatch callback.
   * @returns 'complete' if all phases succeeded, 'partial' if some IMAP rounds failed
   *          but some results were emitted, 'error' if the search failed entirely before
   *          any results could be produced.
   */
  async search(options: SearchOptions): Promise<'complete' | 'partial' | 'error'> {
    const { naturalQuery = '', accountId = 0, userEmail = '', todayDate = '', folders = [], onBatch } = options;
    if (!onBatch) {
      log.warn('[SemanticSearch] search called without onBatch callback');
      return 'error';
    }
    const vectorDb = VectorDbService.getInstance();

    if (!vectorDb.vectorsAvailable) {
      log.debug('[SemanticSearch] Vector DB unavailable — skipping semantic search');
      return 'error';
    }

    const ollama = OllamaService.getInstance();
    const embeddingModel = ollama.getEmbeddingModel();

    if (!embeddingModel) {
      log.debug('[SemanticSearch] No embedding model configured — skipping semantic search');
      return 'error';
    }

    if (!vectorDb.getVectorDimension()) {
      log.debug('[SemanticSearch] Vector dimension not configured — skipping semantic search');
      return 'error';
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

    if (intent.semanticQuery.trim() === '' && hasFilters(intent.filters)) {
      return this.runFilterOnlyFallback(accountId, intent.filters, onBatch);
    }

    // Step 2: Embed the semantic topic query (strip filter qualifiers, embed topic only).
    let queryEmbedding: number[];
    try {
      const embeddings = await ollama.embed([intent.semanticQuery]);
      if (!embeddings[0] || embeddings[0].length === 0) {
        log.warn('[SemanticSearch] Empty embedding returned for query');
        return 'error';
      }
      queryEmbedding = embeddings[0];
    } catch (embedError) {
      log.warn('[SemanticSearch] Failed to embed query:', embedError);
      return 'error';
    }

    // Step 3: Run similarity search — fetch more candidates than needed to allow for filtering.
    const rawResults = vectorDb.search(queryEmbedding, accountId, MAX_VECTOR_SEARCH_RESULTS);

    if (rawResults.length === 0) {
      log.info('[SemanticSearch] No vector search results');
      return 'complete';
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
    const excludedFolders = [trashFolder, this.SPAM_FOLDER, this.DRAFTS_FOLDER];

    const folderFilteredCandidates = this.filterExcludedFolders(db, accountId, sortedBySimilarity, excludedFolders);

    // Step 7: Unified resolve + filter path (handles both filter and no-filter cases).
    log.info(
      `[SemanticSearch] filterAndResolve: ${folderFilteredCandidates.length} candidates ` +
      `(${sortedBySimilarity.length} before folder filter)`
    );

    const status = await this.filterAndResolve(
      accountId,
      folderFilteredCandidates,
      intent.filters,
      excludedFolders,
      onBatch
    );

    log.info(`[SemanticSearch] search complete with status: ${status}`);
    return status;
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
   *   - Emit all locally-confirmed msgIds as a 'local' phase batch via onBatch
   *     (even if empty — signals local phase completion to the receiver).
   *
   * Iterative loop:
   *   Each round takes a deficit-sized batch (deficit = MAX_RESULTS - confirmed.size)
   *   from the eligibleCandidates array via a cursor. Items in filteredLocalMsgIds are
   *   confirmed instantly; missing items are resolved via a single batched IMAP SEARCH
   *   that OR's all candidate X-GM-MSGIDs together with the X-GM-RAW filter query.
   *   Surviving UIDs are then FETCHed for envelopes and upserted, all within a single
   *   mailbox lock per round. Confirmed results are merged across rounds. The loop exits
   *   when MAX_RESULTS are confirmed or all eligible candidates are exhausted.
   *   After each round's mailbox lock resolves, newly confirmed msgIds (diff vs. the set
   *   before the round) are date-sorted and emitted as an 'imap' phase batch via onBatch.
   *
   * @param accountId - Account ID to scope queries
   * @param candidates - Candidate message IDs (similarity-ordered, already folder-filtered)
   * @param filters - Structured filter constraints from LLM intent extraction (may be empty)
   * @param excludedFolders - Folders to exclude (Trash, Spam, Drafts — resolved for this account)
   * @param onBatch - Callback invoked with each incremental batch of confirmed message IDs.
   *                  Called once with phase 'local' before IMAP work begins (may be empty),
   *                  then once per IMAP round with phase 'imap'.
   * @returns 'complete' if all IMAP rounds succeeded, 'partial' if some rounds failed,
   *          'error' if the method itself threw before any results were emitted.
   */
  private async filterAndResolve(
    accountId: number,
    candidates: string[],
    filters: SemanticSearchFilters | undefined,
    excludedFolders: string[],
    onBatch: (msgIds: string[], phase: 'local' | 'imap') => void
  ): Promise<'complete' | 'partial' | 'error'> {
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
    const gmRaw = this.buildGmRawWithExclusions(filterQuery);

    // --- Upfront Step 5: Open IMAP connection (only if missing candidates exist) ---
    const crawlService = ImapCrawlService.getInstance();
    const accountIdStr = String(accountId);
    let connectionOpened = false;
    let imapAvailable = false;

    if (missingCount > 0) {
      const connection = await this.ensureCrawlConnection(accountIdStr, {
        logContext: 'IMAP resolution',
      });
      imapAvailable = connection.imapAvailable;
      connectionOpened = connection.connectionOpened;
    }

    // --- Emit local phase batch ---
    // Date-sort the locally-confirmed candidates and emit them before any IMAP work begins.
    // Always emit even if empty — it signals to the receiver that the local phase is complete.
    const localConfirmedMsgIds = eligibleCandidates.filter((msgId) => filteredLocalMsgIds.has(msgId));
    const sortedLocalBatch = this.sortByDate(accountId, localConfirmedMsgIds);
    onBatch(sortedLocalBatch, 'local');

    // Pre-build list of missing eligible candidates (those not already locally confirmed).
    // This is what the iterative loop will process — local ones are already confirmed above.
    const missingEligibleCandidates = eligibleCandidates.filter(
      (msgId) => !filteredLocalMsgIds.has(msgId)
    );

    // --- State persisted across all rounds ---
    const confirmed = new Set<string>(localConfirmedMsgIds);
    let imapConfirmedCount = 0;
    let missingCursor = 0;
    let roundCounter = 0;
    // Mark as error if IMAP is unavailable but there are missing candidates —
    // those candidates could not be verified server-side, so results are partial.
    let hadImapRoundError = !imapAvailable && missingEligibleCandidates.length > 0;

    try {
      // --- Iterative loop: process missing candidates in deficit-sized rounds ---
      while (confirmed.size < this.MAX_RESULTS && missingCursor < missingEligibleCandidates.length) {
        const deficit = this.MAX_RESULTS - confirmed.size;
        const batch = missingEligibleCandidates.slice(missingCursor, missingCursor + deficit);
        missingCursor += batch.length;
        roundCounter += 1;

        // All items in this batch are missing (local ones are already confirmed pre-loop).
        const missingBatch = batch;

        // IMAP SEARCH + FETCH for missing items in this round
        if (missingBatch.length > 0 && imapAvailable) {
          log.info(
            `[SemanticSearch] Round ${roundCounter}: IMAP resolving ` +
            `${missingBatch.length} missing candidates`
          );

          // Snapshot confirmed set before the lock — used to diff newly confirmed after.
          const confirmedBeforeRound = new Set<string>(confirmed);

          try {
            await crawlService.withMailboxLock(
              accountIdStr,
              this.ALL_MAIL_PATH,
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
                    this.upsertEnvelopeFromCrawl(accountId, envelope, `Round ${roundCounter}`);
                  }
                }
              }
            );
          } catch (roundError) {
            hadImapRoundError = true;
            log.warn(
              `[SemanticSearch] Round ${roundCounter} failed, ` +
              `skipping ${missingBatch.length} candidates:`,
              roundError
            );
          }

          // Emit newly confirmed msgIds from this IMAP round (diff vs. pre-round snapshot).
          // Done OUTSIDE the mailbox lock so we never block the lock with callback work.
          const newlyConfirmedInRound = Array.from(confirmed).filter(
            (msgId) => !confirmedBeforeRound.has(msgId)
          );
          const sortedImapBatch = this.sortByDate(accountId, newlyConfirmedInRound);
          onBatch(sortedImapBatch, 'imap');
        }
      }

      log.info(
        `[SemanticSearch] Loop complete: ${confirmed.size} confirmed ` +
        `(${confirmed.size - imapConfirmedCount} local + ${imapConfirmedCount} IMAP) ` +
        `across ${roundCounter} round(s), cursor at ${missingCursor}/${missingEligibleCandidates.length}`
      );

      if (hadImapRoundError && confirmed.size > 0) {
        return 'partial';
      }
      if (hadImapRoundError && confirmed.size === 0) {
        return 'error';
      }
      return 'complete';

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
   * Run filter-only search when semantic query is empty but filters are present.
   * Uses local DB + IMAP SEARCH with Gmail raw query, then emits batches via onBatch.
   *
   * @param accountId - Account to search
   * @param filters - Structured filters from intent extraction
   * @param onBatch - Callback for each batch (local then imap)
   * @returns 'complete' if all phases succeeded, 'partial' if IMAP had errors
   */
  private async runFilterOnlyFallback(
    accountId: number,
    filters: SemanticSearchFilters,
    onBatch: (msgIds: string[], phase: 'local' | 'imap') => void
  ): Promise<'complete' | 'partial'> {
    const filterGmailQuery = translateFiltersToGmailQuery(filters).trim();
    const gmRaw = this.buildGmRawWithExclusions(filterGmailQuery);

    log.info('[SemanticSearch] Empty semantic query with active filters — falling back to keyword search', {
      gmailQuery: gmRaw,
    });

    const localMsgIds = this.runLocalSearchByGmailQuery(accountId, gmRaw, this.MAX_RESULTS);
    const sortedLocalMsgIds = this.sortByDate(accountId, localMsgIds);
    onBatch(sortedLocalMsgIds, 'local');

    const crawlService = ImapCrawlService.getInstance();
    const accountIdStr = String(accountId);
    const { imapAvailable, connectionOpened } = await this.ensureCrawlConnection(accountIdStr, {
      logContext: 'Filter-only fallback',
    });

    const emittedMsgIds = new Set<string>(sortedLocalMsgIds);
    let hadImapError = false;
    let imapBatchMsgIds: string[] = [];

    if (imapAvailable) {
      try {
        await crawlService.withMailboxLock(
          accountIdStr,
          this.ALL_MAIL_PATH,
          async (client) => {
            let survivingUids: number[];
            try {
              const searchResult = await client.search(
                { gmraw: gmRaw } as Record<string, unknown>,
                { uid: true }
              ) as number[] | false;
              survivingUids = searchResult ? Array.from(searchResult) : [];
            } catch (searchError) {
              log.warn('[SemanticSearch] Filter-only fallback: IMAP SEARCH failed:', searchError);
              return;
            }

            log.info(`[SemanticSearch] Filter-only fallback: ${survivingUids.length} UIDs from IMAP SEARCH`);

            if (survivingUids.length === 0) {
              return;
            }

            const remaining = this.MAX_RESULTS - emittedMsgIds.size;
            if (remaining <= 0) {
              return;
            }
            const cappedUids = survivingUids.slice(0, remaining);

            const fetchedEnvelopes = await this.fetchEnvelopesForUids(client, cappedUids);
            const newImapMsgIds: string[] = [];

            for (const envelope of fetchedEnvelopes) {
              if (envelope.xGmMsgId && !emittedMsgIds.has(envelope.xGmMsgId)) {
                emittedMsgIds.add(envelope.xGmMsgId);
                newImapMsgIds.push(envelope.xGmMsgId);
                this.upsertEnvelopeFromCrawl(accountId, envelope, 'Filter-only fallback');
              }
            }

            imapBatchMsgIds = this.sortByDate(accountId, newImapMsgIds);
          }
        );
      } catch (imapError) {
        hadImapError = true;
        log.warn('[SemanticSearch] Filter-only fallback: IMAP round failed:', imapError);
      }
    }

    onBatch(imapBatchMsgIds, 'imap');

    try {
      if (connectionOpened) {
        await crawlService.disconnect(accountIdStr);
      }
    } catch (disconnectError) {
      log.warn('[SemanticSearch] Filter-only fallback: failed to disconnect:', disconnectError);
    }

    return hadImapError ? 'partial' : 'complete';
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
      date: (envelope.date ? DateTime.fromJSDate(envelope.date).toUTC().toISO() : null) ?? DateTime.utc().toISO()!,
      isRead: flags.includes('\\Seen'),
      isStarred: flags.includes('\\Flagged'),
      isDraft: flags.includes('\\Draft'),
      size: msg.size || 0,
      uid: msg.uid,
    };
  }

  /**
   * Ensure IMAP crawl connection is open for the account. Caller must disconnect in finally if connectionOpened.
   */
  private async ensureCrawlConnection(
    accountIdStr: string,
    options: { logContext: string }
  ): Promise<{ imapAvailable: boolean; connectionOpened: boolean }> {
    const crawlService = ImapCrawlService.getInstance();
    let connectionOpened = false;
    try {
      if (!crawlService.isConnected(accountIdStr)) {
        await crawlService.connect(accountIdStr);
        connectionOpened = true;
      }
      return { imapAvailable: true, connectionOpened };
    } catch (connectError) {
      log.warn(`[SemanticSearch] ${options.logContext}: failed to open IMAP connection:`, connectError);
      return { imapAvailable: false, connectionOpened: false };
    }
  }
}
