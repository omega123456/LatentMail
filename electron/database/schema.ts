export function getInitialSchemaForMigrations(): string {
  return `
  -- Accounts table
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    last_sync_at TEXT,
    sync_cursor TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    needs_reauth INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Emails table (one row per message, keyed by X-GM-MSGID)
  CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    x_gm_msgid TEXT NOT NULL,
    x_gm_thrid TEXT NOT NULL,
    message_id TEXT,
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
    is_draft INTEGER NOT NULL DEFAULT 0,
    is_filtered INTEGER NOT NULL DEFAULT 0,
    snippet TEXT,
    size INTEGER,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    labels TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    UNIQUE(account_id, x_gm_msgid)
  );

  CREATE INDEX IF NOT EXISTS idx_emails_account_thread ON emails(account_id, x_gm_thrid);
  CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date DESC);
  CREATE INDEX IF NOT EXISTS idx_emails_from ON emails(from_address);

  -- Email-folder association table (emails can appear in multiple folders)
  CREATE TABLE IF NOT EXISTS email_folders (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    x_gm_msgid TEXT NOT NULL,
    folder TEXT NOT NULL,
    uid INTEGER,
    UNIQUE(account_id, x_gm_msgid, folder)
  );

  CREATE INDEX IF NOT EXISTS idx_email_folders_account_folder ON email_folders(account_id, folder);
  CREATE INDEX IF NOT EXISTS idx_email_folders_msgid ON email_folders(account_id, x_gm_msgid);

  -- Threads table (keyed by X-GM-THRID)
  CREATE TABLE IF NOT EXISTS threads (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    x_gm_thrid TEXT NOT NULL,
    subject TEXT,
    last_message_date TEXT NOT NULL,
    participants TEXT,
    message_count INTEGER NOT NULL DEFAULT 1,
    snippet TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    is_starred INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    UNIQUE(account_id, x_gm_thrid)
  );

  CREATE INDEX IF NOT EXISTS idx_threads_last_date ON threads(last_message_date DESC);

  -- Thread-folder association table (threads can appear in multiple folders)
  CREATE TABLE IF NOT EXISTS thread_folders (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    x_gm_thrid TEXT NOT NULL,
    folder TEXT NOT NULL,
    UNIQUE(account_id, x_gm_thrid, folder)
  );

  CREATE INDEX IF NOT EXISTS idx_thread_folders_account_folder ON thread_folders(account_id, folder);

  -- Folder state for CONDSTORE incremental sync
  CREATE TABLE IF NOT EXISTS folder_state (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    folder TEXT NOT NULL,
    uid_validity TEXT NOT NULL,
    highest_modseq TEXT,
    condstore_supported INTEGER NOT NULL DEFAULT 1,
    last_reconciled_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    UNIQUE(account_id, folder)
  );

  CREATE INDEX IF NOT EXISTS idx_folder_state_account ON folder_state(account_id);

  -- Attachments table (references emails.id for compact FK)
  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY,
    email_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT,
    size INTEGER,
    content_id TEXT,
    local_path TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
  );

  -- Unique index for attachments: identity is (email_id, filename, COALESCE(content_id, ''))
  -- Enables INSERT OR IGNORE to skip duplicates on re-sync.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_email_filename_contentid
    ON attachments (email_id, filename, COALESCE(content_id, ''));

  -- Contacts table
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT,
    avatar_url TEXT,
    frequency INTEGER NOT NULL DEFAULT 1,
    last_contacted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_contacts_frequency ON contacts(frequency DESC);

  -- Labels table
  CREATE TABLE IF NOT EXISTS labels (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    gmail_label_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'user',
    color TEXT,
    unread_count INTEGER NOT NULL DEFAULT 0,
    total_count INTEGER NOT NULL DEFAULT 0,
    special_use TEXT,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    UNIQUE(account_id, gmail_label_id)
  );

  -- Filters table
  CREATE TABLE IF NOT EXISTS filters (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    conditions TEXT NOT NULL,
    actions TEXT NOT NULL,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    is_ai_generated INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  -- Settings table (key-value store)
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global'
  );

  -- AI cache table
  CREATE TABLE IF NOT EXISTS ai_cache (
    id INTEGER PRIMARY KEY,
    operation_type TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,
    UNIQUE(operation_type, input_hash, model)
  );

  -- Search index table (LIKE-based search)
  CREATE TABLE IF NOT EXISTS search_index (
    id INTEGER PRIMARY KEY,
    email_id INTEGER NOT NULL UNIQUE,
    subject TEXT,
    body TEXT,
    from_name TEXT,
    from_address TEXT,
    FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_search_subject ON search_index(subject);
  CREATE INDEX IF NOT EXISTS idx_search_from ON search_index(from_address);

  -- Mail queue table (persistent operation queue for drafts, sends, moves, flags, deletes)
  CREATE TABLE IF NOT EXISTS mail_queue (
    id TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL,
    operation TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    retry_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_mail_queue_account_status ON mail_queue(account_id, status);

  -- Vector indexed emails table (tracks which emails have been embedded in the vector index)
  CREATE TABLE IF NOT EXISTS vector_indexed_emails (
    x_gm_msgid TEXT NOT NULL,
    account_id INTEGER NOT NULL,
    embedding_hash TEXT NOT NULL,
    PRIMARY KEY (x_gm_msgid, account_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_vector_indexed_emails_account_id ON vector_indexed_emails (account_id);

  -- Embedding crawl progress table (UID-based resume on interrupt for full-mailbox IMAP crawler)
  CREATE TABLE IF NOT EXISTS embedding_crawl_progress (
    account_id        INTEGER NOT NULL,
    last_uid          INTEGER NOT NULL DEFAULT 0,
    build_interrupted INTEGER NOT NULL DEFAULT 0,
    updated_at        TEXT    NOT NULL,
    PRIMARY KEY (account_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  -- Umzug migration tracking
  CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY);
`;
}
