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
  // 1. Stop OllamaService health checks so no background fetch timers fire
  //    during test runs. Use dynamic require to avoid top-level service init.
  try {
    const { OllamaService } = require('../../../electron/services/ollama-service') as typeof import('../../../electron/services/ollama-service');
    OllamaService.getInstance().stopHealthChecks();
  } catch (error) {
    console.warn('[quiesceAndRestore] Failed to stop OllamaService health checks:', error);
  }

  // 2. Cancel any queued mail operations so they don't bleed into the next test
  try {
    const { MailQueueService } = require('../../../electron/services/mail-queue-service') as typeof import('../../../electron/services/mail-queue-service');
    MailQueueService.getInstance().cancelAllRetries();
  } catch (error) {
    console.warn('[quiesceAndRestore] Failed to cancel MailQueueService retries:', error);
  }

  // 3. Disconnect all IMAP connections
  try {
    const { ImapService } = require('../../../electron/services/imap-service') as typeof import('../../../electron/services/imap-service');
    await ImapService.getInstance().disconnectAll();
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
}
