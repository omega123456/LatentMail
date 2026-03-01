/**
 * Embedding Worker Thread
 *
 * Runs off the main Electron process thread to handle the CPU/IO-intensive
 * embedding pipeline: chunking email text → HTTP calls to Ollama /api/embed
 * → writing vectors to the vector DB via better-sqlite3.
 *
 * Communication protocol (via parentPort messages):
 *
 * Main → Worker:
 *   { type: 'batch', emails: EmailBatchItem[] }
 *   { type: 'cancel' }
 *   { type: 'pause' }
 *   { type: 'resume' }
 *
 * Worker → Main:
 *   { type: 'progress', indexed: number, total: number, percent: number }
 *   { type: 'batch-done', results: BatchResult[] }
 *   { type: 'error', message: string }
 *   { type: 'complete' }
 *   { type: 'log', level: 'info' | 'warn' | 'error' | 'debug', message: string, data?: unknown }
 */

import { workerData, parentPort } from 'worker_threads';
import type BetterSqlite3 from 'better-sqlite3';
import { chunkEmailBody } from '../utils/text-chunker';

// ---- Types ----

export interface EmbeddingWorkerData {
  /** Ollama base URL (e.g. 'http://localhost:11434') */
  ollamaBaseUrl: string;
  /** Embedding model name (e.g. 'nomic-embed-text') */
  embeddingModel: string;
  /** Path to the vector DB file (latentmail-vectors.db) */
  vectorDbPath: string;
  /** Current vector dimension (must match the model's output dimension) */
  vectorDimension: number;
  /** Number of text chunks to embed per Ollama API call */
  ollamaBatchSize: number;
  /** Path to sqlite-vec extension binary (required for vec0 virtual table) */
  sqliteVecExtensionPath?: string;
}

export interface EmailBatchItem {
  xGmMsgId: string;
  accountId: number;
  subject: string;
  textBody: string | null;
  htmlBody: string | null;
  /** SHA-256 hash of the body content (computed on main thread) */
  hash: string;
}

export interface BatchResult {
  xGmMsgId: string;
  hash: string;
}

// ---- Worker state ----

const config = workerData as EmbeddingWorkerData;
let isCancelled = false;
let isPaused = false;
let db: BetterSqlite3.Database | null = null;

// ---- Helpers ----

function postLog(level: 'info' | 'warn' | 'error' | 'debug', message: string, data?: unknown): void {
  parentPort?.postMessage({ type: 'log', level, message, data });
}

function postProgress(indexed: number, total: number): void {
  const percent = total > 0 ? Math.round((indexed / total) * 100) : 0;
  parentPort?.postMessage({ type: 'progress', indexed, total, percent });
}

/** Initialize the better-sqlite3 connection to the vector DB. */
function initVectorDb(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3');
  db = new BetterSqlite3(config.vectorDbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  if (config.sqliteVecExtensionPath) {
    db.loadExtension(config.sqliteVecExtensionPath);
  }
}

/** Wait until unpaused (polls every 500ms). */
async function waitWhilePaused(): Promise<void> {
  while (isPaused && !isCancelled) {
    await sleep(500);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Call Ollama /api/embed for a batch of text strings.
 * Retries up to 3 times on connection failure with exponential backoff (5s / 15s / 45s).
 * Returns a 2D array (one vector per input string).
 */
async function callOllamaEmbed(texts: string[]): Promise<number[][]> {
  const retryDelaysMs = [5_000, 15_000, 45_000];
  const payload = { model: config.embeddingModel, input: texts };

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000);

      const response = await fetch(`${config.ollamaBaseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Ollama embed HTTP ${response.status}: ${body.slice(0, 200)}`);
      }

      const data = await response.json() as { embeddings: number[][] };
      if (!Array.isArray(data.embeddings)) {
        throw new Error('Ollama embed response missing embeddings array');
      }
      return data.embeddings;
    } catch (err) {
      const isLastAttempt = attempt >= retryDelaysMs.length;
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (isLastAttempt) {
        throw new Error(`Ollama embed failed after ${retryDelaysMs.length + 1} attempts: ${errorMessage}`);
      }

      const delayMs = retryDelaysMs[attempt];
      postLog('warn', `Ollama embed attempt ${attempt + 1} failed, retrying in ${delayMs / 1000}s: ${errorMessage}`);
      await sleep(delayMs);

      if (isCancelled) {
        throw new Error('Cancelled during retry backoff');
      }
    }
  }

  // TypeScript needs this, even though the loop above always throws or returns.
  throw new Error('Unexpected error in callOllamaEmbed');
}

/**
 * Insert embedding chunks for one email into the vector DB.
 * Uses a transaction to keep email_embeddings and embedding_metadata rowids in sync.
 */
function insertChunks(
  accountId: number,
  xGmMsgId: string,
  chunks: Array<{ chunkIndex: number; chunkText: string; embedding: number[] }>
): void {
  if (!db) {
    throw new Error('Vector DB not initialized');
  }

  const insertVector = db.prepare('INSERT INTO email_embeddings(embedding) VALUES (?)');
  const insertMetadata = db.prepare(
    `INSERT INTO embedding_metadata (rowid, account_id, x_gm_msgid, chunk_index, chunk_text)
     VALUES (:rowid, :accountId, :xGmMsgId, :chunkIndex, :chunkText)`
  );
  const getLastRowid = db.prepare('SELECT last_insert_rowid() AS rowid');

  const runTransaction = db.transaction(() => {
    for (const chunk of chunks) {
      const float32Buffer = Buffer.from(new Float32Array(chunk.embedding).buffer);
      insertVector.run(float32Buffer);
      const rowidResult = getLastRowid.get() as { rowid: number };
      insertMetadata.run({
        rowid: rowidResult.rowid,
        accountId,
        xGmMsgId,
        chunkIndex: chunk.chunkIndex,
        chunkText: chunk.chunkText,
      });
    }
  });

  runTransaction();
}

/**
 * Delete existing embedding chunks for an email before re-embedding.
 * Cleans up both the vec0 rows and metadata rows.
 */
function deleteExistingChunks(accountId: number, xGmMsgId: string): void {
  if (!db) {
    return;
  }

  const rowids = db
    .prepare('SELECT rowid FROM embedding_metadata WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId')
    .all({ accountId, xGmMsgId }) as Array<{ rowid: number }>;

  if (rowids.length === 0) {
    return;
  }

  const deleteVector = db.prepare('DELETE FROM email_embeddings WHERE rowid = :rowid');
  const deleteMetadata = db.prepare(
    'DELETE FROM embedding_metadata WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId'
  );

  const runTransaction = db.transaction(() => {
    for (const row of rowids) {
      deleteVector.run({ rowid: row.rowid });
    }
    deleteMetadata.run({ accountId, xGmMsgId });
  });

  runTransaction();
}

/**
 * Process a single email: chunk, embed (in sub-batches), store vectors.
 * Returns the hash on success, or null if the email should be skipped.
 */
async function processEmail(email: EmailBatchItem): Promise<BatchResult | null> {
  const chunks = chunkEmailBody(email.textBody, email.htmlBody, email.subject);

  if (chunks.length === 0) {
    postLog('debug', `[EmbeddingWorker] No chunks for email ${email.xGmMsgId} — skipping`);
    return null;
  }

  // Remove any stale chunks for this email before inserting new ones
  deleteExistingChunks(email.accountId, email.xGmMsgId);

  // Embed chunks in sub-batches of ollamaBatchSize
  const allEmbeddings: number[][] = [];

  for (let chunkStart = 0; chunkStart < chunks.length; chunkStart += config.ollamaBatchSize) {
    if (isCancelled) {
      return null;
    }
    await waitWhilePaused();

    const subBatch = chunks.slice(chunkStart, chunkStart + config.ollamaBatchSize);
    const embeddings = await callOllamaEmbed(subBatch);
    allEmbeddings.push(...embeddings);
  }

  // Validate dimensions
  for (const embedding of allEmbeddings) {
    if (embedding.length !== config.vectorDimension) {
      postLog('warn',
        `[EmbeddingWorker] Embedding dimension mismatch for ${email.xGmMsgId}: ` +
        `expected ${config.vectorDimension}, got ${embedding.length}. Skipping.`
      );
      return null;
    }
  }

  // Store all chunks in the vector DB
  const chunkData = chunks.map((chunkText, index) => ({
    chunkIndex: index,
    chunkText,
    embedding: allEmbeddings[index],
  }));

  insertChunks(email.accountId, email.xGmMsgId, chunkData);

  return { xGmMsgId: email.xGmMsgId, hash: email.hash };
}

// ---- Message handler ----

// Track overall indexed count across batches for progress reporting
let totalEmailsInRun = 0;
let indexedSoFar = 0;

parentPort?.on('message', async (message: { type: string; emails?: EmailBatchItem[]; total?: number; firstBatch?: boolean }) => {
  if (message.type === 'cancel') {
    isCancelled = true;
    postLog('info', '[EmbeddingWorker] Cancellation received');
    return;
  }

  if (message.type === 'pause') {
    isPaused = true;
    postLog('info', '[EmbeddingWorker] Paused');
    return;
  }

  if (message.type === 'resume') {
    isPaused = false;
    postLog('info', '[EmbeddingWorker] Resumed');
    return;
  }

  if (message.type === 'batch' && message.emails) {
    // Start of a new build: main sends firstBatch only on the first batch of each build
    if (message.firstBatch) {
      if (message.total !== undefined) {
        totalEmailsInRun = message.total;
      }
      indexedSoFar = 0;
    }

    const batchResults: BatchResult[] = [];

    for (const email of message.emails) {
      if (isCancelled) {
        break;
      }

      await waitWhilePaused();

      try {
        const result = await processEmail(email);
        if (result) {
          batchResults.push(result);
          indexedSoFar++;
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        // Check if this is a connection-level failure (retries exhausted)
        if (errorMessage.includes('after') && errorMessage.includes('attempts')) {
          postLog('error', `[EmbeddingWorker] Ollama connection lost: ${errorMessage}`);
          parentPort?.postMessage({ type: 'error', message: errorMessage });
          return;
        }

        // Skip this email and continue with the next one
        postLog('warn', `[EmbeddingWorker] Failed to embed email ${email.xGmMsgId}: ${errorMessage}`);
      }

      // Post progress after each email
      postProgress(indexedSoFar, totalEmailsInRun);
    }

    // Report batch results back to main thread so it can write to vector_indexed_emails in main DB
    parentPort?.postMessage({ type: 'batch-done', results: batchResults });
  }
});

// ---- Startup ----

try {
  initVectorDb();
  postLog('info', `[EmbeddingWorker] Started. Model: ${config.embeddingModel}, Dim: ${config.vectorDimension}`);
} catch (err) {
  const errorMessage = err instanceof Error ? err.message : String(err);
  postLog('error', `[EmbeddingWorker] Failed to initialize vector DB: ${errorMessage}`);
  parentPort?.postMessage({ type: 'error', message: `Worker init failed: ${errorMessage}` });
}

