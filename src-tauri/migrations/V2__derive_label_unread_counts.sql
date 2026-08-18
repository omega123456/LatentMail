CREATE INDEX threads_unread ON threads(account_id) WHERE is_unread=1;

ALTER TABLE labels DROP COLUMN unread_count;
