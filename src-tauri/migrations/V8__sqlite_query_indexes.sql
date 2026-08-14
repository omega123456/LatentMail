-- Match the indexes to the production read paths. Replacing, rather than
-- stacking, keeps write amplification bounded as mailbox data grows.
DROP INDEX messages_by_thread;
CREATE INDEX messages_by_thread
ON messages(account_id, thread_id, sent_at, id);

-- No production query filters or orders by history_id; the strict history
-- gate addresses rows by their (account_id, id) primary key instead.
DROP INDEX messages_by_history;

DROP INDEX threads_by_latest;
CREATE INDEX threads_by_latest
ON threads(account_id, latest_at DESC, id DESC);

-- Gmail draft ids are stable while message ids change on every draft save.
CREATE INDEX messages_by_draft
ON messages(account_id, draft_id)
WHERE draft_id IS NOT NULL;

DROP INDEX operations_ready;
CREATE INDEX operations_by_account
ON operations(account_id);
CREATE INDEX operations_queued_durable
ON operations(created_at)
WHERE status='queued' AND kind IN ('send','draft');
CREATE INDEX operations_active_sends
ON operations(account_id)
WHERE kind='send' AND status='active';
CREATE INDEX operations_active_drafts
ON operations(id)
WHERE kind='draft' AND status='active';
CREATE INDEX operations_discardable_drafts
ON operations(account_id, entity_key)
WHERE kind='draft' AND status IN ('queued','active');

-- The primary key already covers exact (account_id, address) lookups. This
-- NOCASE variant lets SQLite turn the autocomplete LIKE prefix into a range.
DROP INDEX contacts_lookup;
CREATE INDEX contacts_lookup
ON contacts(account_id, address COLLATE NOCASE);
