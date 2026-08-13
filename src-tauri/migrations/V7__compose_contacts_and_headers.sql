CREATE TABLE contacts (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  display_name TEXT,
  frequency INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, address)
);

ALTER TABLE messages ADD COLUMN to_recipients TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN cc_recipients TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN bcc_recipients TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN rfc_references TEXT;

-- The old flattened representation has no recoverable roles. Keep all of it
-- as To rather than dropping any address during the migration.
UPDATE messages SET to_recipients = recipients WHERE to_recipients = '';

CREATE TABLE compose_draft_metadata (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  original_message_id TEXT,
  original_gmail_message_id TEXT,
  target_thread_id TEXT,
  in_reply_to TEXT,
  rfc_references TEXT,
  boundary_version INTEGER NOT NULL,
  editable_body_fingerprint TEXT,
  quote_html TEXT,
  quote_plain TEXT,
  PRIMARY KEY (account_id, draft_id)
);

CREATE INDEX contacts_lookup ON contacts(account_id, address);
