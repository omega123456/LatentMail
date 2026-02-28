import type { MigrationContext } from './001_initial_schema';

/**
 * Add embedding_hash TEXT column to the emails table.
 *
 * embedding_hash stores the first 16 hex characters of the SHA-256 hash of the
 * email's text_body (or html_body if text_body is absent). Used to track which
 * emails have been embedded into the vector index and to detect when a body
 * changes (requiring re-embedding on the next incremental run).
 *
 * NULL = not yet embedded (either indexing hasn't run, or the body is absent).
 */
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  context.db.run('ALTER TABLE emails ADD COLUMN embedding_hash TEXT');
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  // SQLite supports DROP COLUMN since version 3.35.0 (sql.js 1.14+ bundles 3.47+)
  context.db.run('ALTER TABLE emails DROP COLUMN embedding_hash');
}
