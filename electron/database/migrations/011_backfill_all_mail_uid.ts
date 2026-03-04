import type { MigrationContext } from './001_initial_schema';

export async function up({ context }: { context: MigrationContext }): Promise<void> {
  context.db.prepare('DELETE FROM folder_state WHERE folder = :folder').run({ folder: '[Gmail]/All Mail' });
}

export async function down(_: { context: MigrationContext }): Promise<void> {
  // No-op: re-syncing All Mail is idempotent; there is nothing meaningful to restore.
}
