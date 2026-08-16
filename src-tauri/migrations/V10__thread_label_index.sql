-- The mailbox listing filters threads by label but orders them by the
-- thread's `latest_at`. Those two facts live in different tables, so no index
-- over `message_labels`/`threads` can serve both at once: V8's nested-EXISTS
-- form drives from `threads_by_latest` and tests each thread, which is ~1ms
-- for a label most threads carry (Inbox) but degrades to a full scan of every
-- thread for a selective one — measured at 33ms per page over 40k threads,
-- and linear in mailbox size from there. The flat-join/CTE alternative simply
-- inverts which case is pathological (16ms rare, 27ms common).
--
-- `thread_labels` denormalises "this thread has at least one message carrying
-- this label" together with the thread's sort key, so the listing becomes an
-- ordered range scan with LIMIT: no temp B-tree, and no rows touched beyond
-- the page. Both cases measure at 0.03ms.
--
-- Maintained exclusively by `ThreadRepository::write_summary` — the single
-- point every membership-changing path already funnels through to recompute a
-- thread summary, in the same transaction as the change itself. Thread
-- deletion (a thread losing its last message, a full re-sync's wipe, an
-- account removal) is handled by the cascade rather than by that code path.
CREATE TABLE thread_labels (
  account_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  latest_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, label_id, latest_at DESC, thread_id DESC),
  FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE CASCADE
) WITHOUT ROWID;

-- Without this the cascade above rescans the whole table per deleted thread,
-- which would make a full re-sync's `DELETE FROM threads` quadratic.
CREATE INDEX thread_labels_by_thread ON thread_labels(account_id, thread_id);

INSERT INTO thread_labels (account_id, label_id, thread_id, latest_at)
SELECT DISTINCT t.account_id, ml.label_id, t.id, t.latest_at
FROM threads t
JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
JOIN message_labels ml ON ml.account_id = m.account_id AND ml.message_id = m.id;
