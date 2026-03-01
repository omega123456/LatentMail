import * as path from 'path';
import { app } from 'electron';
import type BetterSqlite3 from 'better-sqlite3';
import { isWindows, isMacOS, isLinux, isX64, isArm64 } from '../utils/platform';
import { LoggerService } from './logger-service';

const log = LoggerService.getInstance();

/**
 * Result from a vector similarity search.
 */
export interface VectorSearchResult {
  /** Stable email identifier (x_gm_msgid from the main DB). */
  xGmMsgId: string;
  /** Account ID the email belongs to. */
  accountId: number;
  /** Index of the chunk within the email. */
  chunkIndex: number;
  /** Cosine similarity score (0.0 to 1.0; higher = more similar). */
  similarity: number;
  /** The chunk text content (for debugging). */
  chunkText: string;
}

/**
 * Input for inserting a set of embedding chunks for one email.
 */
export interface InsertChunksInput {
  accountId: number;
  xGmMsgId: string;
  chunks: Array<{
    chunkIndex: number;
    chunkText: string;
    embedding: number[];
  }>;
}

/**
 * VectorDbService manages a dedicated better-sqlite3 database for storing
 * email chunk embeddings via the sqlite-vec extension.
 *
 * Stored at: <userData>/latentmail-vectors.db
 *
 * Schema:
 * - vec_config: metadata (current model name, vector dimension)
 * - email_embeddings: sqlite-vec vec0 virtual table (float32 vectors)
 * - embedding_metadata: chunk text, x_gm_msgid, account_id, chunk_index (rowid-aligned with email_embeddings)
 *
 * Graceful degradation: if sqlite-vec fails to load, vectorsAvailable is set to false
 * and all operations become no-ops. The app continues functioning without semantic search.
 */
export class VectorDbService {
  private static instance: VectorDbService;

  /** Whether the sqlite-vec extension loaded successfully and is available. */
  vectorsAvailable: boolean = false;

  private db: BetterSqlite3.Database | null = null;
  private dbPath: string = '';
  private sqliteVecExtensionPath: string | null = null;
  private currentDimension: number | null = null;
  private currentModel: string | null = null;

  private constructor() {}

  static getInstance(): VectorDbService {
    if (!VectorDbService.instance) {
      VectorDbService.instance = new VectorDbService();
    }
    return VectorDbService.instance;
  }

  /**
   * Returns the path to the vector DB file (for worker thread access).
   */
  getDbPath(): string {
    return this.dbPath;
  }

  /**
   * Returns the path to the sqlite-vec extension binary, or null if not loaded.
   * Used by the embedding worker to load the extension into its own DB connection.
   */
  getSqliteVecExtensionPath(): string | null {
    return this.sqliteVecExtensionPath;
  }

  /**
   * Initialize the vector database. Opens (or creates) the better-sqlite3 DB file,
   * loads the sqlite-vec extension, and creates the schema tables.
   *
   * This must be called once on app startup, after the main DB is initialized.
   * On failure, vectorsAvailable is set to false and all operations become no-ops.
   */
  initialize(): void {
    try {
      this.dbPath = this.resolveDbPath();
      log.info(`[VectorDbService] Opening vector database at: ${this.dbPath}`);

      // Require better-sqlite3 dynamically to avoid issues if it's not built
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3');
      this.db = new BetterSqlite3(this.dbPath);

      // Load the sqlite-vec extension
      this.loadSqliteVec();
      if (!this.vectorsAvailable) {
        this.db.close();
        this.db = null;
        return;
      }

      // Configure for performance
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');

      // Create schema tables
      this.createSchema();

      // Load existing configuration
      this.loadConfig();

      log.info(
        `[VectorDbService] Initialized successfully. ` +
        `Model: ${this.currentModel ?? 'none'}, Dimension: ${this.currentDimension ?? 'none'}`
      );
    } catch (error) {
      log.warn('[VectorDbService] Initialization failed — semantic search will be unavailable:', error);
      this.vectorsAvailable = false;
      this.db = null;
    }
  }

  /**
   * Resolve the user-data path for the vector database file.
   */
  private resolveDbPath(): string {
    if (process.env['DATABASE_PATH']) {
      // In test environments, use the same directory as the main DB
      return path.join(path.dirname(process.env['DATABASE_PATH']), 'latentmail-vectors.db');
    }
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, 'latentmail-vectors.db');
  }

  /**
   * Load the sqlite-vec extension into better-sqlite3.
   * Tries the sqlite-vec package's own load() helper first (works in dev),
   * then falls back to a production asar-unpacked path.
   *
   * Sets vectorsAvailable based on success.
   */
  private loadSqliteVec(): void {
    if (!this.db) {
      return;
    }

    // Strategy 1: Use sqlite-vec's own getLoadablePath() to find the extension binary.
    // This works in development where node_modules is available.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sqliteVec = require('sqlite-vec') as { load: (db: BetterSqlite3.Database) => void; getLoadablePath: () => string };
      sqliteVec.load(this.db);
      this.sqliteVecExtensionPath = sqliteVec.getLoadablePath();
      log.info(`[VectorDbService] sqlite-vec extension loaded via package helper (${this.sqliteVecExtensionPath})`);
      this.vectorsAvailable = true;
      return;
    } catch (error) {
      log.debug('[VectorDbService] sqlite-vec package helper failed, trying production path:', error);
    }

    // Strategy 2: Production path — extension is in app.asar.unpacked/node_modules/sqlite-vec-*/
    // The platform-specific package name determines the extension file name.
    try {
      const extensionPath = this.resolveProductionExtensionPath();
      if (extensionPath) {
        this.db.loadExtension(extensionPath);
        this.sqliteVecExtensionPath = extensionPath;
        log.info(`[VectorDbService] sqlite-vec extension loaded from production path: ${extensionPath}`);
        this.vectorsAvailable = true;
        return;
      }
    } catch (error) {
      log.debug('[VectorDbService] Production path extension load failed:', error);
    }

    log.warn(
      '[VectorDbService] Failed to load sqlite-vec extension. ' +
      'Semantic search will be unavailable. ' +
      'Ensure sqlite-vec is installed and native binaries are accessible.'
    );
    this.vectorsAvailable = false;
  }

  /**
   * Resolve the sqlite-vec extension binary path for packaged (production) builds.
   * Returns null if the path cannot be determined.
   *
   * In packaged builds, node_modules is inside app.asar, but native binaries are
   * unpacked to app.asar.unpacked/node_modules/sqlite-vec-<platform>/.
   */
  private resolveProductionExtensionPath(): string | null {
    // Determine platform-specific package name and extension filename
    const platformPackage = this.getSqliteVecPlatformPackage();
    if (!platformPackage) {
      return null;
    }

    // The extension file (e.g. vec0.dll on Windows, vec0.so on Linux, vec0.dylib on macOS)
    const extensionFilename = this.getSqliteVecExtensionFilename();
    if (!extensionFilename) {
      return null;
    }

    // Production path: app.asar.unpacked/node_modules/<platform-package>/<filename>
    const resourcesPath = process.resourcesPath || '';
    const productionPath = path.join(
      resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      platformPackage,
      extensionFilename
    );

    return productionPath;
  }

  /**
   * Get the platform-specific sqlite-vec npm package name.
   */
  private getSqliteVecPlatformPackage(): string | null {
    if (isWindows() && isX64()) {
      return 'sqlite-vec-windows-x64';
    }
    if (isMacOS() && isArm64()) {
      return 'sqlite-vec-darwin-arm64';
    }
    if (isMacOS() && isX64()) {
      return 'sqlite-vec-darwin-x64';
    }
    if (isLinux() && isArm64()) {
      return 'sqlite-vec-linux-arm64';
    }
    if (isLinux() && isX64()) {
      return 'sqlite-vec-linux-x64';
    }

    log.warn(`[VectorDbService] Unsupported platform/arch: ${process.platform}/${process.arch}`);
    return null;
  }

  /**
   * Get the sqlite-vec extension file name for the current platform.
   */
  private getSqliteVecExtensionFilename(): string | null {
    if (isWindows()) {
      return 'vec0.dll';
    }
    if (isMacOS()) {
      return 'vec0.dylib';
    }
    if (isLinux()) {
      return 'vec0.so';
    }

    return null;
  }

  /**
   * Create the schema tables in the vector database if they don't already exist.
   */
  private createSchema(): void {
    if (!this.db) {
      return;
    }

    // Metadata table for configuration
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vec_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Metadata table for chunk content and email linkage
    // rowid is kept in sync with email_embeddings rowid
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_metadata (
        rowid INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL,
        x_gm_msgid TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        chunk_text TEXT NOT NULL
      )
    `);

    // Index for fast lookups by (account_id, x_gm_msgid)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_embedding_metadata_msgid
      ON embedding_metadata (account_id, x_gm_msgid)
    `);

    // Note: email_embeddings vec0 virtual table is created on-demand when the
    // first embedding model is configured, because its dimension is model-dependent.
  }

  /**
   * Load existing configuration from the vec_config table.
   */
  private loadConfig(): void {
    if (!this.db) {
      return;
    }

    try {
      const modelRow = this.db
        .prepare('SELECT value FROM vec_config WHERE key = :key')
        .get({ key: 'embedding_model' }) as { value: string } | undefined;

      const dimensionRow = this.db
        .prepare('SELECT value FROM vec_config WHERE key = :key')
        .get({ key: 'vector_dimension' }) as { value: string } | undefined;

      this.currentModel = modelRow?.value ?? null;
      this.currentDimension = dimensionRow ? parseInt(dimensionRow.value, 10) : null;
    } catch {
      // Table may be empty on first run — that's fine
      this.currentModel = null;
      this.currentDimension = null;
    }
  }

  /**
   * Get the currently configured vector dimension, or null if not set.
   */
  getVectorDimension(): number | null {
    return this.currentDimension;
  }

  /**
   * Get the currently configured embedding model name, or null if not set.
   */
  getCurrentModel(): string | null {
    return this.currentModel;
  }

  /**
   * Configure the vector dimension and model.
   * If the dimension changes from the existing one, drops and recreates the vec0 table.
   * This is called when the user selects a new embedding model.
   *
   * @param model - Embedding model name (e.g. 'nomic-embed-text')
   * @param dimension - Vector dimension produced by the model
   */
  configureModel(model: string, dimension: number): void {
    if (!this.vectorsAvailable || !this.db) {
      return;
    }

    const dimensionChanged = this.currentDimension !== null && this.currentDimension !== dimension;

    if (dimensionChanged) {
      log.info(
        `[VectorDbService] Vector dimension changed from ${this.currentDimension} to ${dimension}. ` +
        'Dropping and recreating vec0 table.'
      );
      this.dropVec0Table();
    } else if (this.currentDimension === null) {
      // Safety check: if vec_config was missing or cleared (e.g., corruption, manual DB edit)
      // but the email_embeddings table already exists, we drop it to avoid dimension mismatch.
      const orphanTableExists = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='email_embeddings'")
        .get() as { name: string } | undefined;

      if (orphanTableExists) {
        log.warn(
          '[VectorDbService] email_embeddings table found without vec_config metadata. ' +
          'Dropping and recreating to ensure dimension consistency.'
        );
        this.dropVec0Table();
      }
    }

    // Create or recreate the vec0 table with the correct dimension
    this.ensureVec0Table(dimension);

    // Persist configuration
    this.db.prepare(
      'INSERT INTO vec_config (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run({ key: 'embedding_model', value: model });

    this.db.prepare(
      'INSERT INTO vec_config (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run({ key: 'vector_dimension', value: String(dimension) });

    this.db.prepare(
      'INSERT INTO vec_config (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run({ key: 'created_at', value: new Date().toISOString() });

    this.currentModel = model;
    this.currentDimension = dimension;

    log.info(`[VectorDbService] Model configured: ${model} (dim=${dimension})`);
  }

  /**
   * Ensure the email_embeddings vec0 virtual table exists with the given dimension.
   * If it already exists with the correct dimension, does nothing.
   */
  private ensureVec0Table(dimension: number): void {
    if (!this.db) {
      return;
    }

    // Check if the vec0 table already exists
    const tableExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='email_embeddings'")
      .get() as { name: string } | undefined;

    if (!tableExists) {
      this.db.exec(`
        CREATE VIRTUAL TABLE email_embeddings USING vec0(
          embedding float[${dimension}] distance_metric=cosine
        )
      `);
      log.info(`[VectorDbService] Created email_embeddings vec0 table (dim=${dimension})`);
    }
  }

  /**
   * Drop the email_embeddings vec0 virtual table and clear all embedding_metadata rows.
   * Called when switching to a model with a different vector dimension.
   */
  private dropVec0Table(): void {
    if (!this.db) {
      return;
    }

    try {
      this.db.exec('DROP TABLE IF EXISTS email_embeddings');
      this.db.exec('DELETE FROM embedding_metadata');
      log.info('[VectorDbService] Dropped email_embeddings table and cleared metadata');
    } catch (error) {
      log.error('[VectorDbService] Failed to drop vec0 table:', error);
      throw error;
    }
  }

  /**
   * Clear all vectors and metadata from the database.
   * Called when the user switches embedding models (requires a full re-index).
   * Also drops and recreates the vec0 table with the new dimension.
   *
   * @param newModel - The new model name
   * @param newDimension - The new vector dimension
   */
  clearAllAndReconfigure(newModel: string, newDimension: number): void {
    if (!this.vectorsAvailable || !this.db) {
      return;
    }

    this.dropVec0Table();
    this.configureModel(newModel, newDimension);

    log.info(`[VectorDbService] Cleared all vectors and reconfigured for model: ${newModel}`);
  }

  /**
   * Insert embedding chunks for an email. All chunks are inserted in a single transaction.
   * The rowid of each email_embeddings row is kept in sync with embedding_metadata.rowid
   * by using last_insert_rowid() within the same transaction.
   *
   * @param input - Email chunk data and embeddings
   * @throws if vectorsAvailable is false or vec0 table is not initialized
   */
  insertChunks(input: InsertChunksInput): void {
    if (!this.vectorsAvailable || !this.db) {
      return;
    }

    if (!this.currentDimension) {
      log.warn('[VectorDbService] insertChunks called before model is configured — skipping');
      return;
    }

    const insertVector = this.db.prepare(
      'INSERT INTO email_embeddings(embedding) VALUES (?)'
    );

    const insertMetadata = this.db.prepare(
      `INSERT INTO embedding_metadata (rowid, account_id, x_gm_msgid, chunk_index, chunk_text)
       VALUES (:rowid, :accountId, :xGmMsgId, :chunkIndex, :chunkText)`
    );

    const getLastRowid = this.db.prepare('SELECT last_insert_rowid() AS rowid');

    const runTransaction = this.db.transaction((chunks: InsertChunksInput['chunks']) => {
      for (const chunk of chunks) {
        // Convert number[] to Float32Array for sqlite-vec's float[N] column
        const float32Buffer = Buffer.from(new Float32Array(chunk.embedding).buffer);
        insertVector.run(float32Buffer);

        const rowidResult = getLastRowid.get() as { rowid: number };
        insertMetadata.run({
          rowid: rowidResult.rowid,
          accountId: input.accountId,
          xGmMsgId: input.xGmMsgId,
          chunkIndex: chunk.chunkIndex,
          chunkText: chunk.chunkText,
        });
      }
    });

    runTransaction(input.chunks);
  }

  /**
   * Delete all embedding chunks for a specific email (by x_gm_msgid and account_id).
   * Removes both the embedding_metadata rows and the corresponding vec0 rows.
   *
   * @param accountId - Account ID the email belongs to
   * @param xGmMsgId - Stable Gmail message ID
   */
  deleteByXGmMsgId(accountId: number, xGmMsgId: string): void {
    if (!this.vectorsAvailable || !this.db) {
      return;
    }

    // Get rowids to delete from vec0
    const rowids = this.db
      .prepare(
        'SELECT rowid FROM embedding_metadata WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId'
      )
      .all({ accountId, xGmMsgId }) as Array<{ rowid: number }>;

    if (rowids.length === 0) {
      return;
    }

    const deleteVectors = this.db.prepare('DELETE FROM email_embeddings WHERE rowid = :rowid');
    const deleteMetadata = this.db.prepare(
      'DELETE FROM embedding_metadata WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId'
    );

    const runTransaction = this.db.transaction(() => {
      for (const row of rowids) {
        deleteVectors.run({ rowid: row.rowid });
      }
      deleteMetadata.run({ accountId, xGmMsgId });
    });

    runTransaction();
  }

  /**
   * Delete all embedding chunks for a specific account.
   * Called when an account is deleted from the app.
   *
   * @param accountId - Account ID whose embeddings should be removed
   */
  deleteByAccountId(accountId: number): void {
    if (!this.vectorsAvailable || !this.db) {
      return;
    }

    // Get all rowids for this account
    const rowids = this.db
      .prepare('SELECT rowid FROM embedding_metadata WHERE account_id = :accountId')
      .all({ accountId }) as Array<{ rowid: number }>;

    if (rowids.length === 0) {
      return;
    }

    const deleteVectors = this.db.prepare('DELETE FROM email_embeddings WHERE rowid = :rowid');
    const deleteMetadata = this.db.prepare(
      'DELETE FROM embedding_metadata WHERE account_id = :accountId'
    );

    const runTransaction = this.db.transaction(() => {
      for (const row of rowids) {
        deleteVectors.run({ rowid: row.rowid });
      }
      deleteMetadata.run({ accountId });
    });

    runTransaction();

    log.info(`[VectorDbService] Deleted all embeddings for account ${accountId}`);
  }

  /**
   * Run a cosine similarity search against the stored embeddings.
   * Returns the top-N results sorted by similarity descending.
   *
   * @param queryEmbedding - The query vector (must match current vector dimension)
   * @param accountId - Filter results to this account
   * @param topN - Maximum number of results to return
   * @returns Array of search results sorted by similarity descending
   */
  search(queryEmbedding: number[], accountId: number, topN: number = 100): VectorSearchResult[] {
    if (!this.vectorsAvailable || !this.db || !this.currentDimension) {
      return [];
    }

    if (queryEmbedding.length !== this.currentDimension) {
      log.warn(
        `[VectorDbService] Query embedding dimension (${queryEmbedding.length}) ` +
        `does not match configured dimension (${this.currentDimension}). Skipping search.`
      );
      return [];
    }

    try {
      // Check if the vec0 table exists before searching
      const tableExists = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='email_embeddings'")
        .get() as { name: string } | undefined;

      if (!tableExists) {
        return [];
      }

      const queryBuffer = Buffer.from(new Float32Array(queryEmbedding).buffer);

      // sqlite-vec cosine similarity search with join to embedding_metadata for account filtering.
      // The distance column in vec0 is cosine distance (lower = more similar).
      // We fetch topN * 3 from the KNN index to have enough candidates after the account JOIN filter.
      // The final result is sliced to topN after the JOIN.
      // Similarity = 1 - cosine_distance.
      const rows = this.db.prepare(`
        SELECT
          m.x_gm_msgid,
          m.account_id,
          m.chunk_index,
          m.chunk_text,
          v.distance
        FROM email_embeddings v
        JOIN embedding_metadata m ON m.rowid = v.rowid
        WHERE v.embedding MATCH :query
          AND v.k = :topK
          AND m.account_id = :accountId
        ORDER BY v.distance ASC
      `).all({
        query: queryBuffer,
        topK: topN * 3, // Over-fetch to account for account-filter reduction after the JOIN
        accountId,
      }) as Array<{
        x_gm_msgid: string;
        account_id: number;
        chunk_index: number;
        chunk_text: string;
        distance: number;
      }>;

      // Cap results at the requested topN limit
      const cappedRows = rows.slice(0, topN);

      return cappedRows.map((row) => ({
        xGmMsgId: row.x_gm_msgid,
        accountId: row.account_id,
        chunkIndex: row.chunk_index,
        chunkText: row.chunk_text,
        // Convert cosine distance to cosine similarity
        similarity: 1 - row.distance,
      }));
    } catch (error) {
      log.error('[VectorDbService] Search failed:', error);
      return [];
    }
  }

  /**
   * Count the total number of unique emails that have at least one embedding chunk.
   *
   * @param accountId - Account ID to count for (or undefined for all accounts)
   * @returns Number of unique x_gm_msgid values in the metadata table
   */
  countIndexedEmails(accountId?: number): number {
    if (!this.vectorsAvailable || !this.db) {
      return 0;
    }

    try {
      if (accountId !== undefined) {
        const result = this.db
          .prepare('SELECT COUNT(DISTINCT x_gm_msgid) AS count FROM embedding_metadata WHERE account_id = :accountId')
          .get({ accountId }) as { count: number };
        return result?.count ?? 0;
      } else {
        const result = this.db
          .prepare('SELECT COUNT(DISTINCT x_gm_msgid) AS count FROM embedding_metadata')
          .get() as { count: number };
        return result?.count ?? 0;
      }
    } catch {
      return 0;
    }
  }

  /**
   * Close the database connection. Called on app shutdown.
   */
  close(): void {
    if (this.db) {
      try {
        this.db.close();
        log.info('[VectorDbService] Database connection closed');
      } catch (error) {
        log.warn('[VectorDbService] Error closing database:', error);
      }
      this.db = null;
    }
    this.vectorsAvailable = false;
  }
}
