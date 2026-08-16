-- Avatar cache metadata (D2): image bytes live as files on disk under the
-- application data directory; this table is the only source of truth for
-- what is cached, its outcome, and when it was looked up. Expiry (30d
-- positive / 7d negative / 1d account, D3) is derived from outcome + age via
-- chrono at query time — never stored, so no expiry migration is ever
-- needed to change a lifetime constant.
CREATE TABLE avatar_cache (
  cache_key TEXT PRIMARY KEY,
  outcome TEXT NOT NULL, -- 'hit' | 'miss'
  image_path TEXT,       -- relative to the avatar cache root; NULL on a miss
  looked_up_at INTEGER NOT NULL
);

-- Thread-summary identity (D12/D13): a display label + bare address for the
-- ordinary case (the newest message's sender) and, when the thread carries
-- at least one Sent-labelled message, the same pair for the newest such
-- message's first recipient. Each column holds a small JSON object
-- (`{"display":...,"address":...}`) rather than two separate columns, so the
-- paginated listing's SELECT gains exactly two new columns (see
-- ThreadRepository::list_paginated) — this table is Rust-internal storage,
-- never raw text handed to the frontend; sync::dto::ThreadDto decodes it
-- into proper typed fields before it ever crosses IPC.
ALTER TABLE threads ADD COLUMN sender_identity TEXT NOT NULL
  DEFAULT '{"display":"(No sender)","address":null}';
ALTER TABLE threads ADD COLUMN recipient_identity TEXT;
