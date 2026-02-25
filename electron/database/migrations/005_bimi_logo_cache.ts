import type { MigrationContext } from './001_initial_schema';

/**
 * Create bimi_logo_cache table for caching BIMI logo URLs per sender domain.
 * Positive cache (logo URL): TTL 30 days. Negative cache (no BIMI): TTL 24 hours.
 */
export async function up({ context }: { context: MigrationContext }): Promise<void> {
  const db = context.db;
  db.run(`
    CREATE TABLE IF NOT EXISTS bimi_logo_cache (
      domain TEXT PRIMARY KEY,
      logo_url TEXT NOT NULL,
      cached_at TEXT NOT NULL
    )
  `);
}

export async function down(): Promise<void> {
  // No-op: table can remain for simplicity; drop would require context.db from caller.
}
