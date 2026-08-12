-- Phase 3 (Slice 2): traversal cursor persistence, the truncated-body /
-- HTML-presence marker pair backfill needs, and the Gmail colour pair on
-- user labels. Forward-only; applies cleanly over V1/V2 without touching
-- existing rows (every new column is nullable or carries a safe default).

-- One row per account tracking whole-mailbox backfill/reconciliation
-- progress (D11: a count, never a percentage). `kind` distinguishes which
-- traversal produced this cursor — 'backfill' or 'reconciliation' — so a
-- resumed run and a later reconciliation pass never get confused with one
-- another. `position` is an opaque resume marker (e.g. a Gmail page token)
-- interpreted only by the traversal code that wrote it.
CREATE TABLE traversal_cursors (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  position TEXT,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  persisted_count INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  last_advanced_at INTEGER NOT NULL
);

-- `truncated_body`: the first 10,000 characters of plain text a resumable
-- whole-mailbox backfill persists (D1) — populated only by that path
-- (Phase 4), left NULL for messages that already carry a full `plain_body`
-- from initial/incremental sync.
--
-- `html_presence`: three states, not the two `html_body IS NULL` already
-- gave us. "never fetched" (the normal state of every backfilled message,
-- which must trigger a fetch on open) is indistinguishable from "fetched
-- and genuinely absent" (which must not) under plain nullability — see the
-- Data Models section of the plan. Existing rows default to 'present' or
-- 'absent' via the backfill below, since every message written before this
-- migration was already fetched in full.
ALTER TABLE messages ADD COLUMN truncated_body TEXT;
ALTER TABLE messages ADD COLUMN html_presence TEXT NOT NULL DEFAULT 'never_fetched';
UPDATE messages SET html_presence = CASE WHEN html_body IS NOT NULL THEN 'present' ELSE 'absent' END;

-- Gmail's fixed text/background colour pair, present only on user labels
-- (D10). Both NULL for system labels and for any label predating this
-- migration until the next `labels.list` refresh repopulates them.
ALTER TABLE labels ADD COLUMN color_text TEXT;
ALTER TABLE labels ADD COLUMN color_background TEXT;
