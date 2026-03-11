/**
 * suite-lifecycle.ts — Quiesce and restore protocol for backend test suites.
 *
 * Call quiesceAndRestore() in a Mocha beforeEach() or before() hook to
 * reset the system to a clean state before each test suite runs.
 *
 * Phase 1 scope:
 *   - Stop OllamaService health checks
 *   - Cancel MailQueueService retries
 *   - Disconnect IMAP connections
 *   - Close main DB → restore from template → reopen
 *   - Close vector DB → restore from template → reopen
 *   - Delete credential file
 *   - Clear attachment/BIMI/avatar cache directories
 *   - Clear TestEventBus history
 *
 * Phase 6 will add mock server reset integration.
 */

import * as fs from 'fs';
import * as path from 'path';
import { TestEventBus } from './test-event-bus';

/**
 * Reset the system to its clean template state.
 *
 * This must be called AFTER services are initialized (i.e., inside a Mocha
 * before()/beforeEach() hook, not at module scope).
 */
export async function quiesceAndRestore(): Promise<void> {
  // 0. Hard-reset SyncQueueBridge FIRST — before any other cleanup.
  //    resetForTesting() increments the generation counter (so in-flight
  //    enqueueSyncForAccount() calls abort after their next await), sets
  //    testSuspended=true (blocks new calls), AND clears the background
  //    setInterval (prevents a stale timer from firing onSyncTick() while
  //    the DB is being restored between suites).  Using resetForTesting()
  //    rather than the older suspendForTesting() is the key fix for the
  //    "SyncQueueBridge timer not fully reset" finding.
  try {
    const { SyncQueueBridge } = require('../../../electron/services/sync-queue-bridge') as typeof import('../../../electron/services/sync-queue-bridge');
    SyncQueueBridge.getInstance().resetForTesting();
  } catch (error) {
    console.warn('[quiesceAndRestore] Failed to reset SyncQueueBridge:', error);
  }

  // 1. Stop OllamaService health checks so no background fetch timers fire
  //    during test runs. Use dynamic require to avoid top-level service init.
  try {
    const { OllamaService } = require('../../../electron/services/ollama-service') as typeof import('../../../electron/services/ollama-service');
    OllamaService.getInstance().stopHealthChecks();
  } catch (error) {
    console.warn('[quiesceAndRestore] Failed to stop OllamaService health checks:', error);
  }

  // 2. Kill all in-flight and pending mail queue operations so they don't bleed
  //    into the next test. resetForTesting() kills fastq workers, clears all
  //    items, retry timers, and dedup keys — much stronger than cancelAllRetries().
  try {
    const { MailQueueService } = require('../../../electron/services/mail-queue-service') as typeof import('../../../electron/services/mail-queue-service');
    MailQueueService.getInstance().resetForTesting();
  } catch (error) {
    console.warn('[quiesceAndRestore] Failed to reset MailQueueService:', error);
  }

  // 2b. Reset BodyFetchQueueService — kills its fastq workers, sets isPaused so
  //     any in-flight worker fails fast on the next ensureDedicatedConnection()
  //     call, disconnects dedicated IMAP connections, and clears all tracking maps.
  //     This prevents body-fetch workers from the previous suite from writing to
  //     the freshly-restored DB or keeping stale IMAP connections open.
  //     isPaused is lifted by seedTestAccount() → BodyFetchQueueService.resumeFromTesting().
  try {
    const { BodyFetchQueueService } = require('../../../electron/services/body-fetch-queue-service') as typeof import('../../../electron/services/body-fetch-queue-service');
    BodyFetchQueueService.getInstance().resetForTesting();
  } catch (error) {
    console.warn('[quiesceAndRestore] Failed to reset BodyFetchQueueService:', error);
  }

  // 2c. Clear FilterService.processingAccounts.
  //     An in-flight syncAllMail worker (from the previous suite) may have called
  //     filterService.processNewEmails(accountId) and added accountId to
  //     processingAccounts just before resetForTesting() killed the fastq queue.
  //     Because fastq.kill() does NOT abort in-flight workers, the worker may still
  //     be running (or have exited without reaching the finally block that deletes
  //     from processingAccounts).  The next suite always uses accountId=1 (DB is
  //     reset to template each time), so a stale entry causes the guard to skip
  //     filter processing entirely — making is_filtered stay 0.
  try {
    const { FilterService } = require('../../../electron/services/filter-service') as typeof import('../../../electron/services/filter-service');
    FilterService.getInstance().resetForTesting();
  } catch (error) {
    console.warn('[quiesceAndRestore] Failed to reset FilterService:', error);
  }

  // 2d. Clear all PendingOpService entries. resetForTesting() above clears the
  //     MailQueueService items map, but PendingOpService is a separate singleton
  //     that is NOT cleared by resetForTesting(). If any move/delete operations
  //     from the previous suite registered pending ops, those entries will cause
  //     the next suite's sync to skip those xGmMsgIds (syncAllMail checks
  //     getPendingForThread before inserting). Clearing here ensures a clean
  //     slate for the new suite's sync.
  try {
    const { PendingOpService } = require('../../../electron/services/pending-op-service') as typeof import('../../../electron/services/pending-op-service');
    PendingOpService.getInstance().clearAll();
  } catch (error) {
    console.warn('[quiesceAndRestore] Failed to clear PendingOpService:', error);
  }

  // 3a. Reset SyncService IDLE state BEFORE disconnecting IMAP.
  //     When ImapService.disconnectAllAndClearPending() closes the underlying TCP
  //     connections, each IDLE connection fires its onClose callback.  Those callbacks
  //     call scheduleIdleReconnect() / scheduleIdleAllMailReconnect() — which would
  //     queue a reconnect timer for the next suite unless globalIdleSuppression is set.
  //     resetIdleStateForTesting() sets globalIdleSuppression=true and cancels any
  //     already-queued reconnect timers and clears stored callbacks, so the onClose
  //     callbacks that fire during step 3b become harmless no-ops.
  try {
    const { SyncService } = require('../../../electron/services/sync-service') as typeof import('../../../electron/services/sync-service');
    SyncService.getInstance().resetIdleStateForTesting();
  } catch (error) {
    console.warn('[quiesceAndRestore] Failed to reset SyncService IDLE state:', error);
  }

  // 3b. Disconnect all IMAP connections AND clear the pending-connection map.
  //     disconnectAll() drops live connections but leaves this.connecting populated;
  //     if a stale connect() promise is in-flight from the previous suite, the next
  //     connect() call would reuse it (wrong credentials). Clearing pending fixes that.
  try {
    const { ImapService } = require('../../../electron/services/imap-service') as typeof import('../../../electron/services/imap-service');
    await ImapService.getInstance().disconnectAllAndClearPending();
  } catch (error) {
    console.warn('[quiesceAndRestore] Failed to disconnect IMAP connections:', error);
  }

  const dbPath = process.env['DATABASE_PATH'];
  if (!dbPath) {
    throw new Error('[quiesceAndRestore] DATABASE_PATH env var is not set');
  }

  const templatePath = dbPath.replace('.test.db', '.test.template.db');
  const dbDir = path.dirname(dbPath);
  const vectorDbPath = path.join(dbDir, 'latentmail-vectors.db');
  const vectorTemplatePath = path.join(dbDir, 'latentmail-vectors.test.template.db');

  // 4. Close main DB, overwrite with template, reopen
  try {
    const { DatabaseService } = require('../../../electron/services/database-service') as typeof import('../../../electron/services/database-service');
    const dbService = DatabaseService.getInstance();
    dbService.close();

    if (fs.existsSync(templatePath)) {
      // Always delete stale WAL/SHM files first — a previous suite's stale WAL
      // can be replayed on reopen and corrupt isolation even if the template
      // does not have its own WAL/SHM sidecars.
      fs.rmSync(dbPath + '-wal', { force: true });
      fs.rmSync(dbPath + '-shm', { force: true });

      fs.copyFileSync(templatePath, dbPath);

      const templateWalPath = templatePath + '-wal';
      const templateShmPath = templatePath + '-shm';
      if (fs.existsSync(templateWalPath)) {
        fs.copyFileSync(templateWalPath, dbPath + '-wal');
      }
      if (fs.existsSync(templateShmPath)) {
        fs.copyFileSync(templateShmPath, dbPath + '-shm');
      }
    }

    await dbService.reopen(dbPath);
  } catch (error) {
    console.warn('[quiesceAndRestore] Failed to restore main database:', error);
    throw error;
  }

  // 5. Close vector DB, overwrite with template, reopen
  try {
    const { VectorDbService } = require('../../../electron/services/vector-db-service') as typeof import('../../../electron/services/vector-db-service');
    const vectorDbService = VectorDbService.getInstance();
    vectorDbService.close();

    if (fs.existsSync(vectorTemplatePath)) {
      // Always delete stale WAL/SHM files first before copying the template.
      fs.rmSync(vectorDbPath + '-wal', { force: true });
      fs.rmSync(vectorDbPath + '-shm', { force: true });

      fs.copyFileSync(vectorTemplatePath, vectorDbPath);

      const vectorTemplateWalPath = vectorTemplatePath + '-wal';
      const vectorTemplateShmPath = vectorTemplatePath + '-shm';
      if (fs.existsSync(vectorTemplateWalPath)) {
        fs.copyFileSync(vectorTemplateWalPath, vectorDbPath + '-wal');
      }
      if (fs.existsSync(vectorTemplateShmPath)) {
        fs.copyFileSync(vectorTemplateShmPath, vectorDbPath + '-shm');
      }
    }

    vectorDbService.reopen(vectorDbPath);
  } catch (error) {
    console.warn('[quiesceAndRestore] Failed to restore vector database:', error);
    // Non-fatal — vector DB may not be available in all environments
  }

  // 6. Clear credential file
  const credentialsFile = path.join(dbDir, 'credentials.enc');
  try {
    if (fs.existsSync(credentialsFile)) {
      fs.unlinkSync(credentialsFile);
    }
  } catch (error) {
    console.warn('[quiesceAndRestore] Failed to clear credentials file:', error);
  }

  // 7. Clear attachment, BIMI, and avatar cache directories
  const cacheDirs = [
    path.join(dbDir, 'attachments'),
    path.join(dbDir, 'bimi-cache'),
    path.join(dbDir, 'account-avatars'),
  ];

  for (const cacheDir of cacheDirs) {
    try {
      if (fs.existsSync(cacheDir)) {
        fs.rmSync(cacheDir, { recursive: true, force: true });
        fs.mkdirSync(cacheDir, { recursive: true });
      }
    } catch (error) {
      console.warn(`[quiesceAndRestore] Failed to clear cache directory ${cacheDir}:`, error);
    }
  }

  // 8. Clear TestEventBus history and listeners
  TestEventBus.getInstance().clear();

  // NOTE: MailQueueService, SyncQueueBridge, and BodyFetchQueueService remain in
  // "suspended/paused" state after this function returns. They are resumed by
  // seedTestAccount() once the DB and mock servers are fully configured for the
  // new suite. This ensures no lingering async callers from the previous suite can
  // pollute the new suite's queue state while still allowing all IPC calls after
  // seedTestAccount() to work normally.
}
