PRAGMA foreign_keys = ON;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  history_id INTEGER,
  needs_reauthentication INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE labels (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  color TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, id)
);

CREATE TABLE messages (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  rfc_message_id TEXT,
  sender TEXT NOT NULL,
  recipients TEXT NOT NULL,
  subject TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  html_body TEXT,
  plain_body TEXT,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  is_unread INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  history_id INTEGER NOT NULL,
  PRIMARY KEY (account_id, id)
);

CREATE TABLE message_labels (
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY (account_id, message_id, label_id),
  FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, label_id) REFERENCES labels(account_id, id) ON DELETE CASCADE
);

CREATE TABLE threads (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  subject TEXT NOT NULL,
  participants TEXT NOT NULL,
  latest_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  is_unread INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  has_draft INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, id)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lane TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX messages_by_thread ON messages(account_id, thread_id, sent_at);
CREATE INDEX messages_by_history ON messages(account_id, history_id);
CREATE INDEX message_labels_by_label ON message_labels(account_id, label_id, message_id);
CREATE INDEX threads_by_latest ON threads(account_id, latest_at DESC);
CREATE INDEX operations_ready ON operations(account_id, status, next_attempt_at);
