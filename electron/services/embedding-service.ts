/**
 * EmbeddingService — main-thread orchestrator for the embedding pipeline.
 *
 * Responsibilities:
 * - Spawns and manages the embedding worker thread
 * - Full build: crawls [Gmail]/All Mail via ImapCrawlService, embeds emails on-the-fly,
 *   discards bodies after embedding (fetch → embed → discard strategy)
 * - Incremental build: reads emails with bodies from the local DB (post-body-fetch)
 * - After embedding, writes indexed records to the vector_indexed_emails table
 * - Forwards progress events to all renderer windows
 * - Handles build/cancel/status lifecycle with reconnect-and-resume resilience
 * - Provides scheduleIncrementalIndex() for post-body-fetch hooks
 *
 * Full build flow (sequential, one batch at a time):
 *   1. ImapCrawlService connects to [Gmail]/All Mail
 *   2. SEARCH ALL → full UID list
 *   3. getIndexedMsgIds() → set of already-indexed xGmMsgIds
 *   4. For each UID batch (50 UIDs):
 *      a. Fetch full bodies via ImapCrawlService.fetchBatch()
 *      b. Filter out Spam/Trash/Draft → write SKIPPED_FILTERED sentinel to vector_indexed_emails
 *      c. Truncate body text at 10,000 characters
 *      d. Send batch to embedding worker
 *      e. Worker embeds, stores vectors, returns batch-done
 *      f. Write (xGmMsgId, account_id, hash) to vector_indexed_emails
 *      g. Sleep 1 second
 *   5. Disconnect ImapCrawlService
 *   6. Broadcast complete
 *
 * On IMAP error: reconnect-and-resume (up to 3 attempts, exponential backoff).
 * vector_indexed_emails is the checkpoint — re-runs skip already-indexed emails.
 */

import { Worker } from 'worker_threads';
import * as path from 'path';
import * as crypto from 'crypto';
import { BrowserWindow } from 'electron';
import { LoggerService } from './logger-service';
import { DatabaseService } from './database-service';
import { VectorDbService } from './vector-db-service';
import { OllamaService } from './ollama-service';
import { ImapCrawlService } from './imap-crawl-service';
import { getLastIpcActivityTimestamp } from '../ipc/ipc-activity-tracker';
import type { EmailBatchItem, EmbeddingWorkerData, BatchResult } from '../workers/embedding-worker';

const log = LoggerService.getInstance();

/** Batch size: number of emails fetched from IMAP / DB and sent to worker at once. */
const EMAIL_BATCH_SIZE = 50;

/** Maximum body text characters to pass to the chunker (after simpleParser extraction). */
const MAX_BODY_CHARS = 10_000;

/**
 * Sentinel value written to vector_indexed_emails.embedding_hash for emails that
 * are filtered out (Spam, Trash, or Drafts). They count as "indexed" for progress
 * and are never re-fetched on subsequent builds.
 */
const SKIPPED_FILTERED = 'SKIPPED_FILTERED';

/** Gmail paths used for spam/trash/draft filtering. */
const SPAM_PATH = '[Gmail]/Spam';
const DRAFTS_PATH = '[Gmail]/Drafts';
const SENT_PATH = '[Gmail]/Sent Mail';

/** Reconnect-and-resume configuration. */
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAYS_MS = [5_000, 15_000, 45_000];

/** Build state machine states. */
type BuildState = 'idle' | 'building' | 'error';

/** IPC channel names for embedding push events (mirrored here to avoid circular imports). */
const EMBEDDING_PROGRESS_CHANNEL = 'embedding:progress';
const EMBEDDING_COMPLETE_CHANNEL = 'embedding:complete';
const EMBEDDING_ERROR_CHANNEL = 'embedding:error';
const EMBEDDING_RESUME_CHANNEL = 'embedding:resume';

export class EmbeddingService {
  private static instance: EmbeddingService;

  private vectorDbService: VectorDbService;
  private worker: Worker | null = null;
  private buildState: BuildState = 'idle';
  private incrementalScheduled: boolean = false;

  /** Total emails to index in the current full build (IMAP-based UID count minus indexed). */
  private currentBuildTotal: number = 0;

  /**
   * Emails indexed so far in the current full build.
   * Includes both successfully-embedded emails and SKIPPED_FILTERED sentinels.
   */
  private currentBuildIndexed: number = 0;

  /**
   * Timestamp of the most recent mail or compose IPC invocation.
   * @deprecated Use getLastIpcActivityTimestamp() from ipc-activity-tracker instead.
   *             Kept for backward compatibility; the tracker module is the canonical source.
   */
  lastIpcActivityTimestamp: number = 0;

  private constructor(vectorDbService: VectorDbService) {
    this.vectorDbService = vectorDbService;
  }

  static getInstance(vectorDbService?: VectorDbService): EmbeddingService {
    if (!EmbeddingService.instance) {
      if (!vectorDbService) {
        throw new Error('EmbeddingService.getInstance() called before initialization with VectorDbService');
      }
      EmbeddingService.instance = new EmbeddingService(vectorDbService);
    }
    return EmbeddingService.instance;
  }

  // ---- Public API ----

  /** Current build state. */
  getBuildState(): BuildState {
    return this.buildState;
  }

  /**
   * Total emails to index in the current full build (IMAP UID count minus already indexed).
   * Returns 0 outside of an active build.
   */
  getCurrentBuildTotal(): number {
    return this.currentBuildTotal;
  }

  /**
   * Emails indexed so far in the current full build (sentinels + embedded).
   * Returns 0 outside of an active build.
   */
  getCurrentBuildIndexed(): number {
    return this.currentBuildIndexed;
  }

  /**
   * Start a full index build using the IMAP crawl pipeline.
   * Crawls [Gmail]/All Mail via a dedicated IMAP connection, embeds emails on-the-fly,
   * and discards bodies after embedding.
   * Returns immediately; progress is reported via push events.
   *
   * @throws if a build is already in progress
   */
  startBuild(): void {
    if (this.buildState === 'building') {
      throw new Error('Index build already in progress');
    }

    const ollama = OllamaService.getInstance();
    const embeddingModel = ollama.getEmbeddingModel();
    if (!embeddingModel) {
      throw new Error('No embedding model selected');
    }

    if (!this.vectorDbService.vectorsAvailable) {
      throw new Error('Vector DB is unavailable (sqlite-vec extension failed to load)');
    }

    const vectorDimension = this.vectorDbService.getVectorDimension();
    if (!vectorDimension) {
      throw new Error('Vector dimension not configured — please select and validate an embedding model first');
    }

    this.buildState = 'building';
    this.currentBuildTotal = 0;
    this.currentBuildIndexed = 0;
    log.info('[EmbeddingService] Starting full index build (IMAP crawl pipeline)');

    this.runBuildLoop(embeddingModel, vectorDimension).catch((err) => {
      log.error('[EmbeddingService] Build loop failed unexpectedly:', err);
      this.buildState = 'error';
      this.broadcastError(err instanceof Error ? err.message : String(err));
    });
  }

  /**
   * Cancel an in-progress build.
   * Emails fully embedded before cancel are committed (kept in vector_indexed_emails and vector DB).
   * Clears build_interrupted for all active accounts so auto-resume is NOT triggered on next
   * app start — cursor position is preserved so a manual restart resumes efficiently.
   */
  cancelBuild(): void {
    if (this.buildState !== 'building') {
      return;
    }

    log.info('[EmbeddingService] Cancelling index build');
    this.terminateWorker();
    this.buildState = 'idle';
    this.currentBuildTotal = 0;
    this.currentBuildIndexed = 0;

    // Clear build_interrupted for all active accounts so the cancelled build
    // is not auto-resumed on the next app start. Cursor (last_uid) is preserved
    // so a manual "Build Index" can resume from where it left off.
    const db = DatabaseService.getInstance();
    try {
      const accounts = db.getAccounts().filter((account) => account.isActive);
      for (const account of accounts) {
        db.setEmbeddingBuildInterrupted(account.id, false);
      }
    } catch (err) {
      log.warn('[EmbeddingService] Failed to clear build_interrupted on cancel:', err);
    }
  }

  /**
   * Notify EmbeddingService to check for un-embedded emails on its next idle cycle.
   * Called after body-fetch queue items complete. Non-blocking (fire-and-forget).
   * Waits until no mail or compose IPC activity in the last 30 seconds before starting.
   */
  scheduleIncrementalIndex(): void {
    if (this.incrementalScheduled || this.buildState === 'building') {
      return;
    }

    this.incrementalScheduled = true;
    log.debug('[EmbeddingService] Incremental index scheduled after body-fetch');

    setImmediate(() => {
      this.runIncrementalWhenIdle().catch((err) => {
        log.warn('[EmbeddingService] Incremental index failed:', err);
      });
    });
  }

  /**
   * Handle an embedding model change.
   * Clears all existing vectors, clears all vector_indexed_emails records,
   * and reconfigures with the new vector dimension.
   * A fresh full build is required after this call.
   *
   * @param newModel - The new embedding model name
   * @param newDimension - Vector dimension for the new model
   */
  async onModelChange(newModel: string, newDimension: number): Promise<void> {
    if (this.buildState === 'building') {
      this.cancelBuild();
      await sleep(200);
    }

    log.info(`[EmbeddingService] Model changed to ${newModel} (dim=${newDimension}) — clearing index`);

    this.vectorDbService.clearAllAndReconfigure(newModel, newDimension);

    const db = DatabaseService.getInstance();
    db.clearAllVectorIndexedEmails();
    db.clearAllEmbeddingCrawlProgress();

    log.info('[EmbeddingService] Model change complete — index cleared, re-index required');
  }

  /**
   * Check for interrupted builds on app startup and automatically resume them.
   *
   * Called once from main.ts after all services are initialized. Checks prerequisites
   * (model configured, Ollama reachable, vector DB available) before attempting resume.
   * If prerequisites are not met, the method returns silently — the build_interrupted flag
   * remains set and auto-resume will be attempted on the next app start.
   *
   * Delay strategy: this method waits 15 seconds internally (plus the 5-second setTimeout
   * in main.ts) for ~20 seconds total before startBuild() fires, giving IMAP connections,
   * OAuth token refreshes, and the SyncQueueBridge's first cycle time to settle.
   */
  async autoResumeInterruptedBuilds(): Promise<void> {
    try {
      const db = DatabaseService.getInstance();
      const interruptedAccountIds = db.getInterruptedEmbeddingAccounts();

      if (interruptedAccountIds.length === 0) {
        log.debug('[EmbeddingService] Auto-resume: no interrupted builds found');
        return;
      }

      // Only consider accounts that are currently active — an interrupted account
      // that was subsequently disabled should not trigger a build on every startup.
      const activeAccounts = db.getAccounts().filter((account) => account.isActive);
      const activeInterruptedIds = interruptedAccountIds.filter((interruptedId) =>
        activeAccounts.some((account) => account.id === interruptedId)
      );

      if (activeInterruptedIds.length === 0) {
        log.info(
          '[EmbeddingService] Auto-resume skipped: interrupted account(s) are no longer active'
        );
        return;
      }

      log.info(
        `[EmbeddingService] Auto-resume: found ${activeInterruptedIds.length} active interrupted ` +
        `account(s): ${activeInterruptedIds.join(', ')}`
      );

      // Check prerequisites: embedding model configured
      const ollama = OllamaService.getInstance();
      const embeddingModel = ollama.getEmbeddingModel();
      if (!embeddingModel) {
        log.info('[EmbeddingService] Auto-resume skipped: no embedding model configured');
        return;
      }

      // Check prerequisites: vector DB available
      if (!this.vectorDbService.vectorsAvailable) {
        log.info('[EmbeddingService] Auto-resume skipped: vector DB unavailable');
        return;
      }

      // Check prerequisites: vector dimension configured
      const vectorDimension = this.vectorDbService.getVectorDimension();
      if (!vectorDimension) {
        log.info('[EmbeddingService] Auto-resume skipped: vector dimension not configured');
        return;
      }

      // Check prerequisites: Ollama is reachable
      const isHealthy = await ollama.checkHealth();
      if (!isHealthy) {
        log.info('[EmbeddingService] Auto-resume skipped: Ollama is not reachable');
        return;
      }

      // Wait 15 seconds to let normal sync and IMAP connections settle
      log.info('[EmbeddingService] Auto-resume: waiting 15s before resuming build...');
      await sleep(15_000);

      // Re-check: user may have started a manual build during the delay
      if (this.buildState !== 'idle') {
        log.info(
          `[EmbeddingService] Auto-resume skipped: build already in state '${this.buildState}'`
        );
        return;
      }

      log.info('[EmbeddingService] Auto-resume: starting build...');

      // startBuild() may throw (e.g., vector DB reconfigured, no model). Broadcast the
      // resume event only after we confirm the build started successfully so the renderer
      // does not show a "Resuming…" toast for a build that never actually runs.
      this.startBuild();
      this.broadcastResume();
    } catch (err) {
      // Auto-resume must never crash the app
      log.warn('[EmbeddingService] Auto-resume encountered an error:', err);
    }
  }

  // ---- Internal build loop (full IMAP crawl) ----

  /**
   * Main build loop: crawls [Gmail]/All Mail via ImapCrawlService, embeds all
   * un-indexed emails, and writes completion records to vector_indexed_emails.
   *
   * Processes accounts sequentially. Within each account, processes UID batches
   * sequentially with a 1-second inter-batch delay.
   *
   * Resume behaviour:
   * - At account start: sets build_interrupted = 1 so crashes are detectable
   * - Reads the stored cursor (last_uid) and calls searchUidsAfter(cursor)
   *   so only UIDs above the cursor are returned from the IMAP server
   * - Anomaly detection: if cursor > 0 and searchUidsAfter returns empty,
   *   falls back to searchAllUids to distinguish complete vs UID-renumbered
   * - Deferred sentinel commits: sentinel records are collected in memory and
   *   committed together with worker results + cursor in one atomic transaction
   * - On per-account completion: clears build_interrupted; cursor (last_uid) is PRESERVED
   *   so subsequent "check for new emails" calls use searchUidsAfter(cursor) instead of
   *   searchAllUids(), fetching only newly-arrived UIDs from the IMAP server.
   *
   * On IMAP connection failure: reconnects (up to MAX_RECONNECT_ATTEMPTS) and resumes.
   * vector_indexed_emails serves as the checkpoint — after reconnect, already-indexed
   * emails are skipped even though remaining UIDs are re-traversed.
   */
  private async runBuildLoop(embeddingModel: string, vectorDimension: number): Promise<void> {
    const db = DatabaseService.getInstance();
    const crawlService = ImapCrawlService.getInstance();
    const accounts = db.getAccounts().filter((account) => account.isActive);


    if (accounts.length === 0) {
      log.info('[EmbeddingService] No active accounts — nothing to index');
      this.buildState = 'idle';
      return;
    }

    // Spawn the embedding worker once for the entire build
    if (!this.spawnWorker(embeddingModel, vectorDimension)) {
      return; // spawnWorker sets error state internally
    }

    let isFirstBatch = true;
    let totalSentinels = 0;
    let globalWorkerError: string | null = null;

    for (const account of accounts) {
      if (this.buildState !== 'building') {
        break;
      }

      log.info(`[EmbeddingService] Processing account ${account.id} (${account.email})`);

      // Mark this account's build as interrupted at the start.
      // If the app crashes before we complete, this flag stays set and triggers
      // auto-resume on the next app start.
      try {
        db.setEmbeddingBuildInterrupted(account.id, true);
      } catch (err) {
        log.warn(`[EmbeddingService] Failed to set build_interrupted for account ${account.id}:`, err);
      }

      // Connect dedicated IMAP connection for this account
      try {
        await crawlService.connect(String(account.id));
      } catch (err) {
        log.error(`[EmbeddingService] Failed to connect IMAP for account ${account.id}:`, err);
        continue; // skip this account, try next
      }

      let accountWorkerError: string | null = null;
      let reconnectAttempts = 0;
      // Tracks the highest UID committed for this account across all batches.
      // Initialized to the stored cursor so the completion log is accurate even
      // if all UIDs are skipped (already indexed) and no new batch cursor is written.
      let lastCommittedCursorUid = db.getEmbeddingCrawlCursor(account.id);

      // Outer loop: reconnect-and-resume on IMAP failure
      while (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS && this.buildState === 'building') {
        try {
          // 1. Read the stored cursor (0 = fresh build, or last completed batch's max UID)
          const cursor = db.getEmbeddingCrawlCursor(account.id);
          log.info(`[EmbeddingService] Account ${account.id}: resume cursor = ${cursor}`);

          // 2. Get UIDs to process — only those above the cursor
          let uidsToProcess = await crawlService.searchUidsAfter(String(account.id), cursor);
          log.info(`[EmbeddingService] Account ${account.id}: ${uidsToProcess.length} UIDs above cursor`);

          // 3. Anomaly detection: if cursor > 0 and searchUidsAfter returned empty,
          //    distinguish between "genuinely complete" and "UID renumbering occurred"
          if (cursor > 0 && uidsToProcess.length === 0) {
            log.info(
              `[EmbeddingService] Account ${account.id}: no UIDs above cursor ${cursor}, ` +
              `checking for UID renumbering via full search`
            );
            const allUids = await crawlService.searchAllUids(String(account.id));
            if (allUids.length === 0) {
              // Mailbox is genuinely empty — nothing to do
              log.info(`[EmbeddingService] Account ${account.id}: mailbox is empty, skipping`);
              break;
            }
            const maxAllUid = Math.max(...allUids);
            if (maxAllUid < cursor) {
              // UID renumbering detected — reset cursor and re-index everything
              log.warn(
                `[EmbeddingService] Account ${account.id}: UID renumbering detected ` +
                `(maxAllUid=${maxAllUid} < cursor=${cursor}). Resetting cursor and re-indexing.`
              );
              db.clearEmbeddingCrawlProgress(account.id);
              // Re-assert build_interrupted so a crash during re-index is still detected
              db.setEmbeddingBuildInterrupted(account.id, true);
              uidsToProcess = allUids;
            } else {
              // The account appears to be fully indexed (all UIDs ≤ cursor are in indexedSet)
              log.info(
                `[EmbeddingService] Account ${account.id}: all UIDs already indexed ` +
                `(maxAllUid=${maxAllUid}, cursor=${cursor})`
              );
              break;
            }
          }

          // 4. Get the set of already-indexed xGmMsgIds (indexed + sentinels)
          const indexedSet = db.getIndexedMsgIds(account.id);
          log.info(`[EmbeddingService] Account ${account.id}: ${indexedSet.size} already indexed`);

          // 5. Compute progress total contribution for this account
          const estimatedUnindexed = Math.max(0, uidsToProcess.length - indexedSet.size);
          this.currentBuildTotal += estimatedUnindexed;

          // 6. Resolve trash folder for filtering
          const trashFolder = db.getTrashFolder(account.id);

          // 7. Process UIDs in batches of EMAIL_BATCH_SIZE
          for (
            let batchStart = 0;
            batchStart < uidsToProcess.length && this.buildState === 'building';
            batchStart += EMAIL_BATCH_SIZE
          ) {
            const batchUids = uidsToProcess.slice(batchStart, batchStart + EMAIL_BATCH_SIZE);

            // Fetch full bodies for this batch
            const fetchedEmails = await crawlService.fetchBatch(String(account.id), batchUids);

            // Categorize: skip already-indexed, collect sentinel records in memory for
            // deferred commit, prepare embedding items for the worker
            const deferredSentinelRecords: Array<{ xGmMsgId: string; embeddingHash: string }> = [];
            const batchItems: EmailBatchItem[] = [];

            // Envelope metadata to upsert into the emails table for non-filtered emails.
            // rawLabels is intentionally omitted — passing labels would create email_folders /
            // thread_folders rows with NULL UIDs, making incomplete envelope-only emails
            // visible in the normal mail UI. Only the All Mail UID link is written.
            const pendingEnvelopes: Array<{
              accountId: number;
              xGmMsgId: string;
              xGmThrid: string;
              messageId: string;
              subject: string;
              fromAddress: string;
              fromName: string;
              toAddresses: string;
              date: string;
              isRead: boolean;
              isStarred: boolean;
              isDraft: boolean;
              size: number;
              uid?: number;
            }> = [];

            for (const email of fetchedEmails) {
              // Skip if already indexed (from a previous build or earlier in this run)
              if (indexedSet.has(email.xGmMsgId)) {
                continue;
              }

              // Filter Spam / Trash / Drafts
              const isFiltered =
                email.rawLabels.includes(SPAM_PATH) ||
                email.rawLabels.includes(trashFolder) ||
                email.rawLabels.includes(DRAFTS_PATH) ||
                email.isDraft;

              if (isFiltered) {
                // Collect sentinel record but do NOT write to DB yet —
                // will be committed atomically with worker results + cursor at batch end
                deferredSentinelRecords.push({
                  xGmMsgId: email.xGmMsgId,
                  embeddingHash: SKIPPED_FILTERED,
                });
                // Update in-memory set immediately to prevent re-processing within this run
                indexedSet.add(email.xGmMsgId);
              } else {
                // Truncate body at MAX_BODY_CHARS before passing to chunker
                const truncatedText =
                  email.textBody.length > MAX_BODY_CHARS
                    ? email.textBody.slice(0, MAX_BODY_CHARS)
                    : email.textBody;
                const truncatedHtml =
                  email.htmlBody.length > MAX_BODY_CHARS
                    ? email.htmlBody.slice(0, MAX_BODY_CHARS)
                    : email.htmlBody;

                const bodyContent = truncatedText || truncatedHtml || '';
                const hash = crypto
                  .createHash('sha256')
                  .update(bodyContent)
                  .digest('hex')
                  .slice(0, 16);

                batchItems.push({
                  xGmMsgId: email.xGmMsgId,
                  accountId: account.id,
                  subject: email.subject,
                  fromAddress: email.fromAddress,
                  toAddresses: email.toAddresses,
                  isSentFolder: email.rawLabels.includes(SENT_PATH),
                  textBody: truncatedText || null,
                  htmlBody: truncatedHtml || null,
                  hash,
                });

                // Collect envelope metadata for DB upsert.
                // rawLabels is deliberately excluded — see pendingEnvelopes declaration above.
                pendingEnvelopes.push({
                  accountId: account.id,
                  xGmMsgId: email.xGmMsgId,
                  xGmThrid: email.xGmThrid,
                  messageId: email.messageId,
                  subject: email.subject,
                  fromAddress: email.fromAddress,
                  fromName: email.fromName,
                  toAddresses: email.toAddresses,
                  date: email.date,
                  isRead: email.isRead,
                  isStarred: email.isStarred,
                  isDraft: email.isDraft,
                  size: email.size,
                  uid: email.uid,
                });
              }
            }

            // Compute the cursor advance for this batch (max UID in the batch)
            const batchCursorUid = Math.max(...batchUids);

            // Upsert envelope metadata for all non-filtered emails before sending to the
            // worker. This ensures email rows exist in the main DB even if the worker
            // subsequently fails — rows will be harmlessly re-upserted on resume.
            // If the upsert itself fails we abort the current account build: indexing
            // without metadata rows would recreate the "blank source card" problem.
            if (pendingEnvelopes.length > 0) {
              try {
                db.batchUpsertEmailEnvelopes(pendingEnvelopes);
              } catch (upsertErr) {
                const upsertErrorMessage = upsertErr instanceof Error ? upsertErr.message : String(upsertErr);
                log.error('[EmbeddingService] Failed to upsert envelope metadata — aborting build for account:', upsertErrorMessage);
                accountWorkerError = upsertErrorMessage;
                break;
              }
            }

            if (batchItems.length > 0) {
              // Send non-filtered emails to the embedding worker
              let batchDoneResults: BatchResult[] = [];
              try {
                batchDoneResults = await this.sendBatchAndWait(
                  batchItems,
                  this.currentBuildTotal,
                  totalSentinels + deferredSentinelRecords.length,
                  isFirstBatch
                );
                isFirstBatch = false;
              } catch (err) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                log.error('[EmbeddingService] Batch worker error:', errorMessage);
                accountWorkerError = errorMessage;
                break;
              }

              // Merge sentinel records + worker results and commit atomically with cursor
              const allRecordsForBatch = [
                ...deferredSentinelRecords,
                ...batchDoneResults.map((result) => ({
                  xGmMsgId: result.xGmMsgId,
                  embeddingHash: result.hash,
                })),
              ];

              db.batchInsertVectorIndexedEmails(account.id, allRecordsForBatch, batchCursorUid);
              lastCommittedCursorUid = batchCursorUid;

              totalSentinels += deferredSentinelRecords.length;
              this.currentBuildIndexed += deferredSentinelRecords.length + batchDoneResults.length;
              for (const result of batchDoneResults) {
                indexedSet.add(result.xGmMsgId);
              }
            } else if (deferredSentinelRecords.length > 0) {
              // Sentinel-only batch (all items were filtered, no embedding work needed)
              // Commit sentinels + cursor atomically
              db.batchInsertVectorIndexedEmails(
                account.id,
                deferredSentinelRecords,
                batchCursorUid
              );
              lastCommittedCursorUid = batchCursorUid;
              totalSentinels += deferredSentinelRecords.length;
              this.currentBuildIndexed += deferredSentinelRecords.length;
              isFirstBatch = false;
            } else {
              // Entirely skipped batch (all already indexed) — no progress to broadcast
              // Still advance cursor to skip these UIDs on resume
              db.upsertEmbeddingCrawlCursor(account.id, batchCursorUid);
              lastCommittedCursorUid = batchCursorUid;
              isFirstBatch = false;
            }

            // Inter-batch delay (reduce Gmail rate limiting pressure)
            await sleep(1_000);
          }

          // Success — exit the reconnect loop
          break;
        } catch (err) {
          // IMAP-level error (network, auth, etc.)
          if (
            reconnectAttempts < MAX_RECONNECT_ATTEMPTS &&
            this.buildState === 'building' &&
            accountWorkerError === null
          ) {
            const delayMs = RECONNECT_DELAYS_MS[reconnectAttempts];
            reconnectAttempts++;
            log.warn(
              `[EmbeddingService] IMAP error for account ${account.id} ` +
              `(attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}), ` +
              `reconnecting in ${delayMs / 1000}s:`,
              err
            );
            await sleep(delayMs);
            try {
              await crawlService.reconnect(String(account.id));
              // Reset this account's contribution to the total so it gets recomputed
              // after SEARCH is re-run on the next iteration
              this.currentBuildTotal = Math.max(0, this.currentBuildTotal);
            } catch (reconnectErr) {
              log.error(`[EmbeddingService] Reconnect failed for account ${account.id}:`, reconnectErr);
              accountWorkerError = reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr);
              break;
            }
          } else {
            log.error(
              `[EmbeddingService] IMAP error exhausted retries for account ${account.id}:`,
              err
            );
            accountWorkerError = err instanceof Error ? err.message : String(err);
            break;
          }
        }
      }

      // Disconnect crawl connection for this account
      await crawlService.disconnect(String(account.id));

      if (accountWorkerError) {
        globalWorkerError = accountWorkerError;
        break;
      }

      // Account completed successfully — clear build_interrupted but KEEP the cursor.
      // The cursor (last_uid) records the highest UID processed in this build.
      // Preserving it means "Check for new emails to index" can call
      // searchUidsAfter(cursor) instead of searchAllUids(), so only emails
      // received after the last build are fetched from IMAP — not the full mailbox.
      // Only update if the build is still active (not cancelled). If cancelled,
      // buildState is 'idle' here and the cursor is already preserved.
      if (this.buildState === 'building') {
        try {
          db.setEmbeddingBuildInterrupted(account.id, false);
          log.info(
            `[EmbeddingService] Account ${account.id}: build complete, ` +
            `cursor preserved at uid=${lastCommittedCursorUid} for incremental check`
          );
        } catch (err) {
          log.warn(`[EmbeddingService] Failed to clear build_interrupted for account ${account.id}:`, err);
        }
      }
    }

    // Terminate the worker now that all batches are processed
    this.terminateWorker();

    if (globalWorkerError) {
      this.buildState = 'error';
      this.currentBuildTotal = 0;
      this.currentBuildIndexed = 0;
      this.broadcastError(globalWorkerError);
    } else if (this.buildState === 'building') {
      this.buildState = 'idle';
      log.info(
        `[EmbeddingService] Full index build complete. ` +
        `Total indexed: ${this.currentBuildIndexed} (including ${totalSentinels} filtered sentinels)`
      );
      this.currentBuildTotal = 0;
      this.currentBuildIndexed = 0;
      this.broadcastComplete();
    }
    // If buildState was changed to 'idle' by cancelBuild() during the loop, we exit cleanly.
  }

  // ---- Internal incremental loop (DB-based, post-body-fetch) ----

  /**
   * Incremental index loop: reads emails with bodies from the local DB that
   * haven't been indexed yet (getEmailsNeedingVectorIndexing) and embeds them.
   * No IMAP connection needed — bodies were just fetched by BodyPrefetchService.
   */
  private async runIncrementalLoop(embeddingModel: string, vectorDimension: number): Promise<void> {
    const db = DatabaseService.getInstance();
    const accounts = db.getAccounts().filter((account) => account.isActive);


    if (accounts.length === 0) {
      return;
    }

    // Spawn worker for the incremental run
    if (!this.spawnWorker(embeddingModel, vectorDimension)) {
      return;
    }

    let isFirstBatch = true;
    let totalIndexed = 0;
    let workerError: string | null = null;

    // Quick check: see if there is anything at all to embed before spawning work
    const hasAny = accounts.some((account) => db.getEmailsNeedingVectorIndexing(account.id, 1).length > 0);
    if (!hasAny) {
      this.terminateWorker();
      return;
    }

    // Total is not pre-computed for incremental runs (bodies arrive in small batches post-sync).
    // The worker reports per-batch progress relative to each batch size.
    const totalNeedingIndex = 0;

    log.info('[EmbeddingService] Incremental index: starting (bodies available in local DB)');

    for (const account of accounts) {
      if (this.buildState !== 'building') {
        break;
      }

      let hasMore = true;
      while (hasMore && this.buildState === 'building') {
        const emails = db.getEmailsNeedingVectorIndexing(account.id, EMAIL_BATCH_SIZE);

        if (emails.length === 0) {
          hasMore = false;
          break;
        }

        const batchItems: EmailBatchItem[] = emails.map((email) => {
          const bodyContent = email.textBody ?? email.htmlBody ?? '';
          const hash = crypto.createHash('sha256').update(bodyContent).digest('hex').slice(0, 16);
          return {
            xGmMsgId: email.xGmMsgId,
            accountId: email.accountId,
            subject: email.subject,
            fromAddress: email.fromAddress,
            toAddresses: email.toAddresses,
            isSentFolder: email.isSentFolder,
            textBody: email.textBody ?? null,
            htmlBody: email.htmlBody ?? null,
            hash,
          };
        });

        let batchDoneResults: BatchResult[] = [];
        try {
          batchDoneResults = await this.sendBatchAndWait(
            batchItems,
            totalNeedingIndex,
            0, // no sentinels in incremental path
            isFirstBatch
          );
          isFirstBatch = false;
        } catch (err) {
          workerError = err instanceof Error ? err.message : String(err);
          log.error('[EmbeddingService] Incremental batch error:', workerError);
          break;
        }

        if (batchDoneResults.length > 0) {
          db.batchInsertVectorIndexedEmails(
            account.id,
            batchDoneResults.map((result) => ({
              xGmMsgId: result.xGmMsgId,
              embeddingHash: result.hash,
            }))
          );
          totalIndexed += batchDoneResults.length;
        }

        if (emails.length < EMAIL_BATCH_SIZE) {
          hasMore = false;
        }
      }

      if (workerError) {
        break;
      }
    }

    this.terminateWorker();

    if (workerError) {
      this.buildState = 'error';
      this.broadcastError(workerError);
    } else if (this.buildState === 'building') {
      this.buildState = 'idle';
      log.info(`[EmbeddingService] Incremental index complete. Embedded: ${totalIndexed}`);
      this.broadcastComplete();
    }
  }

  // ---- Worker management ----

  /**
   * Spawn the embedding worker thread. Sets error state and returns false on failure.
   * Sets this.worker on success.
   */
  private spawnWorker(embeddingModel: string, vectorDimension: number): boolean {
    const workerData: EmbeddingWorkerData = {
      ollamaBaseUrl: OllamaService.getInstance().getBaseUrl(),
      embeddingModel,
      vectorDbPath: this.vectorDbService.getDbPath(),
      vectorDimension,
      ollamaBatchSize: 32,
      sqliteVecExtensionPath: this.vectorDbService.getSqliteVecExtensionPath() ?? undefined,
    };

    const workerPath = path.join(__dirname, '..', 'workers', 'embedding-worker.js');

    try {
      this.worker = new Worker(workerPath, { workerData });
    } catch (err) {
      log.error('[EmbeddingService] Failed to spawn embedding worker:', err);
      this.buildState = 'error';
      this.broadcastError(err instanceof Error ? err.message : 'Failed to spawn worker');
      return false;
    }

    // Forward worker log messages to electron-log
    this.worker.on('message', (message: { type: string; level?: string; message?: string; data?: unknown }) => {
      if (message.type === 'log') {
        const level = (message.level ?? 'info') as 'info' | 'warn' | 'error' | 'debug';
        const logFn = (log[level] as ((msg: unknown, ...args: unknown[]) => void) | undefined) ?? log.info.bind(log);
        if (message.data !== undefined) {
          logFn(message.message, message.data);
        } else {
          logFn(message.message);
        }
      }
    });

    // Handle unexpected worker errors
    this.worker.on('error', (err: Error) => {
      log.error('[EmbeddingService] Worker thread error:', err);
      if (this.buildState === 'building') {
        this.buildState = 'error';
        this.broadcastError(err.message);
      }
    });

    return true;
  }

  /**
   * Send one batch to the worker and wait for the `batch-done` response.
   * Returns the results from the worker. Throws on worker error.
   *
   * @param batchItems - Emails to embed
   * @param totalInRun - Total emails in this build run (for progress display)
   * @param sentinelOffset - Number of sentinel-filtered emails already counted toward progress.
   *                         Added to the worker's own indexed count for accurate display.
   * @param isFirstBatch - True for the very first batch of this build (resets worker counter)
   */
  private sendBatchAndWait(
    batchItems: EmailBatchItem[],
    totalInRun: number,
    sentinelOffset: number,
    isFirstBatch: boolean
  ): Promise<BatchResult[]> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not available'));
        return;
      }

      // Timeout safety: reject after 10 minutes if no response
      const timeoutHandle = setTimeout(() => {
        this.worker?.removeListener('message', onMessage);
        reject(new Error('Batch processing timed out after 10 minutes'));
      }, 10 * 60 * 1000);

      const onMessage = (message: {
        type: string;
        results?: BatchResult[];
        indexed?: number;
        total?: number;
        percent?: number;
        message?: string;
      }) => {
        if (message.type === 'progress') {
          // Worker's indexed count (non-sentinel emails only); add sentinelOffset for accurate total
          const workerIndexed = message.indexed ?? 0;
          const totalIndexed = sentinelOffset + workerIndexed;
          this.currentBuildIndexed = totalIndexed;
          const percent = totalInRun > 0 ? Math.round((totalIndexed / totalInRun) * 100) : 0;
          this.broadcastProgress(totalIndexed, totalInRun, percent);
          return; // Keep listening
        }

        if (message.type === 'batch-done') {
          clearTimeout(timeoutHandle);
          this.worker?.removeListener('message', onMessage);
          resolve(message.results ?? []);
          return;
        }

        if (message.type === 'error') {
          clearTimeout(timeoutHandle);
          this.worker?.removeListener('message', onMessage);
          reject(new Error(message.message ?? 'Worker error'));
          return;
        }
        // 'log' messages are handled by the permanent listener set up in spawnWorker(); ignore here.
      };

      this.worker.on('message', onMessage);
      this.worker.postMessage({
        type: 'batch',
        emails: batchItems,
        total: totalInRun,
        firstBatch: isFirstBatch,
      });
    });
  }

  /**
   * Terminate the worker thread, if one is running.
   */
  private terminateWorker(): void {
    if (this.worker) {
      this.worker.postMessage({ type: 'cancel' });
      const workerRef = this.worker;
      this.worker = null;
      setTimeout(() => {
        workerRef.terminate().catch(() => {});
      }, 500);
    }
  }

  // ---- Incremental indexing ----

  /**
   * Run an incremental index when the app is idle (no recent IPC activity).
   * Called after body-fetch queue items complete via scheduleIncrementalIndex().
   */
  private async runIncrementalWhenIdle(): Promise<void> {
    const IDLE_THRESHOLD_MS = 30_000;

    const isBuilding = (): boolean => this.buildState === 'building';

    if (isBuilding()) {
      this.incrementalScheduled = false;
      return;
    }

    // Wait until idle — no mail:* or compose:* IPC activity in the last 30 seconds
    let waitCount = 0;
    while (Date.now() - getLastIpcActivityTimestamp() < IDLE_THRESHOLD_MS) {
      await sleep(5_000);
      waitCount++;
      if (waitCount > 60) {
        // Waited 5 minutes without becoming idle — give up
        this.incrementalScheduled = false;
        return;
      }
      if (isBuilding()) {
        this.incrementalScheduled = false;
        return;
      }
    }

    const ollama = OllamaService.getInstance();
    const embeddingModel = ollama.getEmbeddingModel();

    if (!embeddingModel || !this.vectorDbService.vectorsAvailable) {
      this.incrementalScheduled = false;
      return;
    }

    const vectorDimension = this.vectorDbService.getVectorDimension();
    if (!vectorDimension) {
      this.incrementalScheduled = false;
      return;
    }

    const db = DatabaseService.getInstance();
    const accounts = db.getAccounts().filter((account) => account.isActive);

    let hasAnyUnindexed = false;

    for (const account of accounts) {
      const needsIndexing = db.getEmailsNeedingVectorIndexing(account.id, 1);
      if (needsIndexing.length > 0) {
        hasAnyUnindexed = true;
        break;
      }
    }

    if (!hasAnyUnindexed) {
      log.debug('[EmbeddingService] Incremental index: nothing to embed');
      this.incrementalScheduled = false;
      return;
    }

    log.info('[EmbeddingService] Starting incremental index (idle mode)');
    this.buildState = 'building';

    try {
      await this.runIncrementalLoop(embeddingModel, vectorDimension);
    } finally {
      this.incrementalScheduled = false;
    }
  }

  // ---- Broadcast helpers ----

  private broadcastProgress(indexed: number, total: number, percent: number): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(EMBEDDING_PROGRESS_CHANNEL, { indexed, total, percent });
      }
    }
  }

  private broadcastComplete(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(EMBEDDING_COMPLETE_CHANNEL);
      }
    }
  }

  private broadcastError(message: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(EMBEDDING_ERROR_CHANNEL, { message });
      }
    }
  }

  private broadcastResume(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(EMBEDDING_RESUME_CHANNEL);
      }
    }
  }
}

// ---- Utility ----

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
