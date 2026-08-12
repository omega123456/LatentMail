-- Fixes a data-loss bug: `traversal_cursors` was keyed only by
-- `account_id`, so backfill and reconciliation (ADR: three-lane queue /
-- metadata-first whole-mailbox sync, D3) shared one row. Reconciliation
-- upserting its own progress into that row destroyed an in-progress
-- backfill's `position`/counts, and backfill's guard against a
-- foreign-kind cursor then made every later backfill attempt a silent,
-- permanent no-op. Re-key by (account_id, kind) so each traversal kind
-- owns an independent row and neither can clobber the other's progress.
-- Mutual exclusion between the two traversals is unaffected — it was
-- always the queue's per-account entity lock (`traversal_entity_key`),
-- never this table, that serialized them (D3), and that lock is untouched
-- by this migration.
ALTER TABLE traversal_cursors RENAME TO traversal_cursors_old;

CREATE TABLE traversal_cursors (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  position TEXT,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  persisted_count INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  last_advanced_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, kind)
);

INSERT INTO traversal_cursors (
  account_id, kind, position, discovered_count, persisted_count, completed, last_advanced_at
)
SELECT account_id, kind, position, discovered_count, persisted_count, completed, last_advanced_at
FROM traversal_cursors_old;

DROP TABLE traversal_cursors_old;
