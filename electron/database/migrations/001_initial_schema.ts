import type { Database } from 'sql.js';
import { getInitialSchemaForMigrations } from '../schema';

export interface MigrationContext {
  db: Database;
  databaseService: unknown;
}

export async function up({ context }: { context: MigrationContext }): Promise<void> {
  const sql = getInitialSchemaForMigrations();
  context.db.exec(sql);
}

export async function down(): Promise<void> {
  // No-op for initial migration; down not required for first iteration.
}
