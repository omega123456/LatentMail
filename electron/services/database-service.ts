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
    let currentVersion: number =
      result.length > 0 && result[0].values.length > 0
        ? (result[0].values[0][0] as number)
        : 0;

    if (currentVersion === 0) {
      this.db.run('INSERT INTO schema_version (version) VALUES (?)', [SCHEMA_VERSION]);
      log.info(`Database schema version set to ${SCHEMA_VERSION}`);
      return;
    }

    while (currentVersion < SCHEMA_VERSION) {
      const nextVersion = currentVersion + 1;
      log.info(`Migrating database from version ${currentVersion} to ${nextVersion}`);

      if (nextVersion === 2) {
        this.migrateTo2();
      }

      this.db.run('UPDATE schema_version SET version = ?', [nextVersion]);
      currentVersion = nextVersion;
    }
  }

  /** Migration 1 → 2: add needs_reauth to accounts if missing */
  private migrateTo2(): void {
    if (!this.db) return;
    const pragma = this.db.exec('PRAGMA table_info(accounts)');
    const columns = pragma.length > 0 ? pragma[0].values.map((row) => row[1] as string) : [];
    if (!columns.includes('needs_reauth')) {
      this.db.run('ALTER TABLE accounts ADD COLUMN needs_reauth INTEGER NOT NULL DEFAULT 0');
      log.info('Added needs_reauth column to accounts');
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
  getAccounts(): Array<{ id: number; email: string; display_name: string; avatar_url: string | null; is_active: number; needs_reauth: number }> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec('SELECT id, email, display_name, avatar_url, is_active, needs_reauth FROM accounts WHERE is_active = 1');
    if (result.length === 0) return [];
    return result[0].values.map((row: (string | number | Uint8Array | null)[]) => ({
      id: row[0] as number,
      email: row[1] as string,
      display_name: row[2] as string,
      avatar_url: row[3] as string | null,
      is_active: row[4] as number,
      needs_reauth: (row[5] as number) || 0,
    }));
  }

  getAccountById(id: number): { id: number; email: string; display_name: string; avatar_url: string | null; is_active: number; needs_reauth: number } | null {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec('SELECT id, email, display_name, avatar_url, is_active, needs_reauth FROM accounts WHERE id = ?', [id]);
    if (result.length === 0 || result[0].values.length === 0) return null;
    const row = result[0].values[0];
    return {
      id: row[0] as number,
      email: row[1] as string,
      display_name: row[2] as string,
      avatar_url: row[3] as string | null,
      is_active: row[4] as number,
      needs_reauth: (row[5] as number) || 0,
    };
  }

  createAccount(email: string, displayName: string, avatarUrl: string | null): number {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      'INSERT INTO accounts (email, display_name, avatar_url, is_active) VALUES (?, ?, ?, 1)',
      [email, displayName, avatarUrl]
    );
    // Get the last inserted rowid
    const result = this.db.exec('SELECT last_insert_rowid()');
    const id = result[0].values[0][0] as number;
    this.scheduleSave();
    return id;
  }

  updateAccount(id: number, displayName: string, avatarUrl: string | null): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      'UPDATE accounts SET display_name = ?, avatar_url = ?, needs_reauth = 0, updated_at = datetime(\'now\') WHERE id = ?',
      [displayName, avatarUrl, id]
    );
    this.scheduleSave();
  }

  deleteAccount(id: number): void {
    if (!this.db) throw new Error('Database not initialized');
    // CASCADE will handle emails, threads, labels, filters
    this.db.run('DELETE FROM accounts WHERE id = ?', [id]);
    this.scheduleSave();
    log.info(`Deleted account ${id} and all related data`);
  }

  setAccountNeedsReauth(id: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('UPDATE accounts SET needs_reauth = 1, updated_at = datetime(\'now\') WHERE id = ?', [id]);
    this.scheduleSave();
  }

  getAccountCount(): number {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec('SELECT COUNT(*) FROM accounts WHERE is_active = 1');
    if (result.length === 0) return 0;
    return result[0].values[0][0] as number;
  }

  // ---- Email operations ----

  upsertEmail(email: {
    accountId: number;
    gmailMessageId: string;
    gmailThreadId: string;
    folder: string;
    fromAddress: string;
    fromName?: string;
    toAddresses: string;
    ccAddresses?: string;
    bccAddresses?: string;
    subject?: string;
    textBody?: string;
    htmlBody?: string;
    date: string;
    isRead: boolean;
    isStarred: boolean;
    isImportant: boolean;
    snippet?: string;
    size?: number;
    hasAttachments: boolean;
    labels?: string;
  }): number {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      `INSERT INTO emails (account_id, gmail_message_id, gmail_thread_id, folder, from_address, from_name,
        to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body, date,
        is_read, is_starred, is_important, snippet, size, has_attachments, labels)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, gmail_message_id) DO UPDATE SET
        folder = excluded.folder, from_address = excluded.from_address, from_name = excluded.from_name,
        to_addresses = excluded.to_addresses, cc_addresses = excluded.cc_addresses, bcc_addresses = excluded.bcc_addresses,
        subject = excluded.subject, text_body = COALESCE(excluded.text_body, text_body),
        html_body = COALESCE(excluded.html_body, html_body), date = excluded.date,
        is_read = excluded.is_read, is_starred = excluded.is_starred, is_important = excluded.is_important,
        snippet = excluded.snippet, size = excluded.size, has_attachments = excluded.has_attachments,
        labels = excluded.labels`,
      [
        email.accountId, email.gmailMessageId, email.gmailThreadId, email.folder,
        email.fromAddress, email.fromName || '', email.toAddresses,
        email.ccAddresses || '', email.bccAddresses || '', email.subject || '',
        email.textBody || '', email.htmlBody || '', email.date,
        email.isRead ? 1 : 0, email.isStarred ? 1 : 0, email.isImportant ? 1 : 0,
        email.snippet || '', email.size || 0, email.hasAttachments ? 1 : 0,
        email.labels || '',
      ]
    );
    const result = this.db.exec('SELECT last_insert_rowid()');
    const id = result[0].values[0][0] as number;
    this.scheduleSave();
    return id;
  }

  getEmailsByFolder(
    accountId: number,
    folder: string,
    limit: number = 50,
    offset: number = 0
  ): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, gmail_message_id, gmail_thread_id, folder, from_address, from_name,
        to_addresses, cc_addresses, bcc_addresses, subject, snippet, date,
        is_read, is_starred, is_important, size, has_attachments, labels
       FROM emails WHERE account_id = ? AND folder = ?
       ORDER BY date DESC LIMIT ? OFFSET ?`,
      [accountId, folder, limit, offset]
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => this.mapEmailRow(row, result[0].columns));
  }

  getEmailsByThreadId(accountId: number, gmailThreadId: string): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, gmail_message_id, gmail_thread_id, folder, from_address, from_name,
        to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body, snippet, date,
        is_read, is_starred, is_important, size, has_attachments, labels
       FROM emails WHERE account_id = ? AND gmail_thread_id = ?
       ORDER BY date ASC`,
      [accountId, gmailThreadId]
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => this.mapEmailRow(row, result[0].columns));
  }

  getEmailById(id: number): Record<string, unknown> | null {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, gmail_message_id, gmail_thread_id, folder, from_address, from_name,
        to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body, snippet, date,
        is_read, is_starred, is_important, size, has_attachments, labels
       FROM emails WHERE id = ?`,
      [id]
    );
    if (result.length === 0 || result[0].values.length === 0) return null;
    return this.mapEmailRow(result[0].values[0], result[0].columns);
  }

  updateEmailFlags(
    accountId: number,
    gmailMessageId: string,
    flags: { isRead?: boolean; isStarred?: boolean; isImportant?: boolean }
  ): void {
    if (!this.db) throw new Error('Database not initialized');
    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (flags.isRead !== undefined) {
      updates.push('is_read = ?');
      values.push(flags.isRead ? 1 : 0);
    }
    if (flags.isStarred !== undefined) {
      updates.push('is_starred = ?');
      values.push(flags.isStarred ? 1 : 0);
    }
    if (flags.isImportant !== undefined) {
      updates.push('is_important = ?');
      values.push(flags.isImportant ? 1 : 0);
    }

    if (updates.length === 0) return;

    values.push(accountId, gmailMessageId);
    this.db.run(
      `UPDATE emails SET ${updates.join(', ')} WHERE account_id = ? AND gmail_message_id = ?`,
      values
    );
    this.scheduleSave();
  }

  deleteEmailsByAccount(accountId: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('DELETE FROM emails WHERE account_id = ?', [accountId]);
    this.scheduleSave();
  }

  // ---- Thread operations ----

  upsertThread(thread: {
    accountId: number;
    gmailThreadId: string;
    subject?: string;
    lastMessageDate: string;
    participants?: string;
    messageCount: number;
    snippet?: string;
    folder: string;
    isRead: boolean;
    isStarred: boolean;
  }): number {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      `INSERT INTO threads (account_id, gmail_thread_id, subject, last_message_date, participants,
        message_count, snippet, folder, is_read, is_starred, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(account_id, gmail_thread_id) DO UPDATE SET
        subject = excluded.subject, last_message_date = excluded.last_message_date,
        participants = excluded.participants, message_count = excluded.message_count,
        snippet = excluded.snippet, folder = excluded.folder,
        is_read = excluded.is_read, is_starred = excluded.is_starred,
        updated_at = datetime('now')`,
      [
        thread.accountId, thread.gmailThreadId, thread.subject || '',
        thread.lastMessageDate, thread.participants || '', thread.messageCount,
        thread.snippet || '', thread.folder, thread.isRead ? 1 : 0, thread.isStarred ? 1 : 0,
      ]
    );
    const result = this.db.exec('SELECT last_insert_rowid()');
    const id = result[0].values[0][0] as number;
    this.scheduleSave();
    return id;
  }

  getThreadsByFolder(
    accountId: number,
    folder: string,
    limit: number = 50,
    offset: number = 0
  ): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, gmail_thread_id, subject, last_message_date, participants,
        message_count, snippet, folder, is_read, is_starred
       FROM threads WHERE account_id = ? AND folder = ?
       ORDER BY last_message_date DESC LIMIT ? OFFSET ?`,
      [accountId, folder, limit, offset]
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => this.mapThreadRow(row, result[0].columns));
  }

  getThreadById(accountId: number, gmailThreadId: string): Record<string, unknown> | null {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, gmail_thread_id, subject, last_message_date, participants,
        message_count, snippet, folder, is_read, is_starred
       FROM threads WHERE account_id = ? AND gmail_thread_id = ?`,
      [accountId, gmailThreadId]
    );
    if (result.length === 0 || result[0].values.length === 0) return null;
    return this.mapThreadRow(result[0].values[0], result[0].columns);
  }

  // ---- Label/Folder operations ----

  upsertLabel(label: {
    accountId: number;
    gmailLabelId: string;
    name: string;
    type: string;
    color?: string;
    unreadCount: number;
    totalCount: number;
  }): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      `INSERT INTO labels (account_id, gmail_label_id, name, type, color, unread_count, total_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, gmail_label_id) DO UPDATE SET
        name = excluded.name, type = excluded.type, color = excluded.color,
        unread_count = excluded.unread_count, total_count = excluded.total_count`,
      [label.accountId, label.gmailLabelId, label.name, label.type,
       label.color || null, label.unreadCount, label.totalCount]
    );
    this.scheduleSave();
  }

  getLabelsByAccount(accountId: number): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, gmail_label_id, name, type, color, unread_count, total_count
       FROM labels WHERE account_id = ? ORDER BY type ASC, name ASC`,
      [accountId]
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => ({
      id: row[0] as number,
      accountId: row[1] as number,
      gmailLabelId: row[2] as string,
      name: row[3] as string,
      type: row[4] as string,
      color: row[5] as string | null,
      unreadCount: row[6] as number,
      totalCount: row[7] as number,
    }));
  }

  updateLabelCounts(accountId: number, gmailLabelId: string, unreadCount: number, totalCount: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      'UPDATE labels SET unread_count = ?, total_count = ? WHERE account_id = ? AND gmail_label_id = ?',
      [unreadCount, totalCount, accountId, gmailLabelId]
    );
    this.scheduleSave();
  }

  // ---- Contact operations ----

  upsertContact(email: string, displayName?: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      `INSERT INTO contacts (email, display_name, frequency, last_contacted_at, updated_at)
       VALUES (?, ?, 1, datetime('now'), datetime('now'))
       ON CONFLICT(email) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, display_name),
        frequency = frequency + 1,
        last_contacted_at = datetime('now'),
        updated_at = datetime('now')`,
      [email, displayName || null]
    );
    this.scheduleSave();
  }

  // ---- Search operations ----

  upsertSearchIndex(emailId: number, subject: string, body: string, fromName: string, fromAddress: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      `INSERT INTO search_index (email_id, subject, body, from_name, from_address)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(email_id) DO UPDATE SET
        subject = excluded.subject, body = excluded.body,
        from_name = excluded.from_name, from_address = excluded.from_address`,
      [emailId, subject, body, fromName, fromAddress]
    );
    // Don't schedule save for search index — let the caller batch saves
  }

  searchEmails(accountId: number, query: string, limit: number = 50): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');
    const likeQuery = `%${query}%`;
    const result = this.db.exec(
      `SELECT e.id, e.account_id, e.gmail_message_id, e.gmail_thread_id, e.folder,
        e.from_address, e.from_name, e.to_addresses, e.subject, e.snippet, e.date,
        e.is_read, e.is_starred, e.is_important, e.size, e.has_attachments, e.labels
       FROM emails e
       WHERE e.account_id = ? AND (
         e.subject LIKE ? OR e.from_address LIKE ? OR e.from_name LIKE ?
         OR e.to_addresses LIKE ? OR e.text_body LIKE ?
       )
       ORDER BY e.date DESC LIMIT ?`,
      [accountId, likeQuery, likeQuery, likeQuery, likeQuery, likeQuery, limit]
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => this.mapEmailRow(row, result[0].columns));
  }

  // ---- Account sync state ----

  updateAccountSyncState(accountId: number, lastSyncAt: string, syncCursor?: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      `UPDATE accounts SET last_sync_at = ?, sync_cursor = ?, updated_at = datetime('now') WHERE id = ?`,
      [lastSyncAt, syncCursor || null, accountId]
    );
    this.scheduleSave();
  }

  getAccountSyncState(accountId: number): { lastSyncAt: string | null; syncCursor: string | null } {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      'SELECT last_sync_at, sync_cursor FROM accounts WHERE id = ?',
      [accountId]
    );
    if (result.length === 0 || result[0].values.length === 0) {
      return { lastSyncAt: null, syncCursor: null };
    }
    return {
      lastSyncAt: result[0].values[0][0] as string | null,
      syncCursor: result[0].values[0][1] as string | null,
    };
  }

  // ---- Row mapping helpers ----

  private mapEmailRow(row: (string | number | Uint8Array | null)[], columns: string[]): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const val = row[i];
      // Convert snake_case to camelCase and handle booleans
      const key = col.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (col === 'is_read' || col === 'is_starred' || col === 'is_important' || col === 'has_attachments') {
        obj[key] = val === 1;
      } else {
        obj[key] = val;
      }
    }
    return obj;
  }

  private mapThreadRow(row: (string | number | Uint8Array | null)[], columns: string[]): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const val = row[i];
      const key = col.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (col === 'is_read' || col === 'is_starred') {
        obj[key] = val === 1;
      } else {
        obj[key] = val;
      }
    }
    return obj;
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
