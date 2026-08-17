PRAGMA foreign_keys = ON;

-- Squashed from the ten migrations this project shipped through Slice 4
-- (V1 initial schema through V10 thread_labels). No production data exists
-- (D8), so this file states the schema directly instead of replaying that
-- history. Every rowid table below carries an explicit
-- `seq INTEGER PRIMARY KEY AUTOINCREMENT` as its first column so a stable
-- integer key exists for `message_search` to join against by rowid, safe
-- against VACUUM or a future table rebuild renumbering an implicit rowid.
-- Each table's former key is retained as a `NOT NULL UNIQUE` constraint, so
-- every existing `ON CONFLICT(...)` target and foreign key still resolves
-- unchanged. `thread_labels` is the one exception: it stays WITHOUT ROWID
-- with no integer key, exactly as introduced by V10.

CREATE TABLE accounts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  history_id INTEGER,
  needs_reauthentication INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE labels (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  color TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  color_text TEXT,
  color_background TEXT,
  UNIQUE (account_id, id)
);

-- `truncated_body`: the first 10,000 characters of plain text a resumable
-- whole-mailbox backfill persists, populated only by that path and left
-- NULL for messages that already carry a full `plain_body` from
-- initial/incremental sync.
--
-- `html_presence`: three states, not the two `html_body IS NULL` alone
-- gives. "Never fetched" (the normal state of every backfilled message,
-- which must trigger a fetch on open) is indistinguishable from "fetched
-- and genuinely absent" (which must not) under plain nullability.
CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
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
  truncated_body TEXT,
  html_presence TEXT NOT NULL DEFAULT 'never_fetched',
  draft_id TEXT,
  to_recipients TEXT NOT NULL DEFAULT '',
  cc_recipients TEXT NOT NULL DEFAULT '',
  bcc_recipients TEXT NOT NULL DEFAULT '',
  rfc_references TEXT,
  UNIQUE (account_id, id)
);

CREATE TABLE message_labels (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  UNIQUE (account_id, message_id, label_id),
  FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, label_id) REFERENCES labels(account_id, id) ON DELETE CASCADE
);

CREATE TABLE threads (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
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
  sender_identity TEXT NOT NULL DEFAULT '{"display":"(No sender)","address":null}',
  recipient_identity TEXT,
  UNIQUE (account_id, id)
);

CREATE TABLE settings (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL
);

CREATE TABLE operations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
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

-- Raw inline (Content-ID referenced) attachment bytes captured at sync time.
-- Message HTML is stored unsanitized; sanitization happens at
-- `load_conversation` time, right before crossing IPC, using this table to
-- assemble the cid -> bytes map DOMPurify/ammonia need to resolve `cid:`
-- image sources.
CREATE TABLE message_inline_parts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  content_id TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  bytes BLOB NOT NULL,
  UNIQUE (account_id, message_id, content_id),
  FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE
);

-- Keyed by (account_id, kind), not account_id alone, so backfill and
-- reconciliation traversals each own an independent progress row and
-- neither upsert can clobber the other's `position`/counts. Mutual
-- exclusion between the two traversals is unrelated to this table — it is
-- the queue's per-account entity lock that serializes them.
CREATE TABLE traversal_cursors (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  position TEXT,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  persisted_count INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  last_advanced_at INTEGER NOT NULL,
  resumed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (account_id, kind)
);

CREATE TABLE contacts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  display_name TEXT,
  frequency INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL,
  UNIQUE (account_id, address)
);

CREATE TABLE compose_draft_metadata (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
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
  UNIQUE (account_id, draft_id)
);

-- Avatar cache metadata: image bytes live as files on disk under the
-- application data directory; this table is the only source of truth for
-- what is cached, its outcome, and when it was looked up. Expiry is derived
-- from outcome + age via chrono at query time, never stored, so no expiry
-- migration is ever needed to change a lifetime constant.
CREATE TABLE avatar_cache (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_key TEXT NOT NULL UNIQUE,
  outcome TEXT NOT NULL,
  image_path TEXT,
  looked_up_at INTEGER NOT NULL
);

-- The mailbox listing filters threads by label but orders them by the
-- thread's `latest_at`. Those two facts live in different tables, so no
-- index over the normalised schema can serve both at once: a nested-EXISTS
-- form driving from `threads_by_latest` and testing each thread is ~1ms for
-- a label most threads carry (Inbox) but degrades to a full scan of every
-- thread for a selective one — measured at 33ms per page over 40k threads,
-- linear in mailbox size from there. The flat-join/CTE alternative merely
-- inverts which case is pathological (16ms rare, 27ms common).
--
-- `thread_labels` denormalises "this thread has at least one message
-- carrying this label" together with the thread's sort key, so the listing
-- becomes an ordered range scan with LIMIT: no temp B-tree, and no rows
-- touched beyond the page. Both cases measure at 0.03ms.
--
-- Maintained exclusively by `ThreadRepository::write_summary` — the single
-- point every membership-changing path already funnels through to
-- recompute a thread summary, in the same transaction as the change
-- itself. Thread deletion (a thread losing its last message, a full
-- re-sync's wipe, an account removal) is handled by the cascade rather
-- than by that code path. This table stays WITHOUT ROWID with no `seq`
-- column: it is not joined against by `message_search`, and an
-- AUTOINCREMENT key here would serve no purpose.
CREATE TABLE thread_labels (
  account_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  latest_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, label_id, latest_at DESC, thread_id DESC),
  FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE CASCADE
) WITHOUT ROWID;

-- Without this the cascade above rescans the whole table per deleted
-- thread, which would make a full re-sync's `DELETE FROM threads`
-- quadratic.
CREATE INDEX thread_labels_by_thread ON thread_labels(account_id, thread_id);

CREATE INDEX messages_by_thread ON messages(account_id, thread_id, sent_at, id);

-- Load-bearing for the Trash/Spam/Drafts scope exclusion in search's
-- predicate-only query shape, in addition to serving the label-filtered
-- listing's join.
CREATE INDEX message_labels_by_label ON message_labels(account_id, label_id, message_id);

CREATE INDEX threads_by_latest ON threads(account_id, latest_at DESC, id DESC);

-- Gmail draft ids are stable while message ids change on every draft save.
CREATE INDEX messages_by_draft ON messages(account_id, draft_id) WHERE draft_id IS NOT NULL;

CREATE INDEX operations_by_account ON operations(account_id);
CREATE INDEX operations_queued_durable ON operations(created_at) WHERE status='queued' AND kind IN ('send','draft');
CREATE INDEX operations_active_sends ON operations(account_id) WHERE kind='send' AND status='active';
CREATE INDEX operations_active_drafts ON operations(id) WHERE kind='draft' AND status='active';
CREATE INDEX operations_discardable_drafts ON operations(account_id, entity_key) WHERE kind='draft' AND status IN ('queued','active');

-- The primary key already covers exact (account_id, address) lookups. This
-- NOCASE variant lets SQLite turn the autocomplete LIKE prefix into a range.
CREATE INDEX contacts_lookup ON contacts(account_id, address COLLATE NOCASE);

-- Local keyword search index. `rowid` is `messages.seq`, guaranteed stable
-- across VACUUM and any future table rebuild by the AUTOINCREMENT key
-- above. Contentless (`content=''`): the index holds no retrievable text of
-- its own, only postings, and `contentless_delete=1` lets a row be removed
-- by rowid without needing the original column values back. `recipients`
-- concatenates To, Cc and Bcc; `body` is the full plain body where sync
-- captured one, falling back to the truncated backfill prefix. HTML is
-- never indexed. No prefix index: this table is queried by whole-word
-- MATCH, never by prefix completion.
CREATE VIRTUAL TABLE message_search USING fts5(
  subject, sender, recipients, body,
  content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER message_search_insert AFTER INSERT ON messages BEGIN
  INSERT INTO message_search(rowid, subject, sender, recipients, body)
  VALUES (
    new.seq,
    new.subject,
    new.sender,
    new.to_recipients || ' ' || new.cc_recipients || ' ' || new.bcc_recipients,
    COALESCE(new.plain_body, new.truncated_body, '')
  );
END;

CREATE TRIGGER message_search_delete AFTER DELETE ON messages BEGIN
  DELETE FROM message_search WHERE rowid = old.seq;
END;

-- Scoped to exactly the text-bearing columns a re-index needs. A bare
-- `AFTER UPDATE` would re-tokenise every message's body on every mark-read
-- or label change; those never touch this column list, so they never fire
-- this trigger.
CREATE TRIGGER message_search_update AFTER UPDATE OF
  subject, sender, to_recipients, cc_recipients, bcc_recipients, plain_body, truncated_body
ON messages BEGIN
  DELETE FROM message_search WHERE rowid = old.seq;
  INSERT INTO message_search(rowid, subject, sender, recipients, body)
  VALUES (
    new.seq,
    new.subject,
    new.sender,
    new.to_recipients || ' ' || new.cc_recipients || ' ' || new.bcc_recipients,
    COALESCE(new.plain_body, new.truncated_body, '')
  );
END;
