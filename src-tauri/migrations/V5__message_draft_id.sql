-- Fixes a bug: draft deletion sent the Gmail *message* id to
-- `DELETE /users/me/drafts/{id}`, but a draft id is a distinct Gmail
-- identifier from its message id — nothing in the schema stored it, so the
-- request 404s against real Gmail. `draft_id` is resolved (via
-- `GmailClient::list_draft_ids`) and cached here the first time a draft
-- message is deleted, then reused directly on every later delete of the
-- same message. Nullable: unpopulated until first resolved, and irrelevant
-- for every non-draft message.
ALTER TABLE messages ADD COLUMN draft_id TEXT;
