import type { MigrationContext } from './001_initial_schema';

/**
 * Add `updated_at` column to the `emails` table.
 *
 * Used by orphan-cleanup functions to implement a 1-hour grace period: emails
 * recently inserted or updated (e.g. discovered by IMAP search but without a
 * folder-link) survive cleanup until the grace period expires.
 *
 * Migration steps:
 *   1. Add column as nullable (SQLite ALTER TABLE ADD COLUMN cannot have a
 *      non-constant default or NOT NULL without a default on older SQLite).
 *   2. Backfill existing rows from `created_at` so they don't appear "brand new"
 *      and aren't kept alive by the grace period unnecessarily.
 *
 * Application code (`upsertEmail`, `updateEmailFlags`, `markEmailsAsFiltered`)
 * always writes `datetime('now')` into `updated_at` for new and updated rows.
 *
 * Down: no-op — column removal requires SQLite 3.35+ (`ALTER TABLE DROP COLUMN`);
 * leaving the column in place is safe and avoids version-gating the migration.
 */
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  const db = context.db;

  // Step 1: Add the column as nullable.
  db.run('ALTER TABLE emails ADD COLUMN updated_at TEXT');

  // Step 2: Backfill all existing rows with their created_at timestamp so they
  // are not treated as recently-touched and incorrectly protected by the grace period.
  db.run('UPDATE emails SET updated_at = created_at WHERE updated_at IS NULL');
}

export async function down(): Promise<void> {
  // No-op: DROP COLUMN requires SQLite 3.35+; safer to leave the column in place.
}
