import type { Database } from 'sql.js';

/**
 * Umzug storage adapter for sql.js.
 * Uses table schema_migrations (name TEXT PRIMARY KEY).
 */
export function createSqlJsStorage(db: Database) {
  return {
    async executed(): Promise<string[]> {
      try {
        const result = db.exec('SELECT name FROM schema_migrations');
        if (result.length === 0 || result[0].values.length === 0) {
          return [];
        }
        return result[0].values.map((row) => String(row[0]));
      } catch {
        return [];
      }
    },

    async logMigration(params: { name: string }): Promise<void> {
      db.run('INSERT INTO schema_migrations (name) VALUES (:name)', { ':name': params.name });
    },

    async unlogMigration(params: { name: string }): Promise<void> {
      db.run('DELETE FROM schema_migrations WHERE name = :name', { ':name': params.name });
    },
  };
}
