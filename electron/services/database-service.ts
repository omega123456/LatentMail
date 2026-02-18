import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import log from 'electron-log/main';
import { CREATE_TABLES_SQL, SCHEMA_VERSION } from '../database/schema';
import type { UpsertEmailInput, UpsertThreadInput, UpsertFolderStateInput, FolderStateRecord } from '../database/models';

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
    let isLegacyDb = false;
    if (fs.existsSync(this.dbPath)) {
      const fileBuffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(fileBuffer);
      log.info('Loaded existing database');

      // Check for legacy schema (old era: version > 1 and <= 7)
      let currentVersion = 0;
      try {
        const result = this.db.exec('SELECT version FROM schema_version LIMIT 1');
        if (result.length > 0 && result[0].values.length > 0) {
          currentVersion = (result[0].values[0][0] as number) || 0;
        }
      } catch {
        // schema_version table may not exist
        currentVersion = 0;
      }

      // Detect old-era schema: version > 1 (new-era is 1) and <= 7 (old-era max)
      // OR version 0 with old-style columns (gmail_message_id in emails table)
      if (currentVersion > SCHEMA_VERSION && currentVersion <= 7) {
        isLegacyDb = true;
      } else if (currentVersion === 0) {
        // Check if it has old-style columns
        try {
          const colCheck = this.db.exec("PRAGMA table_info(emails)");
          const hasGmailMessageId = colCheck.length > 0 && colCheck[0].values.some(
            (row) => (row[1] as string) === 'gmail_message_id'
          );
          if (hasGmailMessageId) {
            isLegacyDb = true;
          }
        } catch {
          // If we can't check, assume fresh DB
        }
      } else if (currentVersion === SCHEMA_VERSION) {
        // Current era, check that schema is actually correct
        try {
          const colCheck = this.db.exec("PRAGMA table_info(emails)");
          const hasXGmMsgId = colCheck.length > 0 && colCheck[0].values.some(
            (row) => (row[1] as string) === 'x_gm_msgid'
          );
          if (!hasXGmMsgId) {
            // Version says 1 but columns are wrong — legacy DB
            isLegacyDb = true;
          }
        } catch {
          isLegacyDb = true;
        }
      }

      if (isLegacyDb) {
        log.info(`Database reset: detected legacy schema (v${currentVersion}), deleting and recreating with new schema v${SCHEMA_VERSION}`);
        this.db.close();
        this.db = null;
        fs.unlinkSync(this.dbPath);
        this.db = new SQL.Database();
        log.info('Created fresh database after legacy cleanup');
      }
    } else {
      this.db = new SQL.Database();
      log.info('Created new database');
    }

    // Enable foreign keys
    this.db.run('PRAGMA foreign_keys = ON');

    // Run schema creation (creates tables if they don't exist)
    this.db.run(CREATE_TABLES_SQL);

    // Ensure version row exists and is up to date
    this.db.run('DELETE FROM schema_version');
    this.db.run('INSERT INTO schema_version (version) VALUES (:version)', { ':version': SCHEMA_VERSION });
    log.info(`Database schema version set to ${SCHEMA_VERSION}`);

    // Save to disk
    this.saveToDisk();

    log.info('Database schema initialized');
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

  // ---- Settings operations ----

  getSetting(key: string): string | null {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec('SELECT value FROM settings WHERE key = :key', { ':key': key });
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0] as string;
    }
    return null;
  }

  setSetting(key: string, value: string, scope: string = 'global'): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      'INSERT INTO settings (key, value, scope) VALUES (:key, :value, :scope) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      { ':key': key, ':value': value, ':scope': scope }
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

  // ---- Account operations ----

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
    const result = this.db.exec('SELECT id, email, display_name, avatar_url, is_active, needs_reauth FROM accounts WHERE id = :id', { ':id': id });
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
      'INSERT INTO accounts (email, display_name, avatar_url, is_active) VALUES (:email, :displayName, :avatarUrl, 1)',
      { ':email': email, ':displayName': displayName, ':avatarUrl': avatarUrl }
    );
    const result = this.db.exec('SELECT last_insert_rowid()');
    const id = result[0].values[0][0] as number;
    this.scheduleSave();
    return id;
  }

  updateAccount(id: number, displayName: string, avatarUrl: string | null): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      'UPDATE accounts SET display_name = :displayName, avatar_url = :avatarUrl, needs_reauth = 0, updated_at = datetime(\'now\') WHERE id = :id',
      { ':displayName': displayName, ':avatarUrl': avatarUrl, ':id': id }
    );
    this.scheduleSave();
  }

  deleteAccount(id: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('DELETE FROM accounts WHERE id = :id', { ':id': id });
    this.scheduleSave();
    log.info(`Deleted account ${id} and all related data`);
  }

  setAccountNeedsReauth(id: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('UPDATE accounts SET needs_reauth = 1, updated_at = datetime(\'now\') WHERE id = :id', { ':id': id });
    this.scheduleSave();
  }

  getAccountCount(): number {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec('SELECT COUNT(*) FROM accounts WHERE is_active = 1');
    if (result.length === 0) return 0;
    return result[0].values[0][0] as number;
  }

  // ---- Email operations (keyed by X-GM-MSGID) ----

  upsertEmail(email: UpsertEmailInput): number {
    if (!this.db) throw new Error('Database not initialized');
    // Upsert the single email row.
    // Pass NULL (not '') for empty bodies so COALESCE preserves existing body on update.
    this.db.run(
      `INSERT INTO emails (account_id, x_gm_msgid, x_gm_thrid, message_id, from_address, from_name,
        to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body, date,
        is_read, is_starred, is_important, is_draft, snippet, size, has_attachments, labels)
       VALUES (:accountId, :xGmMsgId, :xGmThrid, :messageId, :fromAddress, :fromName,
        :toAddresses, :ccAddresses, :bccAddresses, :subject, :textBody, :htmlBody, :date,
        :isRead, :isStarred, :isImportant, :isDraft, :snippet, :size, :hasAttachments, :labels)
       ON CONFLICT(account_id, x_gm_msgid) DO UPDATE SET
        x_gm_thrid = excluded.x_gm_thrid,
        message_id = COALESCE(NULLIF(excluded.message_id, ''), message_id),
        from_address = excluded.from_address, from_name = excluded.from_name,
        to_addresses = excluded.to_addresses, cc_addresses = excluded.cc_addresses, bcc_addresses = excluded.bcc_addresses,
        subject = excluded.subject,
        text_body = COALESCE(NULLIF(excluded.text_body, ''), text_body),
        html_body = COALESCE(NULLIF(excluded.html_body, ''), html_body),
        date = excluded.date,
        is_read = excluded.is_read, is_starred = excluded.is_starred, is_important = excluded.is_important,
        is_draft = excluded.is_draft,
        snippet = excluded.snippet, size = excluded.size, has_attachments = excluded.has_attachments,
        labels = excluded.labels`,
      {
        ':accountId': email.accountId,
        ':xGmMsgId': email.xGmMsgId,
        ':xGmThrid': email.xGmThrid,
        ':messageId': email.messageId || null,
        ':fromAddress': email.fromAddress,
        ':fromName': email.fromName || '',
        ':toAddresses': email.toAddresses,
        ':ccAddresses': email.ccAddresses || '',
        ':bccAddresses': email.bccAddresses || '',
        ':subject': email.subject || '',
        ':textBody': email.textBody || null,
        ':htmlBody': email.htmlBody || null,
        ':date': email.date,
        ':isRead': email.isRead ? 1 : 0,
        ':isStarred': email.isStarred ? 1 : 0,
        ':isImportant': email.isImportant ? 1 : 0,
        ':isDraft': email.isDraft ? 1 : 0,
        ':snippet': email.snippet || '',
        ':size': email.size || 0,
        ':hasAttachments': email.hasAttachments ? 1 : 0,
        ':labels': email.labels || '',
      }
    );

    // Retrieve the actual id (last_insert_rowid is unreliable after ON CONFLICT)
    const result = this.db.exec(
      'SELECT id FROM emails WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId',
      { ':accountId': email.accountId, ':xGmMsgId': email.xGmMsgId }
    );
    const id = result[0].values[0][0] as number;

    // Record folder association in the link table (keyed by x_gm_msgid, not email_id)
    if (email.folderUid != null) {
      this.db.run(
        `INSERT INTO email_folders (account_id, x_gm_msgid, folder, uid) VALUES (:accountId, :xGmMsgId, :folder, :folderUid)
         ON CONFLICT(account_id, x_gm_msgid, folder) DO UPDATE SET uid = excluded.uid`,
        { ':accountId': email.accountId, ':xGmMsgId': email.xGmMsgId, ':folder': email.folder, ':folderUid': email.folderUid }
      );
    } else {
      this.db.run(
        'INSERT OR IGNORE INTO email_folders (account_id, x_gm_msgid, folder) VALUES (:accountId, :xGmMsgId, :folder)',
        { ':accountId': email.accountId, ':xGmMsgId': email.xGmMsgId, ':folder': email.folder }
      );
    }

    this.scheduleSave();
    return id;
  }

  getEmailsByThreadId(accountId: number, xGmThrid: string): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, x_gm_msgid, x_gm_thrid, message_id, from_address, from_name,
        to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body, snippet, date,
        is_read, is_starred, is_important, is_draft, size, has_attachments, labels
       FROM emails WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid
       ORDER BY date ASC`,
      { ':accountId': accountId, ':xGmThrid': xGmThrid }
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => this.mapEmailRow(row, result[0].columns));
  }

  getEmailById(id: number): Record<string, unknown> | null {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, x_gm_msgid, x_gm_thrid, message_id, from_address, from_name,
        to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body, snippet, date,
        is_read, is_starred, is_important, is_draft, size, has_attachments, labels
       FROM emails WHERE id = :id`,
      { ':id': id }
    );
    if (result.length === 0 || result[0].values.length === 0) return null;
    return this.mapEmailRow(result[0].values[0], result[0].columns);
  }

  getEmailByXGmMsgId(accountId: number, xGmMsgId: string): Record<string, unknown> | null {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, x_gm_msgid, x_gm_thrid, message_id, from_address, from_name,
        to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body, snippet, date,
        is_read, is_starred, is_important, is_draft, size, has_attachments, labels
       FROM emails WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId LIMIT 1`,
      { ':accountId': accountId, ':xGmMsgId': xGmMsgId }
    );
    if (result.length === 0 || result[0].values.length === 0) return null;
    return this.mapEmailRow(result[0].values[0], result[0].columns);
  }

  /** Get all folders an email appears in (via the email_folders link table). */
  getFoldersForEmail(accountId: number, xGmMsgId: string): string[] {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT folder FROM email_folders
       WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId`,
      { ':accountId': accountId, ':xGmMsgId': xGmMsgId }
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => row[0] as string);
  }

  /**
   * Get all (folder, uid) pairs for an email.
   * UID is returned only where present (non-null).
   */
  getFolderUidsForEmail(accountId: number, xGmMsgId: string): Array<{ folder: string; uid: number }> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT folder, uid FROM email_folders
       WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId AND uid IS NOT NULL`,
      { ':accountId': accountId, ':xGmMsgId': xGmMsgId }
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => ({
      folder: row[0] as string,
      uid: row[1] as number,
    }));
  }

  updateEmailFlags(
    accountId: number,
    xGmMsgId: string,
    flags: { isRead?: boolean; isStarred?: boolean; isImportant?: boolean }
  ): void {
    if (!this.db) throw new Error('Database not initialized');
    const updates: string[] = [];
    const params: Record<string, string | number> = {
      ':accountId': accountId,
      ':xGmMsgId': xGmMsgId,
    };

    if (flags.isRead !== undefined) {
      updates.push('is_read = :isRead');
      params[':isRead'] = flags.isRead ? 1 : 0;
    }
    if (flags.isStarred !== undefined) {
      updates.push('is_starred = :isStarred');
      params[':isStarred'] = flags.isStarred ? 1 : 0;
    }
    if (flags.isImportant !== undefined) {
      updates.push('is_important = :isImportant');
      params[':isImportant'] = flags.isImportant ? 1 : 0;
    }

    if (updates.length === 0) return;

    this.db.run(
      `UPDATE emails SET ${updates.join(', ')} WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId`,
      params
    );
    this.scheduleSave();
  }

  deleteEmailsByAccount(accountId: number): void {
    if (!this.db) throw new Error('Database not initialized');
    // Clean up junction tables first (no FK cascade from emails to email_folders in new schema)
    this.db.run('DELETE FROM email_folders WHERE account_id = :accountId', { ':accountId': accountId });
    this.db.run('DELETE FROM thread_folders WHERE account_id = :accountId', { ':accountId': accountId });
    this.db.run('DELETE FROM emails WHERE account_id = :accountId', { ':accountId': accountId });
    this.db.run('DELETE FROM threads WHERE account_id = :accountId', { ':accountId': accountId });
    this.scheduleSave();
  }

  deleteEmailsByThreadId(accountId: number, xGmThrid: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('BEGIN');
    try {
      // Remove email_folders associations for all emails in this thread before deleting the emails
      this.db.run(
        `DELETE FROM email_folders WHERE account_id = :accountId AND x_gm_msgid IN (
           SELECT x_gm_msgid FROM emails WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid
         )`,
        { ':accountId': accountId, ':xGmThrid': xGmThrid }
      );
      // Remove thread_folders associations
      this.db.run(
        'DELETE FROM thread_folders WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid',
        { ':accountId': accountId, ':xGmThrid': xGmThrid }
      );
      // Delete the email rows (CASCADE handles attachments, search_index)
      this.db.run(
        'DELETE FROM emails WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid',
        { ':accountId': accountId, ':xGmThrid': xGmThrid }
      );
      // Delete the thread row itself
      this.db.run(
        'DELETE FROM threads WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid',
        { ':accountId': accountId, ':xGmThrid': xGmThrid }
      );
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    this.scheduleSave();
  }

  // ---- Thread operations (keyed by X-GM-THRID) ----

  upsertThread(thread: UpsertThreadInput): number {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      `INSERT INTO threads (account_id, x_gm_thrid, subject, last_message_date, participants,
        message_count, snippet, is_read, is_starred, updated_at)
       VALUES (:accountId, :xGmThrid, :subject, :lastMessageDate, :participants,
        :messageCount, :snippet, :isRead, :isStarred, datetime('now'))
       ON CONFLICT(account_id, x_gm_thrid) DO UPDATE SET
        subject = excluded.subject, last_message_date = excluded.last_message_date,
        participants = excluded.participants, message_count = excluded.message_count,
        snippet = excluded.snippet,
        is_read = excluded.is_read, is_starred = excluded.is_starred,
        updated_at = datetime('now')`,
      {
        ':accountId': thread.accountId,
        ':xGmThrid': thread.xGmThrid,
        ':subject': thread.subject || '',
        ':lastMessageDate': thread.lastMessageDate,
        ':participants': thread.participants || '',
        ':messageCount': thread.messageCount,
        ':snippet': thread.snippet || '',
        ':isRead': thread.isRead ? 1 : 0,
        ':isStarred': thread.isStarred ? 1 : 0,
      }
    );
    const result = this.db.exec(
      'SELECT id FROM threads WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid',
      { ':accountId': thread.accountId, ':xGmThrid': thread.xGmThrid }
    );
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
      `SELECT t.id, t.account_id, t.x_gm_thrid, t.subject, t.last_message_date, t.participants,
        t.message_count, t.snippet, tf.folder, t.is_read, t.is_starred
       FROM threads t
       INNER JOIN thread_folders tf ON t.account_id = tf.account_id AND t.x_gm_thrid = tf.x_gm_thrid
       WHERE t.account_id = :accountId AND tf.folder = :folder
       ORDER BY t.last_message_date DESC LIMIT :limit OFFSET :offset`,
      { ':accountId': accountId, ':folder': folder, ':limit': limit, ':offset': offset }
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => this.mapThreadRow(row, result[0].columns));
  }

  getThreadsByFolderBeforeDate(
    accountId: number,
    folder: string,
    beforeDate: string,
    limit: number = 50
  ): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT t.id, t.account_id, t.x_gm_thrid, t.subject, t.last_message_date, t.participants,
        t.message_count, t.snippet, tf.folder, t.is_read, t.is_starred
       FROM threads t
       INNER JOIN thread_folders tf ON t.account_id = tf.account_id AND t.x_gm_thrid = tf.x_gm_thrid
       WHERE t.account_id = :accountId AND tf.folder = :folder AND t.last_message_date < :beforeDate
       ORDER BY t.last_message_date DESC LIMIT :limit`,
      { ':accountId': accountId, ':folder': folder, ':beforeDate': beforeDate, ':limit': limit }
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => this.mapThreadRow(row, result[0].columns));
  }

  getThreadById(accountId: number, xGmThrid: string): Record<string, unknown> | null {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, x_gm_thrid, subject, last_message_date, participants,
        message_count, snippet, is_read, is_starred
       FROM threads WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid`,
      { ':accountId': accountId, ':xGmThrid': xGmThrid }
    );
    if (result.length === 0 || result[0].values.length === 0) return null;
    return this.mapThreadRow(result[0].values[0], result[0].columns);
  }

  updateThreadFlags(
    accountId: number,
    xGmThrid: string,
    flags: { isRead?: boolean; isStarred?: boolean }
  ): void {
    if (!this.db) throw new Error('Database not initialized');
    const updates: string[] = [];
    const params: Record<string, string | number> = {
      ':accountId': accountId,
      ':xGmThrid': xGmThrid,
    };

    if (flags.isRead !== undefined) {
      updates.push('is_read = :isRead');
      params[':isRead'] = flags.isRead ? 1 : 0;
    }
    if (flags.isStarred !== undefined) {
      updates.push('is_starred = :isStarred');
      params[':isStarred'] = flags.isStarred ? 1 : 0;
    }

    if (updates.length === 0) return;

    this.db.run(
      `UPDATE threads SET ${updates.join(', ')} WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid`,
      params
    );
    this.scheduleSave();
  }

  // ---- Thread-Folder operations (keyed by X-GM-THRID) ----

  upsertThreadFolder(accountId: number, xGmThrid: string, folder: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      `INSERT OR IGNORE INTO thread_folders (account_id, x_gm_thrid, folder)
       VALUES (:accountId, :xGmThrid, :folder)`,
      { ':accountId': accountId, ':xGmThrid': xGmThrid, ':folder': folder }
    );
    this.scheduleSave();
  }

  removeThreadFolderAssociation(accountId: number, xGmThrid: string, folder: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      'DELETE FROM thread_folders WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid AND folder = :folder',
      { ':accountId': accountId, ':xGmThrid': xGmThrid, ':folder': folder }
    );
    this.scheduleSave();
  }

  getFoldersForThread(accountId: number, xGmThrid: string): string[] {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      'SELECT DISTINCT folder FROM thread_folders WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid',
      { ':accountId': accountId, ':xGmThrid': xGmThrid }
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => row[0] as string);
  }

  getThreadInternalId(accountId: number, xGmThrid: string): number | null {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      'SELECT id FROM threads WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid',
      { ':accountId': accountId, ':xGmThrid': xGmThrid }
    );
    if (result.length === 0 || result[0].values.length === 0) return null;
    return result[0].values[0][0] as number;
  }

  // ---- Email-Folder association management (keyed by X-GM-MSGID) ----

  removeEmailFolderAssociation(accountId: number, xGmMsgId: string, folder: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      'DELETE FROM email_folders WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId AND folder = :folder',
      { ':accountId': accountId, ':xGmMsgId': xGmMsgId, ':folder': folder }
    );
    this.scheduleSave();
  }

  /**
   * Atomically remove email-folder (and thread-folder) associations for a set of stale
   * x_gm_msgid values from a given folder.  All raw SQL runs inside a single BEGIN/COMMIT
   * block owned entirely by this method, so no scheduleSave() side effects leak out of the
   * transaction boundary.  scheduleSave() is called once after a successful commit.
   */
  removeStaleEmailFolderAssociations(accountId: number, folder: string, xGmMsgIds: string[]): void {
    if (!this.db) throw new Error('Database not initialized');
    if (xGmMsgIds.length === 0) return;

    // Collect thread IDs before mutating (needed for thread-folder cleanup check).
    const affectedThreadIds = new Map<string, string>(); // xGmMsgId → xGmThrid
    for (const xGmMsgId of xGmMsgIds) {
      const emailResult = this.db.exec(
        'SELECT x_gm_thrid FROM emails WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId',
        { ':accountId': accountId, ':xGmMsgId': xGmMsgId }
      );
      if (emailResult.length > 0 && emailResult[0].values.length > 0) {
        const xGmThrid = emailResult[0].values[0][0] as string;
        if (xGmThrid) {
          affectedThreadIds.set(xGmMsgId, xGmThrid);
        }
      }
    }

    this.db.run('BEGIN');
    try {
      for (const xGmMsgId of xGmMsgIds) {
        // Remove email-folder association (raw SQL — no scheduleSave inside transaction)
        this.db.run(
          'DELETE FROM email_folders WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId AND folder = :folder',
          { ':accountId': accountId, ':xGmMsgId': xGmMsgId, ':folder': folder }
        );

        // Remove thread-folder if no remaining emails for this thread exist in the folder
        const xGmThrid = affectedThreadIds.get(xGmMsgId);
        if (xGmThrid) {
          const countResult = this.db.exec(
            `SELECT COUNT(*) FROM email_folders ef
             JOIN emails e ON e.account_id = ef.account_id AND e.x_gm_msgid = ef.x_gm_msgid
             WHERE e.account_id = :accountId AND e.x_gm_thrid = :xGmThrid AND ef.folder = :folder`,
            { ':accountId': accountId, ':xGmThrid': xGmThrid, ':folder': folder }
          );
          const remaining = (countResult.length > 0 && countResult[0].values.length > 0)
            ? countResult[0].values[0][0] as number : 0;
          if (remaining === 0) {
            this.db.run(
              'DELETE FROM thread_folders WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid AND folder = :folder',
              { ':accountId': accountId, ':xGmThrid': xGmThrid, ':folder': folder }
            );
          }
        }
      }
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    this.scheduleSave();
  }

  moveEmailFolder(accountId: number, xGmMsgId: string, sourceFolder: string, targetFolder: string, targetUid?: number | null): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('BEGIN');
    try {
      // Remove source folder association
      this.db.run(
        'DELETE FROM email_folders WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId AND folder = :folder',
        { ':accountId': accountId, ':xGmMsgId': xGmMsgId, ':folder': sourceFolder }
      );
      // Add target folder association (with uid if available)
      if (targetUid != null) {
        this.db.run(
          `INSERT INTO email_folders (account_id, x_gm_msgid, folder, uid) VALUES (:accountId, :xGmMsgId, :folder, :uid)
           ON CONFLICT(account_id, x_gm_msgid, folder) DO UPDATE SET uid = excluded.uid`,
          { ':accountId': accountId, ':xGmMsgId': xGmMsgId, ':folder': targetFolder, ':uid': targetUid }
        );
      } else {
        this.db.run(
          'INSERT OR IGNORE INTO email_folders (account_id, x_gm_msgid, folder) VALUES (:accountId, :xGmMsgId, :folder)',
          { ':accountId': accountId, ':xGmMsgId': xGmMsgId, ':folder': targetFolder }
        );
      }
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    this.scheduleSave();
  }

  moveThreadFolder(accountId: number, xGmThrid: string, sourceFolder: string, targetFolder: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('BEGIN');
    try {
      this.db.run(
        'DELETE FROM thread_folders WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid AND folder = :folder',
        { ':accountId': accountId, ':xGmThrid': xGmThrid, ':folder': sourceFolder }
      );
      this.db.run(
        'INSERT OR IGNORE INTO thread_folders (account_id, x_gm_thrid, folder) VALUES (:accountId, :xGmThrid, :folder)',
        { ':accountId': accountId, ':xGmThrid': xGmThrid, ':folder': targetFolder }
      );
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    this.scheduleSave();
  }

  threadHasEmailsInFolder(accountId: number, xGmThrid: string, folder: string): boolean {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT COUNT(*) FROM email_folders ef
       JOIN emails e ON e.account_id = ef.account_id AND e.x_gm_msgid = ef.x_gm_msgid
       WHERE e.account_id = :accountId AND e.x_gm_thrid = :xGmThrid AND ef.folder = :folder`,
      { ':accountId': accountId, ':xGmThrid': xGmThrid, ':folder': folder }
    );
    if (result.length === 0 || result[0].values.length === 0) return false;
    return (result[0].values[0][0] as number) > 0;
  }

  /** Get all x_gm_msgid values that have a folder association for a given account + folder. */
  getEmailXGmMsgIdsByFolder(accountId: number, folder: string): string[] {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT x_gm_msgid FROM email_folders
       WHERE account_id = :accountId AND folder = :folder`,
      { ':accountId': accountId, ':folder': folder }
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => row[0] as string);
  }

  /** Get all (x_gm_msgid, uid) pairs from email_folders for a given account + folder. */
  getEmailFolderUids(accountId: number, folder: string): Array<{ xGmMsgId: string; uid: number }> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT x_gm_msgid, uid FROM email_folders
       WHERE account_id = :accountId AND folder = :folder AND uid IS NOT NULL`,
      { ':accountId': accountId, ':folder': folder }
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => ({
      xGmMsgId: row[0] as string,
      uid: row[1] as number,
    }));
  }

  // ---- Email removal and orphan cleanup ----

  removeEmailAndAssociations(accountId: number, xGmMsgId: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('BEGIN');
    try {
      const emailResult = this.db.exec(
        'SELECT id, x_gm_thrid FROM emails WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId',
        { ':accountId': accountId, ':xGmMsgId': xGmMsgId }
      );
      if (emailResult.length === 0 || emailResult[0].values.length === 0) {
        this.db.run('COMMIT');
        return;
      }
      const emailId = emailResult[0].values[0][0] as number;
      const xGmThrid = emailResult[0].values[0][1] as string;

      // Remove all folder associations for this email
      this.db.run('DELETE FROM email_folders WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId',
        { ':accountId': accountId, ':xGmMsgId': xGmMsgId });

      // Remove the email row itself (CASCADE handles attachments, search_index, email_labels)
      this.db.run('DELETE FROM emails WHERE id = :emailId', { ':emailId': emailId });

      // Clean up orphaned thread
      if (xGmThrid) {
        const remainingResult = this.db.exec(
          'SELECT COUNT(*) FROM emails WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid',
          { ':accountId': accountId, ':xGmThrid': xGmThrid }
        );
        const remaining = (remainingResult.length > 0 && remainingResult[0].values.length > 0)
          ? remainingResult[0].values[0][0] as number : 0;

        if (remaining === 0) {
          this.db.run(
            'DELETE FROM thread_folders WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid',
            { ':accountId': accountId, ':xGmThrid': xGmThrid }
          );
          this.db.run(
            'DELETE FROM threads WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid',
            { ':accountId': accountId, ':xGmThrid': xGmThrid }
          );
        } else {
          // Thread still has emails — remove thread_folders for folders with no remaining emails
          const tfResult = this.db.exec(
            'SELECT DISTINCT folder FROM thread_folders WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid',
            { ':accountId': accountId, ':xGmThrid': xGmThrid }
          );
          if (tfResult.length > 0) {
            for (const row of tfResult[0].values) {
              const folder = row[0] as string;
              const countResult = this.db.exec(
                `SELECT COUNT(*) FROM email_folders ef
                 JOIN emails e ON e.account_id = ef.account_id AND e.x_gm_msgid = ef.x_gm_msgid
                 WHERE e.account_id = :accountId AND e.x_gm_thrid = :xGmThrid AND ef.folder = :folder`,
                { ':accountId': accountId, ':xGmThrid': xGmThrid, ':folder': folder }
              );
              const count = (countResult.length > 0 && countResult[0].values.length > 0)
                ? countResult[0].values[0][0] as number : 0;
              if (count === 0) {
                this.db.run(
                  'DELETE FROM thread_folders WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid AND folder = :folder',
                  { ':accountId': accountId, ':xGmThrid': xGmThrid, ':folder': folder }
                );
              }
            }
          }
        }
      }

      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    this.scheduleSave();
  }

  removeOrphanedEmails(accountId: number): Array<{ xGmMsgId: string; xGmThrid: string }> {
    if (!this.db) throw new Error('Database not initialized');

    const removed: Array<{ xGmMsgId: string; xGmThrid: string }> = [];

    this.db.run('BEGIN');
    try {
      const selectResult = this.db.exec(
        `SELECT x_gm_msgid, x_gm_thrid FROM emails
         WHERE account_id = :accountId
           AND x_gm_msgid NOT IN (SELECT x_gm_msgid FROM email_folders WHERE account_id = :accountId)`,
        { ':accountId': accountId }
      );

      if (selectResult.length > 0) {
        for (const row of selectResult[0].values) {
          removed.push({
            xGmMsgId: row[0] as string,
            xGmThrid: row[1] as string,
          });
        }
      }

      if (removed.length > 0) {
        this.db.run(
          `DELETE FROM emails
           WHERE account_id = :accountId
             AND x_gm_msgid NOT IN (SELECT x_gm_msgid FROM email_folders WHERE account_id = :accountId)`,
          { ':accountId': accountId }
        );
      }

      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }

    if (removed.length > 0) {
      this.scheduleSave();
    }
    return removed;
  }

  removeOrphanedThreads(accountId: number): number {
    if (!this.db) throw new Error('Database not initialized');
    const countResult = this.db.exec(
      `SELECT COUNT(*) FROM threads t WHERE t.account_id = :accountId
       AND NOT EXISTS (SELECT 1 FROM thread_folders tf WHERE tf.account_id = t.account_id AND tf.x_gm_thrid = t.x_gm_thrid)`,
      { ':accountId': accountId }
    );
    const count = (countResult.length > 0 && countResult[0].values.length > 0)
      ? countResult[0].values[0][0] as number : 0;

    if (count > 0) {
      this.db.run(
        `DELETE FROM threads WHERE account_id = :accountId
         AND NOT EXISTS (SELECT 1 FROM thread_folders tf WHERE tf.account_id = threads.account_id AND tf.x_gm_thrid = threads.x_gm_thrid)`,
        { ':accountId': accountId }
      );
      this.scheduleSave();
    }
    return count;
  }

  getAffectedThreadIds(accountId: number, xGmMsgIds: string[]): string[] {
    if (!this.db) throw new Error('Database not initialized');
    if (xGmMsgIds.length === 0) return [];

    const placeholders = xGmMsgIds.map((_, i) => `:id${i}`).join(', ');
    const params: Record<string, string | number> = { ':accountId': accountId };
    for (let i = 0; i < xGmMsgIds.length; i++) {
      params[`:id${i}`] = xGmMsgIds[i];
    }

    const result = this.db.exec(
      `SELECT DISTINCT x_gm_thrid FROM emails
       WHERE account_id = :accountId AND x_gm_msgid IN (${placeholders})`,
      params
    );

    if (result.length === 0) return [];
    return result[0].values.map((row) => row[0] as string);
  }

  recomputeThreadMetadata(accountId: number, xGmThrid: string): void {
    if (!this.db) throw new Error('Database not initialized');

    this.db.run('BEGIN');
    try {
      const countResult = this.db.exec(
        `SELECT COUNT(*) FROM emails
         WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid`,
        { ':accountId': accountId, ':xGmThrid': xGmThrid }
      );
      const emailCount = (countResult.length > 0 && countResult[0].values.length > 0)
        ? countResult[0].values[0][0] as number : 0;

      const threadResult = this.db.exec(
        'SELECT id FROM threads WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid',
        { ':accountId': accountId, ':xGmThrid': xGmThrid }
      );
      if (threadResult.length === 0 || threadResult[0].values.length === 0) {
        this.db.run('COMMIT');
        return;
      }
      const threadId = threadResult[0].values[0][0] as number;

      if (emailCount === 0) {
        this.db.run('DELETE FROM thread_folders WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid',
          { ':accountId': accountId, ':xGmThrid': xGmThrid });
        this.db.run('DELETE FROM threads WHERE id = :threadId', { ':threadId': threadId });
        this.db.run('COMMIT');
        this.scheduleSave();
        return;
      }

      const aggResult = this.db.exec(
        `SELECT
           COUNT(*) AS message_count,
           MAX(date) AS last_message_date,
           MIN(CASE WHEN is_read = 0 THEN 0 ELSE 1 END) AS all_read,
           MAX(is_starred) AS any_starred
         FROM emails
         WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid`,
        { ':accountId': accountId, ':xGmThrid': xGmThrid }
      );

      if (aggResult.length === 0 || aggResult[0].values.length === 0) {
        this.db.run('COMMIT');
        return;
      }

      const agg = aggResult[0].values[0];
      const messageCount = agg[0] as number;
      const lastMessageDate = agg[1] as string;
      const isRead = (agg[2] as number) === 1;
      const isStarred = (agg[3] as number) === 1;

      const snippetResult = this.db.exec(
        `SELECT snippet FROM emails
         WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid
         ORDER BY date DESC LIMIT 1`,
        { ':accountId': accountId, ':xGmThrid': xGmThrid }
      );
      const snippet = (snippetResult.length > 0 && snippetResult[0].values.length > 0)
        ? snippetResult[0].values[0][0] as string : '';

      const participantsResult = this.db.exec(
        `SELECT DISTINCT from_address FROM emails
         WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid`,
        { ':accountId': accountId, ':xGmThrid': xGmThrid }
      );
      const participants = participantsResult.length > 0 && participantsResult[0].values.length > 0
        ? participantsResult[0].values.map((row) => row[0] as string).join(', ') : '';

      this.db.run(
        `UPDATE threads SET
           message_count = :messageCount,
           last_message_date = :lastMessageDate,
           snippet = :snippet,
           participants = :participants,
           is_read = :isRead,
           is_starred = :isStarred,
           updated_at = datetime('now')
         WHERE id = :threadId`,
        {
          ':messageCount': messageCount,
          ':lastMessageDate': lastMessageDate,
          ':snippet': snippet || '',
          ':participants': participants,
          ':isRead': isRead ? 1 : 0,
          ':isStarred': isStarred ? 1 : 0,
          ':threadId': threadId,
        }
      );

      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    this.scheduleSave();
  }

  // ---- Folder State operations (CONDSTORE) ----

  upsertFolderState(input: UpsertFolderStateInput): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      `INSERT INTO folder_state (account_id, folder, uid_validity, highest_modseq, condstore_supported, last_reconciled_at, updated_at)
       VALUES (:accountId, :folder, :uidValidity, :highestModseq, :condstoreSupported, :lastReconciledAt, datetime('now'))
       ON CONFLICT(account_id, folder) DO UPDATE SET
        uid_validity = excluded.uid_validity,
        highest_modseq = excluded.highest_modseq,
        condstore_supported = excluded.condstore_supported,
        last_reconciled_at = COALESCE(excluded.last_reconciled_at, folder_state.last_reconciled_at),
        updated_at = datetime('now')`,
      {
        ':accountId': input.accountId,
        ':folder': input.folder,
        ':uidValidity': input.uidValidity,
        ':highestModseq': input.highestModseq ?? null,
        ':condstoreSupported': (input.condstoreSupported ?? true) ? 1 : 0,
        ':lastReconciledAt': input.lastReconciledAt ?? null,
      }
    );
    this.scheduleSave();
  }

  getFolderState(accountId: number, folder: string): FolderStateRecord | null {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, folder, uid_validity, highest_modseq, condstore_supported, last_reconciled_at, updated_at
       FROM folder_state WHERE account_id = :accountId AND folder = :folder`,
      { ':accountId': accountId, ':folder': folder }
    );
    if (result.length === 0 || result[0].values.length === 0) return null;
    const row = result[0].values[0];
    return {
      id: row[0] as number,
      accountId: row[1] as number,
      folder: row[2] as string,
      uidValidity: row[3] as string,
      highestModseq: row[4] as string | null,
      condstoreSupported: (row[5] as number) === 1,
      lastReconciledAt: row[6] as string | null,
      updatedAt: row[7] as string,
    };
  }

  getAllFolderStates(accountId: number): FolderStateRecord[] {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, folder, uid_validity, highest_modseq, condstore_supported, last_reconciled_at, updated_at
       FROM folder_state WHERE account_id = :accountId`,
      { ':accountId': accountId }
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => ({
      id: row[0] as number,
      accountId: row[1] as number,
      folder: row[2] as string,
      uidValidity: row[3] as string,
      highestModseq: row[4] as string | null,
      condstoreSupported: (row[5] as number) === 1,
      lastReconciledAt: row[6] as string | null,
      updatedAt: row[7] as string,
    }));
  }

  deleteFolderState(accountId: number, folder: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      'DELETE FROM folder_state WHERE account_id = :accountId AND folder = :folder',
      { ':accountId': accountId, ':folder': folder }
    );
    this.scheduleSave();
  }

  updateFolderStateReconciliation(accountId: number, folder: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      `UPDATE folder_state SET last_reconciled_at = datetime('now'), updated_at = datetime('now')
       WHERE account_id = :accountId AND folder = :folder`,
      { ':accountId': accountId, ':folder': folder }
    );
    this.scheduleSave();
  }

  /**
   * Wipe all folder data for a UIDVALIDITY reset.
   * Removes email_folders, thread_folders for the folder, cleans orphans.
   */
  wipeFolderData(accountId: number, folder: string): void {
    if (!this.db) throw new Error('Database not initialized');

    const affectedThreadIds = new Set<string>();
    const affectedResult = this.db.exec(
      `SELECT DISTINCT e.x_gm_thrid
       FROM emails e
       INNER JOIN email_folders ef ON ef.account_id = e.account_id AND ef.x_gm_msgid = e.x_gm_msgid
       WHERE ef.account_id = :accountId AND ef.folder = :folder`,
      { ':accountId': accountId, ':folder': folder }
    );
    if (affectedResult.length > 0) {
      for (const row of affectedResult[0].values) {
        const xGmThrid = row[0] as string;
        if (xGmThrid) {
          affectedThreadIds.add(xGmThrid);
        }
      }
    }

    this.db.run('BEGIN');
    try {
      // Remove all email_folders for this folder
      this.db.run(
        'DELETE FROM email_folders WHERE account_id = :accountId AND folder = :folder',
        { ':accountId': accountId, ':folder': folder }
      );
      // Remove all thread_folders for this folder
      this.db.run(
        'DELETE FROM thread_folders WHERE account_id = :accountId AND folder = :folder',
        { ':accountId': accountId, ':folder': folder }
      );
      // Remove folder state
      this.db.run(
        'DELETE FROM folder_state WHERE account_id = :accountId AND folder = :folder',
        { ':accountId': accountId, ':folder': folder }
      );
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }

    // Remove newly orphaned emails and track their affected threads
    const orphanedEmails = this.removeOrphanedEmails(accountId);
    for (const orphan of orphanedEmails) {
      if (orphan.xGmThrid) {
        affectedThreadIds.add(orphan.xGmThrid);
      }
    }

    // Recompute metadata for all affected threads
    for (const xGmThrid of affectedThreadIds) {
      try {
        this.recomputeThreadMetadata(accountId, xGmThrid);
      } catch (err) {
        log.warn(`[DatabaseService] wipeFolderData: recomputeThreadMetadata failed for thread ${xGmThrid}:`, err);
      }
    }

    // Remove threads that no longer belong to any folder
    this.removeOrphanedThreads(accountId);

    this.scheduleSave();
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
       VALUES (:accountId, :gmailLabelId, :name, :type, :color, :unreadCount, :totalCount)
       ON CONFLICT(account_id, gmail_label_id) DO UPDATE SET
        name = excluded.name, type = excluded.type, color = excluded.color,
        unread_count = excluded.unread_count, total_count = excluded.total_count`,
      {
        ':accountId': label.accountId,
        ':gmailLabelId': label.gmailLabelId,
        ':name': label.name,
        ':type': label.type,
        ':color': label.color || null,
        ':unreadCount': label.unreadCount,
        ':totalCount': label.totalCount,
      }
    );
    this.scheduleSave();
  }

  getUnreadThreadCountsByFolder(accountId: number): Record<string, number> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT tf.folder, COUNT(DISTINCT t.id) AS cnt
       FROM thread_folders tf
       INNER JOIN threads t ON t.account_id = tf.account_id AND t.x_gm_thrid = tf.x_gm_thrid
       WHERE tf.account_id = :accountId AND t.is_read = 0
       GROUP BY tf.folder`,
      { ':accountId': accountId }
    );
    const out: Record<string, number> = {};
    if (result.length > 0 && result[0].values.length > 0) {
      for (const row of result[0].values) {
        out[row[0] as string] = (row[1] as number) || 0;
      }
    }
    return out;
  }

  getLabelsByAccount(accountId: number): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, gmail_label_id, name, type, color, unread_count, total_count
       FROM labels WHERE account_id = :accountId ORDER BY type ASC, name ASC`,
      { ':accountId': accountId }
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
      'UPDATE labels SET unread_count = :unreadCount, total_count = :totalCount WHERE account_id = :accountId AND gmail_label_id = :gmailLabelId',
      { ':unreadCount': unreadCount, ':totalCount': totalCount, ':accountId': accountId, ':gmailLabelId': gmailLabelId }
    );
    this.scheduleSave();
  }

  // ---- Contact operations ----

  upsertContact(email: string, displayName?: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      `INSERT INTO contacts (email, display_name, frequency, last_contacted_at, updated_at)
       VALUES (:email, :displayName, 1, datetime('now'), datetime('now'))
       ON CONFLICT(email) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, display_name),
        frequency = frequency + 1,
        last_contacted_at = datetime('now'),
        updated_at = datetime('now')`,
      { ':email': email, ':displayName': displayName || null }
    );
    this.scheduleSave();
  }

  searchContacts(query: string, limit: number = 10): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');
    const likeQuery = `%${query}%`;
    const result = this.db.exec(
      `SELECT id, email, display_name, frequency, last_contacted_at
       FROM contacts WHERE email LIKE :likeQuery OR display_name LIKE :likeQuery
       ORDER BY frequency DESC LIMIT :limit`,
      { ':likeQuery': likeQuery, ':limit': limit }
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => this.mapGenericRow(row, result[0].columns));
  }

  // ---- Search operations ----

  upsertSearchIndex(emailId: number, subject: string, body: string, fromName: string, fromAddress: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      `INSERT INTO search_index (email_id, subject, body, from_name, from_address)
       VALUES (:emailId, :subject, :body, :fromName, :fromAddress)
       ON CONFLICT(email_id) DO UPDATE SET
        subject = excluded.subject, body = excluded.body,
        from_name = excluded.from_name, from_address = excluded.from_address`,
      { ':emailId': emailId, ':subject': subject, ':body': body, ':fromName': fromName, ':fromAddress': fromAddress }
    );
  }

  searchEmails(accountId: number, query: string, limit: number = 100): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');

    const { parseGmailQuery } = require('../utils/gmail-query-parser');
    const parsed = parseGmailQuery(query, { accountId }) as { whereClause: string; params: Record<string, unknown> };

    const params = {
      ':accountId': accountId,
      ':limit': limit,
      ...parsed.params,
    } as Record<string, number | string | null>;

    const sql = `
      SELECT
        t.id,
        t.account_id,
        t.x_gm_thrid,
        t.subject,
        t.last_message_date,
        t.participants,
        t.message_count,
        t.snippet,
        'search' AS folder,
        t.is_read,
        t.is_starred
      FROM threads t
      WHERE t.account_id = :accountId
        AND t.x_gm_thrid IN (
          SELECT DISTINCT e.x_gm_thrid
          FROM emails e
          WHERE e.account_id = :accountId AND (${parsed.whereClause})
        )
      ORDER BY t.last_message_date DESC
      LIMIT :limit
    `;

    const result = this.db.exec(sql, params);
    if (result.length === 0) return [];
    return result[0].values.map((row) => this.mapThreadRow(row, result[0].columns));
  }

  searchEmailsMulti(accountId: number, queries: string[], limit: number = 100): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');

    const normalizedQueries = queries
      .map((query) => query.trim())
      .filter((query) => query.length > 0);
    if (normalizedQueries.length === 0) return [];

    const { parseGmailQuery } = require('../utils/gmail-query-parser');

    const threadIdSet = new Set<string>();

    for (let index = 0; index < normalizedQueries.length; index++) {
      const query = normalizedQueries[index];
      const parsed = parseGmailQuery(query, {
        accountId,
        paramPrefix: `mq${index + 1}_`,
      }) as { whereClause: string; params: Record<string, unknown> };

      const params = {
        ':accountId': accountId,
        ':limit': limit,
        ...parsed.params,
      } as Record<string, number | string | null>;

      const result = this.db.exec(
        `SELECT DISTINCT e.x_gm_thrid
         FROM emails e
         WHERE e.account_id = :accountId AND (${parsed.whereClause})
         ORDER BY e.date DESC
         LIMIT :limit`,
        params
      );

      if (result.length === 0) continue;
      for (const row of result[0].values) {
        const threadId = row[0] as string | null;
        if (threadId) {
          threadIdSet.add(threadId);
        }
      }
    }

    if (threadIdSet.size === 0) return [];

    return this.getThreadsByXGmThrids(accountId, Array.from(threadIdSet), limit);
  }

  private getThreadsByXGmThrids(accountId: number, xGmThrids: string[], limit: number): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');

    const uniqueIds = Array.from(new Set(xGmThrids.filter((id) => id.trim().length > 0)));
    if (uniqueIds.length === 0) return [];

    const placeholders = uniqueIds.map((_, index) => `:threadId${index}`);
    const params: Record<string, number | string> = {
      ':accountId': accountId,
      ':limit': limit,
    };
    for (let index = 0; index < uniqueIds.length; index++) {
      params[`:threadId${index}`] = uniqueIds[index];
    }

    const result = this.db.exec(
      `SELECT
         t.id,
         t.account_id,
         t.x_gm_thrid,
         t.subject,
         t.last_message_date,
         t.participants,
         t.message_count,
         t.snippet,
         'search' AS folder,
         t.is_read,
         t.is_starred
       FROM threads t
       WHERE t.account_id = :accountId
         AND t.x_gm_thrid IN (${placeholders.join(', ')})
       ORDER BY t.last_message_date DESC
       LIMIT :limit`,
      params
    );

    if (result.length === 0) return [];
    return result[0].values.map((row) => this.mapThreadRow(row, result[0].columns));
  }

  // ---- Batch operations for thread enrichment ----

  getFoldersForThreadBatch(threadIds: number[]): Map<number, string[]> {
    if (!this.db) throw new Error('Database not initialized');

    const map = new Map<number, string[]>();
    const uniqueThreadIds = Array.from(new Set(threadIds.filter((id) => Number.isFinite(id))));
    if (uniqueThreadIds.length === 0) return map;

    // We need to join threads → thread_folders via (account_id, x_gm_thrid) since
    // thread_folders no longer has thread_id FK.
    const placeholders = uniqueThreadIds.map((_, index) => `:threadId${index}`);
    const params: Record<string, number> = {};
    for (let index = 0; index < uniqueThreadIds.length; index++) {
      params[`:threadId${index}`] = uniqueThreadIds[index];
    }

    const result = this.db.exec(
      `SELECT t.id, tf.folder
       FROM threads t
       INNER JOIN thread_folders tf ON t.account_id = tf.account_id AND t.x_gm_thrid = tf.x_gm_thrid
       WHERE t.id IN (${placeholders.join(', ')})
       ORDER BY t.id ASC, tf.folder ASC`,
      params
    );

    if (result.length === 0) return map;

    for (const row of result[0].values) {
      const threadId = row[0] as number;
      const folder = row[1] as string;
      if (!map.has(threadId)) {
        map.set(threadId, []);
      }
      map.get(threadId)!.push(folder);
    }

    return map;
  }

  getThreadIdsWithDrafts(threadIds: number[]): Set<number> {
    if (!this.db) throw new Error('Database not initialized');

    const result = new Set<number>();
    const uniqueThreadIds = Array.from(new Set(threadIds.filter((id) => Number.isFinite(id))));
    if (uniqueThreadIds.length === 0) return result;

    const placeholders = uniqueThreadIds.map((_, index) => `:threadId${index}`);
    const params: Record<string, number> = {};
    for (let index = 0; index < uniqueThreadIds.length; index++) {
      params[`:threadId${index}`] = uniqueThreadIds[index];
    }

    const queryResult = this.db.exec(
      `SELECT DISTINCT t.id
       FROM threads t
       INNER JOIN emails e ON e.account_id = t.account_id AND e.x_gm_thrid = t.x_gm_thrid
       WHERE t.id IN (${placeholders.join(', ')}) AND e.is_draft = 1`,
      params
    );

    if (queryResult.length > 0) {
      for (const row of queryResult[0].values) {
        result.add(row[0] as number);
      }
    }

    return result;
  }

  // ---- Account sync state ----

  updateAccountSyncState(accountId: number, lastSyncAt: string, syncCursor?: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      `UPDATE accounts SET last_sync_at = :lastSyncAt, sync_cursor = :syncCursor, updated_at = datetime('now') WHERE id = :accountId`,
      { ':lastSyncAt': lastSyncAt, ':syncCursor': syncCursor || null, ':accountId': accountId }
    );
    this.scheduleSave();
  }

  getAccountSyncState(accountId: number): { lastSyncAt: string | null; syncCursor: string | null } {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      'SELECT last_sync_at, sync_cursor FROM accounts WHERE id = :accountId',
      { ':accountId': accountId }
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

  private toCamelKey(column: string): string {
    if (column === 'x_gm_msgid') {
      return 'xGmMsgId';
    }
    if (column === 'x_gm_thrid') {
      return 'xGmThrid';
    }
    return column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  }

  private mapEmailRow(row: (string | number | Uint8Array | null)[], columns: string[]): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const val = row[i];
      const key = this.toCamelKey(col);
      if (col === 'is_read' || col === 'is_starred' || col === 'is_important' || col === 'is_draft' || col === 'is_filtered' || col === 'has_attachments') {
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
      const key = this.toCamelKey(col);
      if (col === 'is_read' || col === 'is_starred') {
        obj[key] = val === 1;
      } else {
        obj[key] = val;
      }
    }
    return obj;
  }

  private mapGenericRow(row: (string | number | Uint8Array | null)[], columns: string[]): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const val = row[i];
      const key = this.toCamelKey(col);
      obj[key] = val;
    }
    return obj;
  }

  // ---- AI Cache operations ----

  getAiCacheResult(operation: string, inputHash: string, model: string): string | null {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT result FROM ai_cache
       WHERE operation_type = :operation AND input_hash = :inputHash AND model = :model
       AND (expires_at IS NULL OR expires_at > datetime('now'))`,
      { ':operation': operation, ':inputHash': inputHash, ':model': model }
    );
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0] as string;
    }
    return null;
  }

  setAiCacheResult(operation: string, inputHash: string, model: string, resultText: string, expiresInDays: number | null): void {
    if (!this.db) throw new Error('Database not initialized');
    const expiresAt = expiresInDays != null
      ? new Date(Date.now() + (Math.floor(expiresInDays) * 24 * 60 * 60 * 1000)).toISOString()
      : null;

    this.db.run(
      `INSERT INTO ai_cache (operation_type, input_hash, model, result, expires_at)
       VALUES (:operation, :inputHash, :model, :result, :expiresAt)
       ON CONFLICT(operation_type, input_hash, model) DO UPDATE SET
         result = excluded.result, created_at = datetime('now'), expires_at = excluded.expires_at`,
      { ':operation': operation, ':inputHash': inputHash, ':model': model, ':result': resultText, ':expiresAt': expiresAt }
    );
    this.scheduleSave();
  }

  clearExpiredAiCache(): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run("DELETE FROM ai_cache WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')");
    this.scheduleSave();
  }

  invalidateAiCache(operation: string, inputHash?: string): void {
    if (!this.db) throw new Error('Database not initialized');
    if (inputHash) {
      this.db.run('DELETE FROM ai_cache WHERE operation_type = :operation AND input_hash = :inputHash',
        { ':operation': operation, ':inputHash': inputHash });
    } else {
      this.db.run('DELETE FROM ai_cache WHERE operation_type = :operation', { ':operation': operation });
    }
    this.scheduleSave();
  }

  // ---- Filter CRUD operations ----

  getFilters(accountId: number): Array<{
    id: number; accountId: number; name: string; conditions: string; actions: string;
    isEnabled: boolean; isAiGenerated: boolean; sortOrder: number; createdAt: string; updatedAt: string;
  }> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, name, conditions, actions, is_enabled, is_ai_generated, sort_order, created_at, updated_at
       FROM filters WHERE account_id = :accountId ORDER BY sort_order ASC, id ASC`,
      { ':accountId': accountId }
    );
    if (result.length === 0) return [];
    return result[0].values.map(row => ({
      id: row[0] as number, accountId: row[1] as number, name: row[2] as string,
      conditions: row[3] as string, actions: row[4] as string,
      isEnabled: !!(row[5] as number), isAiGenerated: !!(row[6] as number),
      sortOrder: (row[7] as number) || 0, createdAt: row[8] as string, updatedAt: row[9] as string,
    }));
  }

  saveFilter(filter: {
    accountId: number; name: string; conditions: string; actions: string;
    isEnabled: boolean; isAiGenerated: boolean; sortOrder?: number;
  }): number {
    if (!this.db) throw new Error('Database not initialized');
    let sortOrder = filter.sortOrder;
    if (sortOrder == null) {
      const maxResult = this.db.exec(
        'SELECT COALESCE(MAX(sort_order), 0) FROM filters WHERE account_id = :accountId',
        { ':accountId': filter.accountId }
      );
      sortOrder = ((maxResult[0]?.values[0]?.[0] as number) || 0) + 1;
    }
    this.db.run(
      `INSERT INTO filters (account_id, name, conditions, actions, is_enabled, is_ai_generated, sort_order)
       VALUES (:accountId, :name, :conditions, :actions, :isEnabled, :isAiGenerated, :sortOrder)`,
      {
        ':accountId': filter.accountId, ':name': filter.name, ':conditions': filter.conditions,
        ':actions': filter.actions, ':isEnabled': filter.isEnabled ? 1 : 0,
        ':isAiGenerated': filter.isAiGenerated ? 1 : 0, ':sortOrder': sortOrder,
      }
    );
    const idResult = this.db.exec('SELECT last_insert_rowid()');
    const id = idResult.length > 0 ? (idResult[0].values[0][0] as number) : 0;
    this.scheduleSave();
    return id;
  }

  updateFilter(filter: { id: number; name: string; conditions: string; actions: string; isEnabled: boolean; sortOrder?: number }): void {
    if (!this.db) throw new Error('Database not initialized');
    const updates = ['name = :name', 'conditions = :conditions', 'actions = :actions', 'is_enabled = :isEnabled', "updated_at = datetime('now')"];
    const params: Record<string, string | number> = {
      ':id': filter.id, ':name': filter.name, ':conditions': filter.conditions,
      ':actions': filter.actions, ':isEnabled': filter.isEnabled ? 1 : 0,
    };
    if (filter.sortOrder != null) {
      updates.push('sort_order = :sortOrder');
      params[':sortOrder'] = filter.sortOrder;
    }
    this.db.run(`UPDATE filters SET ${updates.join(', ')} WHERE id = :id`, params);
    this.scheduleSave();
  }

  deleteFilter(id: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('DELETE FROM filters WHERE id = :id', { ':id': id });
    this.scheduleSave();
  }

  toggleFilter(id: number, isEnabled: boolean): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      'UPDATE filters SET is_enabled = :isEnabled, updated_at = datetime(\'now\') WHERE id = :id',
      { ':id': id, ':isEnabled': isEnabled ? 1 : 0 }
    );
    this.scheduleSave();
  }

  // ---- User Label operations ----

  upsertUserLabel(accountId: number, name: string, color?: string | null): number {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      `INSERT INTO user_labels (account_id, name, color) VALUES (:accountId, :name, :color)
       ON CONFLICT(account_id, name) DO UPDATE SET color = COALESCE(excluded.color, user_labels.color)`,
      { ':accountId': accountId, ':name': name, ':color': color || null }
    );
    const result = this.db.exec(
      'SELECT id FROM user_labels WHERE account_id = :accountId AND name = :name',
      { ':accountId': accountId, ':name': name }
    );
    const id = result[0].values[0][0] as number;
    this.scheduleSave();
    return id;
  }

  getUserLabels(accountId: number): Array<{ id: number; accountId: number; name: string; color: string | null; unreadCount: number }> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT ul.id, ul.account_id, ul.name, ul.color,
        (SELECT COUNT(DISTINCT t.id)
         FROM email_labels el2
         JOIN emails e2 ON e2.id = el2.email_id
         JOIN threads t ON t.account_id = e2.account_id AND t.x_gm_thrid = e2.x_gm_thrid
         WHERE el2.label_id = ul.id AND t.is_read = 0
        ) AS unread_count
       FROM user_labels ul WHERE ul.account_id = :accountId ORDER BY ul.name ASC`,
      { ':accountId': accountId }
    );
    if (result.length === 0) return [];
    return result[0].values.map(row => ({
      id: row[0] as number, accountId: row[1] as number, name: row[2] as string,
      color: row[3] as string | null, unreadCount: (row[4] as number) || 0,
    }));
  }

  assignEmailLabel(emailId: number, labelId: number, accountId: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      'INSERT OR IGNORE INTO email_labels (email_id, label_id, account_id) VALUES (:emailId, :labelId, :accountId)',
      { ':emailId': emailId, ':labelId': labelId, ':accountId': accountId }
    );
    this.scheduleSave();
  }

  removeEmailLabel(emailId: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('DELETE FROM email_labels WHERE email_id = :emailId', { ':emailId': emailId });
    this.scheduleSave();
  }

  emailHasLabel(emailId: number): boolean {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec('SELECT 1 FROM email_labels WHERE email_id = :emailId LIMIT 1', { ':emailId': emailId });
    return result.length > 0 && result[0].values.length > 0;
  }

  getThreadsByUserLabel(accountId: number, labelId: number, limit: number = 50, offset: number = 0): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT DISTINCT t.id, t.account_id, t.x_gm_thrid, t.subject, t.last_message_date,
        t.participants, t.message_count, t.snippet, 'label::' || :labelId AS folder,
        t.is_read, t.is_starred
       FROM threads t
       JOIN emails e ON e.account_id = t.account_id AND e.x_gm_thrid = t.x_gm_thrid
       JOIN email_labels el ON el.email_id = e.id
       WHERE el.label_id = :labelId AND el.account_id = :accountId
       ORDER BY t.last_message_date DESC LIMIT :limit OFFSET :offset`,
      { ':accountId': accountId, ':labelId': labelId, ':limit': limit, ':offset': offset }
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => this.mapThreadRow(row, result[0].columns));
  }

  getThreadsByUserLabelBeforeDate(accountId: number, labelId: number, beforeDate: string, limit: number = 50): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT DISTINCT t.id, t.account_id, t.x_gm_thrid, t.subject, t.last_message_date,
        t.participants, t.message_count, t.snippet, 'label::' || :labelId AS folder,
        t.is_read, t.is_starred
       FROM threads t
       JOIN emails e ON e.account_id = t.account_id AND e.x_gm_thrid = t.x_gm_thrid
       JOIN email_labels el ON el.email_id = e.id
       WHERE el.label_id = :labelId AND el.account_id = :accountId AND t.last_message_date < :beforeDate
       ORDER BY t.last_message_date DESC LIMIT :limit`,
      { ':accountId': accountId, ':labelId': labelId, ':beforeDate': beforeDate, ':limit': limit }
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => this.mapThreadRow(row, result[0].columns));
  }

  getLabelsForThreadBatch(threadIds: number[]): Map<number, { labelId: number; labelName: string; labelColor: string | null }> {
    if (!this.db) throw new Error('Database not initialized');
    const map = new Map<number, { labelId: number; labelName: string; labelColor: string | null }>();
    const uniqueIds = Array.from(new Set(threadIds.filter(id => Number.isFinite(id))));
    if (uniqueIds.length === 0) return map;

    const placeholders = uniqueIds.map((_, i) => `:tid${i}`);
    const params: Record<string, number> = {};
    for (let i = 0; i < uniqueIds.length; i++) {
      params[`:tid${i}`] = uniqueIds[i];
    }

    const result = this.db.exec(
      `SELECT t.id AS thread_id, ul.id AS label_id, ul.name AS label_name, ul.color AS label_color
       FROM threads t
       JOIN emails e ON e.account_id = t.account_id AND e.x_gm_thrid = t.x_gm_thrid
       JOIN email_labels el ON el.email_id = e.id
       JOIN user_labels ul ON ul.id = el.label_id
       WHERE t.id IN (${placeholders.join(', ')})
       ORDER BY e.date DESC`,
      params
    );

    if (result.length === 0) return map;

    for (const row of result[0].values) {
      const threadId = row[0] as number;
      if (!map.has(threadId)) {
        map.set(threadId, {
          labelId: row[1] as number,
          labelName: row[2] as string,
          labelColor: row[3] as string | null,
        });
      }
    }
    return map;
  }

  deleteUserLabel(labelId: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('DELETE FROM user_labels WHERE id = :labelId', { ':labelId': labelId });
    this.scheduleSave();
  }

  // ---- Filter execution support ----

  getUnfilteredInboxEmails(accountId: number): Array<{
    id: number; xGmMsgId: string; xGmThrid: string; fromAddress: string; fromName: string;
    toAddresses: string; subject: string; textBody: string | null; htmlBody: string | null; hasAttachments: boolean;
  }> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT e.id, e.x_gm_msgid, e.x_gm_thrid, e.from_address, e.from_name,
        e.to_addresses, e.subject, e.text_body, e.html_body, e.has_attachments
       FROM emails e
       JOIN email_folders ef ON ef.account_id = e.account_id AND ef.x_gm_msgid = e.x_gm_msgid
       WHERE e.account_id = :accountId AND ef.folder = 'INBOX' AND e.is_filtered = 0`,
      { ':accountId': accountId }
    );
    if (result.length === 0) return [];
    return result[0].values.map(row => ({
      id: row[0] as number, xGmMsgId: row[1] as string, xGmThrid: row[2] as string,
      fromAddress: row[3] as string, fromName: (row[4] as string) || '',
      toAddresses: (row[5] as string) || '', subject: (row[6] as string) || '',
      textBody: row[7] as string | null, htmlBody: row[8] as string | null,
      hasAttachments: !!(row[9] as number),
    }));
  }

  markEmailsAsFiltered(emailIds: number[]): void {
    if (!this.db) throw new Error('Database not initialized');
    if (emailIds.length === 0) return;

    this.db.run('BEGIN');
    try {
      const batchSize = 500;
      for (let i = 0; i < emailIds.length; i += batchSize) {
        const batch = emailIds.slice(i, i + batchSize);
        const placeholders = batch.map((_, idx) => `:eid${idx}`);
        const params: Record<string, number> = {};
        for (let j = 0; j < batch.length; j++) {
          params[`:eid${j}`] = batch[j];
        }
        this.db.run(
          `UPDATE emails SET is_filtered = 1 WHERE id IN (${placeholders.join(', ')})`,
          params
        );
      }
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    this.scheduleSave();
  }

  getEnabledFiltersOrdered(accountId: number): Array<{
    id: number; accountId: number; name: string; conditions: string; actions: string; sortOrder: number;
  }> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, name, conditions, actions, sort_order
       FROM filters WHERE account_id = :accountId AND is_enabled = 1
       ORDER BY sort_order ASC, id ASC`,
      { ':accountId': accountId }
    );
    if (result.length === 0) return [];
    return result[0].values.map(row => ({
      id: row[0] as number, accountId: row[1] as number, name: row[2] as string,
      conditions: row[3] as string, actions: row[4] as string, sortOrder: (row[5] as number) || 0,
    }));
  }

  // ---- Close ----

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
