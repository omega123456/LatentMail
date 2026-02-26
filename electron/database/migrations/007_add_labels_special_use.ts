import type { MigrationContext } from './001_initial_schema';

/**
 * Add special_use TEXT column to labels table.
 * Stores the RFC 6154 mailbox attribute (e.g. '\Trash', '\Sent') from ImapFlow mb.specialUse.
 * Nullable — user-created labels have NULL. Populated on next sync via upsertLabelsFromMailboxes.
 */
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  context.db.run('ALTER TABLE labels ADD COLUMN special_use TEXT');
}

export async function down({ context }: { context: MigrationContext }): Promise<void> {
  // SQLite does not support DROP COLUMN in older versions; leave as-is on rollback.
  void context;
}
