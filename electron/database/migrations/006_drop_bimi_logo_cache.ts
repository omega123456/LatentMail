import type { MigrationContext } from './001_initial_schema';

/**
 * Drop bimi_logo_cache table. BIMI logo URLs are no longer cached in the DB;
 * only the image files are cached on disk (userData/bimi-cache) with a 30-day TTL.
 */
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  context.db.run('DROP TABLE IF EXISTS bimi_logo_cache');
}

export async function down(): Promise<void> {
  // Recreating the table would require 005's schema; leave dropped for simplicity.
}
