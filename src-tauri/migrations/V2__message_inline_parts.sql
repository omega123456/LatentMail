-- Raw inline (Content-ID referenced) attachment bytes captured at sync time.
-- Message HTML is stored unsanitized; sanitization (Phase 9's `sanitize`
-- module) happens at `load_conversation` time, right before crossing IPC,
-- using this table to assemble the cid -> bytes map DOMPurify/ammonia need
-- to resolve `cid:` image sources.
CREATE TABLE message_inline_parts (
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  content_id TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (account_id, message_id, content_id),
  FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE
);
