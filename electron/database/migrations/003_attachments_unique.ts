import type { MigrationContext } from './001_initial_schema';

const INDEX_NAME = 'idx_attachments_email_filename_contentid';

/**
 * Deduplicate attachment rows and add a unique index so INSERT OR IGNORE
 * in upsertAttachmentsForEmail() skips existing rows on re-sync.
 * Identity: (email_id, filename, COALESCE(content_id, '')).
 */
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  const db = context.db;

  // Step A: Keep one row per (email_id, filename, COALESCE(content_id, '')); delete the rest.
  db.run(
    `CREATE TEMP TABLE _attachments_keep AS
     SELECT MIN(id) AS id FROM attachments
     GROUP BY email_id, filename, COALESCE(content_id, '')`
  );
  db.run(`DELETE FROM attachments WHERE id NOT IN (SELECT id FROM _attachments_keep)`);
  db.run(`DROP TABLE _attachments_keep`);

  // Step B: Enforce uniqueness so future INSERT OR IGNORE skips duplicates.
  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME} ON attachments (email_id, filename, COALESCE(content_id, ''))`
  );
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  context.db.run(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
}
