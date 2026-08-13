use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Result};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub id: String,
    pub email: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub history_id: Option<i64>,
    pub needs_reauthentication: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct AccountRepository;
impl AccountRepository {
    pub fn upsert(connection: &Connection, account: &Account) -> Result<()> {
        connection.execute("INSERT INTO accounts (id,email,display_name,avatar_url,history_id,needs_reauthentication,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET email=excluded.email, display_name=excluded.display_name, avatar_url=excluded.avatar_url, history_id=excluded.history_id, needs_reauthentication=excluded.needs_reauthentication, updated_at=excluded.updated_at", params![account.id, account.email, account.display_name, account.avatar_url, account.history_id, account.needs_reauthentication, account.created_at, account.updated_at])?;
        Ok(())
    }
    /// Sets the sync checkpoint directly. Callers are responsible for only
    /// calling this on successful sync completion (never on queue
    /// acceptance, never on failure) — that ordering is what D6/D13 rely on.
    pub fn set_history_id(connection: &Connection, id: &str, history_id: i64) -> Result<()> {
        connection.execute(
            "UPDATE accounts SET history_id=?1, updated_at=strftime('%s','now') WHERE id=?2",
            params![history_id, id],
        )?;
        Ok(())
    }
    pub fn get(connection: &Connection, id: &str) -> Result<Option<Account>> {
        connection.query_row("SELECT id,email,display_name,avatar_url,history_id,needs_reauthentication,created_at,updated_at FROM accounts WHERE id=?1", [id], account).optional()
    }
    pub fn get_by_email(connection: &Connection, email: &str) -> Result<Option<Account>> {
        connection.query_row("SELECT id,email,display_name,avatar_url,history_id,needs_reauthentication,created_at,updated_at FROM accounts WHERE email=?1", [email], account).optional()
    }
    pub fn list(connection: &Connection) -> Result<Vec<Account>> {
        let mut statement = connection.prepare("SELECT id,email,display_name,avatar_url,history_id,needs_reauthentication,created_at,updated_at FROM accounts ORDER BY created_at")?;
        let accounts = statement.query_map([], account)?.collect();
        accounts
    }
}

/// A label's Gmail text/background colour pair (D10). Present only on user
/// labels, never on system labels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabelColor {
    pub text: String,
    pub background: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Label {
    pub account_id: String,
    pub id: String,
    pub name: String,
    pub kind: String,
    pub color: Option<LabelColor>,
    pub message_count: i64,
    pub unread_count: i64,
}

/// Reserved system-label names a user label may not collide with, checked
/// case-insensitively. Gmail's own category labels share this prefix.
const RESERVED_LABEL_PREFIX: &str = "CATEGORY_";
const RESERVED_LABEL_NAMES: &[&str] = &[
    "INBOX",
    "SENT",
    "DRAFT",
    "TRASH",
    "SPAM",
    "STARRED",
    "UNREAD",
    "IMPORTANT",
    "CHAT",
];

/// Every rule a label name can fail is reported distinctly (Phase 3 AC6) —
/// a single generic "invalid name" error would leave the caller unable to
/// say *why* to the user.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum LabelNameError {
    #[error("label name cannot be empty")]
    Empty,
    #[error("label name must be 100 characters or fewer")]
    TooLong,
    #[error("label name cannot start with a reserved system prefix")]
    ReservedPrefix,
    #[error("label name cannot contain \\, *, or %")]
    ForbiddenCharacters,
    #[error("a label with this name already exists")]
    Duplicate,
}

pub struct LabelRepository;
impl LabelRepository {
    pub fn upsert(connection: &Connection, label: &Label) -> Result<()> {
        let (color_text, color_background) = match &label.color {
            Some(color) => (Some(color.text.as_str()), Some(color.background.as_str())),
            None => (None, None),
        };
        connection.execute("INSERT INTO labels (account_id,id,name,kind,color_text,color_background,message_count,unread_count) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(account_id,id) DO UPDATE SET name=excluded.name,kind=excluded.kind,color_text=excluded.color_text,color_background=excluded.color_background,message_count=excluded.message_count,unread_count=excluded.unread_count", params![label.account_id,label.id,label.name,label.kind,color_text,color_background,label.message_count,label.unread_count])?;
        Ok(())
    }
    pub fn list(connection: &Connection, account_id: &str) -> Result<Vec<Label>> {
        let mut statement = connection.prepare("SELECT account_id,id,name,kind,color_text,color_background,message_count,unread_count FROM labels WHERE account_id=?1 ORDER BY name")?;
        let labels = statement.query_map([account_id], label)?.collect();
        labels
    }
    pub fn get(connection: &Connection, account_id: &str, id: &str) -> Result<Option<Label>> {
        connection.query_row("SELECT account_id,id,name,kind,color_text,color_background,message_count,unread_count FROM labels WHERE account_id=?1 AND id=?2", params![account_id, id], label).optional()
    }
    /// Inserts a minimal placeholder row for `id` if one doesn't already
    /// exist. `message_labels` has a foreign key onto `labels`, and Gmail
    /// message payloads can reference a label id (a category label, or a
    /// system label like `UNREAD`/`STARRED` in an edge case) that hasn't
    /// come back from a `labels.list` call yet in the same sync run —
    /// without this, that message's membership write would violate the FK.
    /// A subsequent `labels.list` refresh upserts the real name/counts over
    /// this placeholder.
    pub fn ensure_placeholder(connection: &Connection, account_id: &str, id: &str) -> Result<()> {
        connection.execute(
            "INSERT OR IGNORE INTO labels (account_id,id,name,kind,color_text,color_background,message_count,unread_count) VALUES (?1,?2,?2,'system',NULL,NULL,0,0)",
            params![account_id, id],
        )?;
        Ok(())
    }
    /// Trims and validates a candidate label name against every rule in one
    /// pass, checking case-insensitive uniqueness within the account
    /// (excluding `exclude_id`, so renaming a label to its own current name
    /// succeeds). Returns the trimmed name on success — callers should
    /// persist that, not the raw input.
    pub fn validate_name(
        connection: &Connection,
        account_id: &str,
        name: &str,
        exclude_id: Option<&str>,
    ) -> Result<String, LabelNameError> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(LabelNameError::Empty);
        }
        if trimmed.chars().count() > 100 {
            return Err(LabelNameError::TooLong);
        }
        if trimmed.contains(['\\', '*', '%']) {
            return Err(LabelNameError::ForbiddenCharacters);
        }
        let upper = trimmed.to_ascii_uppercase();
        if upper.starts_with(RESERVED_LABEL_PREFIX)
            || RESERVED_LABEL_NAMES.contains(&upper.as_str())
        {
            return Err(LabelNameError::ReservedPrefix);
        }
        let existing: Vec<String> = Self::list(connection, account_id)
            .unwrap_or_default()
            .into_iter()
            .filter(|existing| Some(existing.id.as_str()) != exclude_id)
            .map(|existing| existing.name)
            .collect();
        if existing
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(trimmed))
        {
            return Err(LabelNameError::Duplicate);
        }
        Ok(trimmed.to_owned())
    }
    pub fn rename(connection: &Connection, account_id: &str, id: &str, name: &str) -> Result<()> {
        connection.execute(
            "UPDATE labels SET name=?1 WHERE account_id=?2 AND id=?3",
            params![name, account_id, id],
        )?;
        Ok(())
    }
    pub fn set_color(
        connection: &Connection,
        account_id: &str,
        id: &str,
        color: Option<&LabelColor>,
    ) -> Result<()> {
        let (color_text, color_background) = match color {
            Some(color) => (Some(color.text.as_str()), Some(color.background.as_str())),
            None => (None, None),
        };
        connection.execute(
            "UPDATE labels SET color_text=?1, color_background=?2 WHERE account_id=?3 AND id=?4",
            params![color_text, color_background, account_id, id],
        )?;
        Ok(())
    }
    /// Removes the label and, via `ON DELETE CASCADE`, every message's
    /// membership in it. Never touches the messages themselves.
    pub fn delete(connection: &Connection, account_id: &str, id: &str) -> Result<()> {
        connection.execute(
            "DELETE FROM labels WHERE account_id=?1 AND id=?2",
            params![account_id, id],
        )?;
        Ok(())
    }
}

/// The HTML-presence marker's three states (Phase 3): whether a message's
/// full HTML body has ever been fetched, and if so whether Gmail actually
/// had one to give. Plain `Option<String>` nullability on `html_body` alone
/// cannot distinguish "never fetched" (the normal state of a backfilled
/// message, which must trigger a fetch) from "fetched and genuinely empty"
/// (which must not) — see the plan's Data Models section.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HtmlPresence {
    NeverFetched,
    Present,
    Absent,
}
impl HtmlPresence {
    fn as_db_str(self) -> &'static str {
        match self {
            Self::NeverFetched => "never_fetched",
            Self::Present => "present",
            Self::Absent => "absent",
        }
    }
    fn from_db_str(value: &str) -> Self {
        match value {
            "present" => Self::Present,
            "absent" => Self::Absent,
            _ => Self::NeverFetched,
        }
    }
    /// Derives presence from whether a just-fetched message carried an HTML
    /// part — used by every code path that fetches a message in full
    /// (`format` always includes `payload`, so presence is always known at
    /// that point, never "never fetched").
    pub fn from_fetched_body(html_body: Option<&str>) -> Self {
        if html_body.is_some() {
            Self::Present
        } else {
            Self::Absent
        }
    }
}

/// Caps plain text at 10,000 characters (D1), preferring the `text/plain`
/// part and falling back to tag-stripped HTML only when no plain-text part
/// exists. A pure function so it's testable independent of any Gmail fetch
/// or storage write.
pub fn truncate_body(plain: Option<&str>, html: Option<&str>) -> Option<String> {
    const MAX_CHARS: usize = 10_000;
    let source = plain.map(str::to_owned).or_else(|| html.map(strip_tags))?;
    Some(source.chars().take(MAX_CHARS).collect())
}

fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub account_id: String,
    pub id: String,
    pub thread_id: String,
    pub rfc_message_id: Option<String>,
    pub sender: String,
    pub recipients: String,
    pub subject: String,
    pub sent_at: i64,
    pub snippet: String,
    pub html_body: Option<String>,
    pub plain_body: Option<String>,
    pub has_attachments: bool,
    pub is_unread: bool,
    pub is_starred: bool,
    pub history_id: i64,
    pub truncated_body: Option<String>,
    pub html_presence: HtmlPresence,
}
pub struct MessageRepository;
impl MessageRepository {
    pub fn recipient_roles(
        connection: &Connection,
        account_id: &str,
        id: &str,
    ) -> Result<(String, String, String)> {
        connection.query_row(
            "SELECT to_recipients,cc_recipients,bcc_recipients FROM messages WHERE account_id=?1 AND id=?2",
            params![account_id, id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
    }
    pub fn set_recipient_roles(
        connection: &Connection,
        account_id: &str,
        id: &str,
        to: &str,
        cc: &str,
        bcc: &str,
        references: Option<&str>,
    ) -> Result<()> {
        connection.execute(
            "UPDATE messages SET to_recipients=?1,cc_recipients=?2,bcc_recipients=?3,rfc_references=?4 WHERE account_id=?5 AND id=?6",
            params![to, cc, bcc, references, account_id, id],
        )?;
        Ok(())
    }
    pub fn write_full_state(connection: &Connection, message: &Message) -> Result<bool> {
        let changed = connection.execute("INSERT INTO messages (account_id,id,thread_id,rfc_message_id,sender,recipients,subject,sent_at,snippet,html_body,plain_body,has_attachments,is_unread,is_starred,history_id,truncated_body,html_presence) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17) ON CONFLICT(account_id,id) DO UPDATE SET thread_id=excluded.thread_id,rfc_message_id=excluded.rfc_message_id,sender=excluded.sender,recipients=excluded.recipients,subject=excluded.subject,sent_at=excluded.sent_at,snippet=excluded.snippet,html_body=excluded.html_body,plain_body=excluded.plain_body,has_attachments=excluded.has_attachments,is_unread=excluded.is_unread,is_starred=excluded.is_starred,history_id=excluded.history_id,truncated_body=excluded.truncated_body,html_presence=excluded.html_presence WHERE excluded.history_id > messages.history_id", params![message.account_id,message.id,message.thread_id,message.rfc_message_id,message.sender,message.recipients,message.subject,message.sent_at,message.snippet,message.html_body,message.plain_body,message.has_attachments,message.is_unread,message.is_starred,message.history_id,message.truncated_body,message.html_presence.as_db_str()])?;
        Ok(changed == 1)
    }
    pub fn get(connection: &Connection, account_id: &str, id: &str) -> Result<Option<Message>> {
        connection.query_row("SELECT account_id,id,thread_id,rfc_message_id,sender,recipients,subject,sent_at,snippet,html_body,plain_body,has_attachments,is_unread,is_starred,history_id,truncated_body,html_presence FROM messages WHERE account_id=?1 AND id=?2", params![account_id,id], message).optional()
    }
    pub fn list_by_thread(
        connection: &Connection,
        account_id: &str,
        thread_id: &str,
    ) -> Result<Vec<Message>> {
        let mut statement = connection.prepare("SELECT account_id,id,thread_id,rfc_message_id,sender,recipients,subject,sent_at,snippet,html_body,plain_body,has_attachments,is_unread,is_starred,history_id,truncated_body,html_presence FROM messages WHERE account_id=?1 AND thread_id=?2 ORDER BY sent_at")?;
        let messages = statement
            .query_map(params![account_id, thread_id], message)?
            .collect();
        messages
    }
    /// Every locally stored message id for an account — the universe
    /// reconciliation's server-diff (Phase 5) compares against. No existing
    /// method provided this: the old expired-checkpoint path deleted
    /// unconditionally and never needed to know what it already had.
    pub fn all_ids(connection: &Connection, account_id: &str) -> Result<Vec<String>> {
        let mut statement =
            connection.prepare("SELECT id FROM messages WHERE account_id=?1 ORDER BY id")?;
        let ids = statement
            .query_map([account_id], |row| row.get(0))?
            .collect();
        ids
    }
    /// Cheap membership check for one id — what incremental sync's Inbox
    /// freshness probe (`sync::probe_inbox`) filters listed ids through so
    /// only genuinely unknown ones cost a `messages.get`. Deliberately not
    /// [`Self::all_ids`]: that loads every id in the mailbox (tens of
    /// thousands) to answer a question about at most one page's worth.
    pub fn exists(connection: &Connection, account_id: &str, id: &str) -> Result<bool> {
        connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE account_id=?1 AND id=?2)",
            params![account_id, id],
            |row| row.get(0),
        )
    }
    /// Traversal's own upsert (D1/Phase 4): writes the metadata and
    /// truncated body a whole-mailbox backfill/reconciliation fetch
    /// discovers for a message. Unlike [`Self::write_full_state`], this
    /// **never touches `html_body`, `plain_body` or `html_presence` on a
    /// row that already exists** — those columns may already hold real
    /// content fetched by initial/incremental sync or the lazy open-time
    /// fetch (Phase 6), and a whole-mailbox traversal re-encountering that
    /// same message (which it always will, for every message initial sync
    /// already pulled into Inbox) must never downgrade it back to
    /// truncated-only. A brand-new row is inserted with the caller's
    /// `html_presence` (always [`HtmlPresence::NeverFetched`] for a
    /// traversal-only fetch), which is the normal state of a message
    /// backfill alone has ever seen. Gated by the same strict
    /// `history_id`-freshness rule as every other write path.
    pub fn write_traversal_state(connection: &Connection, message: &Message) -> Result<bool> {
        let changed = connection.execute(
            "INSERT INTO messages (account_id,id,thread_id,rfc_message_id,sender,recipients,subject,sent_at,snippet,html_body,plain_body,has_attachments,is_unread,is_starred,history_id,truncated_body,html_presence)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL,NULL,?10,?11,?12,?13,?14,?15)
             ON CONFLICT(account_id,id) DO UPDATE SET
               thread_id=excluded.thread_id,
               rfc_message_id=excluded.rfc_message_id,
               sender=excluded.sender,
               recipients=excluded.recipients,
               subject=excluded.subject,
               sent_at=excluded.sent_at,
               snippet=excluded.snippet,
               has_attachments=excluded.has_attachments,
               is_unread=excluded.is_unread,
               is_starred=excluded.is_starred,
               history_id=excluded.history_id,
               truncated_body=excluded.truncated_body
             WHERE excluded.history_id > messages.history_id",
            params![
                message.account_id,
                message.id,
                message.thread_id,
                message.rfc_message_id,
                message.sender,
                message.recipients,
                message.subject,
                message.sent_at,
                message.snippet,
                message.has_attachments,
                message.is_unread,
                message.is_starred,
                message.history_id,
                message.truncated_body,
                message.html_presence.as_db_str()
            ],
        )?;
        Ok(changed == 1)
    }
    /// The Gmail draft id resolved and cached for this message (V5), if any
    /// — distinct from the message's own id, and only ever set for a
    /// message carrying the `DRAFT` label. See
    /// [`Self::set_draft_id`]/`sync::mutations::delete_draft` for how it's
    /// populated and consumed.
    pub fn draft_id(connection: &Connection, account_id: &str, id: &str) -> Result<Option<String>> {
        connection
            .query_row(
                "SELECT draft_id FROM messages WHERE account_id=?1 AND id=?2",
                params![account_id, id],
                |row| row.get(0),
            )
            .optional()
            .map(Option::flatten)
    }
    pub fn set_draft_id(
        connection: &Connection,
        account_id: &str,
        id: &str,
        draft_id: &str,
    ) -> Result<()> {
        connection.execute(
            "UPDATE messages SET draft_id=?1 WHERE account_id=?2 AND id=?3",
            params![draft_id, account_id, id],
        )?;
        Ok(())
    }
    pub fn set_truncated_body(
        connection: &Connection,
        account_id: &str,
        id: &str,
        truncated_body: Option<&str>,
    ) -> Result<()> {
        connection.execute(
            "UPDATE messages SET truncated_body=?1 WHERE account_id=?2 AND id=?3",
            params![truncated_body, account_id, id],
        )?;
        Ok(())
    }
    pub fn set_html_body(
        connection: &Connection,
        account_id: &str,
        id: &str,
        html_body: Option<&str>,
        presence: HtmlPresence,
    ) -> Result<()> {
        connection.execute(
            "UPDATE messages SET html_body=?1, html_presence=?2 WHERE account_id=?3 AND id=?4",
            params![html_body, presence.as_db_str(), account_id, id],
        )?;
        Ok(())
    }
    /// Replaces a message's entire label membership set with exactly
    /// `label_ids`, maintaining the denormalised `is_unread`/`is_starred`
    /// columns via the same [`Self::set_label_membership`] every other
    /// mutation path uses — so bulk reconciliation overwrite (Phase 5) and
    /// thread recomputation never drift from actual membership (Phase 3
    /// AC5).
    pub fn overwrite_membership(
        connection: &Connection,
        account_id: &str,
        message_id: &str,
        label_ids: &[String],
    ) -> Result<()> {
        let current: HashSet<String> = Self::label_ids(connection, account_id, message_id)?
            .into_iter()
            .collect();
        let desired: HashSet<String> = label_ids.iter().cloned().collect();
        for label in current.difference(&desired) {
            Self::set_label_membership(connection, account_id, message_id, label, false)?;
        }
        for label in desired.difference(&current) {
            Self::set_label_membership(connection, account_id, message_id, label, true)?;
        }
        Ok(())
    }
    pub fn write_mutation_history(
        connection: &Connection,
        account_id: &str,
        ids: &[String],
        history_id: i64,
    ) -> Result<usize> {
        let mut statement = connection.prepare(
            "UPDATE messages SET history_id=?1 WHERE account_id=?2 AND id=?3 AND history_id < ?1",
        )?;
        ids.iter().try_fold(0, |count, id| {
            statement
                .execute(params![history_id, account_id, id])
                .map(|changed| count + changed)
        })
    }
    pub fn set_label_membership(
        connection: &Connection,
        account_id: &str,
        message_id: &str,
        label_id: &str,
        present: bool,
    ) -> Result<()> {
        if present {
            connection.execute("INSERT OR IGNORE INTO message_labels (account_id,message_id,label_id) VALUES (?1,?2,?3)", params![account_id,message_id,label_id])?;
        } else {
            connection.execute(
                "DELETE FROM message_labels WHERE account_id=?1 AND message_id=?2 AND label_id=?3",
                params![account_id, message_id, label_id],
            )?;
        }
        if matches!(label_id, "UNREAD" | "STARRED") {
            let column = if label_id == "UNREAD" {
                "is_unread"
            } else {
                "is_starred"
            };
            connection.execute(
                &format!("UPDATE messages SET {column}=?1 WHERE account_id=?2 AND id=?3"),
                params![present, account_id, message_id],
            )?;
        }
        Ok(())
    }
    /// Removes a message (and, via `ON DELETE CASCADE`, its label
    /// memberships and inline parts). Returns the message's `thread_id` so
    /// callers can recompute that thread's summary, or `None` if the
    /// message was already gone.
    pub fn delete(connection: &Connection, account_id: &str, id: &str) -> Result<Option<String>> {
        let thread_id: Option<String> = connection
            .query_row(
                "SELECT thread_id FROM messages WHERE account_id=?1 AND id=?2",
                params![account_id, id],
                |row| row.get(0),
            )
            .optional()?;
        if thread_id.is_some() {
            connection.execute(
                "DELETE FROM messages WHERE account_id=?1 AND id=?2",
                params![account_id, id],
            )?;
        }
        Ok(thread_id)
    }
    pub fn label_ids(connection: &Connection, account_id: &str, id: &str) -> Result<Vec<String>> {
        let mut statement = connection.prepare(
            "SELECT label_id FROM message_labels WHERE account_id=?1 AND message_id=?2 ORDER BY label_id",
        )?;
        let labels = statement
            .query_map(params![account_id, id], |row| row.get(0))?
            .collect();
        labels
    }
    /// Replaces the stored inline (Content-ID) parts for a message with the
    /// set observed in the latest full-state fetch. Delete-then-insert
    /// rather than a diff — inline parts are small and only refreshed on a
    /// full message fetch, never partially.
    pub fn replace_inline_parts(
        connection: &Connection,
        account_id: &str,
        message_id: &str,
        parts: &[InlinePart],
    ) -> Result<()> {
        connection.execute(
            "DELETE FROM message_inline_parts WHERE account_id=?1 AND message_id=?2",
            params![account_id, message_id],
        )?;
        for part in parts {
            connection.execute(
                "INSERT INTO message_inline_parts (account_id,message_id,content_id,mime_type,bytes) VALUES (?1,?2,?3,?4,?5)",
                params![account_id, message_id, part.content_id, part.mime_type, part.bytes],
            )?;
        }
        Ok(())
    }
    pub fn inline_parts(
        connection: &Connection,
        account_id: &str,
        message_id: &str,
    ) -> Result<Vec<InlinePart>> {
        let mut statement = connection.prepare("SELECT content_id,mime_type,bytes FROM message_inline_parts WHERE account_id=?1 AND message_id=?2")?;
        let parts = statement
            .query_map(params![account_id, message_id], |row| {
                Ok(InlinePart {
                    content_id: row.get(0)?,
                    mime_type: row.get(1)?,
                    bytes: row.get(2)?,
                })
            })?
            .collect();
        parts
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposeDraftMetadata {
    pub account_id: String,
    pub draft_id: String,
    pub mode: String,
    pub original_message_id: Option<String>,
    pub original_gmail_message_id: Option<String>,
    pub target_thread_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub rfc_references: Option<String>,
    pub boundary_version: i64,
    pub editable_body_fingerprint: Option<String>,
    pub quote_html: Option<String>,
    pub quote_plain: Option<String>,
}

pub struct ComposeDraftMetadataRepository;
impl ComposeDraftMetadataRepository {
    pub fn upsert(connection: &Connection, metadata: &ComposeDraftMetadata) -> Result<()> {
        connection.execute("INSERT INTO compose_draft_metadata (account_id,draft_id,mode,original_message_id,original_gmail_message_id,target_thread_id,in_reply_to,rfc_references,boundary_version,editable_body_fingerprint,quote_html,quote_plain) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT(account_id,draft_id) DO UPDATE SET mode=excluded.mode,original_message_id=excluded.original_message_id,original_gmail_message_id=excluded.original_gmail_message_id,target_thread_id=excluded.target_thread_id,in_reply_to=excluded.in_reply_to,rfc_references=excluded.rfc_references,boundary_version=excluded.boundary_version,editable_body_fingerprint=excluded.editable_body_fingerprint,quote_html=excluded.quote_html,quote_plain=excluded.quote_plain", params![metadata.account_id,metadata.draft_id,metadata.mode,metadata.original_message_id,metadata.original_gmail_message_id,metadata.target_thread_id,metadata.in_reply_to,metadata.rfc_references,metadata.boundary_version,metadata.editable_body_fingerprint,metadata.quote_html,metadata.quote_plain])?;
        Ok(())
    }
    pub fn get(
        connection: &Connection,
        account_id: &str,
        draft_id: &str,
    ) -> Result<Option<ComposeDraftMetadata>> {
        connection.query_row("SELECT account_id,draft_id,mode,original_message_id,original_gmail_message_id,target_thread_id,in_reply_to,rfc_references,boundary_version,editable_body_fingerprint,quote_html,quote_plain FROM compose_draft_metadata WHERE account_id=?1 AND draft_id=?2", params![account_id,draft_id], |row| Ok(ComposeDraftMetadata { account_id: row.get(0)?, draft_id: row.get(1)?, mode: row.get(2)?, original_message_id: row.get(3)?, original_gmail_message_id: row.get(4)?, target_thread_id: row.get(5)?, in_reply_to: row.get(6)?, rfc_references: row.get(7)?, boundary_version: row.get(8)?, editable_body_fingerprint: row.get(9)?, quote_html: row.get(10)?, quote_plain: row.get(11)? })).optional()
    }
    pub fn remove(connection: &Connection, account_id: &str, draft_id: &str) -> Result<()> {
        connection.execute(
            "DELETE FROM compose_draft_metadata WHERE account_id=?1 AND draft_id=?2",
            params![account_id, draft_id],
        )?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlinePart {
    pub content_id: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thread {
    pub account_id: String,
    pub id: String,
    pub subject: String,
    pub participants: String,
    pub latest_at: i64,
    pub message_count: i64,
    pub is_unread: bool,
    pub is_starred: bool,
    pub has_attachments: bool,
    pub has_draft: bool,
}
pub struct ThreadRepository;
impl ThreadRepository {
    pub fn row_details(
        connection: &Connection,
        account_id: &str,
        thread_id: &str,
    ) -> Result<(String, Vec<String>)> {
        let snippet = connection.query_row(
            "SELECT snippet FROM messages WHERE account_id=?1 AND thread_id=?2 ORDER BY sent_at DESC, id DESC LIMIT 1",
            params![account_id, thread_id],
            |row| row.get(0),
        ).optional()?.unwrap_or_default();
        let mut statement = connection.prepare(
            "SELECT DISTINCT l.name FROM labels l JOIN message_labels ml ON ml.account_id=l.account_id AND ml.label_id=l.id JOIN messages m ON m.account_id=ml.account_id AND m.id=ml.message_id WHERE m.account_id=?1 AND m.thread_id=?2 AND l.kind='user' ORDER BY l.name",
        )?;
        let label_indicators = statement
            .query_map(params![account_id, thread_id], |row| row.get(0))?
            .collect::<Result<Vec<String>>>()?;
        Ok((snippet, label_indicators))
    }
    pub fn upsert(connection: &Connection, thread: &Thread) -> Result<()> {
        connection.execute("INSERT INTO threads (account_id,id,subject,participants,latest_at,message_count,is_unread,is_starred,has_attachments,has_draft) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(account_id,id) DO UPDATE SET subject=excluded.subject,participants=excluded.participants,latest_at=excluded.latest_at,message_count=excluded.message_count,is_unread=excluded.is_unread,is_starred=excluded.is_starred,has_attachments=excluded.has_attachments,has_draft=excluded.has_draft", params![thread.account_id,thread.id,thread.subject,thread.participants,thread.latest_at,thread.message_count,thread.is_unread,thread.is_starred,thread.has_attachments,thread.has_draft])?;
        Ok(())
    }
    pub fn get(connection: &Connection, account_id: &str, id: &str) -> Result<Option<Thread>> {
        connection.query_row("SELECT account_id,id,subject,participants,latest_at,message_count,is_unread,is_starred,has_attachments,has_draft FROM threads WHERE account_id=?1 AND id=?2", params![account_id,id], thread).optional()
    }
    /// Recomputes one thread's aggregate summary from its current messages,
    /// or removes the thread row entirely once it has none left. Callers
    /// invoke this once per touched `thread_id` after applying a batch of
    /// message/label writes, rather than keeping counters incrementally in
    /// sync (aggregation from source rows can't drift).
    pub fn recompute(connection: &Connection, account_id: &str, thread_id: &str) -> Result<()> {
        let mut statement = connection.prepare("SELECT sender,subject,sent_at,has_attachments,is_unread,is_starred FROM messages WHERE account_id=?1 AND thread_id=?2 ORDER BY sent_at")?;
        let rows: Vec<(String, String, i64, bool, bool, bool)> = statement
            .query_map(params![account_id, thread_id], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })?
            .collect::<Result<_>>()?;
        if rows.is_empty() {
            connection.execute(
                "DELETE FROM threads WHERE account_id=?1 AND id=?2",
                params![account_id, thread_id],
            )?;
            return Ok(());
        }
        let mut participants = Vec::new();
        let (mut is_unread, mut is_starred, mut has_attachments) = (false, false, false);
        for (sender, _, _, attachments, unread, starred) in &rows {
            if !participants.contains(sender) {
                participants.push(sender.clone());
            }
            is_unread |= unread;
            is_starred |= starred;
            has_attachments |= attachments;
        }
        let (_, subject, latest_at, _, _, _) = rows.last().expect("checked non-empty above");
        let has_draft: bool = connection.query_row(
            // Nested for the same reason as `list_paginated`'s label filter:
            // a flat join drives from the label's whole membership instead of
            // the thread's own messages.
            "SELECT EXISTS(SELECT 1 FROM messages m WHERE m.account_id=?1 AND m.thread_id=?2 AND EXISTS(SELECT 1 FROM message_labels ml WHERE ml.account_id=m.account_id AND ml.message_id=m.id AND ml.label_id='DRAFT'))",
            params![account_id, thread_id],
            |row| row.get(0),
        )?;
        Self::upsert(
            connection,
            &Thread {
                account_id: account_id.to_owned(),
                id: thread_id.to_owned(),
                subject: subject.clone(),
                participants: participants.join(", "),
                latest_at: *latest_at,
                message_count: rows.len() as i64,
                is_unread,
                is_starred,
                has_attachments,
                has_draft,
            },
        )
    }
    /// Cursor-paginated, newest first, optionally filtered to threads that
    /// have at least one message carrying `label_id`.
    pub fn list_paginated(
        connection: &Connection,
        account_id: &str,
        label_id: Option<&str>,
        cursor: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<Thread>> {
        let (cursor_at, cursor_id) = match cursor {
            Some((at, id)) => (Some(at), Some(id)),
            None => (None, None),
        };
        let mut statement = connection.prepare(
            "SELECT t.account_id,t.id,t.subject,t.participants,t.latest_at,t.message_count,t.is_unread,t.is_starred,t.has_attachments,t.has_draft
             FROM threads t
             WHERE t.account_id=?1
               -- Nested rather than a flat join ON PURPOSE. A flat join lets
               -- SQLite drive the label filter from `message_labels_by_label`
               -- (account_id, label_id), which enumerates *every* message
               -- carrying the label and probes each one's `thread_id` — so a
               -- thread that does not carry the label costs a full walk of
               -- the label's entire membership, once per thread scanned. On a
               -- backfilled mailbox (4.5k Inbox messages, 5.6k threads) that
               -- turned this one query into 5.5s, which the UI experienced as
               -- new mail appearing ~40s after a sync had already stored it.
               -- Nesting forces the messages-by-thread index first and reduces
               -- the label test to a primary-key probe: same rows, ~0.02s.
               AND (?2 IS NULL OR EXISTS(
                 SELECT 1 FROM messages m
                 WHERE m.account_id=t.account_id AND m.thread_id=t.id
                   AND EXISTS(
                     SELECT 1 FROM message_labels ml
                     WHERE ml.account_id=m.account_id AND ml.message_id=m.id AND ml.label_id=?2
                   )
               ))
               AND (?3 IS NULL OR t.latest_at<?3 OR (t.latest_at=?3 AND t.id<?4))
             ORDER BY t.latest_at DESC, t.id DESC
             LIMIT ?5",
        )?;
        let threads = statement
            .query_map(
                params![account_id, label_id, cursor_at, cursor_id, limit],
                thread,
            )?
            .collect();
        threads
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Operation {
    pub id: String,
    pub account_id: String,
    pub lane: String,
    pub kind: String,
    pub entity_key: String,
    pub payload: String,
    pub status: String,
    pub attempts: i64,
    pub next_attempt_at: Option<i64>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}
pub struct OperationRepository;
impl OperationRepository {
    pub fn upsert(connection: &Connection, operation: &Operation) -> Result<()> {
        connection.execute("INSERT INTO operations (id,account_id,lane,kind,entity_key,payload,status,attempts,next_attempt_at,error,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT(id) DO UPDATE SET lane=excluded.lane,kind=excluded.kind,entity_key=excluded.entity_key,payload=excluded.payload,status=excluded.status,attempts=excluded.attempts,next_attempt_at=excluded.next_attempt_at,error=excluded.error,updated_at=excluded.updated_at", params![operation.id,operation.account_id,operation.lane,operation.kind,operation.entity_key,operation.payload,operation.status,operation.attempts,operation.next_attempt_at,operation.error,operation.created_at,operation.updated_at])?;
        Ok(())
    }
    pub fn get(connection: &Connection, id: &str) -> Result<Option<Operation>> {
        connection.query_row("SELECT id,account_id,lane,kind,entity_key,payload,status,attempts,next_attempt_at,error,created_at,updated_at FROM operations WHERE id=?1", [id], operation).optional()
    }
    pub fn pending_durable(connection: &Connection) -> Result<Vec<Operation>> {
        let mut statement = connection.prepare("SELECT id,account_id,lane,kind,entity_key,payload,status,attempts,next_attempt_at,error,created_at,updated_at FROM operations WHERE kind IN ('send','draft') AND status='queued' ORDER BY created_at")?;
        let operations = statement.query_map([], operation)?.collect();
        operations
    }
    /// Flips every send stuck `active` (interrupted mid-promotion — it may
    /// have delivered and may have consumed its draft) to a terminal,
    /// non-retried `failed`/uncertain state, returning the distinct account
    /// ids affected so the caller can schedule exactly one reconciling sync
    /// per account and emit `send://uncertain` (see
    /// `queue::recover_durable_operations`). A `queued` send never started
    /// and is safe to recover ordinarily via [`Self::pending_durable`].
    pub fn mark_interrupted_sends_uncertain(connection: &Connection) -> Result<Vec<String>> {
        let mut statement = connection.prepare(
            "SELECT DISTINCT account_id FROM operations WHERE kind='send' AND status='active'",
        )?;
        let accounts = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>>>()?;
        connection.execute("UPDATE operations SET status='failed', error='May have been sent; retry manually', updated_at=strftime('%s','now') WHERE kind='send' AND status='active'", [])?;
        Ok(accounts)
    }
    /// A draft interrupted mid-execution (crash/kill while `active`) is safe
    /// to retry — create/update are idempotent from Gmail's perspective, and
    /// recovery rebuilds the request from the persisted manifest rather than
    /// any in-memory closure — so it is simply requeued for
    /// [`Self::pending_durable`] to pick back up.
    pub fn requeue_interrupted_drafts(connection: &Connection) -> Result<usize> {
        connection.execute("UPDATE operations SET status='queued', updated_at=strftime('%s','now') WHERE kind='draft' AND status='active'", [])
    }
    pub fn mark_active(connection: &Connection, id: &str) -> Result<()> {
        connection.execute(
            "UPDATE operations SET status='active', updated_at=strftime('%s','now') WHERE id=?1",
            params![id],
        )?;
        Ok(())
    }
    /// Persists a completed operation's terminal state — `done`, `failed` or
    /// `superseded` (coalesced away by a newer save for the same session).
    pub fn mark_terminal(
        connection: &Connection,
        id: &str,
        status: &str,
        error: Option<&str>,
    ) -> Result<()> {
        connection.execute(
            "UPDATE operations SET status=?2, error=?3, updated_at=strftime('%s','now') WHERE id=?1",
            params![id, status, error],
        )?;
        Ok(())
    }
    pub fn remove(connection: &Connection, id: &str) -> Result<()> {
        connection.execute("DELETE FROM operations WHERE id=?1", params![id])?;
        Ok(())
    }
    /// Cancels every not-yet-confirmed create for a compose session. Active
    /// executors observe `discarded` after Gmail returns and delete that
    /// just-created draft before exposing it to the rest of the app.
    pub fn discard_session_creates(
        connection: &Connection,
        account_id: &str,
        session_id: &str,
    ) -> Result<()> {
        connection.execute(
            "UPDATE operations SET status='discarded', updated_at=strftime('%s','now') WHERE account_id=?1 AND kind='draft' AND entity_key=?2 AND status IN ('queued','active')",
            params![account_id, session_id],
        )?;
        Ok(())
    }
}

pub struct SettingRepository;
impl SettingRepository {
    pub fn set(connection: &Connection, key: &str, value: &str) -> Result<()> {
        connection.execute("INSERT INTO settings (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value])?;
        Ok(())
    }
    pub fn get(connection: &Connection, key: &str) -> Result<Option<String>> {
        connection
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |row| {
                row.get(0)
            })
            .optional()
    }
    pub fn list(connection: &Connection) -> Result<Vec<(String, String)>> {
        let mut statement = connection.prepare("SELECT key,value FROM settings")?;
        let settings = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect();
        settings
    }
}

/// Which whole-mailbox traversal produced a cursor row. Fully defined here
/// (including `Reconciliation`) even though reconciliation itself doesn't
/// exist yet (Phase 5) — Phase 6 needs to render reconciliation wording
/// without depending on that phase landing first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TraversalKind {
    Backfill,
    Reconciliation,
}
impl TraversalKind {
    fn as_db_str(self) -> &'static str {
        match self {
            Self::Backfill => "backfill",
            Self::Reconciliation => "reconciliation",
        }
    }
    fn from_db_str(value: &str) -> Self {
        match value {
            "reconciliation" => Self::Reconciliation,
            _ => Self::Backfill,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraversalCursor {
    pub account_id: String,
    pub kind: TraversalKind,
    pub position: Option<String>,
    pub discovered_count: i64,
    pub persisted_count: i64,
    pub completed: bool,
    pub last_advanced_at: i64,
    /// Snapshotted once per logical run (migration
    /// `V6__traversal_cursor_resumed_flag`) — whether this row already had a
    /// saved checkpoint `position` at the moment the current run began, not
    /// whether `position` happens to be non-null right now. See
    /// `sync::traversal::run_backfill_step`'s documentation.
    pub resumed: bool,
}

/// Backfill and reconciliation each own an independent row, keyed by
/// `(account_id, kind)` — see migration `V4__traversal_cursor_composite_key`.
/// A reconciliation pass's checkpoint writes can therefore never clobber an
/// in-progress backfill's `position`/counts (or vice versa); the two
/// traversals remain mutually exclusive only via the queue's per-account
/// entity lock (`traversal::traversal_entity_key`, D3), not via this table.
pub struct TraversalCursorRepository;
impl TraversalCursorRepository {
    pub fn upsert(connection: &Connection, cursor: &TraversalCursor) -> Result<()> {
        connection.execute(
            "INSERT INTO traversal_cursors (account_id,kind,position,discovered_count,persisted_count,completed,last_advanced_at,resumed) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(account_id,kind) DO UPDATE SET position=excluded.position,discovered_count=excluded.discovered_count,persisted_count=excluded.persisted_count,completed=excluded.completed,last_advanced_at=excluded.last_advanced_at,resumed=excluded.resumed",
            params![
                cursor.account_id,
                cursor.kind.as_db_str(),
                cursor.position,
                cursor.discovered_count,
                cursor.persisted_count,
                cursor.completed,
                cursor.last_advanced_at,
                cursor.resumed
            ],
        )?;
        Ok(())
    }
    pub fn get(
        connection: &Connection,
        account_id: &str,
        kind: TraversalKind,
    ) -> Result<Option<TraversalCursor>> {
        connection
            .query_row(
                "SELECT account_id,kind,position,discovered_count,persisted_count,completed,last_advanced_at,resumed FROM traversal_cursors WHERE account_id=?1 AND kind=?2",
                params![account_id, kind.as_db_str()],
                |row| {
                    let kind: String = row.get(1)?;
                    Ok(TraversalCursor {
                        account_id: row.get(0)?,
                        kind: TraversalKind::from_db_str(&kind),
                        position: row.get(2)?,
                        discovered_count: row.get(3)?,
                        persisted_count: row.get(4)?,
                        completed: row.get(5)?,
                        last_advanced_at: row.get(6)?,
                        resumed: row.get(7)?,
                    })
                },
            )
            .optional()
    }
    pub fn delete(connection: &Connection, account_id: &str, kind: TraversalKind) -> Result<()> {
        connection.execute(
            "DELETE FROM traversal_cursors WHERE account_id=?1 AND kind=?2",
            params![account_id, kind.as_db_str()],
        )?;
        Ok(())
    }
}

fn account(row: &rusqlite::Row<'_>) -> Result<Account> {
    Ok(Account {
        id: row.get(0)?,
        email: row.get(1)?,
        display_name: row.get(2)?,
        avatar_url: row.get(3)?,
        history_id: row.get(4)?,
        needs_reauthentication: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}
fn label(row: &rusqlite::Row<'_>) -> Result<Label> {
    let color_text: Option<String> = row.get(4)?;
    let color_background: Option<String> = row.get(5)?;
    let color = match (color_text, color_background) {
        (Some(text), Some(background)) => Some(LabelColor { text, background }),
        _ => None,
    };
    Ok(Label {
        account_id: row.get(0)?,
        id: row.get(1)?,
        name: row.get(2)?,
        kind: row.get(3)?,
        color,
        message_count: row.get(6)?,
        unread_count: row.get(7)?,
    })
}
fn message(row: &rusqlite::Row<'_>) -> Result<Message> {
    let html_presence: String = row.get(16)?;
    Ok(Message {
        account_id: row.get(0)?,
        id: row.get(1)?,
        thread_id: row.get(2)?,
        rfc_message_id: row.get(3)?,
        sender: row.get(4)?,
        recipients: row.get(5)?,
        subject: row.get(6)?,
        sent_at: row.get(7)?,
        snippet: row.get(8)?,
        html_body: row.get(9)?,
        plain_body: row.get(10)?,
        has_attachments: row.get(11)?,
        is_unread: row.get(12)?,
        is_starred: row.get(13)?,
        history_id: row.get(14)?,
        truncated_body: row.get(15)?,
        html_presence: HtmlPresence::from_db_str(&html_presence),
    })
}
fn thread(row: &rusqlite::Row<'_>) -> Result<Thread> {
    Ok(Thread {
        account_id: row.get(0)?,
        id: row.get(1)?,
        subject: row.get(2)?,
        participants: row.get(3)?,
        latest_at: row.get(4)?,
        message_count: row.get(5)?,
        is_unread: row.get(6)?,
        is_starred: row.get(7)?,
        has_attachments: row.get(8)?,
        has_draft: row.get(9)?,
    })
}
fn operation(row: &rusqlite::Row<'_>) -> Result<Operation> {
    Ok(Operation {
        id: row.get(0)?,
        account_id: row.get(1)?,
        lane: row.get(2)?,
        kind: row.get(3)?,
        entity_key: row.get(4)?,
        payload: row.get(5)?,
        status: row.get(6)?,
        attempts: row.get(7)?,
        next_attempt_at: row.get(8)?,
        error: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}
