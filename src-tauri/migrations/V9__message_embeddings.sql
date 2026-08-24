CREATE TABLE message_embeddings (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  message_seq INTEGER NOT NULL REFERENCES messages(seq) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  UNIQUE (message_seq, chunk_index)
);
CREATE INDEX message_embeddings_by_account_message ON message_embeddings(account_id, message_seq);
