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

    if (currentVersion < 3) {
      this.migrateV2toV3();
    }

    if (currentVersion < 4) {
      this.migrateV3toV4();
    }

    if (currentVersion < 5) {
      this.migrateV4toV5();
    }

    if (currentVersion < 6) {
      this.migrateV5toV6();
    }

    // Normalize legacy empty-string bodies to NULL so COALESCE works correctly
    this.db.run("UPDATE emails SET text_body = NULL WHERE text_body = ''");
    this.db.run("UPDATE emails SET html_body = NULL WHERE html_body = ''");

    // Ensure version row exists and is up to date
    this.db.run('DELETE FROM schema_version');
    this.db.run('INSERT INTO schema_version (version) VALUES (:version)', { ':version': SCHEMA_VERSION });
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
          WHERE account_id = :accountId AND gmail_message_id = :gmailMessageId
          ORDER BY (CASE WHEN COALESCE(html_body, '') != '' OR COALESCE(text_body, '') != '' THEN 0 ELSE 1 END), id ASC
          LIMIT 1
        `, { ':accountId': accountId, ':gmailMessageId': gmailMessageId });

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
          FROM emails WHERE id = :canonicalId
        `, { ':canonicalId': canonicalId });

        // Insert folder links for all folders this message appeared in
        for (const folder of folders) {
          this.db.run(
            'INSERT OR IGNORE INTO email_folders (email_id, account_id, folder) VALUES (:emailId, :accountId, :folder)',
            { ':emailId': canonicalId, ':accountId': accountId, ':folder': folder.trim() }
          );
        }

        // Reassign attachments and search_index from non-canonical rows to canonical
        for (const oldId of ids) {
          if (oldId !== canonicalId) {
            this.db.run('UPDATE attachments SET email_id = :newId WHERE email_id = :oldId', { ':newId': canonicalId, ':oldId': oldId });
            this.db.run('UPDATE search_index SET email_id = :newId WHERE email_id = :oldId', { ':newId': canonicalId, ':oldId': oldId });
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

  /**
   * Migrate from schema v2 to v3: add imap_uid and imap_uid_validity to drafts table.
   */
  private migrateV2toV3(): void {
    if (!this.db) throw new Error('Database not initialized');
    log.info('Running migration v2 → v3: add IMAP UID columns to drafts');

    // Check if columns already exist (idempotent)
    const colCheck = this.db.exec("PRAGMA table_info(drafts)");
    const hasImapUid = colCheck.length > 0 && colCheck[0].values.some(
      (row) => (row[1] as string) === 'imap_uid'
    );

    if (!hasImapUid) {
      this.db.run('ALTER TABLE drafts ADD COLUMN imap_uid INTEGER');
      this.db.run('ALTER TABLE drafts ADD COLUMN imap_uid_validity INTEGER');
    }

    log.info('Migration v2 → v3 complete');
  }

  /**
   * Migrate from schema v3 to v4: add uid column to email_folders and backfill
   * from emails.gmail_message_id where it is numeric (legacy UID-based identifiers).
   */
  private migrateV3toV4(): void {
    if (!this.db) throw new Error('Database not initialized');
    log.info('Running migration v3 → v4: add uid to email_folders, Message-ID based dedup');

    // Check if column already exists (idempotent)
    const colCheck = this.db.exec("PRAGMA table_info(email_folders)");
    const hasUid = colCheck.length > 0 && colCheck[0].values.some(
      (row) => (row[1] as string) === 'uid'
    );

    if (!hasUid) {
      this.db.run('ALTER TABLE email_folders ADD COLUMN uid INTEGER');
    }

    // Backfill uid from emails.gmail_message_id where it is purely numeric (legacy rows
    // where gmail_message_id was set to the IMAP UID string).
    // GLOB '[0-9]*' ensures it starts with a digit; the NOT GLOB '*[^0-9]*' ensures
    // it contains only digits (no letters or special chars).
    this.db.run(`
      UPDATE email_folders SET uid = CAST(e.gmail_message_id AS INTEGER)
      FROM emails e
      WHERE email_folders.email_id = e.id
        AND email_folders.uid IS NULL
        AND e.gmail_message_id GLOB '[0-9]*'
        AND e.gmail_message_id NOT GLOB '*[^0-9]*'
        AND CAST(e.gmail_message_id AS INTEGER) > 0
    `);

    log.info('Migration v3 → v4 complete');
  }

  /**
   * Migrate from schema v4 to v5: drop the drafts table.
   * Draft content now lives in the compose store (renderer memory) until server confirms.
   * After confirmation, drafts exist as regular emails in the emails table.
   */
  private migrateV4toV5(): void {
    if (!this.db) throw new Error('Database not initialized');
    log.info('Running migration v4 → v5: remove drafts table (queue-based draft system)');

    // Check if drafts table exists before trying to drop
    const tableCheck = this.db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='drafts'"
    );

    if (tableCheck.length > 0 && tableCheck[0].values.length > 0) {
      // Log warning about data loss
      const draftCount = this.db.exec('SELECT COUNT(*) FROM drafts');
      const count = (draftCount.length > 0 && draftCount[0].values.length > 0)
        ? draftCount[0].values[0][0] as number : 0;

      if (count > 0) {
        log.warn(
          `Dropping drafts table with ${count} local draft(s). ` +
          'Server-backed drafts will reappear on next sync. ' +
          'Local-only drafts (no IMAP UID) are lost.'
        );
      }

      this.db.run('DROP TABLE IF EXISTS drafts');
      this.db.run('DROP INDEX IF EXISTS idx_drafts_account');
    }

    log.info('Migration v4 → v5 complete');
  }

  /**
   * Migrate from schema v5 to v6: add filter execution support.
   * - New tables: user_labels, email_labels
   * - New column: emails.is_filtered
   * - New column: filters.sort_order (backfilled from id)
   */
  private migrateV5toV6(): void {
    if (!this.db) throw new Error('Database not initialized');
    log.info('Running migration v5 → v6: filter execution engine tables');

    // Add is_filtered column to emails (idempotent)
    const emailCols = this.db.exec("PRAGMA table_info(emails)");
    const hasIsFiltered = emailCols.length > 0 && emailCols[0].values.some(
      (row) => (row[1] as string) === 'is_filtered'
    );
    if (!hasIsFiltered) {
      this.db.run('ALTER TABLE emails ADD COLUMN is_filtered INTEGER NOT NULL DEFAULT 0');
    }

    // Add sort_order column to filters (idempotent)
    const filterCols = this.db.exec("PRAGMA table_info(filters)");
    const hasSortOrder = filterCols.length > 0 && filterCols[0].values.some(
      (row) => (row[1] as string) === 'sort_order'
    );
    if (!hasSortOrder) {
      this.db.run('ALTER TABLE filters ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
      // Backfill: set sort_order = id to preserve creation-order as initial priority
      this.db.run('UPDATE filters SET sort_order = id');
    }

    // Create user_labels table (idempotent via IF NOT EXISTS)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_labels (
        id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        color TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        UNIQUE(account_id, name)
      )
    `);

    // Create email_labels table (idempotent via IF NOT EXISTS)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS email_labels (
        id INTEGER PRIMARY KEY,
        email_id INTEGER NOT NULL,
        label_id INTEGER NOT NULL,
        account_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE,
        FOREIGN KEY (label_id) REFERENCES user_labels(id) ON DELETE CASCADE,
        UNIQUE(email_id)
      )
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_email_labels_account_label ON email_labels(account_id, label_id)');

    log.info('Migration v5 → v6 complete');
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
    // Get the last inserted rowid
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
    // CASCADE will handle emails, threads, labels, filters
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

  // ---- Email operations ----

  upsertEmail(email: {
    accountId: number;
    gmailMessageId: string;
    gmailThreadId: string;
    folder: string;
    folderUid?: number;
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
       VALUES (:accountId, :gmailMessageId, :gmailThreadId, :fromAddress, :fromName,
        :toAddresses, :ccAddresses, :bccAddresses, :subject, :textBody, :htmlBody, :date,
        :isRead, :isStarred, :isImportant, :snippet, :size, :hasAttachments, :labels)
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
      {
        ':accountId': email.accountId,
        ':gmailMessageId': email.gmailMessageId,
        ':gmailThreadId': email.gmailThreadId,
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
        ':snippet': email.snippet || '',
        ':size': email.size || 0,
        ':hasAttachments': email.hasAttachments ? 1 : 0,
        ':labels': email.labels || '',
      }
    );

    // Retrieve the actual id (last_insert_rowid is unreliable after ON CONFLICT)
    const result = this.db.exec(
      'SELECT id FROM emails WHERE account_id = :accountId AND gmail_message_id = :gmailMessageId',
      { ':accountId': email.accountId, ':gmailMessageId': email.gmailMessageId }
    );
    const id = result[0].values[0][0] as number;

    // Record folder association in the link table (with per-folder UID if available)
    if (email.folderUid != null) {
      this.db.run(
        `INSERT INTO email_folders (email_id, account_id, folder, uid) VALUES (:emailId, :accountId, :folder, :folderUid)
         ON CONFLICT(email_id, folder) DO UPDATE SET uid = excluded.uid`,
        { ':emailId': id, ':accountId': email.accountId, ':folder': email.folder, ':folderUid': email.folderUid }
      );
    } else {
      this.db.run(
        'INSERT OR IGNORE INTO email_folders (email_id, account_id, folder) VALUES (:emailId, :accountId, :folder)',
        { ':emailId': id, ':accountId': email.accountId, ':folder': email.folder }
      );
    }

    this.scheduleSave();
    return id;
  }

  getEmailsByThreadId(accountId: number, gmailThreadId: string): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, gmail_message_id, gmail_thread_id, from_address, from_name,
        to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body, snippet, date,
        is_read, is_starred, is_important, size, has_attachments, labels
       FROM emails WHERE account_id = :accountId AND gmail_thread_id = :gmailThreadId
       ORDER BY date ASC`,
      { ':accountId': accountId, ':gmailThreadId': gmailThreadId }
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
       FROM emails WHERE id = :id`,
      { ':id': id }
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
       FROM emails WHERE account_id = :accountId AND gmail_message_id = :gmailMessageId LIMIT 1`,
      { ':accountId': accountId, ':gmailMessageId': gmailMessageId }
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
       WHERE e.account_id = :accountId AND e.gmail_message_id = :gmailMessageId`,
      { ':accountId': accountId, ':gmailMessageId': gmailMessageId }
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
    const params: Record<string, string | number> = {
      ':accountId': accountId,
      ':gmailMessageId': gmailMessageId,
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
      `UPDATE emails SET ${updates.join(', ')} WHERE account_id = :accountId AND gmail_message_id = :gmailMessageId`,
      params
    );
    this.scheduleSave();
  }

  deleteEmailsByAccount(accountId: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('DELETE FROM emails WHERE account_id = :accountId', { ':accountId': accountId });
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
       VALUES (:accountId, :gmailThreadId, :subject, :lastMessageDate, :participants,
        :messageCount, :snippet, :folder, :isRead, :isStarred, datetime('now'))
       ON CONFLICT(account_id, gmail_thread_id) DO UPDATE SET
        subject = excluded.subject, last_message_date = excluded.last_message_date,
        participants = excluded.participants, message_count = excluded.message_count,
        snippet = excluded.snippet, folder = excluded.folder,
        is_read = excluded.is_read, is_starred = excluded.is_starred,
        updated_at = datetime('now')`,
      {
        ':accountId': thread.accountId,
        ':gmailThreadId': thread.gmailThreadId,
        ':subject': thread.subject || '',
        ':lastMessageDate': thread.lastMessageDate,
        ':participants': thread.participants || '',
        ':messageCount': thread.messageCount,
        ':snippet': thread.snippet || '',
        ':folder': thread.folder,
        ':isRead': thread.isRead ? 1 : 0,
        ':isStarred': thread.isStarred ? 1 : 0,
      }
    );
    // last_insert_rowid() is only reliable for INSERT, not ON CONFLICT UPDATE.
    // Query the actual ID to handle both cases.
    const result = this.db.exec(
      'SELECT id FROM threads WHERE account_id = :accountId AND gmail_thread_id = :gmailThreadId',
      { ':accountId': thread.accountId, ':gmailThreadId': thread.gmailThreadId }
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
       WHERE t.account_id = :accountId AND tf.folder = :folder
       ORDER BY t.last_message_date DESC LIMIT :limit OFFSET :offset`,
      { ':accountId': accountId, ':folder': folder, ':limit': limit, ':offset': offset }
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => this.mapThreadRow(row, result[0].columns));
  }

  /**
   * Get threads in a folder older than the given date, ordered newest-first.
   * Used by MAIL_FETCH_OLDER to return only the older threads after upserting.
   */
  getThreadsByFolderBeforeDate(
    accountId: number,
    folder: string,
    beforeDate: string,
    limit: number = 50
  ): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT t.id, t.account_id, t.gmail_thread_id, t.subject, t.last_message_date, t.participants,
        t.message_count, t.snippet, tf.folder, t.is_read, t.is_starred
       FROM threads t
       INNER JOIN thread_folders tf ON t.id = tf.thread_id
       WHERE t.account_id = :accountId AND tf.folder = :folder AND t.last_message_date < :beforeDate
       ORDER BY t.last_message_date DESC LIMIT :limit`,
      { ':accountId': accountId, ':folder': folder, ':beforeDate': beforeDate, ':limit': limit }
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => this.mapThreadRow(row, result[0].columns));
  }

  getThreadById(accountId: number, gmailThreadId: string): Record<string, unknown> | null {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, gmail_thread_id, subject, last_message_date, participants,
        message_count, snippet, folder, is_read, is_starred
       FROM threads WHERE account_id = :accountId AND gmail_thread_id = :gmailThreadId`,
      { ':accountId': accountId, ':gmailThreadId': gmailThreadId }
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
       VALUES (:threadId, :accountId, :folder)`,
      { ':threadId': threadId, ':accountId': accountId, ':folder': folder }
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

  /**
   * Unread count per folder as unread *threads* (conversations), to match Gmail's sidebar.
   * Gmail shows unread conversation count, not unread message count.
   */
  getUnreadThreadCountsByFolder(accountId: number): Record<string, number> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT tf.folder, COUNT(DISTINCT t.id) AS cnt
       FROM thread_folders tf
       INNER JOIN threads t ON t.id = tf.thread_id
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
    // Don't schedule save for search index — let the caller batch saves
  }

  /**
   * Search emails across all folders using Gmail-style query operators.
   * Returns thread-grouped results matching the same shape as getThreadsByFolder().
   *
   * Uses the gmail-query-parser to convert operator syntax to SQL WHERE clauses.
   * Groups results by gmail_thread_id and computes thread metadata.
   */
  searchEmails(accountId: number, query: string, limit: number = 100): Array<Record<string, unknown>> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    // Lazy-import to avoid circular dependencies at module load time
    const { parseGmailQuery } = require('../utils/gmail-query-parser');
    const parsed = parseGmailQuery(query, { accountId }) as { whereClause: string; params: Record<string, unknown> };

    // Build query: find matching emails, then group by thread
    const params = {
      ':accountId': accountId,
      ':limit': limit,
      ...parsed.params,
    } as Record<string, number | string | null>;

    const sql = `
      SELECT
        t.id,
        t.account_id,
        t.gmail_thread_id,
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
        AND t.gmail_thread_id IN (
          SELECT DISTINCT e.gmail_thread_id
          FROM emails e
          WHERE e.account_id = :accountId AND (${parsed.whereClause})
        )
      ORDER BY t.last_message_date DESC
      LIMIT :limit
    `;

    const result = this.db.exec(sql, params);
    if (result.length === 0) {
      return [];
    }
    return result[0].values.map((row) => this.mapThreadRow(row, result[0].columns));
  }

  /**
   * Search with multiple Gmail queries. Each query is parsed and executed independently,
   * then matching gmail_thread_id values are unioned in JavaScript and fetched in one pass.
   */
  searchEmailsMulti(accountId: number, queries: string[], limit: number = 100): Array<Record<string, unknown>> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const normalizedQueries = queries
      .map((query) => query.trim())
      .filter((query) => query.length > 0);
    if (normalizedQueries.length === 0) {
      return [];
    }

    // Lazy-import to avoid circular dependencies at module load time
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
        `SELECT DISTINCT e.gmail_thread_id
         FROM emails e
         WHERE e.account_id = :accountId AND (${parsed.whereClause})
         ORDER BY e.date DESC
         LIMIT :limit`,
        params
      );

      if (result.length === 0) {
        continue;
      }
      for (const row of result[0].values) {
        const threadId = row[0] as string | null;
        if (threadId) {
          threadIdSet.add(threadId);
        }
      }
    }

    if (threadIdSet.size === 0) {
      return [];
    }

    return this.getThreadsByGmailThreadIds(accountId, Array.from(threadIdSet), limit);
  }

  /**
   * Fetch folder associations for many thread internal IDs in one query.
   */
  getFoldersForThreadBatch(threadIds: number[]): Map<number, string[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const map = new Map<number, string[]>();
    const uniqueThreadIds = Array.from(new Set(threadIds.filter((threadId) => Number.isFinite(threadId))));
    if (uniqueThreadIds.length === 0) {
      return map;
    }

    const placeholders = uniqueThreadIds.map((_, index) => `:threadId${index}`);
    const params: Record<string, number> = {};
    for (let index = 0; index < uniqueThreadIds.length; index++) {
      params[`:threadId${index}`] = uniqueThreadIds[index];
    }

    const result = this.db.exec(
      `SELECT thread_id, folder
       FROM thread_folders
       WHERE thread_id IN (${placeholders.join(', ')})
       ORDER BY thread_id ASC, folder ASC`,
      params
    );

    if (result.length === 0) {
      return map;
    }

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

  private getThreadsByGmailThreadIds(accountId: number, gmailThreadIds: string[], limit: number): Array<Record<string, unknown>> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const uniqueIds = Array.from(new Set(gmailThreadIds.filter((threadId) => threadId.trim().length > 0)));
    if (uniqueIds.length === 0) {
      return [];
    }

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
         t.gmail_thread_id,
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
         AND t.gmail_thread_id IN (${placeholders.join(', ')})
       ORDER BY t.last_message_date DESC
       LIMIT :limit`,
      params
    );

    if (result.length === 0) {
      return [];
    }

    return result[0].values.map((row) => this.mapThreadRow(row, result[0].columns));
  }

  // ---- Folder association management ----

  /** Remove an email's association with a specific folder. */
  removeEmailFolderAssociation(accountId: number, gmailMessageId: string, folder: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      `DELETE FROM email_folders WHERE folder = :folder AND email_id IN (
        SELECT id FROM emails WHERE account_id = :accountId AND gmail_message_id = :gmailMessageId
      )`,
      { ':folder': folder, ':accountId': accountId, ':gmailMessageId': gmailMessageId }
    );
    this.scheduleSave();
  }

  /** Remove a thread's association with a specific folder. */
  removeThreadFolderAssociation(threadId: number, folder: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      'DELETE FROM thread_folders WHERE thread_id = :threadId AND folder = :folder',
      { ':threadId': threadId, ':folder': folder }
    );
    this.scheduleSave();
  }

  /** Get all gmail_message_ids that have a folder association for a given account + folder. */
  getEmailGmailMessageIdsByFolder(accountId: number, folder: string): string[] {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT e.gmail_message_id FROM emails e
       JOIN email_folders ef ON e.id = ef.email_id
       WHERE e.account_id = :accountId AND ef.folder = :folder`,
      { ':accountId': accountId, ':folder': folder }
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => row[0] as string);
  }

  /**
   * Get all (emailId, uid) pairs from email_folders for a given account + folder.
   * Used for reconciliation: compare local UIDs against server UIDs.
   */
  getEmailFolderUids(accountId: number, folder: string): Array<{ emailId: number; uid: number; gmailMessageId: string }> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT ef.email_id, ef.uid, e.gmail_message_id FROM email_folders ef
       JOIN emails e ON e.id = ef.email_id
       WHERE e.account_id = :accountId AND ef.folder = :folder AND ef.uid IS NOT NULL`,
      { ':accountId': accountId, ':folder': folder }
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => ({
      emailId: row[0] as number,
      uid: row[1] as number,
      gmailMessageId: row[2] as string,
    }));
  }

  /**
   * Get the maximum UID stored for an account+folder (for notification baseline).
   * Returns null if no UIDs are stored for that folder.
   */
  getMaxFolderUid(accountId: number, folder: string): number | null {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT MAX(ef.uid) FROM email_folders ef
       JOIN emails e ON e.id = ef.email_id
       WHERE e.account_id = :accountId AND ef.folder = :folder AND ef.uid IS NOT NULL`,
      { ':accountId': accountId, ':folder': folder }
    );
    if (result.length === 0 || result[0].values.length === 0) return null;
    const val = result[0].values[0][0];
    if (val == null) return null;
    return val as number;
  }

  /**
   * Get folder UIDs for a given email (by gmail_message_id).
   * Returns one entry per folder the email appears in, with the IMAP UID for that folder.
   * Used by flag and move handlers to resolve (account, email) → [(folder, uid)].
   */
  getFolderUidsForEmail(accountId: number, gmailMessageId: string): Array<{ folder: string; uid: number }> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT ef.folder, ef.uid FROM email_folders ef
       JOIN emails e ON e.id = ef.email_id
       WHERE e.account_id = :accountId AND e.gmail_message_id = :gmailMessageId AND ef.uid IS NOT NULL`,
      { ':accountId': accountId, ':gmailMessageId': gmailMessageId }
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => ({
      folder: row[0] as string,
      uid: row[1] as number,
    }));
  }

  /**
   * Move an email from one folder to another atomically.
   * Removes the source folder association and adds the target folder association.
   * If targetUid is provided, stores it as the UID for the new folder association.
   */
  moveEmailFolder(accountId: number, gmailMessageId: string, sourceFolder: string, targetFolder: string, targetUid?: number | null): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('BEGIN');
    try {
      // Get the email's internal ID
      const result = this.db.exec(
        'SELECT id FROM emails WHERE account_id = :accountId AND gmail_message_id = :gmailMessageId',
        { ':accountId': accountId, ':gmailMessageId': gmailMessageId }
      );
      if (result.length > 0 && result[0].values.length > 0) {
        const emailId = result[0].values[0][0] as number;
        // Remove source folder association
        this.db.run(
          'DELETE FROM email_folders WHERE email_id = :emailId AND folder = :folder',
          { ':emailId': emailId, ':folder': sourceFolder }
        );
        // Add target folder association (with uid if available)
        if (targetUid != null) {
          this.db.run(
            `INSERT INTO email_folders (email_id, account_id, folder, uid) VALUES (:emailId, :accountId, :folder, :uid)
             ON CONFLICT(email_id, folder) DO UPDATE SET uid = excluded.uid`,
            { ':emailId': emailId, ':accountId': accountId, ':folder': targetFolder, ':uid': targetUid }
          );
        } else {
          this.db.run(
            'INSERT OR IGNORE INTO email_folders (email_id, account_id, folder) VALUES (:emailId, :accountId, :folder)',
            { ':emailId': emailId, ':accountId': accountId, ':folder': targetFolder }
          );
        }
      }
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    this.scheduleSave();
  }

  /**
   * Move a thread from one folder to another atomically.
   * Removes the source folder association and adds the target folder association.
   */
  moveThreadFolder(threadId: number, accountId: number, sourceFolder: string, targetFolder: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('BEGIN');
    try {
      // Remove source folder association
      this.db.run(
        'DELETE FROM thread_folders WHERE thread_id = :threadId AND folder = :folder',
        { ':threadId': threadId, ':folder': sourceFolder }
      );
      // Add target folder association
      this.db.run(
        'INSERT OR IGNORE INTO thread_folders (thread_id, account_id, folder) VALUES (:threadId, :accountId, :folder)',
        { ':threadId': threadId, ':accountId': accountId, ':folder': targetFolder }
      );
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    this.scheduleSave();
  }

  /**
   * Remove orphaned threads — threads with no remaining folder associations.
   */
  removeOrphanedThreads(accountId: number): number {
    if (!this.db) throw new Error('Database not initialized');
    // Count before deleting for logging
    const countResult = this.db.exec(
      `SELECT COUNT(*) FROM threads t WHERE t.account_id = :accountId
       AND NOT EXISTS (SELECT 1 FROM thread_folders tf WHERE tf.thread_id = t.id)`,
      { ':accountId': accountId }
    );
    const count = (countResult.length > 0 && countResult[0].values.length > 0)
      ? countResult[0].values[0][0] as number : 0;

    if (count > 0) {
      this.db.run(
        `DELETE FROM threads WHERE account_id = :accountId
         AND NOT EXISTS (SELECT 1 FROM thread_folders tf WHERE tf.thread_id = threads.id)`,
        { ':accountId': accountId }
      );
      this.scheduleSave();
    }
    return count;
  }

  /**
   * Get the internal thread ID for a given gmail_thread_id.
   */
  getThreadInternalId(accountId: number, gmailThreadId: string): number | null {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      'SELECT id FROM threads WHERE account_id = :accountId AND gmail_thread_id = :gmailThreadId',
      { ':accountId': accountId, ':gmailThreadId': gmailThreadId }
    );
    if (result.length === 0 || result[0].values.length === 0) return null;
    return result[0].values[0][0] as number;
  }

  /**
   * Get folder paths for a thread (from thread_folders). Used by fetchThread to fetch from each folder instead of All Mail.
   */
  getFoldersForThread(accountId: number, gmailThreadId: string): string[] {
    if (!this.db) throw new Error('Database not initialized');
    const threadId = this.getThreadInternalId(accountId, gmailThreadId);
    if (threadId == null) return [];
    const result = this.db.exec(
      'SELECT DISTINCT folder FROM thread_folders WHERE thread_id = :threadId AND account_id = :accountId',
      { ':threadId': threadId, ':accountId': accountId }
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => row[0] as string);
  }

  /**
   * Get all thread IDs (internal) that have emails in a given folder.
   * Used for reconciliation to find threads that should be disassociated from a folder.
   */
  getThreadIdsByFolder(accountId: number, folder: string): number[] {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      'SELECT DISTINCT thread_id FROM thread_folders WHERE account_id = :accountId AND folder = :folder',
      { ':accountId': accountId, ':folder': folder }
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => row[0] as number);
  }

  /**
   * Check if a thread still has any emails in a given folder.
   * Used during reconciliation to decide whether to keep the thread-folder association.
   */
  threadHasEmailsInFolder(accountId: number, gmailThreadId: string, folder: string): boolean {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT COUNT(*) FROM emails e
       JOIN email_folders ef ON e.id = ef.email_id
       WHERE e.account_id = :accountId AND e.gmail_thread_id = :gmailThreadId AND ef.folder = :folder`,
      { ':accountId': accountId, ':gmailThreadId': gmailThreadId, ':folder': folder }
    );
    if (result.length === 0 || result[0].values.length === 0) return false;
    return (result[0].values[0][0] as number) > 0;
  }

  /**
   * Remove an email and all its folder associations.
   * Also cleans up orphaned threads (threads with no remaining emails).
   * Used by the queue delete worker after successful IMAP deletion.
   */
  removeEmailAndAssociations(accountId: number, gmailMessageId: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('BEGIN');
    try {
      // Get the email row
      const emailResult = this.db.exec(
        'SELECT id, gmail_thread_id FROM emails WHERE account_id = :accountId AND gmail_message_id = :gmailMessageId',
        { ':accountId': accountId, ':gmailMessageId': gmailMessageId }
      );
      if (emailResult.length === 0 || emailResult[0].values.length === 0) {
        this.db.run('COMMIT');
        return;
      }
      const emailId = emailResult[0].values[0][0] as number;
      const gmailThreadId = emailResult[0].values[0][1] as string;

      // Remove all folder associations for this email
      this.db.run('DELETE FROM email_folders WHERE email_id = :emailId', { ':emailId': emailId });

      // Remove the email row itself
      this.db.run('DELETE FROM emails WHERE id = :emailId', { ':emailId': emailId });

      // Clean up orphaned thread: if no more emails reference this thread, remove thread + thread_folders
      if (gmailThreadId) {
        const remainingResult = this.db.exec(
          'SELECT COUNT(*) FROM emails WHERE account_id = :accountId AND gmail_thread_id = :gmailThreadId',
          { ':accountId': accountId, ':gmailThreadId': gmailThreadId }
        );
        const remaining = (remainingResult.length > 0 && remainingResult[0].values.length > 0)
          ? remainingResult[0].values[0][0] as number : 0;

        if (remaining === 0) {
          // No emails left — remove thread and all its folder associations
          const threadIdResult = this.db.exec(
            'SELECT id FROM threads WHERE account_id = :accountId AND gmail_thread_id = :gmailThreadId',
            { ':accountId': accountId, ':gmailThreadId': gmailThreadId }
          );
          if (threadIdResult.length > 0 && threadIdResult[0].values.length > 0) {
            const threadId = threadIdResult[0].values[0][0] as number;
            this.db.run('DELETE FROM thread_folders WHERE thread_id = :threadId', { ':threadId': threadId });
            this.db.run('DELETE FROM threads WHERE id = :threadId', { ':threadId': threadId });
          }
        } else {
          // Thread still has emails — update thread_folders to remove associations
          // for folders that no longer have any emails from this thread
          const threadIdResult = this.db.exec(
            'SELECT id FROM threads WHERE account_id = :accountId AND gmail_thread_id = :gmailThreadId',
            { ':accountId': accountId, ':gmailThreadId': gmailThreadId }
          );
          if (threadIdResult.length > 0 && threadIdResult[0].values.length > 0) {
            const threadId = threadIdResult[0].values[0][0] as number;
            // Get all folders this thread is associated with
            const tfResult = this.db.exec(
              'SELECT DISTINCT folder FROM thread_folders WHERE thread_id = :threadId',
              { ':threadId': threadId }
            );
            if (tfResult.length > 0) {
              for (const row of tfResult[0].values) {
                const folder = row[0] as string;
                // Check if thread still has emails in this folder
                const countResult = this.db.exec(
                  `SELECT COUNT(*) FROM emails e
                   JOIN email_folders ef ON e.id = ef.email_id
                   WHERE e.account_id = :accountId AND e.gmail_thread_id = :gmailThreadId AND ef.folder = :folder`,
                  { ':accountId': accountId, ':gmailThreadId': gmailThreadId, ':folder': folder }
                );
                const count = (countResult.length > 0 && countResult[0].values.length > 0)
                  ? countResult[0].values[0][0] as number : 0;
                if (count === 0) {
                  this.db.run(
                    'DELETE FROM thread_folders WHERE thread_id = :threadId AND folder = :folder',
                    { ':threadId': threadId, ':folder': folder }
                  );
                }
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

  // ---- Contact search (for autocomplete) ----

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

  // ---- AI Cache operations ----

  /**
   * Get a cached AI result by operation type, input hash, and model.
   * Returns null if not found or expired.
   */
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

  /**
   * Store an AI result in the cache.
   * @param expiresInDays - Number of days until expiry. Null for no expiry.
   */
  setAiCacheResult(
    operation: string,
    inputHash: string,
    model: string,
    resultText: string,
    expiresInDays: number | null
  ): void {
    if (!this.db) throw new Error('Database not initialized');
    const expiresAt = expiresInDays != null
      ? new Date(Date.now() + (Math.floor(expiresInDays) * 24 * 60 * 60 * 1000)).toISOString()
      : null;

    this.db.run(
      `INSERT INTO ai_cache (operation_type, input_hash, model, result, expires_at)
       VALUES (:operation, :inputHash, :model, :result, :expiresAt)
       ON CONFLICT(operation_type, input_hash, model) DO UPDATE SET
         result = excluded.result, created_at = datetime('now'), expires_at = excluded.expires_at`,
      {
        ':operation': operation,
        ':inputHash': inputHash,
        ':model': model,
        ':result': resultText,
        ':expiresAt': expiresAt,
      }
    );

    this.scheduleSave();
  }

  /**
   * Clear expired AI cache entries.
   */
  clearExpiredAiCache(): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run("DELETE FROM ai_cache WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')");
    this.scheduleSave();
  }

  /**
   * Clear AI cache entries for a specific operation type and input hash.
   * Used to invalidate cache when underlying data changes (e.g., thread gets new messages).
   */
  invalidateAiCache(operation: string, inputHash?: string): void {
    if (!this.db) throw new Error('Database not initialized');
    if (inputHash) {
      this.db.run(
        'DELETE FROM ai_cache WHERE operation_type = :operation AND input_hash = :inputHash',
        { ':operation': operation, ':inputHash': inputHash }
      );
    } else {
      this.db.run(
        'DELETE FROM ai_cache WHERE operation_type = :operation',
        { ':operation': operation }
      );
    }
    this.scheduleSave();
  }

  // ---- Filter CRUD operations ----

  /**
   * Get all filters for an account.
   */
  getFilters(accountId: number): Array<{
    id: number;
    accountId: number;
    name: string;
    conditions: string;
    actions: string;
    isEnabled: boolean;
    isAiGenerated: boolean;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
  }> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, name, conditions, actions, is_enabled, is_ai_generated, sort_order, created_at, updated_at
       FROM filters WHERE account_id = :accountId ORDER BY sort_order ASC, id ASC`,
      { ':accountId': accountId }
    );
    if (result.length === 0) return [];
    return result[0].values.map(row => ({
      id: row[0] as number,
      accountId: row[1] as number,
      name: row[2] as string,
      conditions: row[3] as string,
      actions: row[4] as string,
      isEnabled: !!(row[5] as number),
      isAiGenerated: !!(row[6] as number),
      sortOrder: (row[7] as number) || 0,
      createdAt: row[8] as string,
      updatedAt: row[9] as string,
    }));
  }

  /**
   * Save a new filter.
   */
  saveFilter(filter: {
    accountId: number;
    name: string;
    conditions: string;
    actions: string;
    isEnabled: boolean;
    isAiGenerated: boolean;
    sortOrder?: number;
  }): number {
    if (!this.db) throw new Error('Database not initialized');
    // If no sort_order provided, place at end (max + 1)
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
        ':accountId': filter.accountId,
        ':name': filter.name,
        ':conditions': filter.conditions,
        ':actions': filter.actions,
        ':isEnabled': filter.isEnabled ? 1 : 0,
        ':isAiGenerated': filter.isAiGenerated ? 1 : 0,
        ':sortOrder': sortOrder,
      }
    );
    const idResult = this.db.exec('SELECT last_insert_rowid()');
    const id = idResult.length > 0 ? (idResult[0].values[0][0] as number) : 0;
    this.scheduleSave();
    return id;
  }

  /**
   * Update an existing filter.
   */
  updateFilter(filter: {
    id: number;
    name: string;
    conditions: string;
    actions: string;
    isEnabled: boolean;
    sortOrder?: number;
  }): void {
    if (!this.db) throw new Error('Database not initialized');
    const updates = [
      'name = :name',
      'conditions = :conditions',
      'actions = :actions',
      'is_enabled = :isEnabled',
      "updated_at = datetime('now')",
    ];
    const params: Record<string, string | number> = {
      ':id': filter.id,
      ':name': filter.name,
      ':conditions': filter.conditions,
      ':actions': filter.actions,
      ':isEnabled': filter.isEnabled ? 1 : 0,
    };
    if (filter.sortOrder != null) {
      updates.push('sort_order = :sortOrder');
      params[':sortOrder'] = filter.sortOrder;
    }
    this.db.run(
      `UPDATE filters SET ${updates.join(', ')} WHERE id = :id`,
      params
    );
    this.scheduleSave();
  }

  /**
   * Delete a filter by ID.
   */
  deleteFilter(id: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('DELETE FROM filters WHERE id = :id', { ':id': id });
    this.scheduleSave();
  }

  /**
   * Toggle filter enabled/disabled state.
   */
  toggleFilter(id: number, isEnabled: boolean): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      'UPDATE filters SET is_enabled = :isEnabled, updated_at = datetime(\'now\') WHERE id = :id',
      { ':id': id, ':isEnabled': isEnabled ? 1 : 0 }
    );
    this.scheduleSave();
  }

  // ---- User Label operations (filter execution) ----

  /**
   * Upsert a user label by name for an account. Returns the label ID.
   * Creates if not exists, returns existing ID if it does.
   */
  upsertUserLabel(accountId: number, name: string, color?: string | null): number {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      `INSERT INTO user_labels (account_id, name, color)
       VALUES (:accountId, :name, :color)
       ON CONFLICT(account_id, name) DO UPDATE SET
        color = COALESCE(excluded.color, user_labels.color)`,
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

  /**
   * Get all user labels for an account with unread thread counts.
   */
  getUserLabels(accountId: number): Array<{
    id: number;
    accountId: number;
    name: string;
    color: string | null;
    unreadCount: number;
  }> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT ul.id, ul.account_id, ul.name, ul.color,
        (SELECT COUNT(DISTINCT t.id)
         FROM email_labels el2
         JOIN emails e2 ON e2.id = el2.email_id
         JOIN threads t ON t.account_id = e2.account_id AND t.gmail_thread_id = e2.gmail_thread_id
         WHERE el2.label_id = ul.id AND t.is_read = 0
        ) AS unread_count
       FROM user_labels ul
       WHERE ul.account_id = :accountId
       ORDER BY ul.name ASC`,
      { ':accountId': accountId }
    );
    if (result.length === 0) return [];
    return result[0].values.map(row => ({
      id: row[0] as number,
      accountId: row[1] as number,
      name: row[2] as string,
      color: row[3] as string | null,
      unreadCount: (row[4] as number) || 0,
    }));
  }

  /**
   * Assign a label to an email. Enforces one-label-per-email via UNIQUE constraint.
   * Uses INSERT OR IGNORE to skip if email already has a label.
   */
  assignEmailLabel(emailId: number, labelId: number, accountId: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      `INSERT OR IGNORE INTO email_labels (email_id, label_id, account_id)
       VALUES (:emailId, :labelId, :accountId)`,
      { ':emailId': emailId, ':labelId': labelId, ':accountId': accountId }
    );
    this.scheduleSave();
  }

  /**
   * Remove a label assignment from an email.
   */
  removeEmailLabel(emailId: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      'DELETE FROM email_labels WHERE email_id = :emailId',
      { ':emailId': emailId }
    );
    this.scheduleSave();
  }

  /**
   * Check if an email already has a label assigned.
   */
  emailHasLabel(emailId: number): boolean {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      'SELECT 1 FROM email_labels WHERE email_id = :emailId LIMIT 1',
      { ':emailId': emailId }
    );
    return result.length > 0 && result[0].values.length > 0;
  }

  /**
   * Get threads by user label (for virtual label folder browsing).
   * Returns the same column shape as getThreadsByFolder.
   */
  getThreadsByUserLabel(
    accountId: number,
    labelId: number,
    limit: number = 50,
    offset: number = 0
  ): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT DISTINCT t.id, t.account_id, t.gmail_thread_id, t.subject, t.last_message_date,
        t.participants, t.message_count, t.snippet, 'label::' || :labelId AS folder,
        t.is_read, t.is_starred
       FROM threads t
       JOIN emails e ON e.account_id = t.account_id AND e.gmail_thread_id = t.gmail_thread_id
       JOIN email_labels el ON el.email_id = e.id
       WHERE el.label_id = :labelId AND el.account_id = :accountId
       ORDER BY t.last_message_date DESC LIMIT :limit OFFSET :offset`,
      { ':accountId': accountId, ':labelId': labelId, ':limit': limit, ':offset': offset }
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => this.mapThreadRow(row, result[0].columns));
  }

  /**
   * Get threads by user label before a given date (for pagination in virtual label folders).
   */
  getThreadsByUserLabelBeforeDate(
    accountId: number,
    labelId: number,
    beforeDate: string,
    limit: number = 50
  ): Array<Record<string, unknown>> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT DISTINCT t.id, t.account_id, t.gmail_thread_id, t.subject, t.last_message_date,
        t.participants, t.message_count, t.snippet, 'label::' || :labelId AS folder,
        t.is_read, t.is_starred
       FROM threads t
       JOIN emails e ON e.account_id = t.account_id AND e.gmail_thread_id = t.gmail_thread_id
       JOIN email_labels el ON el.email_id = e.id
       WHERE el.label_id = :labelId AND el.account_id = :accountId AND t.last_message_date < :beforeDate
       ORDER BY t.last_message_date DESC LIMIT :limit`,
      { ':accountId': accountId, ':labelId': labelId, ':beforeDate': beforeDate, ':limit': limit }
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => this.mapThreadRow(row, result[0].columns));
  }

  /**
   * Get label info for a batch of thread IDs. Returns a map of threadId → label info.
   * Uses the most recent labeled email per thread (by email date descending).
   */
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

    // For each thread, get the label from the most recent labeled email
    const result = this.db.exec(
      `SELECT t.id AS thread_id, ul.id AS label_id, ul.name AS label_name, ul.color AS label_color
       FROM threads t
       JOIN emails e ON e.account_id = t.account_id AND e.gmail_thread_id = t.gmail_thread_id
       JOIN email_labels el ON el.email_id = e.id
       JOIN user_labels ul ON ul.id = el.label_id
       WHERE t.id IN (${placeholders.join(', ')})
       ORDER BY e.date DESC`,
      params
    );

    if (result.length === 0) return map;

    // First occurrence per thread_id wins (most recent by ORDER BY e.date DESC)
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

  /**
   * Delete a user label by ID. CASCADE removes all email_labels entries.
   */
  deleteUserLabel(labelId: number): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run('DELETE FROM user_labels WHERE id = :labelId', { ':labelId': labelId });
    this.scheduleSave();
  }

  // ---- Filter execution support ----

  /**
   * Get unfiltered INBOX emails for an account.
   * Returns full email data needed for condition matching.
   */
  getUnfilteredInboxEmails(accountId: number): Array<{
    id: number;
    gmailMessageId: string;
    gmailThreadId: string;
    fromAddress: string;
    fromName: string;
    toAddresses: string;
    subject: string;
    textBody: string | null;
    htmlBody: string | null;
    hasAttachments: boolean;
  }> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT e.id, e.gmail_message_id, e.gmail_thread_id, e.from_address, e.from_name,
        e.to_addresses, e.subject, e.text_body, e.html_body, e.has_attachments
       FROM emails e
       JOIN email_folders ef ON ef.email_id = e.id
       WHERE e.account_id = :accountId AND ef.folder = 'INBOX' AND e.is_filtered = 0`,
      { ':accountId': accountId }
    );
    if (result.length === 0) return [];
    return result[0].values.map(row => ({
      id: row[0] as number,
      gmailMessageId: row[1] as string,
      gmailThreadId: row[2] as string,
      fromAddress: row[3] as string,
      fromName: (row[4] as string) || '',
      toAddresses: (row[5] as string) || '',
      subject: (row[6] as string) || '',
      textBody: row[7] as string | null,
      htmlBody: row[8] as string | null,
      hasAttachments: !!(row[9] as number),
    }));
  }

  /**
   * Mark emails as filtered (batch update). Wrapped in transaction.
   */
  markEmailsAsFiltered(emailIds: number[]): void {
    if (!this.db) throw new Error('Database not initialized');
    if (emailIds.length === 0) return;

    this.db.run('BEGIN');
    try {
      // Batch in groups to stay within SQLite variable limits
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

  /**
   * Get enabled filters for an account, ordered by sort_order ascending then id ascending.
   */
  getEnabledFiltersOrdered(accountId: number): Array<{
    id: number;
    accountId: number;
    name: string;
    conditions: string;
    actions: string;
    sortOrder: number;
  }> {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT id, account_id, name, conditions, actions, sort_order
       FROM filters
       WHERE account_id = :accountId AND is_enabled = 1
       ORDER BY sort_order ASC, id ASC`,
      { ':accountId': accountId }
    );
    if (result.length === 0) return [];
    return result[0].values.map(row => ({
      id: row[0] as number,
      accountId: row[1] as number,
      name: row[2] as string,
      conditions: row[3] as string,
      actions: row[4] as string,
      sortOrder: (row[5] as number) || 0,
    }));
  }

  /**
   * Get the INBOX UID for an email (by internal email ID).
   * Returns null if the email is not in INBOX or has no UID.
   */
  getInboxUidForEmail(emailId: number): number | null {
    if (!this.db) throw new Error('Database not initialized');
    const result = this.db.exec(
      `SELECT uid FROM email_folders WHERE email_id = :emailId AND folder = 'INBOX' AND uid IS NOT NULL`,
      { ':emailId': emailId }
    );
    if (result.length === 0 || result[0].values.length === 0) return null;
    return result[0].values[0][0] as number;
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
