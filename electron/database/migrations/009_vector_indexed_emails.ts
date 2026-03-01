import type { MigrationContext } from './001_initial_schema';

/**
 * Create the vector_indexed_emails table as the single source of truth for
 * which emails have been embedded into the vector index.
 *
 * Replaces the emails.embedding_hash column approach:
 *   - embedding_hash on emails only tracked locally-synced emails
 *   - vector_indexed_emails supports the full-mailbox IMAP crawler, which
 *     embeds emails fetched directly from IMAP (fetch → embed → discard)
 *     without requiring them to be stored in the emails table first
 *
 * Schema:
 *   x_gm_msgid   TEXT NOT NULL — stable Gmail message identifier
 *   account_id   INTEGER NOT NULL — account the email belongs to
 *   embedding_hash TEXT NOT NULL — SHA-256 hash (first 16 hex chars) of the
 *     embedded body content. Sentinel value 'SKIPPED_FILTERED' is used for
 *     Spam/Trash/Draft emails that were filtered during the crawl.
 *   PRIMARY KEY (x_gm_msgid, account_id)
 *
 * Migration preserves existing embedding state: rows with non-null, non-empty
 * embedding_hash are migrated from emails → vector_indexed_emails.
 */
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  // Step 1: Create the vector_indexed_emails table
  context.db.exec(`
    CREATE TABLE IF NOT EXISTS vector_indexed_emails (
      x_gm_msgid    TEXT    NOT NULL,
      account_id    INTEGER NOT NULL,
      embedding_hash TEXT   NOT NULL,
      PRIMARY KEY (x_gm_msgid, account_id),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    )
  `);

  // Step 2: Migrate existing embedding_hash data from emails table.
  // Only rows with non-null, non-empty embedding_hash are migrated.
  // INSERT OR IGNORE handles any edge-case duplicates.
  context.db.exec(`
    INSERT OR IGNORE INTO vector_indexed_emails (x_gm_msgid, account_id, embedding_hash)
    SELECT x_gm_msgid, account_id, embedding_hash
    FROM emails
    WHERE embedding_hash IS NOT NULL AND embedding_hash != ''
  `);

  // Step 3: Add an index on account_id for efficient per-account queries.
  // The composite PK is (x_gm_msgid, account_id), so filtering by account_id
  // alone would cause a full table scan at scale without this index.
  context.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_vector_indexed_emails_account_id
      ON vector_indexed_emails(account_id)
  `);

  // Step 4: Drop the embedding_hash column from emails.
  // SQLite supports DROP COLUMN since 3.35.0 (sql.js 1.14+ bundles 3.47+).
  context.db.exec('ALTER TABLE emails DROP COLUMN embedding_hash');
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  // Step 1: Re-add embedding_hash column to emails
  context.db.exec('ALTER TABLE emails ADD COLUMN embedding_hash TEXT');

  // Step 2: Migrate data back from vector_indexed_emails to emails.
  // Only migrate rows with a real hash (not the SKIPPED_FILTERED sentinel).
  context.db.exec(`
    UPDATE emails
    SET embedding_hash = (
      SELECT vie.embedding_hash
      FROM vector_indexed_emails vie
      WHERE vie.x_gm_msgid = emails.x_gm_msgid
        AND vie.account_id = emails.account_id
        AND vie.embedding_hash != 'SKIPPED_FILTERED'
    )
    WHERE EXISTS (
      SELECT 1
      FROM vector_indexed_emails vie
      WHERE vie.x_gm_msgid = emails.x_gm_msgid
        AND vie.account_id = emails.account_id
        AND vie.embedding_hash != 'SKIPPED_FILTERED'
    )
  `);

  // Step 3: Drop the vector_indexed_emails table
  context.db.exec('DROP TABLE IF EXISTS vector_indexed_emails');
}
