/**
 * EmbeddingService — main-thread orchestrator for the embedding pipeline.
 *
 * Responsibilities:
 * - Spawns and manages the embedding worker thread
 * - Queries DatabaseService for un-embedded emails and feeds them to the worker
 * - Receives batch-done results from worker and updates embedding_hash in main DB
 * - Forwards progress events to all renderer windows
 * - Handles build/cancel/status lifecycle
 * - Provides scheduleIncrementalIndex() for post-sync hooks
 *
 * Batch flow (sequential, one batch at a time):
 *   1. Main queries DB for a batch of un-embedded emails
 *   2. Main sends batch to worker via postMessage
 *   3. Worker chunks, embeds, stores vectors, sends back batch-done with results
 *   4. Main receives batch-done, updates embedding_hash in main DB
 *   5. Repeat until all emails are embedded
 *   6. Main terminates worker, broadcasts complete
 */

import { Worker } from 'worker_threads';
import * as path from 'path';
import * as crypto from 'crypto';
import { BrowserWindow } from 'electron';
import { LoggerService } from './logger-service';
import { DatabaseService } from './database-service';
import { VectorDbService } from './vector-db-service';
import { OllamaService } from './ollama-service';
import { getLastIpcActivityTimestamp } from '../ipc/ipc-activity-tracker';
import type { EmailBatchItem, EmbeddingWorkerData, BatchResult } from '../workers/embedding-worker';

const log = LoggerService.getInstance();

/** Batch size: number of emails fetched from DB and sent to worker at once. */
const EMAIL_BATCH_SIZE = 50;

/** Build state machine states. */
type BuildState = 'idle' | 'building' | 'error';

/** IPC channel names for embedding push events (mirrored here to avoid circular imports). */
const EMBEDDING_PROGRESS_CHANNEL = 'embedding:progress';
const EMBEDDING_COMPLETE_CHANNEL = 'embedding:complete';
const EMBEDDING_ERROR_CHANNEL = 'embedding:error';

export class EmbeddingService {
  private static instance: EmbeddingService;

  private vectorDbService: VectorDbService;
  private worker: Worker | null = null;
  private buildState: BuildState = 'idle';
  private incrementalScheduled: boolean = false;

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
   * Start a full index build.
   * Queries all un-embedded emails across all active accounts and sends them to the worker.
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
    log.info('[EmbeddingService] Starting full index build');

    this.runBuildLoop(embeddingModel, vectorDimension).catch((err) => {
      log.error('[EmbeddingService] Build loop failed unexpectedly:', err);
      this.buildState = 'error';
      this.broadcastError(err instanceof Error ? err.message : String(err));
    });
  }

  /**
   * Cancel an in-progress build.
   * Posts cancel to the worker and terminates it.
   */
  cancelBuild(): void {
    if (this.buildState !== 'building') {
      return;
    }

    log.info('[EmbeddingService] Cancelling index build');
    this.terminateWorker();
    this.buildState = 'idle';
  }

  /**
   * Notify EmbeddingService to check for un-embedded emails on its next idle cycle.
   * Called after a sync completes. Non-blocking (fire-and-forget).
   * Waits until no mail or compose IPC activity in the last 30 seconds before starting.
   */
  scheduleIncrementalIndex(): void {
    if (this.incrementalScheduled || this.buildState === 'building') {
      return;
    }

    this.incrementalScheduled = true;
    log.debug('[EmbeddingService] Incremental index scheduled after sync');

    setImmediate(() => {
      this.runIncrementalWhenIdle().catch((err) => {
        log.warn('[EmbeddingService] Incremental index failed:', err);
      });
    });
  }

  /**
   * Handle an embedding model change.
   * Clears all existing vectors, resets all embedding hashes, reconfigures with new dimension.
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
    db.resetAllEmbeddingHashes();

    log.info('[EmbeddingService] Model change complete — index cleared, re-index required');
  }

  // ---- Internal build loop ----

  /**
   * Main build loop: spawns the worker and feeds email batches until all are embedded
   * or the build is cancelled. Fully sequential — one batch at a time.
   */
  private async runBuildLoop(embeddingModel: string, vectorDimension: number): Promise<void> {
    const db = DatabaseService.getInstance();
    const accounts = db.getAccounts().filter((account) => account.is_active);

    if (accounts.length === 0) {
      log.info('[EmbeddingService] No active accounts — nothing to index');
      this.buildState = 'idle';
      return;
    }

    // Count total emails needing embedding across all accounts
    let totalToEmbed = 0;
    for (const account of accounts) {
      const counts = db.countEmbeddingStatus(account.id);
      totalToEmbed += counts.total - counts.embedded;
    }

    if (totalToEmbed === 0) {
      log.info('[EmbeddingService] All emails are already embedded');
      this.buildState = 'idle';
      this.broadcastComplete();
      return;
    }

    log.info(`[EmbeddingService] Building index: ${totalToEmbed} emails across ${accounts.length} accounts`);

    const workerData: EmbeddingWorkerData = {
      ollamaBaseUrl: OllamaService.getInstance().getBaseUrl(),
      embeddingModel,
      vectorDbPath: this.vectorDbService.getDbPath(),
      vectorDimension,
      ollamaBatchSize: 32,
    };

    const workerPath = path.join(__dirname, '..', 'workers', 'embedding-worker.js');

    try {
      this.worker = new Worker(workerPath, { workerData });
    } catch (err) {
      log.error('[EmbeddingService] Failed to spawn embedding worker:', err);
      this.buildState = 'error';
      this.broadcastError(err instanceof Error ? err.message : 'Failed to spawn worker');
      return;
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

    // Process all accounts sequentially
    let totalIndexed = 0;
    let workerError: string | null = null;

    for (const account of accounts) {
      if (this.buildState !== 'building') {
        break;
      }

      let hasMore = true;
      while (hasMore && this.buildState === 'building') {
        const emails = db.getEmailsNeedingEmbedding(account.id, EMAIL_BATCH_SIZE);

        if (emails.length === 0) {
          hasMore = false;
          break;
        }

        // Compute hashes on main thread
        const batchItems: EmailBatchItem[] = emails.map((email) => {
          const bodyContent = email.textBody ?? email.htmlBody ?? '';
          const hash = crypto.createHash('sha256').update(bodyContent).digest('hex').slice(0, 16);
          return {
            xGmMsgId: email.xGmMsgId,
            accountId: email.accountId,
            subject: email.subject,
            textBody: email.textBody,
            htmlBody: email.htmlBody,
            hash,
          };
        });

        // Send batch and wait for results
        let batchDoneResults: BatchResult[] = [];
        let batchError: string | null = null;

        try {
          batchDoneResults = await this.sendBatchAndWait(batchItems, totalToEmbed, totalIndexed);
        } catch (err) {
          batchError = err instanceof Error ? err.message : String(err);
          log.error('[EmbeddingService] Batch processing error:', batchError);
          workerError = batchError;
          break;
        }

        // Update embedding hashes in main DB
        if (batchDoneResults.length > 0) {
          const updates = batchDoneResults.map((result) => ({
            xGmMsgId: result.xGmMsgId,
            hash: result.hash,
          }));
          try {
            db.batchUpdateEmbeddingHash(account.id, updates);
          } catch (err) {
            log.warn('[EmbeddingService] Failed to update embedding hashes:', err);
          }
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

    // Terminate the worker now that all batches are processed
    this.terminateWorker();

    if (workerError) {
      this.buildState = 'error';
      this.broadcastError(workerError);
    } else if (this.buildState === 'building') {
      this.buildState = 'idle';
      log.info(`[EmbeddingService] Full index build complete. Total indexed: ${totalIndexed}`);
      this.broadcastComplete();
    }
    // If buildState was changed to 'idle' by cancelBuild() during the loop, we just exit cleanly.
  }

  /**
   * Send one batch to the worker and wait for the `batch-done` response.
   * Returns the results from the worker. Throws on worker error.
   *
   * @param batchItems - Emails to embed
   * @param totalInRun - Total emails in this run (for progress display)
   * @param indexedSoFar - Emails indexed before this batch
   */
  private sendBatchAndWait(
    batchItems: EmailBatchItem[],
    totalInRun: number,
    indexedSoFar: number
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
          // Forward progress to renderer
          const indexed = (indexedSoFar + (message.indexed ?? 0));
          const percent = totalInRun > 0 ? Math.round((indexed / totalInRun) * 100) : 0;
          this.broadcastProgress(indexed, totalInRun, percent);
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
        // 'log' messages are handled by the permanent listener; ignore here.
      };

      this.worker.on('message', onMessage);
      this.worker.postMessage({ type: 'batch', emails: batchItems, total: totalInRun });
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
   * Called after sync cycles via scheduleIncrementalIndex().
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
    const accounts = db.getAccounts().filter((account) => account.is_active);
    let hasAnyUnembedded = false;

    for (const account of accounts) {
      const counts = db.countEmbeddingStatus(account.id);
      if (counts.total > counts.embedded) {
        hasAnyUnembedded = true;
        break;
      }
    }

    if (!hasAnyUnembedded) {
      log.debug('[EmbeddingService] Incremental index: nothing to embed');
      this.incrementalScheduled = false;
      return;
    }

    log.info('[EmbeddingService] Starting incremental index (idle mode)');
    this.buildState = 'building';

    try {
      await this.runBuildLoop(embeddingModel, vectorDimension);
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
}

// ---- Utility ----

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
