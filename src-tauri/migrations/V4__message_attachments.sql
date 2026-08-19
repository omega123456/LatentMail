PRAGMA foreign_keys = ON;

-- Attachment metadata is a normalised child of messages, mirroring the shape
-- message_inline_parts establishes: bytes never live here, only in the
-- on-disk attachment cache (see src/attachments/cache.rs). One row per real
-- attachment, in sender order via `position`. Written unconditionally by
-- both message-materialisation and backfill traversal (not gated on the
-- message row reporting a change), so an existing mailbox backfills its
-- attachment rows on its next sync instead of staying empty forever.
-- Deletion is by foreign-key cascade; the uniqueness constraint's leading
-- columns (account_id, message_id) cover the cascade so bulk message
-- deletion stays indexed rather than scanning this table.
CREATE TABLE message_attachments (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  position INTEGER NOT NULL,
  UNIQUE (account_id, message_id, attachment_id),
  FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE
);
