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

    // Run schema creation (creates tables if they don't exist)
    this.db.run(CREATE_TABLES_SQL);

    // Determine current schema version (handles legacy DBs missing schema_version rows)
    let currentVersion = 0;
    try {
      const result = this.db.exec('SELECT version FROM schema_version LIMIT 1');
      if (result.length > 0 && result[0].values.length > 0) {
        currentVersion = (result[0].values[0][0] as number) || 0;
      }
    } catch {
      // schema_version table may not exist in very old DBs — CREATE_TABLES_SQL just created it
      currentVersion = 0;
    }

    if (currentVersion === 0) {
      // Fresh DB or legacy DB that never had a version row.
      // Check if the old emails schema (with folder column) exists and needs migration.
      const colCheck = this.db.exec("PRAGMA table_info(emails)");
      const hasFolder = colCheck.length > 0 && colCheck[0].values.some(
        (row) => (row[1] as string) === 'folder'
      );

      if (hasFolder) {
        // Legacy DB with old schema — treat as version 1 so migration runs
        currentVersion = 1;
      } else {
        // Truly fresh DB — schema is already v2 from CREATE_TABLES_SQL
        currentVersion = SCHEMA_VERSION;
      }
    }

    // Run migrations
    if (currentVersion < 2) {
      this.migrateV1toV2();
    } else {
      // Safety: if version claims v2 but the emails table still has a folder column
      // (e.g. a previous migration attempt failed or was incomplete), re-run.
      const colCheck = this.db.exec("PRAGMA table_info(emails)");
      const hasFolder = colCheck.length > 0 && colCheck[0].values.some(
        (row) => (row[1] as string) === 'folder'
      );
      if (hasFolder) {
        log.warn('Schema version is 2 but emails table still has folder column — re-running migration');
        this.migrateV1toV2();
      }
    }

    // Normalize legacy empty-string bodies to NULL so COALESCE works correctly
    this.db.run("UPDATE emails SET text_body = NULL WHERE text_body = ''");
    this.db.run("UPDATE emails SET html_body = NULL WHERE html_body = ''");

    // Ensure version row exists and is up to date
    this.db.run('DELETE FROM schema_version');
    this.db.run('INSERT INTO schema_version (version) VALUES (?)', [SCHEMA_VERSION]);
    log.info(`Database schema version set to ${SCHEMA_VERSION}`);

    // Save to disk
    this.saveToDisk();

    log.info('Database schema initialized');
  }

  /**
   * Migrate from schema v1 (emails has folder column, duplicated rows) to v2
   * (one row per message, email_folders link table).
   */
  private migrateV1toV2(): void {
    if (!this.db) throw new Error('Database not initialized');
    log.info('Running migration v1 → v2: email_folders link table');

    // Disable foreign keys during migration so DROP TABLE doesn't CASCADE-delete
    // rows in email_folders that we just populated.
    this.db.run('PRAGMA foreign_keys = OFF');

    // 1. Drop email_folders if it was created by CREATE_TABLES_SQL before migration
    //    (it would reference the old emails table and would be empty anyway).
    this.db.run('DROP TABLE IF EXISTS email_folders');

    // 2. Create emails_new with the v2 schema (no folder, unique on account+message)
    this.db.run('DROP TABLE IF EXISTS emails_new');
    this.db.run(`
      CREATE TABLE emails_new (
        id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL,
        gmail_message_id TEXT NOT NULL,
        gmail_thread_id TEXT NOT NULL,
        from_address TEXT NOT NULL,
        from_name TEXT,
        to_addresses TEXT NOT NULL,
        cc_addresses TEXT,
        bcc_addresses TEXT,
        subject TEXT,
        text_body TEXT,
        html_body TEXT,
        date TEXT NOT NULL,
        is_read INTEGER NOT NULL DEFAULT 0,
        is_starred INTEGER NOT NULL DEFAULT 0,
        is_important INTEGER NOT NULL DEFAULT 0,
        snippet TEXT,
        size INTEGER,
        has_attachments INTEGER NOT NULL DEFAULT 0,
        labels TEXT,
        raw_headers TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        UNIQUE(account_id, gmail_message_id)
      )
    `);

    // 3. Create email_folders fresh (will reference emails_new after rename)
    this.db.run(`
      CREATE TABLE email_folders (
        id INTEGER PRIMARY KEY,
        email_id INTEGER NOT NULL,
        account_id INTEGER NOT NULL,
        folder TEXT NOT NULL,
        UNIQUE(email_id, folder)
      )
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_email_folders_account_folder ON email_folders(account_id, folder)');

    // 4. For each group of duplicate rows, pick the canonical one (prefer body present)
    //    and insert into emails_new, keeping the original id.
    //    Use char(31) (unit separator) for folders so folder names containing commas are not split.
    const groups = this.db.exec(`
      SELECT account_id, gmail_message_id,
        GROUP_CONCAT(id) AS ids,
        GROUP_CONCAT(folder, char(31)) AS folders
      FROM emails
      GROUP BY account_id, gmail_message_id
    `);

    const FOLDER_SEP = '\u001F'; // must match char(31) used in GROUP_CONCAT
    if (groups.length > 0) {
      for (const row of groups[0].values) {
        const accountId = row[0] as number;
        const gmailMessageId = row[1] as string;
        const ids = (row[2] as string).split(',').map(Number);
        const folders = (row[3] as string).split(FOLDER_SEP);

        // Pick canonical: prefer a row that has body content
        const candidates = this.db.exec(`
          SELECT id FROM emails
          WHERE account_id = ? AND gmail_message_id = ?
          ORDER BY (CASE WHEN COALESCE(html_body, '') != '' OR COALESCE(text_body, '') != '' THEN 0 ELSE 1 END), id ASC
          LIMIT 1
        `, [accountId, gmailMessageId]);

        const canonicalId = candidates[0].values[0][0] as number;

        // Insert canonical row into emails_new (keeping its id)
        this.db.run(`
          INSERT OR IGNORE INTO emails_new (id, account_id, gmail_message_id, gmail_thread_id,
            from_address, from_name, to_addresses, cc_addresses, bcc_addresses,
            subject, text_body, html_body, date, is_read, is_starred, is_important,
            snippet, size, has_attachments, labels, raw_headers, created_at)
          SELECT id, account_id, gmail_message_id, gmail_thread_id,
            from_address, from_name, to_addresses, cc_addresses, bcc_addresses,
            subject, text_body, html_body, date, is_read, is_starred, is_important,
            snippet, size, has_attachments, labels, raw_headers, created_at
          FROM emails WHERE id = ?
        `, [canonicalId]);

        // Insert folder links for all folders this message appeared in
        for (const folder of folders) {
          this.db.run(
            'INSERT OR IGNORE INTO email_folders (email_id, account_id, folder) VALUES (?, ?, ?)',
            [canonicalId, accountId, folder.trim()]
          );
        }

        // Reassign attachments and search_index from non-canonical rows to canonical
        for (const oldId of ids) {
          if (oldId !== canonicalId) {
            this.db.run('UPDATE attachments SET email_id = ? WHERE email_id = ?', [canonicalId, oldId]);
            this.db.run('UPDATE search_index SET email_id = ? WHERE email_id = ?', [canonicalId, oldId]);
          }
        }
      }
    }

    // 5. Swap tables
    this.db.run('DROP TABLE emails');
    this.db.run('ALTER TABLE emails_new RENAME TO emails');

    // 6. Recreate indexes on the new emails table
    this.db.run('CREATE INDEX IF NOT EXISTS idx_emails_account_thread ON emails(account_id, gmail_thread_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date DESC)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_emails_from ON emails(from_address)');

    // 7. Now add the FK constraint to email_folders by recreating it properly
    //    (SQLite doesn't support ALTER TABLE ADD CONSTRAINT, but we just created
    //    email_folders without the FK to avoid CASCADE issues during migration.
    //    Recreate it with the FK now that emails points to the correct table.)
    this.db.run(`
      CREATE TABLE email_folders_new (
        id INTEGER PRIMARY KEY,
        email_id INTEGER NOT NULL,
        account_id INTEGER NOT NULL,
        folder TEXT NOT NULL,
        FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE,
        UNIQUE(email_id, folder)
      )
    `);
    this.db.run('INSERT INTO email_folders_new SELECT * FROM email_folders');
    this.db.run('DROP TABLE email_folders');
    this.db.run('ALTER TABLE email_folders_new RENAME TO email_folders');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_email_folders_account_folder ON email_folders(account_id, folder)');

    // Re-enable foreign keys
    this.db.run('PRAGMA foreign_keys = ON');

    log.info('Migration v1 → v2 complete');
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
    // Upsert the single email row (no folder in the emails table).
    // Pass NULL (not '') for empty bodies so COALESCE preserves existing body on update.
    this.db.run(
      `INSERT INTO emails (account_id, gmail_message_id, gmail_thread_id, from_address, from_name,
        to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body, date,
        is_read, is_starred, is_important, snippet, size, has_attachments, labels)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, gmail_message_id) DO UPDATE SET
        from_address = excluded.from_address, from_name = excluded.from_name,
        to_addresses = excluded.to_addresses, cc_addresses = excluded.cc_addresses, bcc_addresses = excluded.bcc_addresses,
        subject = excluded.subject,
        text_body = COALESCE(NULLIF(excluded.text_body, ''), text_body),
        html_body = COALESCE(NULLIF(excluded.html_body, ''), html_body),
        date = excluded.date,
        is_read = excluded.is_read, is_starred = excluded.is_starred, is_important = excluded.is_important,
        snippet = excluded.snippet, size = excluded.size, has_attachments = excluded.has_attachments,
        labels = excluded.labels`,
      [
        email.accountId, email.gmailMessageId, email.gmailThreadId,
        email.fromAddress, email.fromName || '', email.toAddresses,
        email.ccAddresses || '', email.bccAddresses || '', email.subject || '',
        email.textBody || null, email.htmlBody || null, email.date,
        email.isRead ? 1 : 0, email.isStarred ? 1 : 0, email.isImportant ? 1 : 0,
        email.snippet || '', email.size || 0, email.hasAttachments ? 1 : 0,
        email.labels || '',
      ]
    );

    // Retrieve the actual id (last_insert_rowid is unreliable after ON CONFLICT)
    const result = this.db.exec(
      'SELECT id FROM emails WHERE account_id = ? AND gmail_message_id = ?',
      [email.accountId, email.gmailMessageId]
    );
    const id = result[0].values[0][0] as number;

    // Record folder association in the link table
    this.db.run(
      'INSERT OR IGNORE INTO email_folders (email_id, account_id, folder) VALUES (?, ?, ?)',
      [id, email.accountId, email.folder]
    );

    this.scheduleSave();
    return id;
  }

  getEmailsByThreadId(accountId: number, gmailThreadId: string): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, gmail_message_id, gmail_thread_id, from_address, from_name,
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
      `SELECT id, account_id, gmail_message_id, gmail_thread_id, from_address, from_name,
        to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body, snippet, date,
        is_read, is_starred, is_important, size, has_attachments, labels
       FROM emails WHERE id = ?`,
      [id]
    );
    if (result.length === 0 || result[0].values.length === 0) return null;
    return this.mapEmailRow(result[0].values[0], result[0].columns);
  }

  getEmailByGmailMessageId(accountId: number, gmailMessageId: string): Record<string, unknown> | null {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, gmail_message_id, gmail_thread_id, from_address, from_name,
        to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body, snippet, date,
        is_read, is_starred, is_important, size, has_attachments, labels
       FROM emails WHERE account_id = ? AND gmail_message_id = ? LIMIT 1`,
      [accountId, gmailMessageId]
    );
    if (result.length === 0 || result[0].values.length === 0) return null;
    return this.mapEmailRow(result[0].values[0], result[0].columns);
  }

  /** Get all folders an email appears in (via the email_folders link table). */
  getFoldersForEmail(accountId: number, gmailMessageId: string): string[] {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT ef.folder FROM email_folders ef
       JOIN emails e ON e.id = ef.email_id
       WHERE e.account_id = ? AND e.gmail_message_id = ?`,
      [accountId, gmailMessageId]
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => row[0] as string);
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
    // last_insert_rowid() is only reliable for INSERT, not ON CONFLICT UPDATE.
    // Query the actual ID to handle both cases.
    const result = this.db.exec(
      'SELECT id FROM threads WHERE account_id = ? AND gmail_thread_id = ?',
      [thread.accountId, thread.gmailThreadId]
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
      `SELECT t.id, t.account_id, t.gmail_thread_id, t.subject, t.last_message_date, t.participants,
        t.message_count, t.snippet, tf.folder, t.is_read, t.is_starred
       FROM threads t
       INNER JOIN thread_folders tf ON t.id = tf.thread_id
       WHERE t.account_id = ? AND tf.folder = ?
       ORDER BY t.last_message_date DESC LIMIT ? OFFSET ?`,
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

  /** Associate a thread with a folder (many-to-many). */
  upsertThreadFolder(threadId: number, accountId: number, folder: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      `INSERT OR IGNORE INTO thread_folders (thread_id, account_id, folder)
       VALUES (?, ?, ?)`,
      [threadId, accountId, folder]
    );
    // No scheduleSave here — the caller (SyncService) batches saves via upsertThread.
  }

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
      `SELECT e.id, e.account_id, e.gmail_message_id, e.gmail_thread_id,
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

  // ---- Draft operations ----

  saveDraft(draft: {
    id?: number;
    accountId: number;
    gmailThreadId?: string;
    subject: string;
    to: string;
    cc: string;
    bcc: string;
    htmlBody: string;
    textBody: string;
    inReplyTo?: string;
    references?: string;
    attachmentsJson?: string;
    signature?: string;
  }): number {
    if (!this.db) throw new Error('Database not initialized');
    if (draft.id) {
      this.db.run(
        `UPDATE drafts SET subject = ?, to_addresses = ?, cc_addresses = ?, bcc_addresses = ?,
         html_body = ?, text_body = ?, in_reply_to = ?, "references" = ?,
         attachments_json = ?, signature = ?, updated_at = datetime('now')
         WHERE id = ?`,
        [draft.subject, draft.to, draft.cc, draft.bcc, draft.htmlBody, draft.textBody,
         draft.inReplyTo || null, draft.references || null, draft.attachmentsJson || null,
         draft.signature || null, draft.id]
      );
      this.scheduleSave();
      return draft.id;
    }
    this.db.run(
      `INSERT INTO drafts (account_id, gmail_thread_id, subject, to_addresses, cc_addresses,
       bcc_addresses, html_body, text_body, in_reply_to, "references", attachments_json, signature)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [draft.accountId, draft.gmailThreadId || null, draft.subject, draft.to, draft.cc, draft.bcc,
       draft.htmlBody, draft.textBody, draft.inReplyTo || null, draft.references || null,
       draft.attachmentsJson || null, draft.signature || null]
    );
    const result = this.db.exec('SELECT last_insert_rowid()');
    const id = result[0].values[0][0] as number;
    this.scheduleSave();
    return id;
  }

  getDraftsByAccount(accountId: number): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, gmail_thread_id, subject, to_addresses, cc_addresses,
       bcc_addresses, html_body, text_body, in_reply_to, "references",
       attachments_json, signature, created_at, updated_at
       FROM drafts WHERE account_id = ? ORDER BY updated_at DESC`,
      [accountId]
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => this.mapGenericRow(row, result[0].columns));
  }

  getDraftById(id: number): Record<string, unknown> | null {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, gmail_thread_id, subject, to_addresses, cc_addresses,
       bcc_addresses, html_body, text_body, in_reply_to, "references",
       attachments_json, signature, created_at, updated_at
       FROM drafts WHERE id = ?`,
      [id]
    );
    if (result.length === 0 || result[0].values.length === 0) return null;
    return this.mapGenericRow(result[0].values[0], result[0].columns);
  }

  deleteDraft(id: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('DELETE FROM drafts WHERE id = ?', [id]);
    this.scheduleSave();
  }

  // ---- Contact search (for autocomplete) ----

  searchContacts(query: string, limit: number = 10): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');
    const likeQuery = `%${query}%`;
    const result = this.db.exec(
      `SELECT id, email, display_name, frequency, last_contacted_at
       FROM contacts WHERE email LIKE ? OR display_name LIKE ?
       ORDER BY frequency DESC LIMIT ?`,
      [likeQuery, likeQuery, limit]
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => this.mapGenericRow(row, result[0].columns));
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

  private mapGenericRow(row: (string | number | Uint8Array | null)[], columns: string[]): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const val = row[i];
      const key = col.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      obj[key] = val;
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
