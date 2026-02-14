import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import log from 'electron-log/main';
import { CREATE_TABLES_SQL, SCHEMA_VERSION } from '../database/schema';

export class DatabaseService {
  private static instance: DatabaseService;
  private db: SqlJsDatabase | null = null;
  private dbPath: string = '';
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor() {}

  static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService();
    }
    return DatabaseService.instance;
  }

  private getDbPath(): string {
    if (process.env['DATABASE_PATH']) {
      return process.env['DATABASE_PATH'];
    }
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, 'mailclient.db');
  }

  async initialize(): Promise<void> {
    this.dbPath = this.getDbPath();
    log.info(`Initializing database at: ${this.dbPath}`);

    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Initialize sql.js with the WASM binary from node_modules
    const wasmPath = path.join(
      app.getAppPath(),
      'node_modules',
      'sql.js',
      'dist',
      'sql-wasm.wasm'
    );

    const SQL = await initSqlJs({
      locateFile: () => wasmPath,
    });

    // Load existing database or create new one
    if (fs.existsSync(this.dbPath)) {
      const fileBuffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(fileBuffer);
      log.info('Loaded existing database');
    } else {
      this.db = new SQL.Database();
      log.info('Created new database');
    }

    // Enable foreign keys
    this.db.run('PRAGMA foreign_keys = ON');

    // Run schema creation
    this.db.run(CREATE_TABLES_SQL);

    // Check and run migrations
    this.runMigrations();

    // Save to disk
    this.saveToDisk();

    log.info('Database schema initialized');
  }

  private runMigrations(): void {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.exec('SELECT version FROM schema_version LIMIT 1');
    const versionRow = result.length > 0 && result[0].values.length > 0
      ? { version: result[0].values[0][0] as number }
      : undefined;

    if (!versionRow) {
      this.db.run('INSERT INTO schema_version (version) VALUES (?)', [SCHEMA_VERSION]);
      log.info(`Database schema version set to ${SCHEMA_VERSION}`);
    } else if (versionRow.version < SCHEMA_VERSION) {
      log.info(`Migrating database from version ${versionRow.version} to ${SCHEMA_VERSION}`);
      this.db.run('UPDATE schema_version SET version = ?', [SCHEMA_VERSION]);
    }
  }

  /** Persist the in-memory database to disk */
  saveToDisk(): void {
    if (!this.db) return;
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
    } catch (err) {
      log.error('Failed to save database to disk:', err);
    }
  }

  /** Schedule a debounced save (avoids writing on every single mutation) */
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveToDisk(), 1000);
  }

  getDatabase(): SqlJsDatabase {
    if (!this.db) throw new Error('Database not initialized');
    return this.db;
  }

  // Settings operations
  getSetting(key: string): string | null {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec('SELECT value FROM settings WHERE key = ?', [key]);
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0] as string;
    }
    return null;
  }

  setSetting(key: string, value: string, scope: string = 'global'): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      'INSERT INTO settings (key, value, scope) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value, scope]
    );
    this.scheduleSave();
  }

  getAllSettings(): Record<string, string> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec('SELECT key, value FROM settings');
    const settings: Record<string, string> = {};
    if (result.length > 0) {
      for (const row of result[0].values) {
        settings[row[0] as string] = row[1] as string;
      }
    }
    return settings;
  }

  // Account operations
  getAccounts(): Array<{ id: number; email: string; display_name: string; avatar_url: string | null; is_active: number }> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec('SELECT id, email, display_name, avatar_url, is_active FROM accounts WHERE is_active = 1');
    if (result.length === 0) return [];
    return result[0].values.map((row: (string | number | Uint8Array | null)[]) => ({
      id: row[0] as number,
      email: row[1] as string,
      display_name: row[2] as string,
      avatar_url: row[3] as string | null,
      is_active: row[4] as number,
    }));
  }

  close(): void {
    if (this.db) {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      this.saveToDisk();
      this.db.close();
      this.db = null;
      log.info('Database closed');
    }
  }
}
