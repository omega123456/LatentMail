CREATE TABLE account_ai_config (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  index_paused INTEGER NOT NULL DEFAULT 0,
  base_url TEXT,
  chat_model TEXT,
  embedding_model TEXT,
  embedding_dimensions INTEGER
);
