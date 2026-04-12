import type BetterSqlite3 from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { Umzug } from 'umzug';
import { DateTime } from 'luxon';
import { LoggerService } from './logger-service';
import { createBetterSqlite3Storage } from '../database/umzug-storage';

const log = LoggerService.getInstance();
import type { UpsertEmailInput, UpsertThreadInput, UpsertFolderStateInput, FolderStateRecord, AttachmentRecord } from '../database/models';
import { ALL_MAIL_PATH } from './sync-service';
import { formatParticipantList } from '../utils/format-participant';
import type { SemanticSearchFilters } from '../utils/search-filter-translator';

/**
 * Result of filterEmailsByMsgIds: separates confirmed matches from uncertain
 * candidates whose folder/attachment status cannot be reliably determined
 * locally (All-Mail-only emails indexed via the embedding crawl pipeline).
 */
export interface FilterMsgIdsResult {
  /** Message IDs that passed all DB filters. */
  matched: Set<string>;
  /**
   * Message IDs that exist locally but only have a [Gmail]/All Mail folder
   * association — folder and attachment filters cannot be reliably evaluated.
   * These should be sent to IMAP for server-side verification.
   */
  uncertain: Set<string>;
}

export class DatabaseService {
  private static instance: DatabaseService;
  private db: BetterSqlite3.Database | null = null;
  private dbPath: string = '';

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
    fs.mkdirSync(dir, { recursive: true });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3');

    this.db = new BetterSqlite3(this.dbPath);

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    const migrationsDir = path.join(__dirname, '..', 'database', 'migrations');
    const umzug = new Umzug({
      migrations: {
        glob: ['*.js', { cwd: migrationsDir }],
      },
      context: { db: this.db, databaseService: this },
      storage: createBetterSqlite3Storage(this.db),
      logger: log,
    });

    const executed = await umzug.up();
    if (executed.length > 0) {
      log.info(`[MIGRATIONS] Migrations executed: ${executed.map((m) => m.name).join(', ')}`);
    } else {
      log.info('[MIGRATIONS] No pending migrations');
    }
    log.info('Database schema initialized (Umzug)');
  }

  getDatabase(): BetterSqlite3.Database {
    if (!this.db) throw new Error('Database not initialized');
    return this.db;
  }

  /**
   * Close the current database connection and reopen at the given path.
   * Re-runs PRAGMAs and Umzug migrations on the new handle.
   *
   * Used by the test infrastructure to restore the database from a template snapshot.
   * Call close() first to safely unlock the file before overwriting it, then call
   * reopen() to open the restored copy.
   *
   * @param dbFilePath - Absolute path to the database file. If omitted, uses getDbPath().
   */
  async reopen(dbFilePath?: string): Promise<void> {
    this.close();

    const targetPath = dbFilePath ?? this.getDbPath();
    this.dbPath = targetPath;
    log.info(`[DatabaseService] Reopening database at: ${targetPath}`);

    const dir = path.dirname(targetPath);
    fs.mkdirSync(dir, { recursive: true });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3');
    this.db = new BetterSqlite3(targetPath);

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    const migrationsDir = path.join(__dirname, '..', 'database', 'migrations');
    const umzug = new Umzug({
      migrations: {
        glob: ['*.js', { cwd: migrationsDir }],
      },
      context: { db: this.db, databaseService: this },
      storage: createBetterSqlite3Storage(this.db),
      logger: log,
    });

    await umzug.up();
    log.info('[DatabaseService] Database reopened and migrations applied');
  }

  // ---- Settings operations ----

  getSetting(key: string): string | null {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare('SELECT value FROM settings WHERE key = :key').get({ key }) as { value: string } | undefined;
    if (row === undefined) {
      return null;
    }
    return row.value;
  }

  setSetting(key: string, value: string, scope: string = 'global'): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare(
      'INSERT INTO settings (key, value, scope) VALUES (:key, :value, :scope) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run({ key, value, scope });
  }

  getAllSettings(): Record<string, string> {
    if (!this.db) throw new Error('Database not initialized');
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    return settings;
  }

  // ---- Account operations ----

  getAccounts(): Array<{ id: number; email: string; displayName: string; avatarUrl: string | null; isActive: boolean; needsReauth: boolean; lastSyncAt: string | null }> {
    if (!this.db) throw new Error('Database not initialized');
    const rows = this.db.prepare('SELECT id, email, display_name, avatar_url, is_active, needs_reauth, last_sync_at FROM accounts WHERE is_active = 1').all();
    return rows.map((row) => this.mapRow<{ id: number; email: string; displayName: string; avatarUrl: string | null; isActive: boolean; needsReauth: boolean; lastSyncAt: string | null }>(row as Record<string, unknown>));
  }

  getAccountById(id: number): { id: number; email: string; displayName: string; avatarUrl: string | null; isActive: boolean; needsReauth: boolean } | null {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare('SELECT id, email, display_name, avatar_url, is_active, needs_reauth FROM accounts WHERE id = :id').get({ id });
    if (row === undefined) {
      return null;
    }
    return this.mapRow<{ id: number; email: string; displayName: string; avatarUrl: string | null; isActive: boolean; needsReauth: boolean }>(row as Record<string, unknown>);
  }

  createAccount(email: string, displayName: string, avatarUrl: string | null): number {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.prepare(
      'INSERT INTO accounts (email, display_name, avatar_url, is_active) VALUES (:email, :displayName, :avatarUrl, 1)'
    ).run({ email, displayName, avatarUrl });
    return Number(result.lastInsertRowid);
  }

  updateAccount(id: number, displayName: string, avatarUrl: string | null): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare(
      "UPDATE accounts SET display_name = :displayName, avatar_url = :avatarUrl, needs_reauth = 0, updated_at = datetime('now') WHERE id = :id"
    ).run({ displayName, avatarUrl, id });
  }

  deleteAccount(id: number): void {
    if (!this.db) throw new Error('Database not initialized');
    const deleteAllAccountData = this.db.transaction(() => {
      // Delete all account data explicitly — do not rely on FK ON DELETE CASCADE
      // since junction tables (email_folders, thread_folders) have no FK to accounts.

      // attachments and search_index reference emails(id) with no account_id column;
      // delete them via subquery before the emails rows are removed.
      this.db!.prepare(
        'DELETE FROM attachments WHERE email_id IN (SELECT id FROM emails WHERE account_id = :accountId)'
      ).run({ accountId: id });
      this.db!.prepare(
        'DELETE FROM search_index WHERE email_id IN (SELECT id FROM emails WHERE account_id = :accountId)'
      ).run({ accountId: id });
      // Junction tables have no FK constraint to accounts — must be deleted explicitly.
      this.db!.prepare('DELETE FROM email_folders WHERE account_id = :accountId').run({ accountId: id });
      this.db!.prepare('DELETE FROM thread_folders WHERE account_id = :accountId').run({ accountId: id });
      // Direct account-owned tables.
      this.db!.prepare('DELETE FROM emails WHERE account_id = :accountId').run({ accountId: id });
      this.db!.prepare('DELETE FROM threads WHERE account_id = :accountId').run({ accountId: id });
      this.db!.prepare('DELETE FROM folder_state WHERE account_id = :accountId').run({ accountId: id });
      this.db!.prepare('DELETE FROM labels WHERE account_id = :accountId').run({ accountId: id });
      this.db!.prepare('DELETE FROM filters WHERE account_id = :accountId').run({ accountId: id });
      // Finally remove the accounts row itself.
      this.db!.prepare('DELETE FROM accounts WHERE id = :id').run({ id });
    });
    deleteAllAccountData();
    log.info(`Deleted account ${id} and all related data`);
  }

  setAccountNeedsReauth(id: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare("UPDATE accounts SET needs_reauth = 1, updated_at = datetime('now') WHERE id = :id").run({ id });
  }

  getAccountCount(): number {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM accounts WHERE is_active = 1').get() as { count: number } | undefined;
    if (row === undefined) {
      return 0;
    }
    return row.count;
  }

  // ---- Email operations (keyed by X-GM-MSGID) ----

  upsertEmail(email: UpsertEmailInput): number {
    if (!this.db) throw new Error('Database not initialized');
    // Upsert the single email row.
    // Pass NULL (not '') for empty bodies so COALESCE preserves existing body on update.
    this.db.prepare(
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
        updated_at = datetime('now')`
    ).run({
      accountId: email.accountId,
      xGmMsgId: email.xGmMsgId,
      xGmThrid: email.xGmThrid,
      messageId: email.messageId || null,
      fromAddress: email.fromAddress,
      fromName: email.fromName || '',
      toAddresses: email.toAddresses,
      ccAddresses: email.ccAddresses || '',
      bccAddresses: email.bccAddresses || '',
      subject: email.subject || '',
      textBody: email.textBody || null,
      htmlBody: email.htmlBody || null,
      date: email.date,
      isRead: email.isRead ? 1 : 0,
      isStarred: email.isStarred ? 1 : 0,
      isImportant: email.isImportant ? 1 : 0,
      isDraft: email.isDraft ? 1 : 0,
      snippet: email.snippet || '',
      size: email.size || 0,
      hasAttachments: email.hasAttachments ? 1 : 0,
      labels: email.labels || '',
    });

    // Retrieve the actual id (last_insert_rowid is unreliable after ON CONFLICT)
    const idRow = this.db.prepare(
      'SELECT id FROM emails WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId'
    ).get({ accountId: email.accountId, xGmMsgId: email.xGmMsgId }) as { id: number } | undefined;
    const id = idRow!.id;

    // Record folder association in the link table (keyed by x_gm_msgid, not email_id).
    // All Mail rows are now persisted with UIDs so stale-removal can operate on them.
    if (email.folderUid != null) {
      this.db.prepare(
        `INSERT INTO email_folders (account_id, x_gm_msgid, folder, uid) VALUES (:accountId, :xGmMsgId, :folder, :folderUid)
         ON CONFLICT(account_id, x_gm_msgid, folder) DO UPDATE SET uid = excluded.uid`
      ).run({ accountId: email.accountId, xGmMsgId: email.xGmMsgId, folder: email.folder, folderUid: email.folderUid });
    } else {
      this.db.prepare(
        'INSERT OR IGNORE INTO email_folders (account_id, x_gm_msgid, folder) VALUES (:accountId, :xGmMsgId, :folder)'
      ).run({ accountId: email.accountId, xGmMsgId: email.xGmMsgId, folder: email.folder });
    }

    return id;
  }

  getEmailsByThreadId(accountId: number, xGmThrid: string): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');
    const rows = this.db.prepare(
      `SELECT id, account_id, x_gm_msgid, x_gm_thrid, message_id, from_address, from_name,
        to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body, snippet, date,
        is_read, is_starred, is_important, is_draft, size, has_attachments, labels
       FROM emails WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid
       ORDER BY date ASC`
    ).all({ accountId, xGmThrid });
    return rows.map((row) => this.mapRow<Record<string, unknown>>(row as Record<string, unknown>));
  }

  getEmailById(id: number): Record<string, unknown> | null {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare(
      `SELECT id, account_id, x_gm_msgid, x_gm_thrid, message_id, from_address, from_name,
        to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body, snippet, date,
        is_read, is_starred, is_important, is_draft, size, has_attachments, labels
       FROM emails WHERE id = :id`
    ).get({ id });
    if (row === undefined) return null;
    return this.mapRow<Record<string, unknown>>(row as Record<string, unknown>);
  }

  getEmailByXGmMsgId(accountId: number, xGmMsgId: string): Record<string, unknown> | null {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare(
      `SELECT id, account_id, x_gm_msgid, x_gm_thrid, message_id, from_address, from_name,
        to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body, snippet, date,
        is_read, is_starred, is_important, is_draft, size, has_attachments, labels
       FROM emails WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId LIMIT 1`
    ).get({ accountId, xGmMsgId });
    if (row === undefined) return null;
    return this.mapRow<Record<string, unknown>>(row as Record<string, unknown>);
  }

  /** Get all folders an email appears in (via the email_folders link table). */
  getFoldersForEmail(accountId: number, xGmMsgId: string): string[] {
    if (!this.db) throw new Error('Database not initialized');
    const rows = this.db.prepare(
      `SELECT folder FROM email_folders
       WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId`
    ).all({ accountId, xGmMsgId }) as Array<{ folder: string }>;
    return rows.map((row) => row.folder);
  }

  /**
   * Get all (folder, uid) pairs for an email.
   * UID is returned only where present (non-null).
   */
  getFolderUidsForEmail(accountId: number, xGmMsgId: string): Array<{ folder: string; uid: number }> {
    if (!this.db) throw new Error('Database not initialized');
    const rows = this.db.prepare(
      `SELECT folder, uid FROM email_folders
       WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId AND uid IS NOT NULL`
    ).all({ accountId, xGmMsgId }) as Array<{ folder: string; uid: number }>;
    return rows.map((row) => ({ folder: row.folder, uid: row.uid }));
  }

  updateEmailFlags(
    accountId: number,
    xGmMsgId: string,
    flags: { isRead?: boolean; isStarred?: boolean; isImportant?: boolean }
  ): void {
    if (!this.db) throw new Error('Database not initialized');
    const updates: string[] = [];
    const params: Record<string, string | number> = {
      accountId,
      xGmMsgId,
    };

    if (flags.isRead !== undefined) {
      updates.push('is_read = :isRead');
      params['isRead'] = flags.isRead ? 1 : 0;
    }
    if (flags.isStarred !== undefined) {
      updates.push('is_starred = :isStarred');
      params['isStarred'] = flags.isStarred ? 1 : 0;
    }
    if (flags.isImportant !== undefined) {
      updates.push('is_important = :isImportant');
      params['isImportant'] = flags.isImportant ? 1 : 0;
    }

    if (updates.length === 0) return;

    updates.push("updated_at = datetime('now')");

    this.db.prepare(
      `UPDATE emails SET ${updates.join(', ')} WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId`
    ).run(params);
  }

  deleteEmailsByAccount(accountId: number): void {
    if (!this.db) throw new Error('Database not initialized');
    // Clean up junction tables first (no FK cascade from emails to email_folders in new schema)
    this.db.prepare('DELETE FROM email_folders WHERE account_id = :accountId').run({ accountId });
    this.db.prepare('DELETE FROM thread_folders WHERE account_id = :accountId').run({ accountId });
    this.db.prepare('DELETE FROM emails WHERE account_id = :accountId').run({ accountId });
    this.db.prepare('DELETE FROM threads WHERE account_id = :accountId').run({ accountId });
  }

  deleteEmailsByThreadId(accountId: number, xGmThrid: string): void {
    if (!this.db) throw new Error('Database not initialized');
    const doDelete = this.db.transaction(() => {
      // Remove email_folders associations for all emails in this thread before deleting the emails
      this.db!.prepare(
        `DELETE FROM email_folders WHERE account_id = :accountId AND x_gm_msgid IN (
           SELECT x_gm_msgid FROM emails WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid
         )`
      ).run({ accountId, xGmThrid });
      // Remove thread_folders associations
      this.db!.prepare(
        'DELETE FROM thread_folders WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid'
      ).run({ accountId, xGmThrid });
      // Delete the email rows (CASCADE handles attachments, search_index)
      this.db!.prepare(
        'DELETE FROM emails WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid'
      ).run({ accountId, xGmThrid });
      // Delete the thread row itself
      this.db!.prepare(
        'DELETE FROM threads WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid'
      ).run({ accountId, xGmThrid });
    });
    doDelete();
  }

  // ---- Thread operations (keyed by X-GM-THRID) ----

  upsertThread(thread: UpsertThreadInput): number {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare(
      `INSERT INTO threads (account_id, x_gm_thrid, subject, last_message_date, participants,
        message_count, snippet, is_read, is_starred, updated_at)
       VALUES (:accountId, :xGmThrid, :subject, :lastMessageDate, :participants,
        :messageCount, :snippet, :isRead, :isStarred, datetime('now'))
       ON CONFLICT(account_id, x_gm_thrid) DO UPDATE SET
        subject = excluded.subject, last_message_date = excluded.last_message_date,
        participants = excluded.participants, message_count = excluded.message_count,
        snippet = excluded.snippet,
        is_read = excluded.is_read, is_starred = excluded.is_starred,
        updated_at = datetime('now')`
    ).run({
      accountId: thread.accountId,
      xGmThrid: thread.xGmThrid,
      subject: thread.subject || '',
      lastMessageDate: thread.lastMessageDate,
      participants: thread.participants || '',
      messageCount: thread.messageCount,
      snippet: thread.snippet || '',
      isRead: thread.isRead ? 1 : 0,
      isStarred: thread.isStarred ? 1 : 0,
    });
    const idRow = this.db.prepare(
      'SELECT id FROM threads WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid'
    ).get({ accountId: thread.accountId, xGmThrid: thread.xGmThrid }) as { id: number } | undefined;
    const id = idRow!.id;

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
      accountId,
      folder,
      limit,
      offset,
    };
    if (threadId != null && threadId !== '') {
      params['threadId'] = threadId;
    }
    params['trashFolder'] = this.getTrashFolder(accountId);
    const whereClause =
      threadId != null && threadId !== ''
        ? 'WHERE t.account_id = :accountId AND t.x_gm_thrid = :threadId'
        : 'WHERE t.account_id = :accountId';
    const rows = this.db.prepare(
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
       ORDER BY MAX(e.date) DESC LIMIT :limit OFFSET :offset`
    ).all(params);
    return rows.map((row) => this.mapRow<Record<string, unknown>>(row as Record<string, unknown>));
  }

  getThreadsByFolderBeforeDate(
    accountId: number,
    folder: string,
    beforeDate: string,
    limit: number = 50
  ): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');
    const trashFolder = this.getTrashFolder(accountId);
    const rows = this.db.prepare(
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
       ORDER BY MAX(e.date) DESC LIMIT :limit`
    ).all({ accountId, folder, beforeDate, limit, trashFolder });
    return rows.map((row) => this.mapRow<Record<string, unknown>>(row as Record<string, unknown>));
  }

  getThreadById(accountId: number, xGmThrid: string): Record<string, unknown> | null {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare(
      `SELECT id, account_id, x_gm_thrid, subject, last_message_date, participants,
        message_count, snippet, is_read, is_starred
       FROM threads WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid`
    ).get({ accountId, xGmThrid });
    if (row === undefined) return null;
    return this.mapRow<Record<string, unknown>>(row as Record<string, unknown>);
  }

  updateThreadFlags(
    accountId: number,
    xGmThrid: string,
    flags: { isRead?: boolean; isStarred?: boolean }
  ): void {
    if (!this.db) throw new Error('Database not initialized');
    const updates: string[] = [];
    const params: Record<string, string | number> = {
      accountId,
      xGmThrid,
    };

    if (flags.isRead !== undefined) {
      updates.push('is_read = :isRead');
      params['isRead'] = flags.isRead ? 1 : 0;
    }
    if (flags.isStarred !== undefined) {
      updates.push('is_starred = :isStarred');
      params['isStarred'] = flags.isStarred ? 1 : 0;
    }

    if (updates.length === 0) return;

    updates.push("updated_at = datetime('now')");

    this.db.prepare(
      `UPDATE threads SET ${updates.join(', ')} WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid`
    ).run(params);
  }

  // ---- Thread-Folder operations (keyed by X-GM-THRID) ----

  upsertThreadFolder(accountId: number, xGmThrid: string, folder: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare(
      `INSERT OR IGNORE INTO thread_folders (account_id, x_gm_thrid, folder)
       VALUES (:accountId, :xGmThrid, :folder)`
    ).run({ accountId, xGmThrid, folder });
  }

  removeThreadFolderAssociation(accountId: number, xGmThrid: string, folder: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare(
      'DELETE FROM thread_folders WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid AND folder = :folder'
    ).run({ accountId, xGmThrid, folder });
  }

  getFoldersForThread(accountId: number, xGmThrid: string): string[] {
    if (!this.db) throw new Error('Database not initialized');
    const rows = this.db.prepare(
      'SELECT DISTINCT folder FROM thread_folders WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid'
    ).all({ accountId, xGmThrid }) as Array<{ folder: string }>;
    return rows.map((row) => row.folder);
  }

  getThreadInternalId(accountId: number, xGmThrid: string): number | null {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare(
      'SELECT id FROM threads WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid'
    ).get({ accountId, xGmThrid }) as { id: number } | undefined;
    if (row === undefined) return null;
    return row.id;
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
    const toAdd = currentFolderPaths.filter((folder) => !existingSet.has(folder));
    const toRemove = existingFolders.filter((folder) => folder !== ALL_MAIL_PATH && !currentSet.has(folder));

    if (toAdd.length === 0 && toRemove.length === 0) {
      return affectedFolders;
    }

    // Use db.transaction() for atomicity — handles nesting via SAVEPOINTs automatically.
    const doReconcile = this.db.transaction(() => {
      // Add missing folder associations
      for (const folder of toAdd) {
        this.db!.prepare(
          'INSERT OR IGNORE INTO email_folders (account_id, x_gm_msgid, folder) VALUES (:accountId, :xGmMsgId, :folder)'
        ).run({ accountId, xGmMsgId, folder });
        // Upsert thread_folders
        this.db!.prepare(
          'INSERT OR IGNORE INTO thread_folders (account_id, x_gm_thrid, folder) VALUES (:accountId, :xGmThrid, :folder)'
        ).run({ accountId, xGmThrid, folder });
        affectedFolders.add(folder);
      }

      // Remove stale folder associations
      for (const folder of toRemove) {
        this.db!.prepare(
          'DELETE FROM email_folders WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId AND folder = :folder'
        ).run({ accountId, xGmMsgId, folder });
        // Check if thread still has other emails in this folder
        const countRow = this.db!.prepare(
          `SELECT COUNT(*) AS cnt FROM email_folders ef
           JOIN emails e ON e.account_id = ef.account_id AND e.x_gm_msgid = ef.x_gm_msgid
           WHERE e.account_id = :accountId AND e.x_gm_thrid = :xGmThrid AND ef.folder = :folder`
        ).get({ accountId, xGmThrid, folder }) as { cnt: number } | undefined;
        const remaining = countRow?.cnt ?? 0;
        if (remaining === 0) {
          this.db!.prepare(
            'DELETE FROM thread_folders WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid AND folder = :folder'
          ).run({ accountId, xGmThrid, folder });
        }
        affectedFolders.add(folder);
      }
    });
    doReconcile();

    if (affectedFolders.size > 0) {
  

    }
    return affectedFolders;
  }

  /**
   * Batch-insert or update All Mail email_folders rows with their UIDs for a given account.
   *
   * Called after a full All Mail UID fetch to stamp every known message with its
   * All Mail UID, enabling stale-mail removal based on UID range comparisons.
   *
   * Uses ON CONFLICT DO UPDATE to overwrite any previously stored UID (safe after
   * UIDVALIDITY changes).
   *
   * @param accountId - Account ID
   * @param uidMap    - Map from x_gm_msgid to All Mail UID
   */
  writeAllMailFolderUids(accountId: number, uidMap: Map<string, number>): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    if (uidMap.size === 0) {
      return;
    }
    const insertStmt = this.db.prepare(`
      INSERT INTO email_folders (account_id, x_gm_msgid, folder, uid)
      VALUES (:accountId, :xGmMsgId, :folder, :uid)
      ON CONFLICT(account_id, x_gm_msgid, folder) DO UPDATE SET uid = excluded.uid
    `);
    const insertAll = this.db.transaction((entries: Array<{ xGmMsgId: string; uid: number }>) => {
      for (const entry of entries) {
        insertStmt.run({
          accountId,
          xGmMsgId: entry.xGmMsgId,
          folder: ALL_MAIL_PATH,
          uid: entry.uid
        });
      }
    });
    insertAll(Array.from(uidMap.entries()).map(([xGmMsgId, uid]) => ({ xGmMsgId, uid })));
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

    const placeholders = keepFolders.map((_, index) => `:keep${index}`).join(', ');
    const params: Record<string, string | number> = { accountId };
    for (let index = 0; index < keepFolders.length; index++) {
      params[`keep${index}`] = keepFolders[index];
    }

    // Count before delete
    const countRow = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM folder_state WHERE account_id = :accountId AND folder NOT IN (${placeholders})`
    ).get(params) as { cnt: number } | undefined;
    const count = countRow?.cnt ?? 0;

    if (count > 0) {
      this.db.prepare(
        `DELETE FROM folder_state WHERE account_id = :accountId AND folder NOT IN (${placeholders})`
      ).run(params);
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
    this.db.prepare(
      'INSERT OR IGNORE INTO email_folders (account_id, x_gm_msgid, folder) VALUES (:accountId, :xGmMsgId, :folder)'
    ).run({ accountId, xGmMsgId, folder });
  }

  removeEmailFolderAssociation(accountId: number, xGmMsgId: string, folder: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare(
      'DELETE FROM email_folders WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId AND folder = :folder'
    ).run({ accountId, xGmMsgId, folder });
  }

  /**
   * Atomically remove email-folder (and thread-folder) associations for a set of stale
   * x_gm_msgid values from a given folder.  All raw SQL runs inside a single transaction
   * owned entirely by this method.
   */
  removeStaleEmailFolderAssociations(accountId: number, folder: string, xGmMsgIds: string[]): void {
    if (!this.db) throw new Error('Database not initialized');
    if (xGmMsgIds.length === 0) return;

    // Collect thread IDs before mutating (needed for thread-folder cleanup check).
    const affectedThreadIds = new Map<string, string>(); // xGmMsgId → xGmThrid
    for (const xGmMsgId of xGmMsgIds) {
      const emailRow = this.db.prepare(
        'SELECT x_gm_thrid FROM emails WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId'
      ).get({ accountId, xGmMsgId }) as { x_gm_thrid: string } | undefined;
      if (emailRow?.x_gm_thrid) {
        affectedThreadIds.set(xGmMsgId, emailRow.x_gm_thrid);
      }
    }

    const doRemove = this.db.transaction(() => {
      for (const xGmMsgId of xGmMsgIds) {
        // Remove email-folder association
        this.db!.prepare(
          'DELETE FROM email_folders WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId AND folder = :folder'
        ).run({ accountId, xGmMsgId, folder });

        // Remove thread-folder if no remaining emails for this thread exist in the folder
        const xGmThrid = affectedThreadIds.get(xGmMsgId);
        if (xGmThrid) {
          const countRow = this.db!.prepare(
            `SELECT COUNT(*) AS cnt FROM email_folders ef
             JOIN emails e ON e.account_id = ef.account_id AND e.x_gm_msgid = ef.x_gm_msgid
             WHERE e.account_id = :accountId AND e.x_gm_thrid = :xGmThrid AND ef.folder = :folder`
          ).get({ accountId, xGmThrid, folder }) as { cnt: number } | undefined;
          const remaining = countRow?.cnt ?? 0;
          if (remaining === 0) {
            this.db!.prepare(
              'DELETE FROM thread_folders WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid AND folder = :folder'
            ).run({ accountId, xGmThrid, folder });
          }
        }
      }
    });
    doRemove();
  }

  /**
   * Remove all email-folder (and thread-folder) associations for a set of emails across
   * every folder EXCEPT Trash and Spam.  This is used when a bulk reconcile detects that
   * messages have been permanently deleted from All Mail: we want to strip them from
   * every visible folder while leaving any Trash/Spam links intact (so soft-deleted mail
   * stays in the Trash view until the server eventually expunges it).
   *
   * All mutations run inside a single transaction.  Folder paths and thread IDs are
   * collected BEFORE any deletion so that callers can update the UI accordingly.
   *
   * @param accountId   - The account whose emails are being cleaned up.
   * @param xGmMsgIds   - Stable Gmail message IDs to purge from all non-trash/spam folders.
   * @param trashFolder - The account-specific trash folder path (excluded from deletion).
   * @param spamFolder  - The account-specific spam folder path (excluded from deletion).
   * @returns affectedFolderPaths - Distinct folder paths that had rows removed.
   * @returns affectedThreadIds   - Distinct x_gm_thrid values whose emails were removed.
   */
  removeAllEmailFolderAssociations(
    accountId: number,
    xGmMsgIds: string[],
    trashFolder: string,
    spamFolder: string,
  ): { affectedFolderPaths: Set<string>; affectedThreadIds: Set<string> } {
    if (!this.db) { throw new Error('Database not initialized'); }
    if (xGmMsgIds.length === 0) {
      return { affectedFolderPaths: new Set(), affectedThreadIds: new Set() };
    }

    // --- Pre-deletion SELECT ---
    // Collect all (folder, x_gm_thrid) pairs that will be affected, so we can:
    //   1. Return affected folder paths and thread IDs to the caller.
    //   2. Know which (thread, folder) pairs to check for orphaned thread_folders rows.
    //
    // We iterate each xGmMsgId individually (no IN clause) to stay well within SQLite's
    // bound-parameter limit and to match the established pattern in this file.

    const affectedFolderPaths = new Set<string>();
    const affectedThreadIds = new Set<string>();

    // folderToThrids: folder → Set<x_gm_thrid> — used for thread_folders cleanup below.
    const folderToThrids = new Map<string, Set<string>>();

    const selectStmt = this.db.prepare(
      `SELECT ef.folder, e.x_gm_thrid
         FROM email_folders ef
         JOIN emails e ON e.account_id = ef.account_id AND e.x_gm_msgid = ef.x_gm_msgid
        WHERE e.account_id = :accountId
          AND e.x_gm_msgid  = :xGmMsgId
          AND ef.folder     != :trashFolder
          AND ef.folder     != :spamFolder`,
    );

    for (const xGmMsgId of xGmMsgIds) {
      const rows = selectStmt.all({ accountId, xGmMsgId, trashFolder, spamFolder }) as Array<{
        folder: string;
        x_gm_thrid: string;
      }>;

      for (const row of rows) {
        affectedFolderPaths.add(row.folder);
        affectedThreadIds.add(row.x_gm_thrid);

        if (!folderToThrids.has(row.folder)) {
          folderToThrids.set(row.folder, new Set<string>());
        }
        folderToThrids.get(row.folder)!.add(row.x_gm_thrid);
      }
    }

    // If nothing was found in non-trash/spam folders, nothing to do.
    if (affectedFolderPaths.size === 0) {
      return { affectedFolderPaths, affectedThreadIds };
    }

    // --- Transactional mutations ---
    const doRemove = this.db.transaction(() => {
      // Prepared statements reused across all iterations.
      const deleteEmailFolderStmt = this.db!.prepare(
        `DELETE FROM email_folders
          WHERE account_id = :accountId
            AND x_gm_msgid = :xGmMsgId
            AND folder    != :trashFolder
            AND folder    != :spamFolder`,
      );

      const countRemainingStmt = this.db!.prepare(
        `SELECT COUNT(*) AS cnt
           FROM email_folders ef
           JOIN emails e ON e.account_id = ef.account_id AND e.x_gm_msgid = ef.x_gm_msgid
          WHERE e.account_id  = :accountId
            AND e.x_gm_thrid  = :xGmThrid
            AND ef.folder     = :folder`,
      );

      const deleteThreadFolderStmt = this.db!.prepare(
        `DELETE FROM thread_folders
          WHERE account_id = :accountId
            AND x_gm_thrid = :xGmThrid
            AND folder     = :folder`,
      );

      // 1. Remove email-folder associations (all non-trash/spam folders) for each message.
      for (const xGmMsgId of xGmMsgIds) {
        deleteEmailFolderStmt.run({ accountId, xGmMsgId, trashFolder, spamFolder });
      }

      // 2. For each (folder, thread) pair that was affected, check whether any emails
      //    remain in that folder for that thread.  If none remain, remove the thread_folders
      //    row so the thread no longer appears in that folder's thread list.
      for (const [folder, thrids] of folderToThrids) {
        for (const xGmThrid of thrids) {
          const countRow = countRemainingStmt.get({ accountId, xGmThrid, folder }) as
            | { cnt: number }
            | undefined;
          const remainingCount = countRow?.cnt ?? 0;
          if (remainingCount === 0) {
            deleteThreadFolderStmt.run({ accountId, xGmThrid, folder });
          }
        }
      }
    });

    doRemove();

    return { affectedFolderPaths, affectedThreadIds };
  }

  moveEmailFolder(accountId: number, xGmMsgId: string, sourceFolder: string, targetFolder: string, targetUid?: number | null): void {
    if (!this.db) throw new Error('Database not initialized');
    const doMove = this.db.transaction(() => {
      // Remove source folder association
      this.db!.prepare(
        'DELETE FROM email_folders WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId AND folder = :folder'
      ).run({ accountId, xGmMsgId, folder: sourceFolder });
      // Add target folder association (with uid if available)
      if (targetUid != null) {
        this.db!.prepare(
          `INSERT INTO email_folders (account_id, x_gm_msgid, folder, uid) VALUES (:accountId, :xGmMsgId, :folder, :uid)
           ON CONFLICT(account_id, x_gm_msgid, folder) DO UPDATE SET uid = excluded.uid`
        ).run({ accountId, xGmMsgId, folder: targetFolder, uid: targetUid });
      } else {
        this.db!.prepare(
          'INSERT OR IGNORE INTO email_folders (account_id, x_gm_msgid, folder) VALUES (:accountId, :xGmMsgId, :folder)'
        ).run({ accountId, xGmMsgId, folder: targetFolder });
      }
    });
    doMove();
  }

  moveThreadFolder(accountId: number, xGmThrid: string, sourceFolder: string, targetFolder: string): void {
    if (!this.db) throw new Error('Database not initialized');
    const doMove = this.db.transaction(() => {
      this.db!.prepare(
        'DELETE FROM thread_folders WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid AND folder = :folder'
      ).run({ accountId, xGmThrid, folder: sourceFolder });
      this.db!.prepare(
        'INSERT OR IGNORE INTO thread_folders (account_id, x_gm_thrid, folder) VALUES (:accountId, :xGmThrid, :folder)'
      ).run({ accountId, xGmThrid, folder: targetFolder });
    });
    doMove();
  }

  threadHasEmailsInFolder(accountId: number, xGmThrid: string, folder: string): boolean {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM email_folders ef
       JOIN emails e ON e.account_id = ef.account_id AND e.x_gm_msgid = ef.x_gm_msgid
       WHERE e.account_id = :accountId AND e.x_gm_thrid = :xGmThrid AND ef.folder = :folder`
    ).get({ accountId, xGmThrid, folder }) as { cnt: number } | undefined;
    return (row?.cnt ?? 0) > 0;
  }

  /** Get all x_gm_msgid values that have a folder association for a given account + folder. */
  getEmailXGmMsgIdsByFolder(accountId: number, folder: string): string[] {
    if (!this.db) throw new Error('Database not initialized');
    const rows = this.db.prepare(
      `SELECT x_gm_msgid FROM email_folders
       WHERE account_id = :accountId AND folder = :folder`
    ).all({ accountId, folder }) as Array<{ x_gm_msgid: string }>;
    return rows.map((row) => row.x_gm_msgid);
  }

  /** Get all (x_gm_msgid, uid) pairs from email_folders for a given account + folder. */
  getEmailFolderUids(accountId: number, folder: string): Array<{ xGmMsgId: string; uid: number }> {
    if (!this.db) throw new Error('Database not initialized');
    const rows = this.db.prepare(
      `SELECT x_gm_msgid, uid FROM email_folders
       WHERE account_id = :accountId AND folder = :folder AND uid IS NOT NULL`
    ).all({ accountId, folder }) as Array<{ x_gm_msgid: string; uid: number }>;
    return rows.map((row) => ({ xGmMsgId: row.x_gm_msgid, uid: row.uid }));
  }

  // ---- Email removal and orphan cleanup ----

  removeEmailAndAssociations(accountId: number, xGmMsgId: string): void {
    if (!this.db) throw new Error('Database not initialized');
    const doRemove = this.db.transaction(() => {
      const emailRow = this.db!.prepare(
        'SELECT id, x_gm_thrid FROM emails WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId'
      ).get({ accountId, xGmMsgId }) as { id: number; x_gm_thrid: string } | undefined;
      if (emailRow === undefined) {
        return;
      }
      const emailId = emailRow.id;
      const xGmThrid = emailRow.x_gm_thrid;

      // Remove all folder associations for this email
      this.db!.prepare(
        'DELETE FROM email_folders WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId'
      ).run({ accountId, xGmMsgId });

      // Remove the email row itself (CASCADE handles attachments, search_index)
      this.db!.prepare('DELETE FROM emails WHERE id = :emailId').run({ emailId });

      // Clean up orphaned thread
      if (xGmThrid) {
        const remainingRow = this.db!.prepare(
          'SELECT COUNT(*) AS cnt FROM emails WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid'
        ).get({ accountId, xGmThrid }) as { cnt: number } | undefined;
        const remaining = remainingRow?.cnt ?? 0;

        if (remaining === 0) {
          this.db!.prepare(
            'DELETE FROM thread_folders WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid'
          ).run({ accountId, xGmThrid });
          this.db!.prepare(
            'DELETE FROM threads WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid'
          ).run({ accountId, xGmThrid });
        } else {
          // Thread still has emails — remove thread_folders for folders with no remaining emails
          const folderRows = this.db!.prepare(
            'SELECT DISTINCT folder FROM thread_folders WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid'
          ).all({ accountId, xGmThrid }) as Array<{ folder: string }>;
          for (const folderRow of folderRows) {
            const folder = folderRow.folder;
            const countRow = this.db!.prepare(
              `SELECT COUNT(*) AS cnt FROM email_folders ef
               JOIN emails e ON e.account_id = ef.account_id AND e.x_gm_msgid = ef.x_gm_msgid
               WHERE e.account_id = :accountId AND e.x_gm_thrid = :xGmThrid AND ef.folder = :folder`
            ).get({ accountId, xGmThrid, folder }) as { cnt: number } | undefined;
            const count = countRow?.cnt ?? 0;
            if (count === 0) {
              this.db!.prepare(
                'DELETE FROM thread_folders WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid AND folder = :folder'
              ).run({ accountId, xGmThrid, folder });
            }
          }
        }
      }
    });
    doRemove();
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

    // db.prepare() must be called inside the method since the SQL is dynamic (grace period clause).
    const doRemove = this.db.transaction(() => {
      const selectRows = this.db!.prepare(
        `SELECT x_gm_msgid, x_gm_thrid FROM emails
         WHERE account_id = :accountId
           AND x_gm_msgid NOT IN (SELECT x_gm_msgid FROM email_folders WHERE account_id = :accountId)
           ${gracePeriodClause}`
      ).all({ accountId }) as Array<{ x_gm_msgid: string; x_gm_thrid: string }>;

      for (const row of selectRows) {
        removed.push({
          xGmMsgId: row.x_gm_msgid,
          xGmThrid: row.x_gm_thrid,
        });
      }

      if (removed.length > 0) {
        this.db!.prepare(
          `DELETE FROM emails
           WHERE account_id = :accountId
             AND x_gm_msgid NOT IN (SELECT x_gm_msgid FROM email_folders WHERE account_id = :accountId)
             ${gracePeriodClause}`
        ).run({ accountId });
      }
    });
    doRemove();

    if (removed.length > 0) {
  

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

    const countRow = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM threads t WHERE t.account_id = :accountId
       AND NOT EXISTS (SELECT 1 FROM thread_folders tf WHERE tf.account_id = t.account_id AND tf.x_gm_thrid = t.x_gm_thrid)
       ${countGracePeriodClause}`
    ).get({ accountId }) as { cnt: number } | undefined;
    const count = countRow?.cnt ?? 0;

    if (count > 0) {
      this.db.prepare(
        `DELETE FROM threads WHERE account_id = :accountId
         AND NOT EXISTS (SELECT 1 FROM thread_folders tf WHERE tf.account_id = threads.account_id AND tf.x_gm_thrid = threads.x_gm_thrid)
         ${deleteGracePeriodClause}`
      ).run({ accountId });
    }
    return count;
  }

  getAffectedThreadIds(accountId: number, xGmMsgIds: string[]): string[] {
    if (!this.db) throw new Error('Database not initialized');
    if (xGmMsgIds.length === 0) return [];

    const placeholders = xGmMsgIds.map((_, index) => `:id${index}`).join(', ');
    const params: Record<string, string | number> = { accountId };
    for (let index = 0; index < xGmMsgIds.length; index++) {
      params[`id${index}`] = xGmMsgIds[index];
    }

    const rows = this.db.prepare(
      `SELECT DISTINCT x_gm_thrid FROM emails
       WHERE account_id = :accountId AND x_gm_msgid IN (${placeholders})`
    ).all(params) as Array<{ x_gm_thrid: string }>;

    return rows.map((row) => row.x_gm_thrid);
  }

  /**
   * Recomputes the stored thread metadata (message_count, subject, snippet, etc.).
   * threads.message_count stores the total email count (including trashed emails).
   * List-view queries (getThreadsByFolder, etc.) override this with a live
   * subquery that conditionally excludes trash depending on the viewed folder,
   * so the stored value is only a fallback (e.g. getThreadById in queue ops).
   */
  recomputeThreadMetadata(accountId: number, xGmThrid: string): void {
    if (!this.db) throw new Error('Database not initialized');

    const doRecompute = this.db.transaction(() => {
      const countRow = this.db!.prepare(
        `SELECT COUNT(*) AS cnt FROM emails
         WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid`
      ).get({ accountId, xGmThrid }) as { cnt: number } | undefined;
      const emailCount = countRow?.cnt ?? 0;

      const threadRow = this.db!.prepare(
        'SELECT id FROM threads WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid'
      ).get({ accountId, xGmThrid }) as { id: number } | undefined;
      if (threadRow === undefined) {
        return;
      }
      const threadId = threadRow.id;

      if (emailCount === 0) {
        this.db!.prepare(
          'DELETE FROM thread_folders WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid'
        ).run({ accountId, xGmThrid });
        this.db!.prepare('DELETE FROM threads WHERE id = :threadId').run({ threadId });
        return;
      }

      const aggRow = this.db!.prepare(
        `SELECT
           COUNT(DISTINCT e.id) AS message_count,
           COALESCE(MAX(date), datetime('now')) AS last_message_date,
           MIN(CASE WHEN is_read = 0 THEN 0 ELSE 1 END) AS all_read,
           MAX(is_starred) AS any_starred
         FROM emails e
         WHERE e.account_id = :accountId AND e.x_gm_thrid = :xGmThrid`
      ).get({ accountId, xGmThrid }) as {
        message_count: number;
        last_message_date: string;
        all_read: number;
        any_starred: number;
      } | undefined;

      if (aggRow === undefined) {
        return;
      }

      const messageCount = aggRow.message_count;
      const lastMessageDate = aggRow.last_message_date;
      const isRead = aggRow.all_read === 1;
      const isStarred = aggRow.any_starred === 1;

      const snippetRow = this.db!.prepare(
        `SELECT snippet FROM emails
         WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid
         ORDER BY date DESC LIMIT 1`
      ).get({ accountId, xGmThrid }) as { snippet: string } | undefined;
      const snippet = snippetRow?.snippet ?? '';

      const participantRows = this.db!.prepare(
        `SELECT from_address, from_name FROM emails
         WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid
         ORDER BY date DESC`
      ).all({ accountId, xGmThrid }) as Array<{ from_address: string; from_name: string | null }>;
      const mappedParticipants = participantRows.map((row) => ({
        fromAddress: row.from_address,
        fromName: row.from_name,
      }));
      const participants = formatParticipantList(mappedParticipants);

      this.db!.prepare(
        `UPDATE threads SET
           message_count = :messageCount,
           last_message_date = :lastMessageDate,
           snippet = :snippet,
           participants = :participants,
           is_read = :isRead,
           is_starred = :isStarred,
           updated_at = datetime('now')
         WHERE id = :threadId`
      ).run({
        messageCount,
        lastMessageDate,
        snippet: snippet || '',
        participants,
        isRead: isRead ? 1 : 0,
        isStarred: isStarred ? 1 : 0,
        threadId,
      });
    });
    doRecompute();
  }

  // ---- Folder State operations (CONDSTORE) ----

  upsertFolderState(input: UpsertFolderStateInput): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare(
      `INSERT INTO folder_state (account_id, folder, uid_validity, highest_modseq, condstore_supported, last_reconciled_at, updated_at)
       VALUES (:accountId, :folder, :uidValidity, :highestModseq, :condstoreSupported, :lastReconciledAt, datetime('now'))
       ON CONFLICT(account_id, folder) DO UPDATE SET
        uid_validity = excluded.uid_validity,
        highest_modseq = excluded.highest_modseq,
        condstore_supported = excluded.condstore_supported,
        last_reconciled_at = COALESCE(excluded.last_reconciled_at, folder_state.last_reconciled_at),
        updated_at = datetime('now')`
    ).run({
      accountId: input.accountId,
      folder: input.folder,
      uidValidity: input.uidValidity,
      highestModseq: input.highestModseq ?? null,
      condstoreSupported: (input.condstoreSupported ?? true) ? 1 : 0,
      lastReconciledAt: input.lastReconciledAt ?? null,
    });
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
    this.db.prepare(
      `INSERT INTO folder_state (account_id, folder, uid_validity, highest_modseq, condstore_supported, updated_at)
       VALUES (:accountId, :folder, :uidValidity, NULL, :condstoreSupported, datetime('now'))
       ON CONFLICT(account_id, folder) DO UPDATE SET
        uid_validity        = excluded.uid_validity,
        condstore_supported = excluded.condstore_supported,
        updated_at          = datetime('now')`
    ).run({
      accountId,
      folder,
      uidValidity,
      condstoreSupported: condstoreSupported ? 1 : 0,
    });
  }

  getFolderState(accountId: number, folder: string): FolderStateRecord | null {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare(
      `SELECT id, account_id, folder, uid_validity, highest_modseq, condstore_supported, last_reconciled_at, updated_at
       FROM folder_state WHERE account_id = :accountId AND folder = :folder`
    ).get({ accountId, folder }) as {
      id: number; account_id: number; folder: string; uid_validity: string;
      highest_modseq: string | null; condstore_supported: number;
      last_reconciled_at: string | null; updated_at: string;
    } | undefined;
    if (row === undefined) return null;
    return {
      id: row.id,
      accountId: row.account_id,
      folder: row.folder,
      uidValidity: row.uid_validity,
      highestModseq: row.highest_modseq,
      condstoreSupported: row.condstore_supported === 1,
      lastReconciledAt: row.last_reconciled_at,
      updatedAt: row.updated_at,
    };
  }

  getAllFolderStates(accountId: number): FolderStateRecord[] {
    if (!this.db) throw new Error('Database not initialized');
    const rows = this.db.prepare(
      `SELECT id, account_id, folder, uid_validity, highest_modseq, condstore_supported, last_reconciled_at, updated_at
       FROM folder_state WHERE account_id = :accountId`
    ).all({ accountId }) as Array<{
      id: number; account_id: number; folder: string; uid_validity: string;
      highest_modseq: string | null; condstore_supported: number;
      last_reconciled_at: string | null; updated_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      folder: row.folder,
      uidValidity: row.uid_validity,
      highestModseq: row.highest_modseq,
      condstoreSupported: row.condstore_supported === 1,
      lastReconciledAt: row.last_reconciled_at,
      updatedAt: row.updated_at,
    }));
  }

  deleteFolderState(accountId: number, folder: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare(
      'DELETE FROM folder_state WHERE account_id = :accountId AND folder = :folder'
    ).run({ accountId, folder });
  }

  updateFolderStateReconciliation(accountId: number, folder: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare(
      `UPDATE folder_state SET last_reconciled_at = datetime('now'), updated_at = datetime('now')
       WHERE account_id = :accountId AND folder = :folder`
    ).run({ accountId, folder });
  }

  /**
   * Wipe all folder data for a UIDVALIDITY reset.
   * Removes email_folders, thread_folders for the folder, cleans orphans.
   */
  wipeFolderData(accountId: number, folder: string): void {
    if (!this.db) throw new Error('Database not initialized');

    const affectedThreadIds = new Set<string>();
    const affectedRows = this.db.prepare(
      `SELECT DISTINCT e.x_gm_thrid
       FROM emails e
       INNER JOIN email_folders ef ON ef.account_id = e.account_id AND ef.x_gm_msgid = e.x_gm_msgid
       WHERE ef.account_id = :accountId AND ef.folder = :folder`
    ).all({ accountId, folder }) as Array<{ x_gm_thrid: string }>;
    for (const row of affectedRows) {
      if (row.x_gm_thrid) {
        affectedThreadIds.add(row.x_gm_thrid);
      }
    }

    const doWipe = this.db.transaction(() => {
      // Remove all email_folders for this folder
      this.db!.prepare(
        'DELETE FROM email_folders WHERE account_id = :accountId AND folder = :folder'
      ).run({ accountId, folder });
      // Remove all thread_folders for this folder
      this.db!.prepare(
        'DELETE FROM thread_folders WHERE account_id = :accountId AND folder = :folder'
      ).run({ accountId, folder });
      // Remove folder state
      this.db!.prepare(
        'DELETE FROM folder_state WHERE account_id = :accountId AND folder = :folder'
      ).run({ accountId, folder });
    });
    doWipe();

    // Remove newly orphaned emails and track their affected threads.
    // Pass bypassGracePeriod=true: this is an intentional wipe (UIDVALIDITY reset),
    // so immediate cleanup is correct — no grace period needed.
    // Note: removeOrphanedEmails and removeOrphanedThreads are also wrapped in
    // db.transaction() internally — better-sqlite3 handles nested transactions via savepoints.
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
    this.db.prepare(
      `INSERT INTO labels (account_id, gmail_label_id, name, type, color, unread_count, total_count, special_use)
       VALUES (:accountId, :gmailLabelId, :name, :type, :color, :unreadCount, :totalCount, :specialUse)
       ON CONFLICT(account_id, gmail_label_id) DO UPDATE SET
        name = excluded.name, type = excluded.type, color = COALESCE(excluded.color, labels.color),
        unread_count = excluded.unread_count, total_count = excluded.total_count,
        special_use = COALESCE(excluded.special_use, labels.special_use)`
    ).run({
      accountId: label.accountId,
      gmailLabelId: label.gmailLabelId,
      name: label.name,
      type: label.type,
      color: label.color || null,
      unreadCount: label.unreadCount,
      totalCount: label.totalCount,
      specialUse: label.specialUse || null,
    });
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
    const bySpecialUse = this.db.prepare(
      `SELECT gmail_label_id FROM labels WHERE account_id = :accountId AND special_use = '\\Trash' LIMIT 1`
    ).get({ accountId }) as { gmail_label_id: string } | undefined;
    if (bySpecialUse !== undefined && bySpecialUse.gmail_label_id.length > 0) {
      return bySpecialUse.gmail_label_id;
    }

    // Legacy fallback: check for '[Gmail]/Bin' by label ID (UK locale, before special_use is populated)
    const byBin = this.db.prepare(
      `SELECT gmail_label_id FROM labels WHERE account_id = :accountId AND gmail_label_id = '[Gmail]/Bin' LIMIT 1`
    ).get({ accountId }) as { gmail_label_id: string } | undefined;
    if (byBin !== undefined && byBin.gmail_label_id.length > 0) {
      return byBin.gmail_label_id;
    }

    return '[Gmail]/Trash';
  }

  getUnreadThreadCountsByFolder(accountId: number): Record<string, number> {
    if (!this.db) throw new Error('Database not initialized');
    const rows = this.db.prepare(
      `SELECT tf.folder, COUNT(DISTINCT t.id) AS cnt
       FROM thread_folders tf
       INNER JOIN threads t ON t.account_id = tf.account_id AND t.x_gm_thrid = tf.x_gm_thrid
       WHERE tf.account_id = :accountId AND t.is_read = 0
       GROUP BY tf.folder`
    ).all({ accountId }) as Array<{ folder: string; cnt: number }>;
    const out: Record<string, number> = {};
    for (const row of rows) {
      out[row.folder] = row.cnt || 0;
    }
    return out;
  }

  getLabelsByAccount(accountId: number): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');
    const rows = this.db.prepare(
      `SELECT id, account_id, gmail_label_id, name, type, color, unread_count, total_count, special_use
       FROM labels WHERE account_id = :accountId ORDER BY type ASC, name ASC`
    ).all({ accountId });
    return rows.map((row) => this.mapRow<Record<string, unknown>>(row as Record<string, unknown>));
  }

  /**
   * Insert a new user-defined label (gmail_label_id = label name used as IMAP mailbox path).
   * Returns the new row's id.
   */
  createLabel(accountId: number, gmailLabelId: string, name: string, color: string | null): number {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.prepare(
      `INSERT INTO labels (account_id, gmail_label_id, name, type, color, unread_count, total_count)
       VALUES (:accountId, :gmailLabelId, :name, 'user', :color, 0, 0)`
    ).run({ accountId, gmailLabelId, name, color });
    return Number(result.lastInsertRowid);
  }

  /**
   * Delete a user label and clean up email_folders / thread_folders associations.
   * All three deletions run in a single transaction.
   */
  deleteLabel(accountId: number, gmailLabelId: string): void {
    if (!this.db) throw new Error('Database not initialized');
    const doDelete = this.db.transaction(() => {
      this.db!.prepare(
        'DELETE FROM email_folders WHERE account_id = :accountId AND folder = :gmailLabelId'
      ).run({ accountId, gmailLabelId });
      this.db!.prepare(
        'DELETE FROM thread_folders WHERE account_id = :accountId AND folder = :gmailLabelId'
      ).run({ accountId, gmailLabelId });
      this.db!.prepare(
        'DELETE FROM labels WHERE account_id = :accountId AND gmail_label_id = :gmailLabelId'
      ).run({ accountId, gmailLabelId });
    });
    doDelete();
  }

  /**
   * Update the color column of a label. Pass null to clear the color.
   */
  updateLabelColor(accountId: number, gmailLabelId: string, color: string | null): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare(
      'UPDATE labels SET color = :color WHERE account_id = :accountId AND gmail_label_id = :gmailLabelId'
    ).run({ color, accountId, gmailLabelId });
  }

  /**
   * Look up a single label row by account + gmailLabelId. Returns null if not found.
   */
  getLabelByGmailId(accountId: number, gmailLabelId: string): Record<string, unknown> | null {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare(
      `SELECT id, account_id, gmail_label_id, name, type, color
       FROM labels WHERE account_id = :accountId AND gmail_label_id = :gmailLabelId`
    ).get({ accountId, gmailLabelId });
    if (row === undefined) {
      return null;
    }
    return this.mapRow<Record<string, unknown>>(row as Record<string, unknown>);
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

    // Build parameterized placeholders for the IN clause — avoids string injection risks.
    const thridPlaceholders = xGmThrids.map((_, index) => `:thrid${index}`).join(', ');
    const params: Record<string, string | number> = { accountId };
    for (let index = 0; index < xGmThrids.length; index++) {
      params[`thrid${index}`] = xGmThrids[index];
    }

    const rows = this.db.prepare(
      `SELECT DISTINCT e.x_gm_thrid, l.id, l.name, l.color, l.gmail_label_id
       FROM emails e
       JOIN email_folders ef ON ef.account_id = e.account_id AND ef.x_gm_msgid = e.x_gm_msgid
       JOIN labels l ON l.account_id = e.account_id AND l.gmail_label_id = ef.folder
       WHERE e.account_id = :accountId
         AND l.type = 'user'
         AND e.x_gm_thrid IN (${thridPlaceholders})`
    ).all(params) as Array<{ x_gm_thrid: string; id: number; name: string; color: string | null; gmail_label_id: string }>;

    const map = new Map<string, Array<{ id: number; name: string; color: string | null; gmailLabelId: string }>>();

    for (const row of rows) {
      const xGmThrid = row.x_gm_thrid;
      const labelEntry = {
        id: row.id,
        name: row.name,
        color: row.color,
        gmailLabelId: row.gmail_label_id,
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
    this.db.prepare(
      'UPDATE labels SET unread_count = :unreadCount, total_count = :totalCount WHERE account_id = :accountId AND gmail_label_id = :gmailLabelId'
    ).run({ unreadCount, totalCount, accountId, gmailLabelId });
  }

  // ---- Contact operations ----

  upsertContact(email: string, displayName?: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare(
      `INSERT INTO contacts (email, display_name, frequency, last_contacted_at, updated_at)
       VALUES (:email, :displayName, 1, datetime('now'), datetime('now'))
       ON CONFLICT(email) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, display_name),
        frequency = frequency + 1,
        last_contacted_at = datetime('now'),
        updated_at = datetime('now')`
    ).run({ email, displayName: displayName || null });
  }

  searchContacts(query: string, limit: number = 10): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');
    const likeQuery = `%${query}%`;
    const rows = this.db.prepare(
      `SELECT id, email, display_name, frequency, last_contacted_at
       FROM contacts WHERE email LIKE :likeQuery OR display_name LIKE :likeQuery
       ORDER BY frequency DESC LIMIT :limit`
    ).all({ likeQuery, limit });
    return rows.map((row) => this.mapRow<Record<string, unknown>>(row as Record<string, unknown>));
  }

  // ---- Search operations ----

  upsertSearchIndex(emailId: number, subject: string, body: string, fromName: string, fromAddress: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare(
      `INSERT INTO search_index (email_id, subject, body, from_name, from_address)
       VALUES (:emailId, :subject, :body, :fromName, :fromAddress)
       ON CONFLICT(email_id) DO UPDATE SET
        subject = excluded.subject, body = excluded.body,
        from_name = excluded.from_name, from_address = excluded.from_address`
    ).run({ emailId, subject, body, fromName, fromAddress });
  }

  searchEmails(accountId: number, query: string, limit: number = 100): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');

    const { parseGmailQuery } = require('../utils/gmail-query-parser');
    const parsed = parseGmailQuery(query, {
      accountId,
      trashFolderResolver: (resolverAccountId?: number) => this.getTrashFolder(resolverAccountId ?? accountId),
    }) as { whereClause: string; params: Record<string, unknown> };

    const params = {
      accountId,
      limit,
      trashFolder: this.getTrashFolder(accountId),
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

    const rows = this.db.prepare(sql).all(params);
    return rows.map((row) => this.mapRow<Record<string, unknown>>(row as Record<string, unknown>));
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
        accountId,
        limit,
        ...parsed.params,
      } as Record<string, number | string | null>;

      const rows = this.db.prepare(
        `SELECT DISTINCT e.x_gm_thrid
         FROM emails e
         WHERE e.account_id = :accountId AND (${parsed.whereClause})
         ORDER BY e.date DESC
         LIMIT :limit`
      ).all(params) as Array<{ x_gm_thrid: string | null }>;

      for (const row of rows) {
        const threadId = row.x_gm_thrid;
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
      accountId,
      limit,
      trashFolder: this.getTrashFolder(accountId),
    };
    for (let index = 0; index < uniqueIds.length; index++) {
      params[`threadId${index}`] = uniqueIds[index];
    }

    const rows = this.db.prepare(
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
       LIMIT :limit`
    ).all(params);

    return rows.map((row) => this.mapRow<Record<string, unknown>>(row as Record<string, unknown>));
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
      params[`threadId${index}`] = uniqueThreadIds[index];
    }

    const rows = this.db.prepare(
      `SELECT t.id, tf.folder
       FROM threads t
       INNER JOIN thread_folders tf ON t.account_id = tf.account_id AND t.x_gm_thrid = tf.x_gm_thrid
       WHERE t.id IN (${placeholders.join(', ')})
       ORDER BY t.id ASC, tf.folder ASC`
    ).all(params) as Array<{ id: number; folder: string }>;

    for (const row of rows) {
      const threadId = row.id;
      const folder = row.folder;
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
      folder,
      trashFolder: this.getTrashFolder(accountId),
    };
    for (let index = 0; index < uniqueThreadIds.length; index++) {
      params[`threadId${index}`] = uniqueThreadIds[index];
    }

    const rows = this.db.prepare(
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
         )`
    ).all(params) as Array<{ id: number }>;

    for (const row of rows) {
      result.add(row.id);
    }

    return result;
  }

  // ---- Account sync state ----

  updateAccountSyncState(accountId: number, lastSyncAt: string, syncCursor?: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare(
      `UPDATE accounts SET last_sync_at = :lastSyncAt, sync_cursor = :syncCursor, updated_at = datetime('now') WHERE id = :accountId`
    ).run({ lastSyncAt, syncCursor: syncCursor || null, accountId });
  }

  getAccountSyncState(accountId: number): { lastSyncAt: string | null; syncCursor: string | null } {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare(
      'SELECT last_sync_at, sync_cursor FROM accounts WHERE id = :accountId'
    ).get({ accountId }) as { last_sync_at: string | null; sync_cursor: string | null } | undefined;
    if (row === undefined) {
      return { lastSyncAt: null, syncCursor: null };
    }
    return {
      lastSyncAt: row.last_sync_at,
      syncCursor: row.sync_cursor,
    };
  }

  // ---- Row mapping helpers ----

  /**
   * Convert a snake_case database row object (from better-sqlite3's .get()/.all())
   * to a camelCase object, with boolean coercion for known boolean columns.
   *
   * Special cases:
   *   x_gm_msgid → xGmMsgId
   *   x_gm_thrid → xGmThrid
   *
   * Boolean coercion: known boolean columns are converted from 0/1 integers
   * to false/true.
   */
  private mapRow<T extends Record<string, unknown>>(row: Record<string, unknown>): T {
    const booleanColumns = new Set([
      'is_read', 'is_starred', 'is_important', 'is_draft', 'is_filtered',
      'has_attachments', 'is_enabled', 'is_ai_generated', 'is_active',
      'needs_reauth', 'condstore_supported', 'build_interrupted',
    ]);

    const result: Record<string, unknown> = {};

    for (const key of Object.keys(row)) {
      const value = row[key];

      let camelKey: string;
      if (key === 'x_gm_msgid') {
        camelKey = 'xGmMsgId';
      } else if (key === 'x_gm_thrid') {
        camelKey = 'xGmThrid';
      } else {
        const parts = key.split('_');
        camelKey = parts[0] + parts.slice(1).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
      }

      if (booleanColumns.has(key) && (value === 0 || value === 1)) {
        result[camelKey] = value === 1;
      } else {
        result[camelKey] = value;
      }
    }

    return result as T;
  }

  // ---- AI Cache operations ----

  getAiCacheResult(operation: string, inputHash: string, model: string): string | null {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare(
      `SELECT result FROM ai_cache
       WHERE operation_type = :operation AND input_hash = :inputHash AND model = :model
       AND (expires_at IS NULL OR expires_at > datetime('now'))`
    ).get({ operation, inputHash, model }) as { result: string } | undefined;
    if (row === undefined) {
      return null;
    }
    return row.result;
  }

  setAiCacheResult(operation: string, inputHash: string, model: string, resultText: string, expiresInDays: number | null): void {
    if (!this.db) throw new Error('Database not initialized');
    const expiresAt = expiresInDays != null
      ? DateTime.utc().plus({ days: Math.floor(expiresInDays) }).toISO()
      : null;

    this.db.prepare(
      `INSERT INTO ai_cache (operation_type, input_hash, model, result, expires_at)
       VALUES (:operation, :inputHash, :model, :result, :expiresAt)
       ON CONFLICT(operation_type, input_hash, model) DO UPDATE SET
         result = excluded.result, created_at = datetime('now'), expires_at = excluded.expires_at`
    ).run({ operation, inputHash, model, result: resultText, expiresAt });
  }

  clearExpiredAiCache(): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare("DELETE FROM ai_cache WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')").run();
  }

  invalidateAiCache(operation: string, inputHash?: string): void {
    if (!this.db) throw new Error('Database not initialized');
    if (inputHash) {
      this.db.prepare('DELETE FROM ai_cache WHERE operation_type = :operation AND input_hash = :inputHash').run({ operation, inputHash });
    } else {
      this.db.prepare('DELETE FROM ai_cache WHERE operation_type = :operation').run({ operation });
    }
  }

  // ---- Filter CRUD operations ----

  getFilters(accountId: number): Array<{
    id: number; accountId: number; name: string; conditions: string; actions: string;
    isEnabled: boolean; isAiGenerated: boolean; sortOrder: number; createdAt: string; updatedAt: string;
  }> {
    if (!this.db) throw new Error('Database not initialized');
    const rows = this.db.prepare(
      `SELECT id, account_id, name, conditions, actions, is_enabled, is_ai_generated, sort_order, created_at, updated_at
       FROM filters WHERE account_id = :accountId ORDER BY sort_order ASC, id ASC`
    ).all({ accountId });
    return rows.map((row) => this.mapRow<{
      id: number; accountId: number; name: string; conditions: string; actions: string;
      isEnabled: boolean; isAiGenerated: boolean; sortOrder: number; createdAt: string; updatedAt: string;
    }>(row as Record<string, unknown>));
  }

  saveFilter(filter: {
    accountId: number; name: string; conditions: string; actions: string;
    isEnabled: boolean; isAiGenerated: boolean; sortOrder?: number;
  }): number {
    if (!this.db) throw new Error('Database not initialized');
    let sortOrder = filter.sortOrder;
    if (sortOrder == null) {
      const maxRow = this.db.prepare(
        'SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM filters WHERE account_id = :accountId'
      ).get({ accountId: filter.accountId }) as { maxOrder: number } | undefined;
      sortOrder = ((maxRow?.maxOrder) || 0) + 1;
    }
    const result = this.db.prepare(
      `INSERT INTO filters (account_id, name, conditions, actions, is_enabled, is_ai_generated, sort_order)
       VALUES (:accountId, :name, :conditions, :actions, :isEnabled, :isAiGenerated, :sortOrder)`
    ).run({
      accountId: filter.accountId,
      name: filter.name,
      conditions: filter.conditions,
      actions: filter.actions,
      isEnabled: filter.isEnabled ? 1 : 0,
      isAiGenerated: filter.isAiGenerated ? 1 : 0,
      sortOrder,
    });
    return Number(result.lastInsertRowid);
  }

  updateFilter(filter: { id: number; name: string; conditions: string; actions: string; isEnabled: boolean; sortOrder?: number }): void {
    if (!this.db) throw new Error('Database not initialized');
    const updates = ['name = :name', 'conditions = :conditions', 'actions = :actions', 'is_enabled = :isEnabled', "updated_at = datetime('now')"];
    const params: Record<string, string | number> = {
      id: filter.id,
      name: filter.name,
      conditions: filter.conditions,
      actions: filter.actions,
      isEnabled: filter.isEnabled ? 1 : 0,
    };
    if (filter.sortOrder != null) {
      updates.push('sort_order = :sortOrder');
      params['sortOrder'] = filter.sortOrder;
    }
    this.db.prepare(`UPDATE filters SET ${updates.join(', ')} WHERE id = :id`).run(params);
  }

  deleteFilter(id: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare('DELETE FROM filters WHERE id = :id').run({ id });
  }

  toggleFilter(id: number, isEnabled: boolean): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare(
      "UPDATE filters SET is_enabled = :isEnabled, updated_at = datetime('now') WHERE id = :id"
    ).run({ id, isEnabled: isEnabled ? 1 : 0 });
  }

  // ---- Filter execution support ----

  getUnfilteredInboxEmails(accountId: number): Array<{
    id: number; xGmMsgId: string; xGmThrid: string; fromAddress: string; fromName: string;
    toAddresses: string; subject: string; textBody: string | null; htmlBody: string | null; hasAttachments: boolean;
  }> {
    if (!this.db) throw new Error('Database not initialized');
    const rows = this.db.prepare(
      `SELECT e.id, e.x_gm_msgid, e.x_gm_thrid, e.from_address, e.from_name,
        e.to_addresses, e.subject, e.text_body, e.html_body, e.has_attachments
       FROM emails e
       JOIN email_folders ef ON ef.account_id = e.account_id AND ef.x_gm_msgid = e.x_gm_msgid
       WHERE e.account_id = :accountId AND ef.folder = 'INBOX' AND e.is_filtered = 0`
    ).all({ accountId }) as Array<{
      id: number; x_gm_msgid: string; x_gm_thrid: string; from_address: string; from_name: string;
      to_addresses: string; subject: string; text_body: string | null; html_body: string | null; has_attachments: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      xGmMsgId: row.x_gm_msgid,
      xGmThrid: row.x_gm_thrid,
      fromAddress: row.from_address,
      fromName: row.from_name || '',
      toAddresses: row.to_addresses || '',
      subject: row.subject || '',
      textBody: row.text_body,
      htmlBody: row.html_body,
      hasAttachments: row.has_attachments === 1,
    }));
  }

  markEmailsAsFiltered(emailIds: number[]): void {
    if (!this.db) throw new Error('Database not initialized');
    if (emailIds.length === 0) return;

    const doMark = this.db.transaction(() => {
      const batchSize = 500;
      for (let offset = 0; offset < emailIds.length; offset += batchSize) {
        const batch = emailIds.slice(offset, offset + batchSize);
        const placeholders = batch.map((_, index) => `:eid${index}`).join(', ');
        const params: Record<string, number> = {};
        for (let index = 0; index < batch.length; index++) {
          params[`eid${index}`] = batch[index];
        }
        this.db!.prepare(
          `UPDATE emails SET is_filtered = 1, updated_at = datetime('now') WHERE id IN (${placeholders})`
        ).run(params);
      }
    });
    doMark();
  }

  getEnabledFiltersOrdered(accountId: number): Array<{
    id: number; accountId: number; name: string; conditions: string; actions: string; sortOrder: number;
  }> {
    if (!this.db) throw new Error('Database not initialized');
    const rows = this.db.prepare(
      `SELECT id, account_id, name, conditions, actions, sort_order
       FROM filters WHERE account_id = :accountId AND is_enabled = 1
       ORDER BY sort_order ASC, id ASC`
    ).all({ accountId });
    return rows.map((row) => this.mapRow<{
      id: number; accountId: number; name: string; conditions: string; actions: string; sortOrder: number;
    }>(row as Record<string, unknown>));
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

    // db.prepare() is called inside the method since the SQL is dynamic (sinceMinutes clause).
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
      params = { accountId, sinceMinutes, limit };
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
      params = { accountId, limit };
    }

    const rows = this.db.prepare(sql).all(params) as Array<{
      account_id: number;
      x_gm_msgid: string;
      x_gm_thrid: string;
    }>;
    return rows.map((row) => ({
      accountId: row.account_id,
      xGmMsgId: row.x_gm_msgid,
      xGmThrid: row.x_gm_thrid,
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
    this.db.prepare(
      `UPDATE emails
       SET text_body = :textBody,
           html_body = :htmlBody,
           updated_at = datetime('now')
       WHERE account_id = :accountId
         AND x_gm_msgid = :xGmMsgId
         AND (text_body IS NULL OR text_body = '')
         AND (html_body IS NULL OR html_body = '')`
    ).run({
      textBody: textBody || null,
      htmlBody: htmlBody || null,
      accountId,
      xGmMsgId,
    });
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
    const emailRow = this.db.prepare(
      'SELECT id FROM emails WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId'
    ).get({ accountId, xGmMsgId }) as { id: number } | undefined;
    if (emailRow === undefined) {
      log.warn(`[DB] upsertAttachmentsForEmail: email not found for account=${accountId} msgid=${xGmMsgId}`);
      return;
    }
    const emailId = emailRow.id;

    for (const att of attachments) {
      // Use INSERT OR IGNORE so that re-syncing a message doesn't duplicate attachment rows.
      // Attachment identity is determined by (email_id, filename, content_id).
      this.db.prepare(
        `INSERT OR IGNORE INTO attachments (email_id, filename, mime_type, size, content_id)
         VALUES (:emailId, :filename, :mimeType, :size, :contentId)`
      ).run({
        emailId,
        filename: att.filename,
        mimeType: att.mimeType ?? null,
        size: att.size ?? null,
        contentId: att.contentId ?? null,
      });
    }
  }

  /**
   * Get all attachment metadata rows for a given email (by xGmMsgId).
   */
  getAttachmentsForEmail(accountId: number, xGmMsgId: string): AttachmentRecord[] {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    const rows = this.db.prepare(
      `SELECT a.id, a.email_id, a.filename, a.mime_type, a.size, a.content_id, a.local_path, a.created_at
       FROM attachments a
       JOIN emails e ON e.id = a.email_id
       WHERE e.account_id = :accountId AND e.x_gm_msgid = :xGmMsgId
       ORDER BY a.id ASC`
    ).all({ accountId, xGmMsgId }) as Array<{
      id: number; email_id: number; filename: string; mime_type: string | null;
      size: number | null; content_id: string | null; local_path: string | null; created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      emailId: row.email_id,
      filename: row.filename,
      mimeType: row.mime_type,
      size: row.size,
      contentId: row.content_id,
      localPath: row.local_path,
      createdAt: row.created_at,
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
    const resultMap = new Map<string, AttachmentRecord[]>();
    if (xGmMsgIds.length === 0) {
      return resultMap;
    }

    const placeholders = xGmMsgIds.map((_, index) => `:msgid${index}`).join(', ');
    const params: Record<string, string | number> = { accountId };
    for (let index = 0; index < xGmMsgIds.length; index++) {
      params[`msgid${index}`] = xGmMsgIds[index];
    }

    const rows = this.db.prepare(
      `SELECT a.id, a.email_id, a.filename, a.mime_type, a.size, a.content_id, a.local_path, a.created_at,
              e.x_gm_msgid
       FROM attachments a
       JOIN emails e ON e.id = a.email_id
       WHERE e.account_id = :accountId AND e.x_gm_msgid IN (${placeholders})
       ORDER BY e.x_gm_msgid, a.id ASC`
    ).all(params) as Array<{
      id: number; email_id: number; filename: string; mime_type: string | null;
      size: number | null; content_id: string | null; local_path: string | null;
      created_at: string; x_gm_msgid: string;
    }>;

    for (const row of rows) {
      const xGmMsgId = row.x_gm_msgid;
      if (!resultMap.has(xGmMsgId)) {
        resultMap.set(xGmMsgId, []);
      }
      resultMap.get(xGmMsgId)!.push({
        id: row.id,
        emailId: row.email_id,
        filename: row.filename,
        mimeType: row.mime_type,
        size: row.size,
        contentId: row.content_id,
        localPath: row.local_path,
        createdAt: row.created_at,
      });
    }

    return resultMap;
  }

  /**
   * Update the local_path for a cached attachment file.
   */
  updateAttachmentLocalPath(attachmentId: number, localPath: string): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    this.db.prepare(
      'UPDATE attachments SET local_path = :localPath WHERE id = :id'
    ).run({ localPath, id: attachmentId });
  }

  /**
   * Delete all cached attachment files for an account from the DB (local_path records).
   * Used during account removal to clean up local_path references before filesystem cleanup.
   */
  clearAttachmentLocalPathsForAccount(accountId: number): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    this.db.prepare(
      `UPDATE attachments SET local_path = NULL
       WHERE email_id IN (SELECT id FROM emails WHERE account_id = :accountId)`
    ).run({ accountId });
  }

  /**
   * Get a single attachment record by its ID.
   */
  getAttachmentById(attachmentId: number): AttachmentRecord | null {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    const row = this.db.prepare(
      `SELECT id, email_id, filename, mime_type, size, content_id, local_path, created_at
       FROM attachments WHERE id = :id`
    ).get({ id: attachmentId }) as {
      id: number; email_id: number; filename: string; mime_type: string | null;
      size: number | null; content_id: string | null; local_path: string | null; created_at: string;
    } | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      id: row.id,
      emailId: row.email_id,
      filename: row.filename,
      mimeType: row.mime_type,
      size: row.size,
      contentId: row.content_id,
      localPath: row.local_path,
      createdAt: row.created_at,
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
    const row = this.db.prepare(
      `SELECT e.x_gm_msgid, e.account_id
       FROM attachments a
       JOIN emails e ON e.id = a.email_id
       WHERE a.id = :attachmentId`
    ).get({ attachmentId }) as { x_gm_msgid: string; account_id: number } | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      xGmMsgId: row.x_gm_msgid,
      accountId: row.account_id,
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

    const rows = this.db.prepare(
      'SELECT x_gm_msgid FROM vector_indexed_emails WHERE account_id = :accountId'
    ).all({ accountId }) as Array<{ x_gm_msgid: string }>;

    const indexed = new Set<string>();
    for (const row of rows) {
      if (typeof row.x_gm_msgid === 'string') {
        indexed.add(row.x_gm_msgid);
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
      const params: Record<string, number | string> = { accountId };
      for (let index = 0; index < chunk.length; index++) {
        params[`msgId${index}`] = chunk[index];
      }

      const rows = this.db.prepare(
        `SELECT x_gm_msgid FROM vector_indexed_emails
         WHERE account_id = :accountId AND x_gm_msgid IN (${placeholders})`
      ).all(params) as Array<{ x_gm_msgid: string }>;

      for (const row of rows) {
        if (typeof row.x_gm_msgid === 'string') {
          indexed.add(row.x_gm_msgid);
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

    const doBatchInsert = this.db.transaction(() => {
      for (const record of records) {
        this.db!.prepare(
          `INSERT OR REPLACE INTO vector_indexed_emails (x_gm_msgid, account_id, embedding_hash)
           VALUES (:xGmMsgId, :accountId, :embeddingHash)`
        ).run({
          xGmMsgId: record.xGmMsgId,
          accountId,
          embeddingHash: record.embeddingHash,
        });
      }

      // Atomically update the resume cursor if provided
      if (cursorUid !== undefined) {
        this.db!.prepare(
          `INSERT INTO embedding_crawl_progress (account_id, last_uid, build_interrupted, updated_at)
           VALUES (:accountId, :lastUid, 0, datetime('now'))
           ON CONFLICT(account_id) DO UPDATE SET
             last_uid   = excluded.last_uid,
             updated_at = excluded.updated_at`
        ).run({ accountId, lastUid: cursorUid });
      }
    });
    doBatchInsert();
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

    const row = this.db.prepare(
      'SELECT COUNT(*) AS cnt FROM vector_indexed_emails WHERE account_id = :accountId'
    ).get({ accountId }) as { cnt: number } | undefined;

    return row?.cnt ?? 0;
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

    this.db.prepare(
      'DELETE FROM vector_indexed_emails WHERE account_id = :accountId'
    ).run({ accountId });

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

    this.db.prepare('DELETE FROM vector_indexed_emails').run();

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

    const row = this.db.prepare(
      'SELECT last_uid FROM embedding_crawl_progress WHERE account_id = :accountId'
    ).get({ accountId }) as { last_uid: number } | undefined;

    if (row === undefined) {
      return 0;
    }
    return row.last_uid;
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

    this.db.prepare(
      `INSERT INTO embedding_crawl_progress (account_id, last_uid, build_interrupted, updated_at)
       VALUES (:accountId, :lastUid, 0, datetime('now'))
       ON CONFLICT(account_id) DO UPDATE SET
         last_uid   = excluded.last_uid,
         updated_at = excluded.updated_at`
    ).run({ accountId, lastUid });
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
    this.db.prepare(
      `INSERT INTO embedding_crawl_progress (account_id, last_uid, build_interrupted, updated_at)
       VALUES (:accountId, 0, :interrupted, datetime('now'))
       ON CONFLICT(account_id) DO UPDATE SET
         build_interrupted = excluded.build_interrupted,
         updated_at        = excluded.updated_at`
    ).run({ accountId, interrupted: interruptedValue });
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

    const rows = this.db.prepare(
      'SELECT account_id FROM embedding_crawl_progress WHERE build_interrupted = 1'
    ).all() as Array<{ account_id: number }>;

    return rows.map((row) => row.account_id);
  }

  /**
   * Delete the embedding crawl progress row for a specific account.
   * Called on UID-renumbering detection (cursor reset) or when the embedding model changes.
   * Not called on normal build completion — the cursor is preserved after a successful build
   * so that "Check for new emails to index" can use searchUidsAfter(cursor) instead of
   * searchAllUids(), fetching only newly-arrived UIDs.
   *
   * @param accountId - Account ID to clear progress for
   */
  clearEmbeddingCrawlProgress(accountId: number): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    this.db.prepare(
      'DELETE FROM embedding_crawl_progress WHERE account_id = :accountId'
    ).run({ accountId });
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

    this.db.prepare('DELETE FROM embedding_crawl_progress').run();

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
    fromAddress: string;
    toAddresses: string;
    isSentFolder: boolean;
    textBody: string | null;
    htmlBody: string | null;
  }> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const trashFolder = this.getTrashFolder(accountId);
    const sentFolder = '[Gmail]/Sent Mail';
    const rows = this.db.prepare(
      `SELECT e.x_gm_msgid, e.account_id, e.subject, e.from_address, e.to_addresses, e.text_body, e.html_body,
              EXISTS (
                SELECT 1 FROM email_folders ef_sent
                WHERE ef_sent.account_id = e.account_id
                  AND ef_sent.x_gm_msgid = e.x_gm_msgid
                  AND ef_sent.folder = :sentFolder
              ) AS is_sent_folder
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
       LIMIT :batchSize`
    ).all({
        accountId,
        batchSize,
        trashFolder,
        sentFolder,
        spamFolder: '[Gmail]/Spam',
        draftsFolder: '[Gmail]/Drafts',
      }) as Array<{
        x_gm_msgid: string;
        account_id: number;
        subject: string;
        from_address: string | null;
        to_addresses: string | null;
        text_body: string | null;
        html_body: string | null;
        is_sent_folder: number;
      }>;

    return rows.map((row) => ({
      xGmMsgId: row.x_gm_msgid,
      accountId: row.account_id,
      subject: row.subject || '',
      fromAddress: row.from_address || '',
      toAddresses: row.to_addresses || '',
      isSentFolder: row.is_sent_folder === 1,
      textBody: row.text_body,
      htmlBody: row.html_body,
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

    const params: Record<string, number | string> = { accountId };
    for (let index = 0; index < uniqueIds.length; index++) {
      params[`msgId${index}`] = uniqueIds[index];
    }
    for (let index = 0; index < excludedFolders.length; index++) {
      params[`excludedFolder${index}`] = excludedFolders[index];
    }

    // Select x_gm_msgid values that have at least one folder NOT in the excluded list
    const sql = `
      SELECT DISTINCT ef.x_gm_msgid
      FROM email_folders ef
      WHERE ef.account_id = :accountId
        AND ef.x_gm_msgid IN (${msgIdPlaceholders})
        AND ef.folder NOT IN (${folderPlaceholders})
    `;

    const rows = this.db.prepare(sql).all(params) as Array<{ x_gm_msgid: string }>;
    const included = new Set<string>();
    for (const row of rows) {
      if (typeof row.x_gm_msgid === 'string') {
        included.add(row.x_gm_msgid);
      }
    }
    return included;
  }

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
      const params: Record<string, number | string> = { accountId };
      for (let index = 0; index < chunk.length; index++) {
        params[`msgId${offset + index}`] = chunk[index];
      }

      const rows = this.db.prepare(
        `SELECT DISTINCT x_gm_msgid FROM email_folders WHERE account_id = :accountId AND x_gm_msgid IN (${placeholders})`
      ).all(params) as Array<{ x_gm_msgid: string }>;

      for (const row of rows) {
        if (typeof row.x_gm_msgid === 'string') {
          hasFolder.add(row.x_gm_msgid);
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
      accountId,
      limit: uniqueIds.length,
      trashFolder: this.getTrashFolder(accountId),
    };
    for (let index = 0; index < uniqueIds.length; index++) {
      params[`msgId${index}`] = uniqueIds[index];
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

    const rows = this.db.prepare(sql).all(params);
    const mappedRows = rows.map((row) => this.mapRow<Record<string, unknown>>(row as Record<string, unknown>));

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
    const threadIds = mappedRows.map((row) => row['xGmThrid'] as string);
    const threadMsgIdMap = this.getFirstMatchingMsgIdForThreads(accountId, threadIds, uniqueIds);

    const rankedRows = mappedRows.map((row) => {
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

    const params: Record<string, number | string> = { accountId };
    for (let index = 0; index < xGmThrids.length; index++) {
      params[`thrid${index}`] = xGmThrids[index];
    }
    for (let index = 0; index < candidateMsgIds.length; index++) {
      params[`cand${index}`] = candidateMsgIds[index];
    }

    const sql = `
      SELECT x_gm_thrid, x_gm_msgid
      FROM emails
      WHERE account_id = :accountId
        AND x_gm_thrid IN (${thridPlaceholders})
        AND x_gm_msgid IN (${msgIdPlaceholders})
    `;

    const rows = this.db.prepare(sql).all(params) as Array<{ x_gm_thrid: string; x_gm_msgid: string }>;

    // For each thread, keep track of the best-ranked (lowest index) matching msgId
    const msgIdToRank = new Map<string, number>();
    for (let index = 0; index < candidateMsgIds.length; index++) {
      msgIdToRank.set(candidateMsgIds[index], index);
    }

    const threadBestMap = new Map<string, { msgId: string; rank: number }>();
    for (const row of rows) {
      const thrid = row.x_gm_thrid;
      const msgId = row.x_gm_msgid;
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
   * Given a list of x_gm_msgid values, return the subset that can be resolved
   * fully from the local database for a given account.
   *
   * A message is considered locally resolvable only when BOTH of these exist:
   *   1. an `emails` row for the x_gm_msgid
   *   2. the corresponding `threads` row for that email's x_gm_thrid
   *
   * Semantic search streams x_gm_msgid values first, then the renderer resolves
   * them through `mail:search-by-msgids`, which joins emails → threads. If an
   * email row exists but its thread row is missing, treating it as "local" would
   * emit a dead result that later resolves to zero threads in the UI. Such IDs
   * must therefore be treated as needing IMAP restoration instead.
   *
   * Handles large lists by chunking into batches of 500.
   *
   * @param accountId - Account ID to scope the query
   * @param xGmMsgIds - Candidate message IDs to check
   * @returns Set of x_gm_msgid values that are fully resolvable locally
   */
  getResolvableEmailsExistingInLocalDb(accountId: number, xGmMsgIds: string[]): Set<string> {
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
      const params: Record<string, number | string> = { accountId };
      for (let index = 0; index < chunk.length; index++) {
        params[`msgId${offset + index}`] = chunk[index];
      }

      const rows = this.db.prepare(
        `SELECT e.x_gm_msgid
         FROM emails e
         INNER JOIN threads t
           ON t.account_id = e.account_id
          AND t.x_gm_thrid = e.x_gm_thrid
         WHERE e.account_id = :accountId
           AND e.x_gm_msgid IN (${placeholders})`
      ).all(params) as Array<{ x_gm_msgid: string }>;

      for (const row of rows) {
        if (typeof row.x_gm_msgid === 'string') {
          existing.add(row.x_gm_msgid);
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
   * When rawLabels is provided, email_folders and thread_folders are populated for each
   * label; UIDs are left NULL (envelope-only fetch does not provide per-folder UIDs).
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
    /** Optional Gmail label paths (e.g. '[Gmail]/Inbox') — when set, email_folders and thread_folders are populated. */
    rawLabels?: string[];
    /** Optional All Mail UID — when set, an email_folders row is written for All Mail with this UID. */
    uid?: number;
  }): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    // Upsert the email row (no body fields — NULL body fields are preserved on conflict
    // via COALESCE(NULLIF(excluded.text_body, ''), text_body) logic in upsertEmail).
    // We use a direct INSERT OR IGNORE here to avoid overwriting an existing full body.
    this.db.prepare(
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
         updated_at = datetime('now')`
    ).run({
      accountId,
      xGmMsgId: envelope.xGmMsgId,
      xGmThrid: envelope.xGmThrid,
      messageId: envelope.messageId || null,
      fromAddress: envelope.fromAddress,
      fromName: envelope.fromName || '',
      toAddresses: envelope.toAddresses,
      subject: envelope.subject || '',
      date: envelope.date,
      isRead: envelope.isRead ? 1 : 0,
      isStarred: envelope.isStarred ? 1 : 0,
      isDraft: envelope.isDraft ? 1 : 0,
      size: envelope.size || 0,
    });

    // Upsert a thread row if it doesn't already exist.
    this.db.prepare(
      `INSERT INTO threads (account_id, x_gm_thrid, subject, last_message_date, participants, message_count, snippet, is_read, is_starred)
       VALUES (:accountId, :xGmThrid, :subject, :lastMessageDate, :participants, 1, '', :isRead, :isStarred)
       ON CONFLICT(account_id, x_gm_thrid) DO NOTHING`
    ).run({
      accountId,
      xGmThrid: envelope.xGmThrid,
      subject: envelope.subject || '',
      lastMessageDate: envelope.date,
      participants: envelope.fromAddress,
      isRead: envelope.isRead ? 1 : 0,
      isStarred: envelope.isStarred ? 1 : 0,
    });

    // Insert folder links when rawLabels are provided (envelope-only fetch has no UIDs).
    // [Gmail]/All Mail is skipped in the loop below — All Mail is handled separately via the uid field.
    if (envelope.rawLabels && envelope.rawLabels.length > 0) {
      for (const folder of envelope.rawLabels) {
        if (folder === ALL_MAIL_PATH) {
          continue;
        }
        this.db.prepare(
          'INSERT OR IGNORE INTO email_folders (account_id, x_gm_msgid, folder) VALUES (:accountId, :xGmMsgId, :folder)'
        ).run({ accountId, xGmMsgId: envelope.xGmMsgId, folder });
        this.db.prepare(
          'INSERT OR IGNORE INTO thread_folders (account_id, x_gm_thrid, folder) VALUES (:accountId, :xGmThrid, :folder)'
        ).run({ accountId, xGmThrid: envelope.xGmThrid, folder });
      }
    }

    // Write All Mail email_folders row with UID when provided.
    // Uses ON CONFLICT DO UPDATE so the UID is always stamped (not silently skipped).
    if (envelope.uid !== undefined && envelope.uid !== null) {
      this.db.prepare(`
        INSERT INTO email_folders (account_id, x_gm_msgid, folder, uid)
        VALUES (:accountId, :xGmMsgId, :folder, :uid)
        ON CONFLICT(account_id, x_gm_msgid, folder) DO UPDATE SET uid = excluded.uid
      `).run({
        accountId,
        xGmMsgId: envelope.xGmMsgId,
        folder: ALL_MAIL_PATH,
        uid: envelope.uid
      });
    }
  }

  /**
   * Batch-upsert email envelope metadata for multiple emails in a single transaction.
   *
   * Wraps multiple `upsertEmailFromEnvelope()` calls in one `db.transaction()` block
   * for atomicity and performance. Used by the embedding build crawl to ensure every
   * non-filtered crawled email has a row in the `emails` table (avoiding blank AI chat cards).
   *
   * Callers MUST NOT pass `rawLabels` — omitting rawLabels prevents email_folders /
   * thread_folders rows from being created for visible folders with NULL UIDs, which would
   * make incomplete envelope-only emails appear in the normal mail UI. Pass `uid` only to
   * create the All Mail email_folders link with the correct UID.
   *
   * @param envelopes - Array of envelope objects. Each must include `accountId`.
   *                    `rawLabels` must not be set (excluded from this type by design).
   */
  batchUpsertEmailEnvelopes(
    envelopes: Array<{
      accountId: number;
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
      uid?: number;
    }>
  ): void {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    if (envelopes.length === 0) {
      return;
    }

    const doUpsert = this.db.transaction(() => {
      for (const envelope of envelopes) {
        const { accountId, ...envelopeFields } = envelope;
        this.upsertEmailFromEnvelope(accountId, envelopeFields);
      }
    });
    doUpsert();
  }

  // ---- Structured filter methods ----

  /**
   * Given a set of x_gm_msgid values and structured filters, returns the
   * subset of those message IDs that match all filter conditions in the local
   * emails table, plus an "uncertain" set of IDs that exist locally but only
   * have a `[Gmail]/All Mail` folder association — meaning folder/attachment
   * filters cannot be reliably evaluated locally.
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
   * @returns matched: IDs that passed all DB filters;
   *          uncertain: IDs that exist locally but only have All Mail association
   *          and could not be reliably filtered for folder/attachment constraints.
   */
  filterEmailsByMsgIds(
    accountId: number,
    xGmMsgIds: string[],
    filters: SemanticSearchFilters
  ): FilterMsgIdsResult {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    if (xGmMsgIds.length === 0) {
      return { matched: new Set<string>(), uncertain: new Set<string>() };
    }

    // Note: we no longer short-circuit when no filters are provided, because we
    // always need to exclude Drafts folder emails regardless of other filters.

    const matchingIds = new Set<string>();
    const CHUNK_SIZE = 500;

    const needsFolderJoin = filters.folder !== undefined;

    const filterClauses: string[] = [
      // Always exclude emails that exist in the Drafts folder
      `AND NOT EXISTS (
         SELECT 1 FROM email_folders ef_draft
         WHERE ef_draft.account_id = e.account_id
           AND ef_draft.x_gm_msgid = e.x_gm_msgid
           AND ef_draft.folder = '[Gmail]/Drafts'
       )`,

    ];
    const filterParams: Record<string, string | number> = {};

    if (filters.dateFrom !== undefined) {
      filterClauses.push('AND e.date >= :dateFrom');
      filterParams['dateFrom'] = filters.dateFrom;
    }

    if (filters.dateTo !== undefined) {
      // dateTo is the exclusive upper bound (start of the day after the target date, in UTC).
      // This is set by the caller when normalizing local calendar dates to UTC timestamps.
      filterClauses.push('AND e.date < :dateTo');
      filterParams['dateTo'] = filters.dateTo;
    }

    if (filters.folder !== undefined) {
      filterClauses.push('AND ef.folder = :folder');
      filterParams['folder'] = filters.folder;
    }

    if (filters.sender !== undefined) {
      filterClauses.push(
        'AND (e.from_address LIKE :senderPattern OR e.from_name LIKE :senderPattern)'
      );
      filterParams['senderPattern'] = `%${filters.sender}%`;
    }

    if (filters.recipient !== undefined) {
      filterClauses.push('AND e.to_addresses LIKE :recipientPattern');
      filterParams['recipientPattern'] = `%${filters.recipient}%`;
    }

    if (filters.hasAttachment !== undefined) {
      filterClauses.push('AND e.has_attachments = :hasAttachment');
      filterParams['hasAttachment'] = filters.hasAttachment ? 1 : 0;
    }

    if (filters.isRead !== undefined) {
      filterClauses.push('AND e.is_read = :isRead');
      filterParams['isRead'] = filters.isRead ? 1 : 0;
    }

    if (filters.isStarred !== undefined) {
      filterClauses.push('AND e.is_starred = :isStarred');
      filterParams['isStarred'] = filters.isStarred ? 1 : 0;
    }

    const joinClause = needsFolderJoin
      ? 'JOIN email_folders ef ON ef.account_id = e.account_id AND ef.x_gm_msgid = e.x_gm_msgid'
      : '';

    const filterClausesSql = filterClauses.join('\n     ');

    // Determine whether we need to detect All-Mail-only candidates.
    // This is only relevant when folder or hasAttachment filters are active,
    // because those are the filters that cannot be reliably evaluated when the
    // email's only folder association is [Gmail]/All Mail (written by the
    // embedding crawl pipeline).
    const needsUncertainDetection =
      filters.folder !== undefined || filters.hasAttachment !== undefined;
    const uncertainIds = new Set<string>();

    try {
      for (let offset = 0; offset < xGmMsgIds.length; offset += CHUNK_SIZE) {
        const chunk = xGmMsgIds.slice(offset, offset + CHUNK_SIZE);
        const placeholders = chunk
          .map((_, index) => `:msgId${offset + index}`)
          .join(', ');

        const params: Record<string, string | number> = {
          accountId,
          ...filterParams,
        };

        for (let index = 0; index < chunk.length; index++) {
          params[`msgId${offset + index}`] = chunk[index];
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

        const rows = this.db.prepare(sql).all(params) as Array<{ x_gm_msgid: string }>;

        for (const row of rows) {
          if (typeof row.x_gm_msgid === 'string') {
            matchingIds.add(row.x_gm_msgid);
          }
        }

        // Detect All-Mail-only candidates: emails that exist in the input list,
        // are present in the local DB, but have NO folder association other than
        // [Gmail]/All Mail and are NOT in Drafts. These candidates cannot be
        // reliably filtered locally for folder/attachment constraints and should
        // be sent to IMAP for verification.
        if (needsUncertainDetection) {
          const uncertainParams: Record<string, string | number> = {
            accountId,
            allMailPath: ALL_MAIL_PATH,
          };
          for (let index = 0; index < chunk.length; index++) {
            uncertainParams[`msgId${offset + index}`] = chunk[index];
          }

          const uncertainSql = [
            'SELECT DISTINCT e.x_gm_msgid',
            'FROM emails e',
            'WHERE e.account_id = :accountId',
            `  AND e.x_gm_msgid IN (${placeholders})`,
            `  AND NOT EXISTS (
               SELECT 1 FROM email_folders ef_other
               WHERE ef_other.account_id = e.account_id
                 AND ef_other.x_gm_msgid = e.x_gm_msgid
                 AND ef_other.folder != :allMailPath
             )`,
            `  AND NOT EXISTS (
               SELECT 1 FROM email_folders ef_draft
               WHERE ef_draft.account_id = e.account_id
                 AND ef_draft.x_gm_msgid = e.x_gm_msgid
                 AND ef_draft.folder = '[Gmail]/Drafts'
             )`,
          ].join('\n');

          const uncertainRows = this.db.prepare(uncertainSql).all(uncertainParams) as Array<{ x_gm_msgid: string }>;

          for (const row of uncertainRows) {
            if (typeof row.x_gm_msgid === 'string') {
              uncertainIds.add(row.x_gm_msgid);
            }
          }
        }
      }
    } catch (error) {
      log.error('filterEmailsByMsgIds: query failed', error);
      return { matched: new Set<string>(), uncertain: new Set<string>() };
    }

    // Remove uncertain IDs from matched — they should not appear in both sets.
    for (const uncertainId of uncertainIds) {
      matchingIds.delete(uncertainId);
    }

    return { matched: matchingIds, uncertain: uncertainIds };
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

        const params: Record<string, string | number> = { accountId };
        for (let index = 0; index < chunk.length; index++) {
          params[`msgId${offset + index}`] = chunk[index];
        }

        const rows = this.db.prepare(
          `SELECT e.x_gm_msgid, e.date
           FROM emails e
           WHERE e.account_id = :accountId
             AND e.x_gm_msgid IN (${placeholders})`
        ).all(params) as Array<{ x_gm_msgid: string; date: string }>;

        for (const row of rows) {
          if (typeof row.x_gm_msgid === 'string' && typeof row.date === 'string') {
            dateMap.set(row.x_gm_msgid, row.date);
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
      this.db.close();
      this.db = null;
      log.info('Database closed');
    }
  }
}
