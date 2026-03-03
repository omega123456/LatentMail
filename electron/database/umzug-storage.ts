import type BetterSqlite3 from 'better-sqlite3';

/**
 * Umzug storage adapter for better-sqlite3.
 * Uses table schema_migrations (name TEXT PRIMARY KEY).
 */
export function createBetterSqlite3Storage(db: BetterSqlite3.Database) {
  return {
    async executed(): Promise<string[]> {
      try {
        const rows = db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[];
        return rows.map((row) => row.name);
      } catch {
        return [];
      }
    },

    async logMigration(params: { name: string }): Promise<void> {
      db.prepare('INSERT INTO schema_migrations (name) VALUES (:name)').run({ name: params.name });
    },

    async unlogMigration(params: { name: string }): Promise<void> {
      db.prepare('DELETE FROM schema_migrations WHERE name = :name').run({ name: params.name });
    },
  };
}
