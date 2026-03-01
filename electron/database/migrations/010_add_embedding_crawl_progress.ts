import type { MigrationContext } from './001_initial_schema';

/**
 * Create the embedding_crawl_progress table for UID-based resume on interrupt.
 *
 * Stores one row per account tracking:
 *   - last_uid: the maximum UID from the last fully committed batch (in All Mail).
 *     On resume, IMAP search uses `UID <last_uid+1>:*` to skip already-processed UIDs.
 *   - build_interrupted: 1 = build was interrupted (crash/close), 0 = idle or user-cancelled.
 *     This is the auto-resume signal — set at build start, cleared on completion or cancel.
 *   - updated_at: ISO 8601 timestamp of the last cursor update.
 *
 * The row is removed when a build completes successfully for an account.
 * ON DELETE CASCADE ensures cleanup when the account is removed.
 */
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  context.db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_crawl_progress (
      account_id        INTEGER NOT NULL,
      last_uid          INTEGER NOT NULL DEFAULT 0,
      build_interrupted INTEGER NOT NULL DEFAULT 0,
      updated_at        TEXT    NOT NULL,
      PRIMARY KEY (account_id),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    )
  `);
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  context.db.exec('DROP TABLE IF EXISTS embedding_crawl_progress');
}
