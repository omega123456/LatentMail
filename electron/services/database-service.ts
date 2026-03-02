import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { Umzug } from 'umzug';
import { LoggerService } from './logger-service';
import { createSqlJsStorage } from '../database/umzug-storage';

const log = LoggerService.getInstance();
import type { UpsertEmailInput, UpsertThreadInput, UpsertFolderStateInput, FolderStateRecord, AttachmentRecord } from '../database/models';
import { ALL_MAIL_PATH } from './sync-service';
import { formatParticipantList } from '../utils/format-participant';
import type { SemanticSearchFilters } from '../utils/search-filter-translator';

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
    return path.join(userDataPath, 'latentmail.db');
  }

  async initialize(): Promise<void> {
    this.dbPath = this.getDbPath();
    log.info(`Initializing database at: ${this.dbPath}`);

    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const wasmPath = path.join(
      app.getAppPath(),
      'node_modules',
      'sql.js',
      'dist',
      'sql-wasm.wasm'
    );
    const SQL = await initSqlJs({ locateFile: () => wasmPath });

    if (fs.existsSync(this.dbPath)) {
      const fileBuffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(fileBuffer);
      log.info('Loaded existing database');

      let hasSchemaMigrations = false;
      let hasSchemaVersion = false;
      try {
        this.db.exec('SELECT name FROM schema_migrations LIMIT 1');
        hasSchemaMigrations = true;
      } catch {
        // schema_migrations table does not exist
      }
      try {
        this.db.exec('SELECT version FROM schema_version LIMIT 1');
        hasSchemaVersion = true;
      } catch {
        // schema_version table does not exist
      }
      if (hasSchemaVersion && !hasSchemaMigrations) {
        log.info('Database reset: old schema_version-based DB detected; removing and starting fresh with Umzug migrations');
        this.db.close();
        this.db = null;
        fs.unlinkSync(this.dbPath);
        this.db = new SQL.Database();
        log.info('Created fresh database');
      }
    } else {
      this.db = new SQL.Database();
      log.info('Created new database');
    }

    this.db.run('PRAGMA foreign_keys = ON');

    const migrationsDir = path.join(__dirname, '..', 'database', 'migrations');
    const umzug = new Umzug({
      migrations: {
        glob: ['*.js', { cwd: migrationsDir }],
      },
      context: { db: this.db, databaseService: this },
      storage: createSqlJsStorage(this.db),
      logger: log,
    });

    const executed = await umzug.up();
    if (executed.length > 0) {
      log.info(`[MIGRATIONS] Migrations executed: ${executed.map((m) => m.name).join(', ')}`);
    } else {
      log.info('[MIGRATIONS] No pending migrations');
    }
    this.saveToDisk();
    log.info('Database schema initialized (Umzug)');
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
    this.db.run('BEGIN');
    try {
      // Delete all account data explicitly — do not rely on FK ON DELETE CASCADE
      // since foreign_keys enforcement can be unreliable in sql.js across sessions.

      // attachments and search_index reference emails(id) with no account_id column;
      // delete them via subquery before the emails rows are removed.
      this.db.run(
        'DELETE FROM attachments WHERE email_id IN (SELECT id FROM emails WHERE account_id = :accountId)',
        { ':accountId': id }
      );
      this.db.run(
        'DELETE FROM search_index WHERE email_id IN (SELECT id FROM emails WHERE account_id = :accountId)',
        { ':accountId': id }
      );
      // Junction tables have no FK constraint to accounts — must be deleted explicitly.
      this.db.run('DELETE FROM email_folders WHERE account_id = :accountId', { ':accountId': id });
      this.db.run('DELETE FROM thread_folders WHERE account_id = :accountId', { ':accountId': id });
      // Direct account-owned tables.
      this.db.run('DELETE FROM emails WHERE account_id = :accountId', { ':accountId': id });
      this.db.run('DELETE FROM threads WHERE account_id = :accountId', { ':accountId': id });
      this.db.run('DELETE FROM folder_state WHERE account_id = :accountId', { ':accountId': id });
      this.db.run('DELETE FROM labels WHERE account_id = :accountId', { ':accountId': id });
      this.db.run('DELETE FROM filters WHERE account_id = :accountId', { ':accountId': id });
      // Finally remove the accounts row itself.
      this.db.run('DELETE FROM accounts WHERE id = :id', { ':id': id });
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
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
        is_read, is_starred, is_important, is_draft, snippet, size, has_attachments, labels, updated_at)
       VALUES (:accountId, :xGmMsgId, :xGmThrid, :messageId, :fromAddress, :fromName,
        :toAddresses, :ccAddresses, :bccAddresses, :subject, :textBody, :htmlBody, :date,
        :isRead, :isStarred, :isImportant, :isDraft, :snippet, :size, :hasAttachments, :labels, datetime('now'))
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
        is_draft = MAX(is_draft, excluded.is_draft),
        snippet = excluded.snippet, size = excluded.size, has_attachments = excluded.has_attachments,
        labels = excluded.labels,
        updated_at = datetime('now')`,
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

    // Record folder association in the link table (keyed by x_gm_msgid, not email_id).
    // [Gmail]/All Mail is a discovery scope, not a persisted folder association here.
    if (email.folder !== ALL_MAIL_PATH) {
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

    updates.push("updated_at = datetime('now')");

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
    offset: number = 0,
    threadId?: string
  ): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');
    const params: Record<string, string | number> = {
      ':accountId': accountId,
      ':folder': folder,
      ':limit': limit,
      ':offset': offset,
    };
    if (threadId != null && threadId !== '') {
      params[':threadId'] = threadId;
    }
    params[':trashFolder'] = this.getTrashFolder(accountId);
    const whereClause =
      threadId != null && threadId !== ''
        ? 'WHERE t.account_id = :accountId AND t.x_gm_thrid = :threadId'
        : 'WHERE t.account_id = :accountId';
    const result = this.db.exec(
      `SELECT t.id, t.account_id, t.x_gm_thrid, t.subject, MAX(e.date) AS last_message_date, t.participants,
        (SELECT COUNT(DISTINCT e2.x_gm_msgid)
         FROM emails e2
         JOIN email_folders ef2 ON ef2.account_id = e2.account_id AND ef2.x_gm_msgid = e2.x_gm_msgid
         LEFT JOIN email_folders ef_trash ON ef_trash.account_id = e2.account_id
           AND ef_trash.x_gm_msgid = e2.x_gm_msgid
           AND ef_trash.folder = :trashFolder
         WHERE e2.account_id = :accountId AND e2.x_gm_thrid = t.x_gm_thrid
           AND (
             :folder = :trashFolder
             OR ef_trash.x_gm_msgid IS NULL
           )
        ) AS message_count,
        t.snippet, tf.folder, t.is_read, t.is_starred,
        MAX(e.has_attachments) AS has_attachments,
        (SELECT e2.to_addresses FROM emails e2
         JOIN email_folders ef2 ON ef2.account_id = e2.account_id AND ef2.x_gm_msgid = e2.x_gm_msgid AND ef2.folder = :folder
         WHERE e2.account_id = t.account_id AND e2.x_gm_thrid = t.x_gm_thrid
         ORDER BY e2.date DESC LIMIT 1) AS to_participants
       FROM threads t
       INNER JOIN thread_folders tf ON t.account_id = tf.account_id AND t.x_gm_thrid = tf.x_gm_thrid AND tf.folder = :folder
       INNER JOIN email_folders ef ON ef.account_id = t.account_id AND ef.folder = :folder
       INNER JOIN emails e ON e.account_id = ef.account_id AND e.x_gm_msgid = ef.x_gm_msgid AND e.x_gm_thrid = t.x_gm_thrid
       ${whereClause}
       GROUP BY t.id
       ORDER BY MAX(e.date) DESC LIMIT :limit OFFSET :offset`,
      params
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
    const trashFolder = this.getTrashFolder(accountId);
    const result = this.db.exec(
      `SELECT t.id, t.account_id, t.x_gm_thrid, t.subject, MAX(e.date) AS last_message_date, t.participants,
        (SELECT COUNT(DISTINCT e2.x_gm_msgid)
         FROM emails e2
         JOIN email_folders ef2 ON ef2.account_id = e2.account_id AND ef2.x_gm_msgid = e2.x_gm_msgid
         LEFT JOIN email_folders ef_trash ON ef_trash.account_id = e2.account_id
           AND ef_trash.x_gm_msgid = e2.x_gm_msgid
           AND ef_trash.folder = :trashFolder
         WHERE e2.account_id = :accountId AND e2.x_gm_thrid = t.x_gm_thrid
           AND (
             :folder = :trashFolder
             OR ef_trash.x_gm_msgid IS NULL
           )
        ) AS message_count,
        t.snippet, tf.folder, t.is_read, t.is_starred,
        MAX(e.has_attachments) AS has_attachments,
        (SELECT e2.to_addresses FROM emails e2
         JOIN email_folders ef2 ON ef2.account_id = e2.account_id AND ef2.x_gm_msgid = e2.x_gm_msgid AND ef2.folder = :folder
         WHERE e2.account_id = t.account_id AND e2.x_gm_thrid = t.x_gm_thrid
         ORDER BY e2.date DESC LIMIT 1) AS to_participants
       FROM threads t
       INNER JOIN thread_folders tf ON t.account_id = tf.account_id AND t.x_gm_thrid = tf.x_gm_thrid AND tf.folder = :folder
       INNER JOIN email_folders ef ON ef.account_id = t.account_id AND ef.folder = :folder
       INNER JOIN emails e ON e.account_id = ef.account_id AND e.x_gm_msgid = ef.x_gm_msgid AND e.x_gm_thrid = t.x_gm_thrid
       WHERE t.account_id = :accountId
       GROUP BY t.id
       HAVING MAX(e.date) < :beforeDate
       ORDER BY MAX(e.date) DESC LIMIT :limit`,
      { ':accountId': accountId, ':folder': folder, ':beforeDate': beforeDate, ':limit': limit, ':trashFolder': trashFolder }
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

    updates.push("updated_at = datetime('now')");

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

  // ---- Label-based email-folder reconciliation (All Mail sync) ----

  /**
   * Synchronize email_folders entries for a single email based on its current folder paths
   * (derived from X-GM-LABELS mapping in the All Mail sync path).
   *
   * Compares existing folder associations against the `currentFolderPaths` array:
   * - Adds missing associations (email_folders with uid=NULL, thread_folders upsert)
   * - Removes stale associations (email_folders delete, thread_folders cleanup)
   *
   * Wrapped in a DB transaction for atomicity. Returns the set of all affected
   * folder paths (added + removed) for event emission tracking.
   */
  reconcileEmailFolders(
    accountId: number,
    xGmMsgId: string,
    xGmThrid: string,
    currentFolderPaths: string[],
  ): Set<string> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const affectedFolders = new Set<string>();

    // Get existing folder associations
    const existingFolders = this.getFoldersForEmail(accountId, xGmMsgId);
    const existingSet = new Set(existingFolders);
    const currentSet = new Set(currentFolderPaths);

    // Determine adds and removes
    const toAdd = currentFolderPaths.filter((f) => !existingSet.has(f));
    const toRemove = existingFolders.filter((f) => !currentSet.has(f));

    if (toAdd.length === 0 && toRemove.length === 0) {
      return affectedFolders;
    }

    // Use SAVEPOINT (not BEGIN) so this can be safely nested inside an outer transaction.
    const savepointName = `reconcile_${xGmMsgId.replace(/[^a-zA-Z0-9]/g, '_')}`;
    this.db.run(`SAVEPOINT ${savepointName}`);
    try {
      // Add missing folder associations
      for (const folder of toAdd) {
        this.db.run(
          'INSERT OR IGNORE INTO email_folders (account_id, x_gm_msgid, folder) VALUES (:accountId, :xGmMsgId, :folder)',
          { ':accountId': accountId, ':xGmMsgId': xGmMsgId, ':folder': folder }
        );
        // Upsert thread_folders
        this.db.run(
          'INSERT OR IGNORE INTO thread_folders (account_id, x_gm_thrid, folder) VALUES (:accountId, :xGmThrid, :folder)',
          { ':accountId': accountId, ':xGmThrid': xGmThrid, ':folder': folder }
        );
        affectedFolders.add(folder);
      }

      // Remove stale folder associations
      for (const folder of toRemove) {
        this.db.run(
          'DELETE FROM email_folders WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId AND folder = :folder',
          { ':accountId': accountId, ':xGmMsgId': xGmMsgId, ':folder': folder }
        );
        // Check if thread still has other emails in this folder
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
        affectedFolders.add(folder);
      }

      this.db.run(`RELEASE ${savepointName}`);
    } catch (err) {
      this.db.run(`ROLLBACK TO ${savepointName}`);
      this.db.run(`RELEASE ${savepointName}`);
      throw err;
    }

    if (affectedFolders.size > 0) {
      this.scheduleSave();
    }
    return affectedFolders;
  }

  /**
   * Delete all folder_state rows for an account except the specified folders.
   * Used for one-time cleanup after switching to All Mail sync.
   */
  cleanupStaleFolderStates(accountId: number, keepFolders: string[]): number {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    if (keepFolders.length === 0) {
      return 0;
    }

    const placeholders = keepFolders.map((_, i) => `:keep${i}`).join(', ');
    const params: Record<string, string | number> = { ':accountId': accountId };
    for (let i = 0; i < keepFolders.length; i++) {
      params[`:keep${i}`] = keepFolders[i];
    }

    // Count before delete
    const countResult = this.db.exec(
      `SELECT COUNT(*) FROM folder_state WHERE account_id = :accountId AND folder NOT IN (${placeholders})`,
      params
    );
    const count = (countResult.length > 0 && countResult[0].values.length > 0)
      ? countResult[0].values[0][0] as number : 0;

    if (count > 0) {
      this.db.run(
        `DELETE FROM folder_state WHERE account_id = :accountId AND folder NOT IN (${placeholders})`,
        params
      );
      this.scheduleSave();
    }
    return count;
  }

  // ---- Email-Folder association management (keyed by X-GM-MSGID) ----

  /**
   * Add an email-folder association (e.g. after IMAP COPY places a message in a label folder).
   * Idempotent — uses INSERT OR IGNORE.
   */
  addEmailFolderAssociation(accountId: number, xGmMsgId: string, folder: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      'INSERT OR IGNORE INTO email_folders (account_id, x_gm_msgid, folder) VALUES (:accountId, :xGmMsgId, :folder)',
      { ':accountId': accountId, ':xGmMsgId': xGmMsgId, ':folder': folder }
    );
    this.scheduleSave();
  }

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

      // Remove the email row itself (CASCADE handles attachments, search_index)
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

  removeOrphanedEmails(accountId: number, bypassGracePeriod: boolean = false): Array<{ xGmMsgId: string; xGmThrid: string }> {
    if (!this.db) throw new Error('Database not initialized');

    const removed: Array<{ xGmMsgId: string; xGmThrid: string }> = [];

    // Grace period clause: skip rows touched within the last hour so that
    // recently-discovered archived emails (no folder links) survive until the
    // next periodic cleanup cycle. bypassGracePeriod=true is used by wipeFolderData
    // for intentional UIDVALIDITY-triggered wipes that need immediate cleanup.
    const gracePeriodClause = bypassGracePeriod
      ? ''
      : "AND (updated_at IS NULL OR updated_at < datetime('now', '-1 hour'))";

    this.db.run('BEGIN');
    try {
      const selectResult = this.db.exec(
        `SELECT x_gm_msgid, x_gm_thrid FROM emails
         WHERE account_id = :accountId
           AND x_gm_msgid NOT IN (SELECT x_gm_msgid FROM email_folders WHERE account_id = :accountId)
           ${gracePeriodClause}`,
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
             AND x_gm_msgid NOT IN (SELECT x_gm_msgid FROM email_folders WHERE account_id = :accountId)
             ${gracePeriodClause}`,
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

  removeOrphanedThreads(accountId: number, bypassGracePeriod: boolean = false): number {
    if (!this.db) throw new Error('Database not initialized');

    // Grace period clauses: skip threads touched within the last hour so that
    // recently-discovered archived threads (no folder links) survive cleanup.
    // bypassGracePeriod=true is used by wipeFolderData for intentional wipes.
    // Two variants are needed: one for the aliased SELECT (t.updated_at) and
    // one for the non-aliased DELETE (threads.updated_at).
    const countGracePeriodClause = bypassGracePeriod
      ? ''
      : "AND (t.updated_at IS NULL OR t.updated_at < datetime('now', '-1 hour'))";
    const deleteGracePeriodClause = bypassGracePeriod
      ? ''
      : "AND (threads.updated_at IS NULL OR threads.updated_at < datetime('now', '-1 hour'))";

    const countResult = this.db.exec(
      `SELECT COUNT(*) FROM threads t WHERE t.account_id = :accountId
       AND NOT EXISTS (SELECT 1 FROM thread_folders tf WHERE tf.account_id = t.account_id AND tf.x_gm_thrid = t.x_gm_thrid)
       ${countGracePeriodClause}`,
      { ':accountId': accountId }
    );
    const count = (countResult.length > 0 && countResult[0].values.length > 0)
      ? countResult[0].values[0][0] as number : 0;

    if (count > 0) {
      this.db.run(
        `DELETE FROM threads WHERE account_id = :accountId
         AND NOT EXISTS (SELECT 1 FROM thread_folders tf WHERE tf.account_id = threads.account_id AND tf.x_gm_thrid = threads.x_gm_thrid)
         ${deleteGracePeriodClause}`,
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

  /**
   * Recomputes the stored thread metadata (message_count, subject, snippet, etc.).
   * Note: threads.message_count stores the visible (non-trashed) email count.
   * It is read by getThreadById and surfaced to the renderer in some paths;
   * keeping it consistent with the list-view display count avoids stale data.
   * The Trash folder list view always uses a live subquery that includes all emails,
   * so it is unaffected by this stored value.
   */
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

      const trashFolder = this.getTrashFolder(accountId);
      const aggResult = this.db.exec(
        `SELECT
           COUNT(DISTINCT e.id) AS message_count,
           MAX(date) AS last_message_date,
           MIN(CASE WHEN is_read = 0 THEN 0 ELSE 1 END) AS all_read,
           MAX(is_starred) AS any_starred
         FROM emails e
         LEFT JOIN email_folders ef_trash ON ef_trash.account_id = e.account_id
           AND ef_trash.x_gm_msgid = e.x_gm_msgid
           AND ef_trash.folder = :trashFolder
         WHERE e.account_id = :accountId AND e.x_gm_thrid = :xGmThrid
           AND ef_trash.x_gm_msgid IS NULL`,
        { ':accountId': accountId, ':xGmThrid': xGmThrid, ':trashFolder': trashFolder }
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
        `SELECT from_address, from_name FROM emails
         WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid
         ORDER BY date DESC`,
        { ':accountId': accountId, ':xGmThrid': xGmThrid }
      );
      const participantRows = participantsResult.length > 0 && participantsResult[0].values.length > 0
        ? participantsResult[0].values.map((row) => ({
            fromAddress: row[0] as string,
            fromName: row[1] as string | null,
          }))
        : [];
      const participants = formatParticipantList(participantRows);

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

  /**
   * Update folder_state for uidValidity and condstoreSupported only.
   * Does NOT touch highest_modseq — caller is a queue post-op, not the sync path.
   * If no row exists yet, inserts with highest_modseq = NULL so the next sync
   * falls back to a full date-based fetch.
   */
  updateFolderStateNonModseq(
    accountId: number,
    folder: string,
    uidValidity: string,
    condstoreSupported: boolean,
  ): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      `INSERT INTO folder_state (account_id, folder, uid_validity, highest_modseq, condstore_supported, updated_at)
       VALUES (:accountId, :folder, :uidValidity, NULL, :condstoreSupported, datetime('now'))
       ON CONFLICT(account_id, folder) DO UPDATE SET
        uid_validity        = excluded.uid_validity,
        condstore_supported = excluded.condstore_supported,
        updated_at          = datetime('now')`,
      {
        ':accountId': accountId,
        ':folder': folder,
        ':uidValidity': uidValidity,
        ':condstoreSupported': condstoreSupported ? 1 : 0,
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

    // Remove newly orphaned emails and track their affected threads.
    // Pass bypassGracePeriod=true: this is an intentional wipe (UIDVALIDITY reset),
    // so immediate cleanup is correct — no grace period needed.
    const orphanedEmails = this.removeOrphanedEmails(accountId, true);
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

    // Remove threads that no longer belong to any folder.
    // Pass bypassGracePeriod=true for the same reason as removeOrphanedEmails above.
    this.removeOrphanedThreads(accountId, true);

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
    specialUse?: string;
  }): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      `INSERT INTO labels (account_id, gmail_label_id, name, type, color, unread_count, total_count, special_use)
       VALUES (:accountId, :gmailLabelId, :name, :type, :color, :unreadCount, :totalCount, :specialUse)
       ON CONFLICT(account_id, gmail_label_id) DO UPDATE SET
        name = excluded.name, type = excluded.type, color = COALESCE(excluded.color, labels.color),
        unread_count = excluded.unread_count, total_count = excluded.total_count,
        special_use = COALESCE(excluded.special_use, labels.special_use)`,
      {
        ':accountId': label.accountId,
        ':gmailLabelId': label.gmailLabelId,
        ':name': label.name,
        ':type': label.type,
        ':color': label.color || null,
        ':unreadCount': label.unreadCount,
        ':totalCount': label.totalCount,
        ':specialUse': label.specialUse || null,
      }
    );
    this.scheduleSave();
  }

  /**
   * Resolve the trash folder IMAP path for an account.
   * Primary: queries the labels table for the row with special_use = '\Trash' and returns its gmail_label_id.
   * Legacy fallback: if special_use is not yet populated (before first sync after migration),
   *   checks for a label with gmail_label_id = '[Gmail]/Bin' (UK/international locale variant).
   * Final fallback: '[Gmail]/Trash' (US locale default).
   */
  getTrashFolder(accountId: number): string {
    if (!this.db) throw new Error('Database not initialized');

    // Primary: resolve by special_use attribute (populated after first sync post-migration)
    const bySpecialUse = this.db.exec(
      `SELECT gmail_label_id FROM labels WHERE account_id = :accountId AND special_use = '\Trash' LIMIT 1`,
      { ':accountId': accountId }
    );
    if (bySpecialUse.length > 0 && bySpecialUse[0].values.length > 0) {
      const value = bySpecialUse[0].values[0][0];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }

    // Legacy fallback: check for '[Gmail]/Bin' by label ID (UK locale, before special_use is populated)
    const byBin = this.db.exec(
      `SELECT gmail_label_id FROM labels WHERE account_id = :accountId AND gmail_label_id = '[Gmail]/Bin' LIMIT 1`,
      { ':accountId': accountId }
    );
    if (byBin.length > 0 && byBin[0].values.length > 0) {
      const value = byBin[0].values[0][0];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }

    return '[Gmail]/Trash';
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
      `SELECT id, account_id, gmail_label_id, name, type, color, unread_count, total_count, special_use
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
      specialUse: row[8] as string | null,
    }));
  }

  /**
   * Insert a new user-defined label (gmail_label_id = label name used as IMAP mailbox path).
   * Returns the new row's id.
   */
  createLabel(accountId: number, gmailLabelId: string, name: string, color: string | null): number {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      `INSERT INTO labels (account_id, gmail_label_id, name, type, color, unread_count, total_count)
       VALUES (:accountId, :gmailLabelId, :name, 'user', :color, 0, 0)`,
      { ':accountId': accountId, ':gmailLabelId': gmailLabelId, ':name': name, ':color': color }
    );
    const result = this.db.exec(
      'SELECT id FROM labels WHERE account_id = :accountId AND gmail_label_id = :gmailLabelId',
      { ':accountId': accountId, ':gmailLabelId': gmailLabelId }
    );
    const newId = result[0]?.values[0]?.[0] as number;
    this.scheduleSave();
    return newId;
  }

  /**
   * Delete a user label and clean up email_folders / thread_folders associations.
   * All three deletions run in a single transaction.
   */
  deleteLabel(accountId: number, gmailLabelId: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('BEGIN');
    try {
      this.db.run(
        'DELETE FROM email_folders WHERE account_id = :accountId AND folder = :gmailLabelId',
        { ':accountId': accountId, ':gmailLabelId': gmailLabelId }
      );
      this.db.run(
        'DELETE FROM thread_folders WHERE account_id = :accountId AND folder = :gmailLabelId',
        { ':accountId': accountId, ':gmailLabelId': gmailLabelId }
      );
      this.db.run(
        'DELETE FROM labels WHERE account_id = :accountId AND gmail_label_id = :gmailLabelId',
        { ':accountId': accountId, ':gmailLabelId': gmailLabelId }
      );
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    this.scheduleSave();
  }

  /**
   * Update the color column of a label. Pass null to clear the color.
   */
  updateLabelColor(accountId: number, gmailLabelId: string, color: string | null): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      'UPDATE labels SET color = :color WHERE account_id = :accountId AND gmail_label_id = :gmailLabelId',
      { ':accountId': accountId, ':gmailLabelId': gmailLabelId, ':color': color }
    );
    this.scheduleSave();
  }

  /**
   * Look up a single label row by account + gmailLabelId. Returns null if not found.
   */
  getLabelByGmailId(accountId: number, gmailLabelId: string): Record<string, unknown> | null {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, gmail_label_id, name, type, color
       FROM labels WHERE account_id = :accountId AND gmail_label_id = :gmailLabelId`,
      { ':accountId': accountId, ':gmailLabelId': gmailLabelId }
    );
    if (result.length === 0 || result[0].values.length === 0) {
      return null;
    }
    const row = result[0].values[0];
    return {
      id: row[0] as number,
      accountId: row[1] as number,
      gmailLabelId: row[2] as string,
      name: row[3] as string,
      type: row[4] as string,
      color: row[5] as string | null,
    };
  }

  /**
   * Batch-fetch user labels for a set of thread IDs.
   * Returns a Map keyed by xGmThrid → array of label objects.
   */
  getLabelsForThreadBatch(
    accountId: number,
    xGmThrids: string[]
  ): Map<string, Array<{ id: number; name: string; color: string | null; gmailLabelId: string }>> {
    if (!this.db) throw new Error('Database not initialized');
    if (xGmThrids.length === 0) {
      return new Map();
    }

    // Build a quoted, comma-separated list for the IN clause (no parameterised arrays in sql.js)
    const sanitized = xGmThrids
      .map((identifier) => identifier.replace(/'/g, "''"))
      .map((identifier) => `'${identifier}'`)
      .join(', ');

    const sql = `
      SELECT DISTINCT e.x_gm_thrid, l.id, l.name, l.color, l.gmail_label_id
      FROM emails e
      JOIN email_folders ef ON ef.account_id = e.account_id AND ef.x_gm_msgid = e.x_gm_msgid
      JOIN labels l ON l.account_id = e.account_id AND l.gmail_label_id = ef.folder
      WHERE e.account_id = :accountId
        AND l.type = 'user'
        AND e.x_gm_thrid IN (${sanitized})
    `;

    const result = this.db.exec(sql, { ':accountId': accountId });
    const map = new Map<string, Array<{ id: number; name: string; color: string | null; gmailLabelId: string }>>();

    if (result.length === 0) {
      return map;
    }

    for (const row of result[0].values) {
      const xGmThrid = row[0] as string;
      const labelEntry = {
        id: row[1] as number,
        name: row[2] as string,
        color: row[3] as string | null,
        gmailLabelId: row[4] as string,
      };
      if (!map.has(xGmThrid)) {
        map.set(xGmThrid, []);
      }
      map.get(xGmThrid)!.push(labelEntry);
    }

    return map;
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
    const parsed = parseGmailQuery(query, {
      accountId,
      trashFolderResolver: (resolverAccountId?: number) => this.getTrashFolder(resolverAccountId ?? accountId),
    }) as { whereClause: string; params: Record<string, unknown> };

    const params = {
      ':accountId': accountId,
      ':limit': limit,
      ':trashFolder': this.getTrashFolder(accountId),
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
         (SELECT COUNT(DISTINCT e2.x_gm_msgid)
          FROM emails e2
          JOIN email_folders ef2 ON ef2.account_id = e2.account_id AND ef2.x_gm_msgid = e2.x_gm_msgid
          WHERE e2.account_id = :accountId AND e2.x_gm_thrid = t.x_gm_thrid
            AND ef2.folder != :trashFolder
         ) AS message_count,
         t.snippet,
         'search' AS folder,
         t.is_read,
         t.is_starred,
         (SELECT MAX(e3.has_attachments) FROM emails e3
          WHERE e3.account_id = :accountId AND e3.x_gm_thrid = t.x_gm_thrid
         ) AS has_attachments
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
        trashFolderResolver: (resolverAccountId?: number) => this.getTrashFolder(resolverAccountId ?? accountId),
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
      ':trashFolder': this.getTrashFolder(accountId),
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
          (SELECT COUNT(DISTINCT e2.x_gm_msgid)
          FROM emails e2
          JOIN email_folders ef2 ON ef2.account_id = e2.account_id AND ef2.x_gm_msgid = e2.x_gm_msgid
          WHERE e2.account_id = :accountId AND e2.x_gm_thrid = t.x_gm_thrid
            AND ef2.folder != :trashFolder
         ) AS message_count,
         t.snippet,
         'search' AS folder,
         t.is_read,
         t.is_starred,
         (SELECT MAX(e3.has_attachments) FROM emails e3
          WHERE e3.account_id = :accountId AND e3.x_gm_thrid = t.x_gm_thrid
         ) AS has_attachments
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

  getThreadIdsWithDrafts(accountId: number, threadIds: number[], folder: string): Set<number> {
    if (!this.db) throw new Error('Database not initialized');

    const result = new Set<number>();
    const uniqueThreadIds = Array.from(new Set(threadIds.filter((id) => Number.isFinite(id))));
    if (uniqueThreadIds.length === 0) return result;

    const placeholders = uniqueThreadIds.map((_, index) => `:threadId${index}`);
    const params: Record<string, number | string> = {
      ':folder': folder,
      ':trashFolder': this.getTrashFolder(accountId),
    };
    for (let index = 0; index < uniqueThreadIds.length; index++) {
      params[`:threadId${index}`] = uniqueThreadIds[index];
    }

    const queryResult = this.db.exec(
      `SELECT DISTINCT t.id
       FROM threads t
       INNER JOIN emails e ON e.account_id = t.account_id AND e.x_gm_thrid = t.x_gm_thrid
       LEFT JOIN email_folders ef_trash ON ef_trash.account_id = e.account_id
         AND ef_trash.x_gm_msgid = e.x_gm_msgid
         AND ef_trash.folder = :trashFolder
       WHERE t.id IN (${placeholders.join(', ')}) AND e.is_draft = 1
         AND (
           :folder = :trashFolder
           OR ef_trash.x_gm_msgid IS NULL
         )`,
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
      if (col === 'is_read' || col === 'is_starred' || col === 'has_attachments') {
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
          `UPDATE emails SET is_filtered = 1, updated_at = datetime('now') WHERE id IN (${placeholders.join(', ')})`,
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

  // ---- Body prefetch helpers ----

  /**
   * Query emails with missing bodies (text_body AND html_body both empty/null).
   *
   * Periodic timer path (sinceMinutes omitted): uses a 7-day window on both `date`
   * and `updated_at` so recently-received AND recently-modified emails are covered.
   *
   * IDLE path (sinceMinutes provided): narrows to `updated_at >= :sinceTime` only,
   * targeting only emails that were just synced.
   *
   * Returns newest-first so the most recent emails get bodies first.
   */
  getEmailsNeedingBodies(
    accountId: number,
    limit: number = 50,
    sinceMinutes?: number,
  ): Array<{ accountId: number; xGmMsgId: string; xGmThrid: string }> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    let sql: string;
    let params: Record<string, number | string>;

    // Use SQLite datetime() functions for time window comparisons to avoid format
    // mismatches: `updated_at` is stored as `datetime('now')` format (YYYY-MM-DD HH:MM:SS),
    // while JS `toISOString()` produces ISO 8601 (with T and Z). SQLite's lexicographic
    // string comparison would give incorrect results across these two formats.

    if (sinceMinutes !== undefined) {
      sql = `
        SELECT account_id, x_gm_msgid, x_gm_thrid
        FROM emails
        WHERE account_id = :accountId
          AND (text_body IS NULL OR text_body = '')
          AND (html_body IS NULL OR html_body = '')
          AND updated_at >= datetime('now', '-' || :sinceMinutes || ' minutes')
        ORDER BY date DESC
        LIMIT :limit
      `;
      params = { ':accountId': accountId, ':sinceMinutes': sinceMinutes, ':limit': limit };
    } else {
      sql = `
        SELECT account_id, x_gm_msgid, x_gm_thrid
        FROM emails
        WHERE account_id = :accountId
          AND (text_body IS NULL OR text_body = '')
          AND (html_body IS NULL OR html_body = '')
          AND (date >= datetime('now', '-7 days') OR updated_at >= datetime('now', '-7 days'))
        ORDER BY date DESC
        LIMIT :limit
      `;
      params = { ':accountId': accountId, ':limit': limit };
    }

    const result = this.db.exec(sql, params);
    if (result.length === 0) {
      return [];
    }
    return result[0].values.map((row) => ({
      accountId: row[0] as number,
      xGmMsgId: row[1] as string,
      xGmThrid: row[2] as string,
    }));
  }

  /**
   * Update only the body fields (text_body, html_body) for an existing email.
   * The WHERE clause guards against overwriting a body that was fetched by another
   * path (e.g. syncThread) between the query and this update — making it idempotent.
   * Does NOT modify any other columns (flags, snippet, labels, etc.).
   */
  updateEmailBodyOnly(
    accountId: number,
    xGmMsgId: string,
    textBody: string,
    htmlBody: string,
  ): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    this.db.run(
      `UPDATE emails
       SET text_body = :textBody,
           html_body = :htmlBody,
           updated_at = datetime('now')
       WHERE account_id = :accountId
         AND x_gm_msgid = :xGmMsgId
         AND (text_body IS NULL OR text_body = '')
         AND (html_body IS NULL OR html_body = '')`,
      {
        ':textBody': textBody || null,
        ':htmlBody': htmlBody || null,
        ':accountId': accountId,
        ':xGmMsgId': xGmMsgId,
      },
    );
    this.scheduleSave();
  }

  // ---- Attachment CRUD ----

  /**
   * Bulk insert attachment metadata rows for a given email.
   * Skips rows that already exist (idempotent on re-sync).
   * Returns the internal email_id used for the FK reference.
   */
  upsertAttachmentsForEmail(
    accountId: number,
    xGmMsgId: string,
    attachments: Array<{
      filename: string;
      mimeType: string | null;
      size: number | null;
      contentId: string | null;
    }>
  ): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    if (attachments.length === 0) {
      return;
    }

    // Look up the email's internal id
    const emailResult = this.db.exec(
      'SELECT id FROM emails WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId',
      { ':accountId': accountId, ':xGmMsgId': xGmMsgId }
    );
    if (emailResult.length === 0 || emailResult[0].values.length === 0) {
      log.warn(`[DB] upsertAttachmentsForEmail: email not found for account=${accountId} msgid=${xGmMsgId}`);
      return;
    }
    const emailId = emailResult[0].values[0][0] as number;

    for (const att of attachments) {
      // Use INSERT OR IGNORE so that re-syncing a message doesn't duplicate attachment rows.
      // Attachment identity is determined by (email_id, filename, content_id).
      this.db.run(
        `INSERT OR IGNORE INTO attachments (email_id, filename, mime_type, size, content_id)
         VALUES (:emailId, :filename, :mimeType, :size, :contentId)`,
        {
          ':emailId': emailId,
          ':filename': att.filename,
          ':mimeType': att.mimeType ?? null,
          ':size': att.size ?? null,
          ':contentId': att.contentId ?? null,
        }
      );
    }
    this.scheduleSave();
  }

  /**
   * Get all attachment metadata rows for a given email (by xGmMsgId).
   */
  getAttachmentsForEmail(accountId: number, xGmMsgId: string): AttachmentRecord[] {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    const result = this.db.exec(
      `SELECT a.id, a.email_id, a.filename, a.mime_type, a.size, a.content_id, a.local_path, a.created_at
       FROM attachments a
       JOIN emails e ON e.id = a.email_id
       WHERE e.account_id = :accountId AND e.x_gm_msgid = :xGmMsgId
       ORDER BY a.id ASC`,
      { ':accountId': accountId, ':xGmMsgId': xGmMsgId }
    );
    if (result.length === 0) {
      return [];
    }
    return result[0].values.map((row) => ({
      id: row[0] as number,
      emailId: row[1] as number,
      filename: row[2] as string,
      mimeType: row[3] as string | null,
      size: row[4] as number | null,
      contentId: row[5] as string | null,
      localPath: row[6] as string | null,
      createdAt: row[7] as string,
    }));
  }

  /**
   * Get all attachment metadata rows for multiple emails (by xGmMsgId).
   * Returns a Map of xGmMsgId → AttachmentRecord[].
   * Efficient batch query used when loading thread messages.
   */
  getAttachmentsForEmails(accountId: number, xGmMsgIds: string[]): Map<string, AttachmentRecord[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    const result = new Map<string, AttachmentRecord[]>();
    if (xGmMsgIds.length === 0) {
      return result;
    }

    const placeholders = xGmMsgIds.map((_, i) => `:msgid${i}`).join(', ');
    const params: Record<string, string | number> = { ':accountId': accountId };
    for (let i = 0; i < xGmMsgIds.length; i++) {
      params[`:msgid${i}`] = xGmMsgIds[i];
    }

    const queryResult = this.db.exec(
      `SELECT a.id, a.email_id, a.filename, a.mime_type, a.size, a.content_id, a.local_path, a.created_at,
              e.x_gm_msgid
       FROM attachments a
       JOIN emails e ON e.id = a.email_id
       WHERE e.account_id = :accountId AND e.x_gm_msgid IN (${placeholders})
       ORDER BY e.x_gm_msgid, a.id ASC`,
      params
    );

    if (queryResult.length === 0) {
      return result;
    }

    for (const row of queryResult[0].values) {
      const xGmMsgId = row[8] as string;
      if (!result.has(xGmMsgId)) {
        result.set(xGmMsgId, []);
      }
      result.get(xGmMsgId)!.push({
        id: row[0] as number,
        emailId: row[1] as number,
        filename: row[2] as string,
        mimeType: row[3] as string | null,
        size: row[4] as number | null,
        contentId: row[5] as string | null,
        localPath: row[6] as string | null,
        createdAt: row[7] as string,
      });
    }

    return result;
  }

  /**
   * Update the local_path for a cached attachment file.
   */
  updateAttachmentLocalPath(attachmentId: number, localPath: string): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    this.db.run(
      'UPDATE attachments SET local_path = :localPath WHERE id = :id',
      { ':localPath': localPath, ':id': attachmentId }
    );
    this.scheduleSave();
  }

  /**
   * Delete all cached attachment files for an account from the DB (local_path records).
   * Used during account removal to clean up local_path references before filesystem cleanup.
   */
  clearAttachmentLocalPathsForAccount(accountId: number): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    this.db.run(
      `UPDATE attachments SET local_path = NULL
       WHERE email_id IN (SELECT id FROM emails WHERE account_id = :accountId)`,
      { ':accountId': accountId }
    );
    this.scheduleSave();
  }

  /**
   * Get a single attachment record by its ID.
   */
  getAttachmentById(attachmentId: number): AttachmentRecord | null {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    const result = this.db.exec(
      `SELECT id, email_id, filename, mime_type, size, content_id, local_path, created_at
       FROM attachments WHERE id = :id`,
      { ':id': attachmentId }
    );
    if (result.length === 0 || result[0].values.length === 0) {
      return null;
    }
    const row = result[0].values[0];
    return {
      id: row[0] as number,
      emailId: row[1] as number,
      filename: row[2] as string,
      mimeType: row[3] as string | null,
      size: row[4] as number | null,
      contentId: row[5] as string | null,
      localPath: row[6] as string | null,
      createdAt: row[7] as string,
    };
  }

  /**
   * Get the email's xGmMsgId (and accountId) for a given attachment ID.
   * Used by attachment IPC handlers to locate the source email for on-demand content fetch.
   */
  getEmailInfoForAttachment(attachmentId: number): { xGmMsgId: string; accountId: number } | null {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    const result = this.db.exec(
      `SELECT e.x_gm_msgid, e.account_id
       FROM attachments a
       JOIN emails e ON e.id = a.email_id
       WHERE a.id = :attachmentId`,
      { ':attachmentId': attachmentId }
    );
    if (result.length === 0 || result[0].values.length === 0) {
      return null;
    }
    const row = result[0].values[0];
    return {
      xGmMsgId: row[0] as string,
      accountId: row[1] as number,
    };
  }

  // ---- Vector index tracking operations (vector_indexed_emails) ----

  /**
   * Get all indexed x_gm_msgid values for an account as a Set.
   * Includes both successfully-embedded emails and SKIPPED_FILTERED sentinel rows.
   * Used by EmbeddingService to determine which UIDs have already been processed.
   *
   * @param accountId - Account ID to query
   * @returns Set of x_gm_msgid strings that have been indexed (or skipped)
   */
  getIndexedMsgIds(accountId: number): Set<string> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const result = this.db.exec(
      'SELECT x_gm_msgid FROM vector_indexed_emails WHERE account_id = :accountId',
      { ':accountId': accountId }
    );

    const indexed = new Set<string>();
    if (result.length > 0) {
      for (const row of result[0].values) {
        const msgId = row[0];
        if (typeof msgId === 'string') {
          indexed.add(msgId);
        }
      }
    }
    return indexed;
  }

  /**
   * Given a list of x_gm_msgid values, return the subset that are already
   * recorded in vector_indexed_emails for a given account.
   * Handles large lists by chunking into batches of 500.
   *
   * @param accountId - Account ID to scope the query
   * @param xGmMsgIds - Candidate message IDs to check
   * @returns Set of x_gm_msgid values that are already indexed
   */
  getAlreadyIndexedMsgIds(accountId: number, xGmMsgIds: string[]): Set<string> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const uniqueIds = Array.from(new Set(xGmMsgIds.filter((id) => id.trim().length > 0)));
    if (uniqueIds.length === 0) {
      return new Set();
    }

    const indexed = new Set<string>();
    const chunkSize = 500;

    for (let start = 0; start < uniqueIds.length; start += chunkSize) {
      const chunk = uniqueIds.slice(start, start + chunkSize);
      const placeholders = chunk.map((_, index) => `:msgId${index}`).join(', ');
      const params: Record<string, number | string> = { ':accountId': accountId };
      for (let index = 0; index < chunk.length; index++) {
        params[`:msgId${index}`] = chunk[index];
      }

      const result = this.db.exec(
        `SELECT x_gm_msgid FROM vector_indexed_emails
         WHERE account_id = :accountId AND x_gm_msgid IN (${placeholders})`,
        params
      );

      if (result.length > 0) {
        for (const row of result[0].values) {
          const msgId = row[0];
          if (typeof msgId === 'string') {
            indexed.add(msgId);
          }
        }
      }
    }

    return indexed;
  }

  /**
   * Batch insert indexed records into vector_indexed_emails within a single transaction.
   * Uses INSERT OR REPLACE to handle re-indexing (e.g. after a model change that was
   * cancelled mid-build and then restarted with cleanup).
   *
   * When cursorUid is provided, the embedding_crawl_progress cursor for this account
   * is also upserted inside the same transaction, guaranteeing atomic consistency
   * between indexed records and the resume cursor.
   *
   * @param accountId - Account ID for all records
   * @param records - Array of { xGmMsgId, embeddingHash } pairs to insert
   * @param cursorUid - Optional UID cursor to persist atomically with the records.
   *                    When provided, upserts embedding_crawl_progress.last_uid
   *                    inside the same BEGIN/COMMIT block.
   */
  batchInsertVectorIndexedEmails(
    accountId: number,
    records: Array<{ xGmMsgId: string; embeddingHash: string }>,
    cursorUid?: number
  ): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    if (records.length === 0 && cursorUid === undefined) {
      return;
    }

    this.db.run('BEGIN');
    try {
      for (const record of records) {
        this.db.run(
          `INSERT OR REPLACE INTO vector_indexed_emails (x_gm_msgid, account_id, embedding_hash)
           VALUES (:xGmMsgId, :accountId, :embeddingHash)`,
          {
            ':xGmMsgId': record.xGmMsgId,
            ':accountId': accountId,
            ':embeddingHash': record.embeddingHash,
          }
        );
      }

      // Atomically update the resume cursor if provided
      if (cursorUid !== undefined) {
        this.db.run(
          `INSERT INTO embedding_crawl_progress (account_id, last_uid, build_interrupted, updated_at)
           VALUES (:accountId, :lastUid, 0, datetime('now'))
           ON CONFLICT(account_id) DO UPDATE SET
             last_uid   = excluded.last_uid,
             updated_at = excluded.updated_at`,
          { ':accountId': accountId, ':lastUid': cursorUid }
        );
      }

      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }

    this.scheduleSave();
  }

  /**
   * Count the total number of indexed emails (including SKIPPED_FILTERED sentinel rows)
   * for a given account.
   *
   * @param accountId - Account ID to count for
   * @returns Total number of indexed email records
   */
  countVectorIndexedEmails(accountId: number): number {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const result = this.db.exec(
      'SELECT COUNT(*) FROM vector_indexed_emails WHERE account_id = :accountId',
      { ':accountId': accountId }
    );

    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0] as number;
    }
    return 0;
  }

  /**
   * Clear all vector_indexed_emails records for a specific account.
   * Called when the user removes an account to clean up vector index tracking.
   *
   * @param accountId - Account ID to clear records for
   */
  clearVectorIndexedEmailsForAccount(accountId: number): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    this.db.run(
      'DELETE FROM vector_indexed_emails WHERE account_id = :accountId',
      { ':accountId': accountId }
    );
    this.scheduleSave();
    log.info(`[DatabaseService] Cleared vector index tracking for account ${accountId}`);
  }

  /**
   * Clear all vector_indexed_emails records across all accounts.
   * Called when the user changes the embedding model — a full re-index is required
   * and all prior index state must be discarded.
   */
  clearAllVectorIndexedEmails(): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    this.db.run('DELETE FROM vector_indexed_emails');
    this.scheduleSave();
    log.info('[DatabaseService] Cleared all vector index tracking globally');
  }

  // ---- Embedding crawl progress operations (embedding_crawl_progress) ----

  /**
   * Get the stored UID cursor for an account's embedding crawl progress.
   * Returns 0 if no row exists (fresh build, no cursor stored yet).
   *
   * @param accountId - Account ID to query
   * @returns The last_uid value (0 if not found)
   */
  getEmbeddingCrawlCursor(accountId: number): number {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const result = this.db.exec(
      'SELECT last_uid FROM embedding_crawl_progress WHERE account_id = :accountId',
      { ':accountId': accountId }
    );

    if (result.length === 0 || result[0].values.length === 0) {
      return 0;
    }
    return result[0].values[0][0] as number;
  }

  /**
   * Upsert the UID cursor for an account's embedding crawl progress.
   * Creates the row if it does not exist. Preserves the existing build_interrupted
   * value when updating — only last_uid and updated_at are changed.
   *
   * @param accountId - Account ID to update
   * @param lastUid - The maximum UID from the last fully committed batch
   */
  upsertEmbeddingCrawlCursor(accountId: number, lastUid: number): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    this.db.run(
      `INSERT INTO embedding_crawl_progress (account_id, last_uid, build_interrupted, updated_at)
       VALUES (:accountId, :lastUid, 0, datetime('now'))
       ON CONFLICT(account_id) DO UPDATE SET
         last_uid   = excluded.last_uid,
         updated_at = excluded.updated_at`,
      { ':accountId': accountId, ':lastUid': lastUid }
    );
    this.scheduleSave();
  }

  /**
   * Set or clear the build_interrupted flag for an account.
   * Creates the row if it does not exist. Preserves the existing last_uid value
   * when updating — only build_interrupted and updated_at are changed.
   *
   * @param accountId - Account ID to update
   * @param interrupted - true to set build_interrupted = 1, false to clear it to 0
   */
  setEmbeddingBuildInterrupted(accountId: number, interrupted: boolean): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const interruptedValue = interrupted ? 1 : 0;
    this.db.run(
      `INSERT INTO embedding_crawl_progress (account_id, last_uid, build_interrupted, updated_at)
       VALUES (:accountId, 0, :interrupted, datetime('now'))
       ON CONFLICT(account_id) DO UPDATE SET
         build_interrupted = excluded.build_interrupted,
         updated_at        = excluded.updated_at`,
      { ':accountId': accountId, ':interrupted': interruptedValue }
    );
    this.scheduleSave();
  }

  /**
   * Return the account IDs of all accounts that have build_interrupted = 1.
   * Used at app startup to detect builds that were interrupted by crash or close.
   *
   * @returns Array of account IDs with interrupted builds
   */
  getInterruptedEmbeddingAccounts(): number[] {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const result = this.db.exec(
      'SELECT account_id FROM embedding_crawl_progress WHERE build_interrupted = 1'
    );

    if (result.length === 0 || result[0].values.length === 0) {
      return [];
    }
    return result[0].values.map((row) => row[0] as number);
  }

  /**
   * Delete the embedding crawl progress row for a specific account.
   * Called when a build completes successfully for that account.
   *
   * @param accountId - Account ID to clear progress for
   */
  clearEmbeddingCrawlProgress(accountId: number): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    this.db.run(
      'DELETE FROM embedding_crawl_progress WHERE account_id = :accountId',
      { ':accountId': accountId }
    );
    this.scheduleSave();
  }

  /**
   * Delete all embedding crawl progress rows across all accounts.
   * Called when the user changes the embedding model — all crawl progress
   * is invalid after a model change (different vector space).
   */
  clearAllEmbeddingCrawlProgress(): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    this.db.run('DELETE FROM embedding_crawl_progress');
    this.scheduleSave();
    log.info('[DatabaseService] Cleared all embedding crawl progress globally');
  }

  /**
   * Find emails that have a body stored locally but have not yet been indexed
   * into the vector database. Used for incremental indexing after body-fetch
   * completes post-sync.
   *
   * An email qualifies if:
   *   - Its account_id matches the given accountId
   *   - It is not a draft (is_draft = 0)
   *   - It has a non-empty text_body OR non-empty html_body
   *   - It does NOT have a row in vector_indexed_emails for (x_gm_msgid, account_id)
   *   - It exists in at least one folder that is NOT Trash, Spam, or Drafts
   *     (mirrors the filter the full-crawl indexer applies when writing SKIPPED_FILTERED rows)
   *
   * Ordered by date DESC so the most recently received emails are indexed first.
   *
   * @param accountId - Account ID to query
   * @param batchSize - Maximum number of emails to return
   * @returns Array of email records with bodies ready for incremental embedding
   */
  getEmailsNeedingVectorIndexing(
    accountId: number,
    batchSize: number = 50
  ): Array<{
    xGmMsgId: string;
    accountId: number;
    subject: string;
    textBody: string | null;
    htmlBody: string | null;
  }> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const trashFolder = this.getTrashFolder(accountId);
    const result = this.db.exec(
      `SELECT e.x_gm_msgid, e.account_id, e.subject, e.text_body, e.html_body
       FROM emails e
       WHERE e.account_id = :accountId
         AND e.is_draft = 0
         AND (
           (e.text_body IS NOT NULL AND e.text_body != '')
           OR (e.html_body IS NOT NULL AND e.html_body != '')
         )
         AND NOT EXISTS (
           SELECT 1 FROM vector_indexed_emails vie
           WHERE vie.x_gm_msgid = e.x_gm_msgid
             AND vie.account_id = e.account_id
         )
         AND EXISTS (
           SELECT 1 FROM email_folders ef
           WHERE ef.account_id = e.account_id
             AND ef.x_gm_msgid = e.x_gm_msgid
             AND ef.folder NOT IN (:trashFolder, :spamFolder, :draftsFolder)
         )
       ORDER BY e.date DESC
       LIMIT :batchSize`,
      {
        ':accountId': accountId,
        ':batchSize': batchSize,
        ':trashFolder': trashFolder,
        ':spamFolder': '[Gmail]/Spam',
        ':draftsFolder': '[Gmail]/Drafts',
      }
    );

    if (result.length === 0) {
      return [];
    }

    return result[0].values.map((row) => ({
      xGmMsgId: row[0] as string,
      accountId: row[1] as number,
      subject: (row[2] as string) || '',
      textBody: row[3] as string | null,
      htmlBody: row[4] as string | null,
    }));
  }

  /**
   * Given a list of x_gm_msgid values, return the subset that have at least one
   * email_folders entry whose folder is NOT in the excluded set.
   *
   * Used by SemanticSearchService to filter out emails that live ONLY in
   * Trash, Spam, or Drafts from semantic search results.
   *
   * @param accountId - Account ID to scope the query
   * @param xGmMsgIds - Candidate message IDs to check (may be large)
   * @param excludedFolders - Folders to exclude (e.g. ['[Gmail]/Trash', '[Gmail]/Spam', '[Gmail]/Drafts'])
   * @returns Set of x_gm_msgid values that have at least one non-excluded folder
   */
  getMsgIdsWithNonExcludedFolders(
    accountId: number,
    xGmMsgIds: string[],
    excludedFolders: string[]
  ): Set<string> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const uniqueIds = Array.from(new Set(xGmMsgIds.filter((id) => id.trim().length > 0)));
    if (uniqueIds.length === 0) {
      return new Set();
    }

    // If no folders are excluded, every candidate msgId qualifies — return all of them.
    if (excludedFolders.length === 0) {
      return new Set(uniqueIds);
    }

    // Build dynamic placeholders for x_gm_msgid list
    const msgIdPlaceholders = uniqueIds.map((_, index) => `:msgId${index}`).join(', ');

    // Build dynamic placeholders for excluded folders list
    const folderPlaceholders = excludedFolders.map((_, index) => `:excludedFolder${index}`).join(', ');

    const params: Record<string, number | string> = { ':accountId': accountId };
    for (let index = 0; index < uniqueIds.length; index++) {
      params[`:msgId${index}`] = uniqueIds[index];
    }
    for (let index = 0; index < excludedFolders.length; index++) {
      params[`:excludedFolder${index}`] = excludedFolders[index];
    }

    // Select x_gm_msgid values that have at least one folder NOT in the excluded list
    const sql = `
      SELECT DISTINCT ef.x_gm_msgid
      FROM email_folders ef
      WHERE ef.account_id = :accountId
        AND ef.x_gm_msgid IN (${msgIdPlaceholders})
        AND ef.folder NOT IN (${folderPlaceholders})
    `;

    const result = this.db.exec(sql, params);
    if (result.length === 0) {
      return new Set();
    }

    const included = new Set<string>();
    for (const row of result[0].values) {
      const msgId = row[0];
      if (typeof msgId === 'string') {
        included.add(msgId);
      }
    }
    return included;
  }

  /**
   * Given a list of x_gm_msgid values, return the subset that have AT LEAST ONE
   * folder association in email_folders for this account (regardless of which folder).
   *
   * Used by SemanticSearchService to distinguish "only in excluded folders" from
   * "never locally synced (no email_folders rows at all)". Un-synced emails from the
   * full-mailbox crawl have no rows in email_folders and should pass through the
   * folder exclusion filter.
   *
   * @param accountId - Account ID to scope the query
   * @param xGmMsgIds - Candidate message IDs to check
   * @returns Set of x_gm_msgid values that have at least one email_folders entry
   */
  getMsgIdsWithAnyFolder(accountId: number, xGmMsgIds: string[]): Set<string> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const uniqueIds = Array.from(new Set(xGmMsgIds.filter((id) => id.trim().length > 0)));
    if (uniqueIds.length === 0) {
      return new Set();
    }

    const CHUNK_SIZE = 500;
    const hasFolder = new Set<string>();

    for (let offset = 0; offset < uniqueIds.length; offset += CHUNK_SIZE) {
      const chunk = uniqueIds.slice(offset, offset + CHUNK_SIZE);
      const placeholders = chunk.map((_, index) => `:msgId${offset + index}`).join(', ');
      const params: Record<string, number | string> = { ':accountId': accountId };
      for (let index = 0; index < chunk.length; index++) {
        params[`:msgId${offset + index}`] = chunk[index];
      }

      const result = this.db.exec(
        `SELECT DISTINCT x_gm_msgid FROM email_folders WHERE account_id = :accountId AND x_gm_msgid IN (${placeholders})`,
        params
      );

      if (result.length > 0) {
        for (const row of result[0].values) {
          const msgId = row[0];
          if (typeof msgId === 'string') {
            hasFolder.add(msgId);
          }
        }
      }
    }

    return hasFolder;
  }

  /**
   * Get threads (formatted as thread rows) for a given list of x_gm_msgid values.
   * Used to resolve semantic search results (which return x_gm_msgid values) into
   * full thread objects for the renderer.
   *
   * The results are ordered by the relevance rank of the input msgIds array
   * (index 0 = highest relevance). The DB query fetches in one batch; we then
   * re-sort to preserve the caller's ordering.
   *
   * @param accountId - Account ID
   * @param xGmMsgIds - x_gm_msgid values in relevance order (most relevant first)
   * @returns Thread rows in the same order as xGmMsgIds (unmatched IDs are silently dropped)
   */
  getThreadsByXGmMsgIds(accountId: number, xGmMsgIds: string[]): Array<Record<string, unknown>> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const uniqueIds = Array.from(new Set(xGmMsgIds.filter((id) => id.trim().length > 0)));
    if (uniqueIds.length === 0) {
      return [];
    }

    const placeholders = uniqueIds.map((_, index) => `:msgId${index}`).join(', ');
    const params: Record<string, number | string | null> = {
      ':accountId': accountId,
      ':limit': uniqueIds.length,
      ':trashFolder': this.getTrashFolder(accountId),
    };
    for (let index = 0; index < uniqueIds.length; index++) {
      params[`:msgId${index}`] = uniqueIds[index];
    }

    // Join emails → threads via x_gm_msgid to resolve threads for the given message IDs
    const sql = `
      SELECT DISTINCT
        t.id,
        t.account_id,
        t.x_gm_thrid,
        t.subject,
        t.last_message_date,
        t.participants,
        (SELECT COUNT(DISTINCT e2.x_gm_msgid)
         FROM emails e2
         JOIN email_folders ef2 ON ef2.account_id = e2.account_id AND ef2.x_gm_msgid = e2.x_gm_msgid
         WHERE e2.account_id = :accountId AND e2.x_gm_thrid = t.x_gm_thrid
           AND ef2.folder != :trashFolder
        ) AS message_count,
        t.snippet,
        'search' AS folder,
        t.is_read,
        t.is_starred,
        (SELECT MAX(e3.has_attachments) FROM emails e3
         WHERE e3.account_id = :accountId AND e3.x_gm_thrid = t.x_gm_thrid
        ) AS has_attachments
      FROM emails e
      JOIN threads t ON t.account_id = e.account_id AND t.x_gm_thrid = e.x_gm_thrid
      WHERE e.account_id = :accountId
        AND e.x_gm_msgid IN (${placeholders})
      LIMIT :limit
    `;

    const result = this.db.exec(sql, params);
    if (result.length === 0) {
      return [];
    }

    const rows = result[0].values.map((row) => this.mapThreadRow(row, result[0].columns));

    // Re-sort to preserve the relevance ordering of the input xGmMsgIds.
    // Build a map from x_gm_thrid → rank (using the first matching msgId's position).
    // Since one thread may contain multiple msgIds, use the best (lowest) rank among matches.
    const msgIdToRank = new Map<string, number>();
    for (let index = 0; index < uniqueIds.length; index++) {
      msgIdToRank.set(uniqueIds[index], index);
    }

    // We need to know which msgIds belong to each thread so we can assign a rank.
    // The query joined emails to threads; we need to look up the emailMsgIds for each thread.
    // Simpler approach: for each result thread, compute its rank by querying back.
    // Even simpler: re-query the emails table for xGmThrid → msgId mapping for these threads.
    const threadIds = rows.map((row) => row['xGmThrid'] as string);
    const threadMsgIdMap = this.getFirstMatchingMsgIdForThreads(accountId, threadIds, uniqueIds);

    const rankedRows = rows.map((row) => {
      const xGmThrid = row['xGmThrid'] as string;
      const firstMatchingMsgId = threadMsgIdMap.get(xGmThrid);
      const rank = firstMatchingMsgId !== undefined ? (msgIdToRank.get(firstMatchingMsgId) ?? Infinity) : Infinity;
      return { row, rank };
    });

    rankedRows.sort((a, b) => a.rank - b.rank);

    return rankedRows.map(({ row }) => row);
  }

  /**
   * Helper for getThreadsByXGmMsgIds: for each given thread, find the first (highest-ranked)
   * x_gm_msgid from the candidate list that belongs to it.
   */
  private getFirstMatchingMsgIdForThreads(
    accountId: number,
    xGmThrids: string[],
    candidateMsgIds: string[]
  ): Map<string, string> {
    if (!this.db || xGmThrids.length === 0 || candidateMsgIds.length === 0) {
      return new Map();
    }

    const thridPlaceholders = xGmThrids.map((_, index) => `:thrid${index}`).join(', ');
    const msgIdPlaceholders = candidateMsgIds.map((_, index) => `:cand${index}`).join(', ');

    const params: Record<string, number | string> = { ':accountId': accountId };
    for (let index = 0; index < xGmThrids.length; index++) {
      params[`:thrid${index}`] = xGmThrids[index];
    }
    for (let index = 0; index < candidateMsgIds.length; index++) {
      params[`:cand${index}`] = candidateMsgIds[index];
    }

    const sql = `
      SELECT x_gm_thrid, x_gm_msgid
      FROM emails
      WHERE account_id = :accountId
        AND x_gm_thrid IN (${thridPlaceholders})
        AND x_gm_msgid IN (${msgIdPlaceholders})
    `;

    const result = this.db.exec(sql, params);
    if (result.length === 0) {
      return new Map();
    }

    // For each thread, keep track of the best-ranked (lowest index) matching msgId
    const msgIdToRank = new Map<string, number>();
    for (let index = 0; index < candidateMsgIds.length; index++) {
      msgIdToRank.set(candidateMsgIds[index], index);
    }

    const threadBestMap = new Map<string, { msgId: string; rank: number }>();
    for (const row of result[0].values) {
      const thrid = row[0] as string;
      const msgId = row[1] as string;
      const rank = msgIdToRank.get(msgId) ?? Infinity;
      const existing = threadBestMap.get(thrid);
      if (existing === undefined || rank < existing.rank) {
        threadBestMap.set(thrid, { msgId, rank });
      }
    }

    return new Map(Array.from(threadBestMap.entries()).map(([thrid, { msgId }]) => [thrid, msgId]));
  }

  // ---- On-demand search result resolution ----

  /**
   * Given a list of x_gm_msgid values, return the subset that exist in the
   * local `emails` table for a given account.
   * Handles large lists by chunking into batches of 500.
   *
   * Used by SemanticSearchService to identify which search results are already
   * cached locally and which need to be fetched from IMAP on demand.
   *
   * @param accountId - Account ID to scope the query
   * @param xGmMsgIds - Candidate message IDs to check
   * @returns Set of x_gm_msgid values that exist in the local emails table
   */
  getEmailsExistingInLocalDb(accountId: number, xGmMsgIds: string[]): Set<string> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const uniqueIds = Array.from(new Set(xGmMsgIds.filter((id) => id.trim().length > 0)));
    if (uniqueIds.length === 0) {
      return new Set();
    }

    const existing = new Set<string>();
    const CHUNK_SIZE = 500;

    for (let offset = 0; offset < uniqueIds.length; offset += CHUNK_SIZE) {
      const chunk = uniqueIds.slice(offset, offset + CHUNK_SIZE);
      const placeholders = chunk.map((_, index) => `:msgId${offset + index}`).join(', ');
      const params: Record<string, number | string> = { ':accountId': accountId };
      for (let index = 0; index < chunk.length; index++) {
        params[`:msgId${offset + index}`] = chunk[index];
      }

      const result = this.db.exec(
        `SELECT x_gm_msgid FROM emails WHERE account_id = :accountId AND x_gm_msgid IN (${placeholders})`,
        params
      );

      if (result.length > 0) {
        for (const row of result[0].values) {
          const msgId = row[0];
          if (typeof msgId === 'string') {
            existing.add(msgId);
          }
        }
      }
    }

    return existing;
  }

  /**
   * Upsert email metadata from an IMAP envelope into the local emails table.
   * Used by SemanticSearchService to cache search results that are not yet in the local DB.
   *
   * The upserted row has NULL body fields (text_body, html_body) — the body is fetched
   * on demand when the user opens the email. Thread row is created if it doesn't exist.
   *
   * @param accountId - Account ID
   * @param envelope - Parsed envelope metadata from ImapCrawlService.fetchEnvelopes()
   */
  upsertEmailFromEnvelope(accountId: number, envelope: {
    xGmMsgId: string;
    xGmThrid: string;
    messageId: string;
    subject: string;
    fromAddress: string;
    fromName: string;
    toAddresses: string;
    date: string;
    isRead: boolean;
    isStarred: boolean;
    isDraft: boolean;
    size: number;
  }): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    // Upsert the email row (no body fields — NULL body fields are preserved on conflict
    // via COALESCE(NULLIF(excluded.text_body, ''), text_body) logic in upsertEmail).
    // We use a direct INSERT OR IGNORE here to avoid overwriting an existing full body.
    this.db.run(
      `INSERT INTO emails (account_id, x_gm_msgid, x_gm_thrid, message_id, from_address, from_name,
         to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body, date,
         is_read, is_starred, is_important, is_draft, snippet, size, has_attachments, labels, updated_at)
       VALUES (:accountId, :xGmMsgId, :xGmThrid, :messageId, :fromAddress, :fromName,
         :toAddresses, '', '', :subject, NULL, NULL, :date,
         :isRead, :isStarred, 0, :isDraft, '', :size, 0, '', datetime('now'))
       ON CONFLICT(account_id, x_gm_msgid) DO UPDATE SET
         x_gm_thrid = excluded.x_gm_thrid,
         message_id = COALESCE(NULLIF(excluded.message_id, ''), message_id),
         from_address = excluded.from_address,
         from_name = excluded.from_name,
         to_addresses = excluded.to_addresses,
         subject = excluded.subject,
         date = excluded.date,
         is_read = excluded.is_read,
         is_starred = excluded.is_starred,
         is_draft = MAX(is_draft, excluded.is_draft),
         size = excluded.size,
         updated_at = datetime('now')`,
      {
        ':accountId': accountId,
        ':xGmMsgId': envelope.xGmMsgId,
        ':xGmThrid': envelope.xGmThrid,
        ':messageId': envelope.messageId || null,
        ':fromAddress': envelope.fromAddress,
        ':fromName': envelope.fromName || '',
        ':toAddresses': envelope.toAddresses,
        ':subject': envelope.subject || '',
        ':date': envelope.date,
        ':isRead': envelope.isRead ? 1 : 0,
        ':isStarred': envelope.isStarred ? 1 : 0,
        ':isDraft': envelope.isDraft ? 1 : 0,
        ':size': envelope.size || 0,
      }
    );

    // Upsert a thread row if it doesn't already exist.
    this.db.run(
      `INSERT INTO threads (account_id, x_gm_thrid, subject, last_message_date, participants, message_count, snippet, is_read, is_starred)
       VALUES (:accountId, :xGmThrid, :subject, :lastMessageDate, :participants, 1, '', :isRead, :isStarred)
       ON CONFLICT(account_id, x_gm_thrid) DO NOTHING`,
      {
        ':accountId': accountId,
        ':xGmThrid': envelope.xGmThrid,
        ':subject': envelope.subject || '',
        ':lastMessageDate': envelope.date,
        ':participants': envelope.fromAddress,
        ':isRead': envelope.isRead ? 1 : 0,
        ':isStarred': envelope.isStarred ? 1 : 0,
      }
    );

    this.scheduleSave();
  }

  // ---- Structured filter methods ----

  /**
   * Given a set of x_gm_msgid values and structured filters, returns the
   * subset of those message IDs that match all filter conditions in the local
   * emails table.
   *
   * Handles large lists by chunking into batches of 500. The JOIN on
   * email_folders is added only when the folder filter is present to avoid
   * unnecessary joins and duplicate rows.
   *
   * If no filters are defined (all fields are undefined) the full input set is
   * returned immediately without hitting the database.
   *
   * @param accountId  - Account ID to scope the query
   * @param xGmMsgIds  - Candidate message IDs to filter
   * @param filters    - Structured filter constraints to apply
   * @returns Set of x_gm_msgid values that satisfy all filter conditions
   */
  filterEmailsByMsgIds(
    accountId: number,
    xGmMsgIds: string[],
    filters: SemanticSearchFilters
  ): Set<string> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    if (xGmMsgIds.length === 0) {
      return new Set<string>();
    }

    const noFiltersApplied =
      filters.dateFrom === undefined &&
      filters.dateTo === undefined &&
      filters.folder === undefined &&
      filters.sender === undefined &&
      filters.recipient === undefined &&
      filters.hasAttachment === undefined &&
      filters.isRead === undefined &&
      filters.isStarred === undefined;

    if (noFiltersApplied) {
      return new Set<string>(xGmMsgIds);
    }

    const matchingIds = new Set<string>();
    const CHUNK_SIZE = 500;

    const needsFolderJoin = filters.folder !== undefined;

    const filterClauses: string[] = [];
    const filterParams: Record<string, string | number> = {};

    if (filters.dateFrom !== undefined) {
      filterClauses.push('AND e.date >= :dateFrom');
      filterParams[':dateFrom'] = filters.dateFrom;
    }

    if (filters.dateTo !== undefined) {
      filterClauses.push('AND e.date <= :dateTo');
      filterParams[':dateTo'] = filters.dateTo;
    }

    if (filters.folder !== undefined) {
      filterClauses.push('AND ef.folder = :folder');
      filterParams[':folder'] = filters.folder;
    }

    if (filters.sender !== undefined) {
      filterClauses.push(
        'AND (e.from_address LIKE :senderPattern OR e.from_name LIKE :senderPattern)'
      );
      filterParams[':senderPattern'] = `%${filters.sender}%`;
    }

    if (filters.recipient !== undefined) {
      filterClauses.push('AND e.to_addresses LIKE :recipientPattern');
      filterParams[':recipientPattern'] = `%${filters.recipient}%`;
    }

    if (filters.hasAttachment !== undefined) {
      filterClauses.push('AND e.has_attachments = :hasAttachment');
      filterParams[':hasAttachment'] = filters.hasAttachment ? 1 : 0;
    }

    if (filters.isRead !== undefined) {
      filterClauses.push('AND e.is_read = :isRead');
      filterParams[':isRead'] = filters.isRead ? 1 : 0;
    }

    if (filters.isStarred !== undefined) {
      filterClauses.push('AND e.is_starred = :isStarred');
      filterParams[':isStarred'] = filters.isStarred ? 1 : 0;
    }

    const joinClause = needsFolderJoin
      ? 'JOIN email_folders ef ON ef.account_id = e.account_id AND ef.x_gm_msgid = e.x_gm_msgid'
      : '';

    const filterClausesSql = filterClauses.join('\n     ');

    try {
      for (let offset = 0; offset < xGmMsgIds.length; offset += CHUNK_SIZE) {
        const chunk = xGmMsgIds.slice(offset, offset + CHUNK_SIZE);
        const placeholders = chunk
          .map((_, index) => `:msgId${offset + index}`)
          .join(', ');

        const params: Record<string, string | number> = {
          ':accountId': accountId,
          ...filterParams,
        };

        for (let index = 0; index < chunk.length; index++) {
          params[`:msgId${offset + index}`] = chunk[index];
        }

        const sql = [
          'SELECT DISTINCT e.x_gm_msgid',
          'FROM emails e',
          joinClause,
          'WHERE e.account_id = :accountId',
          `  AND e.x_gm_msgid IN (${placeholders})`,
          filterClausesSql ? `  ${filterClausesSql}` : '',
        ]
          .filter((line) => line.trim().length > 0)
          .join('\n');

        const result = this.db.exec(sql, params);

        if (result.length > 0) {
          for (const row of result[0].values) {
            const msgId = row[0];
            if (typeof msgId === 'string') {
              matchingIds.add(msgId);
            }
          }
        }
      }
    } catch (error) {
      log.error('filterEmailsByMsgIds: query failed', error);
      return new Set<string>();
    }

    return matchingIds;
  }

  /**
   * Fetches the `date` column for a set of x_gm_msgid values, returning a Map
   * from message ID to ISO date string. Used for date-based sorting of search
   * results after filtering.
   *
   * Handles large lists by chunking into batches of 500.
   *
   * @param accountId  - Account ID to scope the query
   * @param xGmMsgIds  - Message IDs whose dates should be fetched
   * @returns Map of x_gm_msgid → date string
   */
  getEmailDatesByMsgIds(
    accountId: number,
    xGmMsgIds: string[]
  ): Map<string, string> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    if (xGmMsgIds.length === 0) {
      return new Map<string, string>();
    }

    const dateMap = new Map<string, string>();
    const CHUNK_SIZE = 500;

    try {
      for (let offset = 0; offset < xGmMsgIds.length; offset += CHUNK_SIZE) {
        const chunk = xGmMsgIds.slice(offset, offset + CHUNK_SIZE);
        const placeholders = chunk
          .map((_, index) => `:msgId${offset + index}`)
          .join(', ');

        const params: Record<string, string | number> = { ':accountId': accountId };
        for (let index = 0; index < chunk.length; index++) {
          params[`:msgId${offset + index}`] = chunk[index];
        }

        const result = this.db.exec(
          `SELECT e.x_gm_msgid, e.date
           FROM emails e
           WHERE e.account_id = :accountId
             AND e.x_gm_msgid IN (${placeholders})`,
          params
        );

        if (result.length > 0) {
          for (const row of result[0].values) {
            const msgId = row[0];
            const date = row[1];
            if (typeof msgId === 'string' && typeof date === 'string') {
              dateMap.set(msgId, date);
            }
          }
        }
      }
    } catch (error) {
      log.error('getEmailDatesByMsgIds: query failed', error);
      return new Map<string, string>();
    }

    return dateMap;
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
