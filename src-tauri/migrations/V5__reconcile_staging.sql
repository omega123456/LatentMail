CREATE TABLE reconcile_remote_messages (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  PRIMARY KEY (account_id, message_id)
) WITHOUT ROWID;

CREATE TABLE reconcile_remote_labels (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY (account_id, message_id, label_id)
) WITHOUT ROWID;

CREATE INDEX reconcile_remote_labels_by_account_label_message
  ON reconcile_remote_labels(account_id, label_id, message_id);
