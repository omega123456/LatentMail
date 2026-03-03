import type BetterSqlite3 from 'better-sqlite3';
import { getInitialSchemaForMigrations } from '../schema';

export interface MigrationContext {
  db: BetterSqlite3.Database;
  databaseService: unknown;
}

export async function up({ context }: { context: MigrationContext }): Promise<void> {
  const schema = getInitialSchemaForMigrations();
  context.db.exec(schema);
}

export async function down(): Promise<void> {
  // No-op for initial migration; down not required for first iteration.
}
