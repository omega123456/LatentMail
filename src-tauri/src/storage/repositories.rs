use std::collections::{HashMap, HashSet};

use rusqlite::{params, types::Value, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::addresses;

const BIND_BATCH_SIZE: usize = 500;

const INSERT_MESSAGE_LABEL: &str =
    "INSERT OR IGNORE INTO message_labels (account_id,message_id,label_id) VALUES (?1,?2,?3)";

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
}

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

const UNREAD_THREADS_PER_LABEL: &str = "SELECT tl.label_id,COUNT(*)
     FROM threads t
     CROSS JOIN thread_labels tl
       ON tl.account_id=t.account_id AND tl.thread_id=t.id
     WHERE t.account_id=?1 AND t.is_unread=1
     GROUP BY tl.label_id";

pub struct LabelRepository;
impl LabelRepository {
    pub fn upsert(connection: &Connection, label: &Label) -> Result<()> {
        let (color_text, color_background) = match &label.color {
            Some(color) => (Some(color.text.as_str()), Some(color.background.as_str())),
            None => (None, None),
        };
        connection.prepare_cached("INSERT INTO labels (account_id,id,name,kind,color_text,color_background,message_count) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(account_id,id) DO UPDATE SET name=excluded.name,kind=excluded.kind,color_text=excluded.color_text,color_background=excluded.color_background,message_count=excluded.message_count")?.execute(params![label.account_id,label.id,label.name,label.kind,color_text,color_background,label.message_count])?;
        Ok(())
    }
    pub fn list(connection: &Connection, account_id: &str) -> Result<Vec<Label>> {
        let mut statement = connection.prepare("SELECT account_id,id,name,kind,color_text,color_background,message_count FROM labels WHERE account_id=?1 ORDER BY name")?;
        let labels = statement.query_map([account_id], label)?.collect();
        labels
    }
    pub fn get(connection: &Connection, account_id: &str, id: &str) -> Result<Option<Label>> {
        connection.query_row("SELECT account_id,id,name,kind,color_text,color_background,message_count FROM labels WHERE account_id=?1 AND id=?2", params![account_id, id], label).optional()
    }

    pub fn unread_thread_counts(
        connection: &Connection,
        account_id: &str,
    ) -> Result<HashMap<String, i64>> {
        let mut statement = connection.prepare_cached(UNREAD_THREADS_PER_LABEL)?;
        let counts = statement.query_map([account_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
        counts.collect()
    }

    pub fn ensure_placeholder(connection: &Connection, account_id: &str, id: &str) -> Result<()> {
        connection
            .prepare_cached(
                "INSERT OR IGNORE INTO labels (account_id,id,name,kind,color_text,color_background,message_count) VALUES (?1,?2,?2,'system',NULL,NULL,0)",
            )?
            .execute(params![account_id, id])?;
        Ok(())
    }

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

    pub fn delete(connection: &Connection, account_id: &str, id: &str) -> Result<()> {
        connection.execute(
            "DELETE FROM labels WHERE account_id=?1 AND id=?2",
            params![account_id, id],
        )?;
        Ok(())
    }
}


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

    pub fn from_fetched_body(html_body: Option<&str>) -> Self {
        if html_body.is_some() {
            Self::Present
        } else {
            Self::Absent
        }
    }
}


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

impl Message {

    pub fn body_is_empty(&self) -> bool {
        self.html_body.is_none() && self.plain_body.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposeMessageContext {
    pub message: Message,
    pub recipient_roles: (String, String, String),
    pub references: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationMessage {
    pub message: Message,
    pub recipient_roles: (String, String, String),
    pub label_ids: Vec<String>,
    pub inline_parts: Vec<InlinePart>,
    pub draft_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconciliationMessage {
    pub thread_id: String,
    pub sender: String,
    pub sent_at: i64,
    pub to_recipients: String,
    pub cc_recipients: String,
    pub label_ids: Vec<String>,
}

pub struct MessageRepository;
impl MessageRepository {
    pub fn compose_context(
        connection: &Connection,
        account_id: &str,
        id: &str,
    ) -> Result<Option<ComposeMessageContext>> {
        connection
            .query_row(
                "SELECT account_id,id,thread_id,rfc_message_id,sender,recipients,subject,sent_at,snippet,html_body,plain_body,has_attachments,is_unread,is_starred,history_id,truncated_body,html_presence,to_recipients,cc_recipients,bcc_recipients,rfc_references
                 FROM messages WHERE account_id=?1 AND id=?2",
                params![account_id, id],
                |row| {
                    Ok(ComposeMessageContext {
                        message: message(row)?,
                        recipient_roles: (row.get(17)?, row.get(18)?, row.get(19)?),
                        references: row.get(20)?,
                    })
                },
            )
            .optional()
    }
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
        connection
            .prepare_cached(
                "UPDATE messages SET to_recipients=?1,cc_recipients=?2,bcc_recipients=?3,rfc_references=?4 WHERE account_id=?5 AND id=?6",
            )?
            .execute(params![to, cc, bcc, references, account_id, id])?;
        Ok(())
    }
    pub fn write_full_state(connection: &Connection, message: &Message) -> Result<bool> {
        let changed = connection.prepare_cached("INSERT INTO messages (account_id,id,thread_id,rfc_message_id,sender,recipients,subject,sent_at,snippet,html_body,plain_body,has_attachments,is_unread,is_starred,history_id,truncated_body,html_presence) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17) ON CONFLICT(account_id,id) DO UPDATE SET thread_id=excluded.thread_id,rfc_message_id=excluded.rfc_message_id,sender=excluded.sender,recipients=excluded.recipients,subject=excluded.subject,sent_at=excluded.sent_at,snippet=excluded.snippet,html_body=excluded.html_body,plain_body=excluded.plain_body,has_attachments=excluded.has_attachments,is_unread=excluded.is_unread,is_starred=excluded.is_starred,history_id=excluded.history_id,truncated_body=excluded.truncated_body,html_presence=excluded.html_presence WHERE excluded.history_id > messages.history_id")?.execute(params![message.account_id,message.id,message.thread_id,message.rfc_message_id,message.sender,message.recipients,message.subject,message.sent_at,message.snippet,message.html_body,message.plain_body,message.has_attachments,message.is_unread,message.is_starred,message.history_id,message.truncated_body,message.html_presence.as_db_str()])?;
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
    pub fn list_by_threads(
        connection: &Connection,
        account_id: &str,
        thread_ids: &[String],
    ) -> Result<HashMap<String, Vec<Message>>> {
        let mut messages: HashMap<String, Vec<Message>> = thread_ids
            .iter()
            .map(|thread_id| (thread_id.clone(), Vec::new()))
            .collect();
        for chunk in thread_ids.chunks(BIND_BATCH_SIZE) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                "SELECT account_id,id,thread_id,rfc_message_id,sender,recipients,subject,sent_at,snippet,html_body,plain_body,has_attachments,is_unread,is_starred,history_id,truncated_body,html_presence
                 FROM messages WHERE account_id=? AND thread_id IN ({placeholders})
                 ORDER BY thread_id,sent_at,id"
            );
            let mut statement = connection.prepare(&sql)?;
            let parameters = std::iter::once(account_id).chain(chunk.iter().map(String::as_str));
            for result in statement.query_map(rusqlite::params_from_iter(parameters), message)? {
                let message = result?;
                messages
                    .entry(message.thread_id.clone())
                    .or_default()
                    .push(message);
            }
        }
        Ok(messages)
    }
    pub fn get_many(
        connection: &Connection,
        account_id: &str,
        ids: &[String],
    ) -> Result<HashMap<String, Message>> {
        let mut messages = HashMap::new();
        for chunk in ids.chunks(BIND_BATCH_SIZE) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                "SELECT account_id,id,thread_id,rfc_message_id,sender,recipients,subject,sent_at,snippet,html_body,plain_body,has_attachments,is_unread,is_starred,history_id,truncated_body,html_presence
                 FROM messages WHERE account_id=? AND id IN ({placeholders})"
            );
            let mut statement = connection.prepare(&sql)?;
            let parameters = std::iter::once(account_id).chain(chunk.iter().map(String::as_str));
            for result in statement.query_map(rusqlite::params_from_iter(parameters), message)? {
                let message = result?;
                messages.insert(message.id.clone(), message);
            }
        }
        Ok(messages)
    }
    pub fn draft_message_ids_by_thread(
        connection: &Connection,
        account_id: &str,
        thread_ids: &[String],
    ) -> Result<HashMap<String, Vec<String>>> {
        let mut drafts: HashMap<String, Vec<String>> = HashMap::new();
        for chunk in thread_ids.chunks(BIND_BATCH_SIZE) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                "SELECT m.thread_id,m.id
                 FROM messages m CROSS JOIN message_labels ml
                 WHERE m.account_id=? AND m.thread_id IN ({placeholders})
                   AND ml.account_id=m.account_id AND ml.message_id=m.id AND ml.label_id='DRAFT'
                 ORDER BY m.thread_id,m.sent_at,m.id"
            );
            let mut statement = connection.prepare(&sql)?;
            let parameters = std::iter::once(account_id).chain(chunk.iter().map(String::as_str));
            let rows = statement
                .query_map(rusqlite::params_from_iter(parameters), |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>>>()?;
            for (thread_id, message_id) in rows {
                drafts.entry(thread_id).or_default().push(message_id);
            }
        }
        Ok(drafts)
    }
    pub fn label_ids_by_thread(
        connection: &Connection,
        account_id: &str,
        thread_ids: &[String],
    ) -> Result<HashMap<String, HashSet<String>>> {
        let mut membership: HashMap<String, HashSet<String>> = HashMap::new();
        for chunk in thread_ids.chunks(BIND_BATCH_SIZE) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                "SELECT DISTINCT m.thread_id,ml.label_id
                 FROM messages m CROSS JOIN message_labels ml
                 WHERE m.account_id=? AND m.thread_id IN ({placeholders})
                   AND ml.account_id=m.account_id AND ml.message_id=m.id"
            );
            let mut statement = connection.prepare(&sql)?;
            let parameters = std::iter::once(account_id).chain(chunk.iter().map(String::as_str));
            let rows = statement
                .query_map(rusqlite::params_from_iter(parameters), |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>>>()?;
            for (thread_id, label_id) in rows {
                membership.entry(thread_id).or_default().insert(label_id);
            }
        }
        Ok(membership)
    }

    pub fn label_ids_by_message(
        connection: &Connection,
        account_id: &str,
        message_ids: &[String],
    ) -> Result<HashMap<String, HashSet<String>>> {
        let mut membership: HashMap<String, HashSet<String>> = HashMap::new();
        for chunk in message_ids.chunks(BIND_BATCH_SIZE) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                "SELECT message_id,label_id FROM message_labels
                 WHERE account_id=? AND message_id IN ({placeholders})"
            );
            let mut statement = connection.prepare(&sql)?;
            let parameters = std::iter::once(account_id).chain(chunk.iter().map(String::as_str));
            let rows = statement
                .query_map(rusqlite::params_from_iter(parameters), |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>>>()?;
            for (message_id, label_id) in rows {
                membership.entry(message_id).or_default().insert(label_id);
            }
        }
        Ok(membership)
    }

    pub fn list_conversation(
        connection: &Connection,
        account_id: &str,
        thread_id: &str,
    ) -> Result<Vec<ConversationMessage>> {
        let mut statement = connection.prepare(
            "SELECT account_id,id,thread_id,rfc_message_id,sender,recipients,subject,sent_at,snippet,html_body,plain_body,has_attachments,is_unread,is_starred,history_id,truncated_body,html_presence,to_recipients,cc_recipients,bcc_recipients,draft_id
             FROM messages WHERE account_id=?1 AND thread_id=?2 ORDER BY sent_at,id",
        )?;
        let mut messages = statement
            .query_map(params![account_id, thread_id], |row| {
                Ok(ConversationMessage {
                    message: message(row)?,
                    recipient_roles: (row.get(17)?, row.get(18)?, row.get(19)?),
                    label_ids: Vec::new(),
                    inline_parts: Vec::new(),
                    draft_id: row.get(20)?,
                })
            })?
            .collect::<Result<Vec<_>>>()?;
        let positions: HashMap<String, usize> = messages
            .iter()
            .enumerate()
            .map(|(index, value)| (value.message.id.clone(), index))
            .collect();

        let mut statement = connection.prepare(
            "SELECT ml.message_id,ml.label_id
             FROM messages m CROSS JOIN message_labels ml
             WHERE m.account_id=?1 AND m.thread_id=?2
               AND ml.account_id=m.account_id AND ml.message_id=m.id",
        )?;
        let labels = statement
            .query_map(params![account_id, thread_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>>>()?;
        for (message_id, label_id) in labels {
            if let Some(index) = positions.get(&message_id) {
                messages[*index].label_ids.push(label_id);
            }
        }
        for message in &mut messages {
            message.label_ids.sort();
        }

        let mut statement = connection.prepare(
            "SELECT p.message_id,p.content_id,p.mime_type,p.bytes
             FROM messages m CROSS JOIN message_inline_parts p
             WHERE m.account_id=?1 AND m.thread_id=?2 AND m.html_body IS NOT NULL
               AND p.account_id=m.account_id AND p.message_id=m.id",
        )?;
        let parts = statement
            .query_map(params![account_id, thread_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    InlinePart {
                        content_id: row.get(1)?,
                        mime_type: row.get(2)?,
                        bytes: row.get(3)?,
                    },
                ))
            })?
            .collect::<Result<Vec<_>>>()?;
        for (message_id, part) in parts {
            if let Some(index) = positions.get(&message_id) {
                messages[*index].inline_parts.push(part);
            }
        }
        Ok(messages)
    }

    pub fn all_ids(connection: &Connection, account_id: &str) -> Result<Vec<String>> {
        let mut statement =
            connection.prepare("SELECT id FROM messages WHERE account_id=?1 ORDER BY id")?;
        let ids = statement
            .query_map([account_id], |row| row.get(0))?
            .collect();
        ids
    }

    pub fn missing_ids(
        connection: &Connection,
        account_id: &str,
        ids: Vec<String>,
    ) -> Result<Vec<String>> {
        let mut seen = HashSet::new();
        let ids: Vec<String> = ids
            .into_iter()
            .filter(|id| seen.insert(id.clone()))
            .collect();
        let mut existing = HashSet::new();
        for chunk in ids.chunks(BIND_BATCH_SIZE) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql =
                format!("SELECT id FROM messages WHERE account_id=? AND id IN ({placeholders})");
            let mut statement = connection.prepare(&sql)?;
            let parameters = std::iter::once(account_id).chain(chunk.iter().map(String::as_str));
            existing.extend(
                statement
                    .query_map(rusqlite::params_from_iter(parameters), |row| row.get(0))?
                    .collect::<Result<Vec<String>>>()?,
            );
        }
        Ok(ids
            .into_iter()
            .filter(|id| !existing.contains(id))
            .collect())
    }

    pub fn write_traversal_state(connection: &Connection, message: &Message) -> Result<bool> {
        let changed = connection.prepare_cached(
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
        )?
            .execute(params![
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
            ])?;
        Ok(changed == 1)
    }

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

    pub fn set_body(
        connection: &Connection,
        account_id: &str,
        id: &str,
        html_body: Option<&str>,
        plain_body: Option<&str>,
        presence: HtmlPresence,
    ) -> Result<()> {
        connection.execute(
            "UPDATE messages SET html_body=?1, plain_body=?2, html_presence=?3 WHERE account_id=?4 AND id=?5",
            params![html_body, plain_body, presence.as_db_str(), account_id, id],
        )?;
        Ok(())
    }

    pub fn overwrite_membership(
        connection: &Connection,
        account_id: &str,
        message_id: &str,
        label_ids: &[String],
    ) -> Result<()> {
        connection
            .prepare_cached("DELETE FROM message_labels WHERE account_id=?1 AND message_id=?2")?
            .execute(params![account_id, message_id])?;
        let mut statement = connection.prepare_cached(INSERT_MESSAGE_LABEL)?;
        for label_id in label_ids {
            statement.execute(params![account_id, message_id, label_id])?;
        }
        drop(statement);
        connection
            .prepare_cached(
                "UPDATE messages SET is_unread=?1,is_starred=?2 WHERE account_id=?3 AND id=?4",
            )?
            .execute(params![
                label_ids.iter().any(|id| id == "UNREAD"),
                label_ids.iter().any(|id| id == "STARRED"),
                account_id,
                message_id
            ])?;
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
            connection
                .prepare_cached(INSERT_MESSAGE_LABEL)?
                .execute(params![account_id, message_id, label_id])?;
        } else {
            connection
                .prepare_cached(
                    "DELETE FROM message_labels WHERE account_id=?1 AND message_id=?2 AND label_id=?3",
                )?
                .execute(params![account_id, message_id, label_id])?;
        }
        let denormalised = match label_id {
            "UNREAD" => Some("UPDATE messages SET is_unread=?1 WHERE account_id=?2 AND id=?3"),
            "STARRED" => Some("UPDATE messages SET is_starred=?1 WHERE account_id=?2 AND id=?3"),
            _ => None,
        };
        if let Some(sql) = denormalised {
            connection
                .prepare_cached(sql)?
                .execute(params![present, account_id, message_id])?;
        }
        Ok(())
    }

    pub fn delete(connection: &Connection, account_id: &str, id: &str) -> Result<Option<String>> {
        connection
            .query_row(
                "DELETE FROM messages WHERE account_id=?1 AND id=?2 RETURNING thread_id",
                params![account_id, id],
                |row| row.get(0),
            )
            .optional()
    }
    pub fn delete_by_draft_id(
        connection: &Connection,
        account_id: &str,
        draft_id: &str,
    ) -> Result<Option<String>> {
        connection
            .query_row(
                "DELETE FROM messages WHERE account_id=?1 AND draft_id=?2 RETURNING thread_id",
                params![account_id, draft_id],
                |row| row.get(0),
            )
            .optional()
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

    pub fn replace_inline_parts(
        connection: &Connection,
        account_id: &str,
        message_id: &str,
        parts: &[InlinePart],
    ) -> Result<()> {
        connection
            .prepare_cached(
                "DELETE FROM message_inline_parts WHERE account_id=?1 AND message_id=?2",
            )?
            .execute(params![account_id, message_id])?;
        let mut statement = connection.prepare_cached(
            "INSERT INTO message_inline_parts (account_id,message_id,content_id,mime_type,bytes) VALUES (?1,?2,?3,?4,?5)",
        )?;
        for part in parts {
            statement.execute(params![
                account_id,
                message_id,
                part.content_id,
                part.mime_type,
                part.bytes
            ])?;
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

    pub fn reconciliation_messages(
        connection: &Connection,
        account_id: &str,
    ) -> Result<HashMap<String, ReconciliationMessage>> {
        let mut statement = connection.prepare(
            "SELECT id,thread_id,sender,sent_at,to_recipients,cc_recipients
             FROM messages WHERE account_id=?1",
        )?;
        let mut messages = statement
            .query_map([account_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    ReconciliationMessage {
                        thread_id: row.get(1)?,
                        sender: row.get(2)?,
                        sent_at: row.get(3)?,
                        to_recipients: row.get(4)?,
                        cc_recipients: row.get(5)?,
                        label_ids: Vec::new(),
                    },
                ))
            })?
            .collect::<Result<HashMap<_, _>>>()?;
        let mut statement = connection.prepare(
            "SELECT message_id,label_id FROM message_labels WHERE account_id=?1 ORDER BY message_id,label_id",
        )?;
        let labels = statement
            .query_map([account_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>>>()?;
        for (message_id, label_id) in labels {
            if let Some(message) = messages.get_mut(&message_id) {
                message.label_ids.push(label_id);
            }
        }
        Ok(messages)
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


#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadIdentity {
    pub display: String,
    pub address: Option<String>,
}
impl ThreadIdentity {
    fn no_sender() -> Self {
        Self {
            display: "(No sender)".to_owned(),
            address: None,
        }
    }
    fn no_recipient() -> Self {
        Self {
            display: "(No recipient)".to_owned(),
            address: None,
        }
    }
    fn from_header(header: &str, fallback: fn() -> Self) -> Self {
        addresses::first_identity(header).map_or_else(fallback, |identity| Self {
            display: identity.display,
            address: Some(identity.address),
        })
    }
    fn encode(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
    fn decode(text: &str, fallback: fn() -> Self) -> Self {
        serde_json::from_str(text).unwrap_or_else(|_| fallback())
    }
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

    pub sender_identity: ThreadIdentity,

    pub recipient_identity: Option<ThreadIdentity>,
}

pub const SYSTEM_FOLDER_LABEL_IDS: [&str; 5] = ["INBOX", "SENT", "DRAFT", "TRASH", "SPAM"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadListRow {
    pub thread: Thread,
    pub snippet: String,
    pub label_indicators: Vec<String>,
    pub system_label_ids: Vec<String>,
}

struct ThreadMessageRow {
    sender: String,
    subject: String,
    sent_at: i64,
    has_attachments: bool,
    is_unread: bool,
    is_starred: bool,
    is_draft: bool,
    to_recipients: String,
    is_sent: bool,
}

pub struct ThreadRepository;
impl ThreadRepository {
    pub fn upsert(connection: &Connection, thread: &Thread) -> Result<()> {
        connection.prepare_cached("INSERT INTO threads (account_id,id,subject,participants,latest_at,message_count,is_unread,is_starred,has_attachments,has_draft,sender_identity,recipient_identity) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT(account_id,id) DO UPDATE SET subject=excluded.subject,participants=excluded.participants,latest_at=excluded.latest_at,message_count=excluded.message_count,is_unread=excluded.is_unread,is_starred=excluded.is_starred,has_attachments=excluded.has_attachments,has_draft=excluded.has_draft,sender_identity=excluded.sender_identity,recipient_identity=excluded.recipient_identity")?.execute(params![thread.account_id,thread.id,thread.subject,thread.participants,thread.latest_at,thread.message_count,thread.is_unread,thread.is_starred,thread.has_attachments,thread.has_draft,thread.sender_identity.encode(),thread.recipient_identity.as_ref().map(ThreadIdentity::encode)])?;
        Ok(())
    }
    pub fn get(connection: &Connection, account_id: &str, id: &str) -> Result<Option<Thread>> {
        connection.query_row("SELECT account_id,id,subject,participants,latest_at,message_count,is_unread,is_starred,has_attachments,has_draft,sender_identity,recipient_identity FROM threads WHERE account_id=?1 AND id=?2", params![account_id,id], thread).optional()
    }

    pub fn recompute(connection: &Connection, account_id: &str, thread_id: &str) -> Result<()> {
        let mut statement = connection.prepare(
            "SELECT m.sender,m.subject,m.sent_at,m.has_attachments,m.is_unread,m.is_starred,
                    EXISTS(SELECT 1 FROM message_labels ml WHERE ml.account_id=m.account_id AND ml.message_id=m.id AND ml.label_id='DRAFT'),
                    m.to_recipients,
                    EXISTS(SELECT 1 FROM message_labels ml WHERE ml.account_id=m.account_id AND ml.message_id=m.id AND ml.label_id='SENT')
             FROM messages m WHERE m.account_id=?1 AND m.thread_id=?2 ORDER BY m.sent_at,m.id",
        )?;
        let rows = statement
            .query_map(params![account_id, thread_id], thread_message_row)?
            .collect::<Result<Vec<_>>>()?;
        Self::write_summary(connection, account_id, thread_id, &rows)
    }

    pub fn recompute_many(
        connection: &Connection,
        account_id: &str,
        thread_ids: &HashSet<String>,
    ) -> Result<()> {
        let mut rows: HashMap<String, Vec<ThreadMessageRow>> = thread_ids
            .iter()
            .map(|thread_id| (thread_id.clone(), Vec::new()))
            .collect();
        let ids: Vec<&str> = thread_ids.iter().map(String::as_str).collect();
        for chunk in ids.chunks(BIND_BATCH_SIZE) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                "SELECT m.thread_id,m.sender,m.subject,m.sent_at,m.has_attachments,m.is_unread,m.is_starred,
                        EXISTS(SELECT 1 FROM message_labels ml WHERE ml.account_id=m.account_id AND ml.message_id=m.id AND ml.label_id='DRAFT'),
                        m.to_recipients,
                        EXISTS(SELECT 1 FROM message_labels ml WHERE ml.account_id=m.account_id AND ml.message_id=m.id AND ml.label_id='SENT')
                 FROM messages m WHERE m.account_id=? AND m.thread_id IN ({placeholders})
                 ORDER BY m.thread_id,m.sent_at,m.id"
            );
            let mut statement = connection.prepare(&sql)?;
            let parameters = std::iter::once(account_id).chain(chunk.iter().copied());
            let results = statement
                .query_map(rusqlite::params_from_iter(parameters), |row| {
                    Ok((row.get::<_, String>(0)?, thread_message_row_offset(row, 1)?))
                })?
                .collect::<Result<Vec<_>>>()?;
            for (thread_id, row) in results {
                rows.get_mut(&thread_id)
                    .expect("summary query only returns requested threads")
                    .push(row);
            }
        }
        for (thread_id, rows) in rows {
            Self::write_summary(connection, account_id, &thread_id, &rows)?;
        }
        Ok(())
    }

    fn write_summary(
        connection: &Connection,
        account_id: &str,
        thread_id: &str,
        rows: &[ThreadMessageRow],
    ) -> Result<()> {
        if rows.is_empty() {
            connection
                .prepare_cached("DELETE FROM threads WHERE account_id=?1 AND id=?2")?
                .execute(params![account_id, thread_id])?;
            return Ok(());
        }
        let mut participants = Vec::new();
        let (mut is_unread, mut is_starred, mut has_attachments, mut has_draft) =
            (false, false, false, false);
        for row in rows {
            if !participants.contains(&row.sender) {
                participants.push(row.sender.clone());
            }
            is_unread |= row.is_unread;
            is_starred |= row.is_starred;
            has_attachments |= row.has_attachments;
            has_draft |= row.is_draft;
        }
        let latest = rows.last().expect("checked non-empty above");

        let sender_identity = ThreadIdentity::from_header(&latest.sender, ThreadIdentity::no_sender);

        let recipient_identity = rows.iter().rev().find(|row| row.is_sent).map(|row| {
            ThreadIdentity::from_header(&row.to_recipients, ThreadIdentity::no_recipient)
        });
        Self::upsert(
            connection,
            &Thread {
                account_id: account_id.to_owned(),
                id: thread_id.to_owned(),
                subject: latest.subject.clone(),
                participants: participants.join(", "),
                latest_at: latest.sent_at,
                message_count: rows.len() as i64,
                is_unread,
                is_starred,
                has_attachments,
                has_draft,
                sender_identity,
                recipient_identity,
            },
        )?;
        Self::write_label_index(connection, account_id, thread_id, latest.sent_at)
    }

    fn write_label_index(
        connection: &Connection,
        account_id: &str,
        thread_id: &str,
        latest_at: i64,
    ) -> Result<()> {
        connection
            .prepare_cached("DELETE FROM thread_labels WHERE account_id=?1 AND thread_id=?2")?
            .execute(params![account_id, thread_id])?;
        connection
            .prepare_cached(
                "WITH message_folder_state AS (
                   SELECT m.id AS message_id,
                          MAX(ml.label_id='TRASH') AS is_trashed,
                          MAX(ml.label_id='SPAM') AS is_spammed
                   FROM messages m
                   LEFT JOIN message_labels ml
                     ON ml.account_id=m.account_id AND ml.message_id=m.id
                   WHERE m.account_id=?1 AND m.thread_id=?2
                   GROUP BY m.id
                 )
                 INSERT INTO thread_labels (account_id,label_id,thread_id,latest_at)
                 SELECT DISTINCT ?1,
                        CASE
                          WHEN mfs.is_trashed THEN 'TRASH'
                          WHEN mfs.is_spammed THEN 'SPAM'
                          ELSE ml.label_id
                        END,
                        ?2,?3
                 FROM messages m
                 CROSS JOIN message_labels ml
                   ON ml.account_id=m.account_id AND ml.message_id=m.id
                 CROSS JOIN message_folder_state mfs
                   ON mfs.message_id=m.id
                 WHERE m.account_id=?1 AND m.thread_id=?2",
            )?
            .execute(params![account_id, thread_id, latest_at])?;
        Ok(())
    }

    pub fn list_paginated(
        connection: &Connection,
        account_id: &str,
        label_id: Option<&str>,
        cursor: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<ThreadListRow>> {
        let source = match label_id {
            Some(_) => {
                "thread_labels tl CROSS JOIN threads t
                 ON t.account_id=tl.account_id AND t.id=tl.thread_id
                 WHERE tl.account_id=?1 AND tl.label_id=?2"
            }
            None => "threads t WHERE t.account_id=?1",
        };
        let (order_at, order_id) = match label_id {
            Some(_) => ("tl.latest_at", "tl.thread_id"),
            None => ("t.latest_at", "t.id"),
        };
        let cursor_sql = cursor
            .as_ref()
            .map_or_else(String::new, |_| format!("AND ({order_at},{order_id})<(?3,?4)"));
        let sql = format!(
            "SELECT t.account_id,t.id,t.subject,t.participants,t.latest_at,t.message_count,t.is_unread,t.is_starred,t.has_attachments,t.has_draft,t.sender_identity,t.recipient_identity,
                    COALESCE((SELECT m.snippet FROM messages m WHERE m.account_id=t.account_id AND m.thread_id=t.id ORDER BY m.sent_at DESC,m.id DESC LIMIT 1),'')
             FROM {source}
               {cursor_sql}
             ORDER BY {order_at} DESC, {order_id} DESC
             LIMIT ?5"
        );
        let mut statement = connection.prepare_cached(&sql)?;
        let (cursor_at, cursor_id) = match cursor {
            Some((at, id)) => (Some(at), Some(id)),
            None => (None, None),
        };
        let rows = statement
            .query_map(
                params![account_id, label_id, cursor_at, cursor_id, limit],
                |row| {
                    Ok(ThreadListRow {
                        thread: thread(row)?,
                        snippet: row.get(12)?,
                        label_indicators: Vec::new(),
                        system_label_ids: Vec::new(),
                    })
                },
            )?
            .collect::<Result<Vec<_>>>()?;
        enrich_thread_rows(connection, account_id, rows)
    }
}

fn enrich_thread_rows(
    connection: &Connection,
    account_id: &str,
    mut rows: Vec<ThreadListRow>,
) -> Result<Vec<ThreadListRow>> {
    if rows.is_empty() {
        return Ok(rows);
    }

    let positions: HashMap<String, usize> = rows
        .iter()
        .enumerate()
        .map(|(index, row)| (row.thread.id.clone(), index))
        .collect();
    let mut all_labels = Vec::new();
    for chunk in rows.chunks(BIND_BATCH_SIZE) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "SELECT m.thread_id,l.name
             FROM messages m
             CROSS JOIN message_labels ml
             CROSS JOIN labels l
             WHERE m.account_id=? AND m.thread_id IN ({placeholders})
               AND ml.account_id=m.account_id AND ml.message_id=m.id
               AND l.account_id=ml.account_id AND l.id=ml.label_id AND l.kind='user'"
        );
        let mut statement = connection.prepare(&sql)?;
        let parameters =
            std::iter::once(account_id).chain(chunk.iter().map(|row| row.thread.id.as_str()));
        all_labels.extend(
            statement
                .query_map(rusqlite::params_from_iter(parameters), |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>>>()?,
        );
    }
    let mut seen = HashSet::new();
    for (thread_id, label) in all_labels {
        if seen.insert((thread_id.clone(), label.clone())) {
            let index = positions
                .get(&thread_id)
                .expect("label query only returns requested threads");
            rows[*index].label_indicators.push(label);
        }
    }
    for row in &mut rows {
        row.label_indicators.sort();
    }

    let mut all_system_labels = Vec::new();
    for chunk in rows.chunks(BIND_BATCH_SIZE) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let system_placeholders = vec!["?"; SYSTEM_FOLDER_LABEL_IDS.len()].join(",");
        let sql = format!(
            "SELECT tl.thread_id,tl.label_id
             FROM thread_labels tl
             WHERE tl.account_id=? AND tl.thread_id IN ({placeholders})
               AND tl.label_id IN ({system_placeholders})"
        );
        let mut statement = connection.prepare(&sql)?;
        let parameters = std::iter::once(account_id)
            .chain(chunk.iter().map(|row| row.thread.id.as_str()))
            .chain(SYSTEM_FOLDER_LABEL_IDS.iter().copied());
        all_system_labels.extend(
            statement
                .query_map(rusqlite::params_from_iter(parameters), |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>>>()?,
        );
    }
    for (thread_id, label_id) in all_system_labels {
        let index = positions
            .get(&thread_id)
            .expect("system label query only returns requested threads");
        rows[*index].system_label_ids.push(label_id);
    }
    for row in &mut rows {
        row.system_label_ids.sort();
    }
    Ok(rows)
}

pub struct SearchRepository;

impl SearchRepository {
    pub fn search(
        connection: &Connection,
        account_id: &str,
        parsed: &crate::search::query::ParsedQuery,
        scope: &crate::search::scope::ScopeFilter,
        cursor: Option<(i64, String)>,
        limit: i64,
    ) -> Result<Vec<ThreadListRow>> {
        let (sql, values) = if parsed.has_text_term {
            search_text_sql(account_id, parsed, scope, cursor, limit)
        } else {
            search_thread_driven_sql(account_id, parsed, scope, cursor, limit)
        };
        let mut statement = connection.prepare_cached(&sql)?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(values.iter()), |row| {
                Ok(ThreadListRow {
                    thread: thread(row)?,
                    snippet: row.get(12)?,
                    label_indicators: Vec::new(),
                    system_label_ids: Vec::new(),
                })
            })?
            .collect::<Result<Vec<_>>>()?;
        enrich_thread_rows(connection, account_id, rows)
    }

    pub fn count(
        connection: &Connection,
        account_id: &str,
        parsed: &crate::search::query::ParsedQuery,
        scope: &crate::search::scope::ScopeFilter,
    ) -> Result<i64> {
        let (where_sql, values) = search_predicate_sql(account_id, parsed, scope);
        let from = if parsed.has_text_term {
            "message_search JOIN messages m ON m.seq=message_search.rowid"
        } else {
            "messages m"
        };
        let sql = format!("SELECT COUNT(DISTINCT m.thread_id) FROM {from} WHERE {where_sql}");
        let mut statement = connection.prepare_cached(&sql)?;
        statement.query_row(rusqlite::params_from_iter(values.iter()), |row| row.get(0))
    }
}

const THREAD_LIST_COLUMNS: &str = "t.account_id,t.id,t.subject,t.participants,t.latest_at,t.message_count,t.is_unread,t.is_starred,t.has_attachments,t.has_draft,t.sender_identity,t.recipient_identity,
                    COALESCE((SELECT m2.snippet FROM messages m2 WHERE m2.account_id=t.account_id AND m2.thread_id=t.id ORDER BY m2.sent_at DESC,m2.id DESC LIMIT 1),'')";

fn search_text_sql(
    account_id: &str,
    parsed: &crate::search::query::ParsedQuery,
    scope: &crate::search::scope::ScopeFilter,
    cursor: Option<(i64, String)>,
    limit: i64,
) -> (String, Vec<Value>) {
    let (mut where_sql, mut values) = search_predicate_sql(account_id, parsed, scope);
    if let Some((at, id)) = cursor {
        where_sql.push_str(" AND (t.latest_at,t.id)<(?,?)");
        values.push(Value::Integer(at));
        values.push(Value::Text(id));
    }
    values.push(Value::Integer(limit));
    let sql = format!(
        "SELECT {THREAD_LIST_COLUMNS}
             FROM message_search
             JOIN messages m ON m.seq=message_search.rowid
             JOIN threads t ON t.account_id=m.account_id AND t.id=m.thread_id
             WHERE {where_sql}
             GROUP BY t.id
             ORDER BY t.latest_at DESC, t.id DESC
             LIMIT ?"
    );
    (sql, values)
}

fn search_thread_driven_sql(
    account_id: &str,
    parsed: &crate::search::query::ParsedQuery,
    scope: &crate::search::scope::ScopeFilter,
    cursor: Option<(i64, String)>,
    limit: i64,
) -> (String, Vec<Value>) {
    let mut values = vec![Value::Text(account_id.to_owned())];
    let cursor_sql = match cursor {
        Some((at, id)) => {
            values.push(Value::Integer(at));
            values.push(Value::Text(id));
            " AND (t.latest_at,t.id)<(?,?)"
        }
        None => "",
    };
    let (conditions, condition_values) = search_message_conditions(parsed, scope);
    values.extend(condition_values);
    values.push(Value::Integer(limit));
    let sql = format!(
        "SELECT {THREAD_LIST_COLUMNS}
             FROM threads t
             WHERE t.account_id=?{cursor_sql}
               AND EXISTS(SELECT 1 FROM messages m
                          WHERE m.account_id=t.account_id AND m.thread_id=t.id{conditions})
             ORDER BY t.latest_at DESC, t.id DESC
             LIMIT ?"
    );
    (sql, values)
}

fn search_predicate_sql(
    account_id: &str,
    parsed: &crate::search::query::ParsedQuery,
    scope: &crate::search::scope::ScopeFilter,
) -> (String, Vec<Value>) {
    let mut sql = String::new();
    let mut values: Vec<Value> = Vec::new();
    if parsed.has_text_term {
        sql.push_str("message_search MATCH ? AND ");
        values.push(Value::Text(
            parsed.match_expression.clone().unwrap_or_default(),
        ));
    }
    sql.push_str("m.account_id=?");
    values.push(Value::Text(account_id.to_owned()));

    let (conditions, condition_values) = search_message_conditions(parsed, scope);
    sql.push_str(&conditions);
    values.extend(condition_values);
    (sql, values)
}

fn search_message_conditions(
    parsed: &crate::search::query::ParsedQuery,
    scope: &crate::search::scope::ScopeFilter,
) -> (String, Vec<Value>) {
    let mut sql = String::new();
    let mut values: Vec<Value> = Vec::new();
    if let Some(label) = &scope.required_label {
        sql.push_str(" AND EXISTS(SELECT 1 FROM message_labels ml WHERE ml.account_id=m.account_id AND ml.message_id=m.id AND ml.label_id=?)");
        values.push(Value::Text(label.clone()));
    }
    if !scope.excluded_labels.is_empty() {
        let placeholders = vec!["?"; scope.excluded_labels.len()].join(",");
        sql.push_str(&format!(" AND NOT EXISTS(SELECT 1 FROM message_labels ml WHERE ml.account_id=m.account_id AND ml.message_id=m.id AND ml.label_id IN ({placeholders}))"));
        for label in &scope.excluded_labels {
            values.push(Value::Text(label.clone()));
        }
    }
    for predicate in &parsed.predicates {
        let (fragment, predicate_values) = search_predicate_fragment(predicate);
        sql.push_str(" AND ");
        sql.push_str(&fragment);
        values.extend(predicate_values);
    }
    (sql, values)
}

fn search_predicate_fragment(
    predicate: &crate::search::query::Predicate,
) -> (String, Vec<Value>) {
    use crate::search::query::PredicateKind;
    let (inner, values): (String, Vec<Value>) = match &predicate.kind {
        PredicateKind::Label(label) => (
            "EXISTS(SELECT 1 FROM message_labels ml WHERE ml.account_id=m.account_id AND ml.message_id=m.id AND ml.label_id=?)".to_owned(),
            vec![Value::Text(label.clone())],
        ),
        PredicateKind::Unread => ("m.is_unread=1".to_owned(), Vec::new()),
        PredicateKind::Starred => ("m.is_starred=1".to_owned(), Vec::new()),
        PredicateKind::HasAttachment => ("m.has_attachments=1".to_owned(), Vec::new()),
        PredicateKind::SentBefore(cutoff) => {
            ("m.sent_at<?".to_owned(), vec![Value::Integer(*cutoff)])
        }
        PredicateKind::SentAfter(cutoff) => {
            ("m.sent_at>=?".to_owned(), vec![Value::Integer(*cutoff)])
        }
        PredicateKind::TextExcludes(expression) => (
            "NOT EXISTS(SELECT 1 FROM message_search WHERE message_search.rowid=m.seq AND message_search MATCH ?)"
                .to_owned(),
            vec![Value::Text(expression.clone())],
        ),
    };
    if predicate.negated {
        (format!("NOT ({inner})"), values)
    } else {
        (inner, values)
    }
}

fn thread_message_row(row: &rusqlite::Row<'_>) -> Result<ThreadMessageRow> {
    thread_message_row_offset(row, 0)
}

fn thread_message_row_offset(row: &rusqlite::Row<'_>, offset: usize) -> Result<ThreadMessageRow> {
    Ok(ThreadMessageRow {
        sender: row.get(offset)?,
        subject: row.get(offset + 1)?,
        sent_at: row.get(offset + 2)?,
        has_attachments: row.get(offset + 3)?,
        is_unread: row.get(offset + 4)?,
        is_starred: row.get(offset + 5)?,
        is_draft: row.get(offset + 6)?,
        to_recipients: row.get(offset + 7)?,
        is_sent: row.get(offset + 8)?,
    })
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

    pub fn mark_interrupted_sends_uncertain(connection: &Connection) -> Result<Vec<String>> {
        let mut statement = connection.prepare(
            "UPDATE operations
             SET status='failed',error='May have been sent; retry manually',updated_at=strftime('%s','now')
             WHERE kind='send' AND status='active'
             RETURNING account_id",
        )?;
        let accounts: HashSet<String> = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<_>>()?;
        let mut accounts: Vec<String> = accounts.into_iter().collect();
        accounts.sort();
        Ok(accounts)
    }

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


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AvatarCacheOutcome {
    Hit,
    Miss,
}
impl AvatarCacheOutcome {
    fn as_db_str(self) -> &'static str {
        match self {
            Self::Hit => "hit",
            Self::Miss => "miss",
        }
    }
    fn from_db_str(value: &str) -> Self {
        match value {
            "hit" => Self::Hit,
            _ => Self::Miss,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvatarCacheRecord {
    pub cache_key: String,
    pub outcome: AvatarCacheOutcome,

    pub image_path: Option<String>,
    pub looked_up_at: i64,
}

pub struct AvatarCacheRepository;
impl AvatarCacheRepository {
    pub fn upsert(connection: &Connection, record: &AvatarCacheRecord) -> Result<()> {
        connection.execute(
            "INSERT INTO avatar_cache (cache_key,outcome,image_path,looked_up_at) VALUES (?1,?2,?3,?4)
             ON CONFLICT(cache_key) DO UPDATE SET outcome=excluded.outcome,image_path=excluded.image_path,looked_up_at=excluded.looked_up_at",
            params![
                record.cache_key,
                record.outcome.as_db_str(),
                record.image_path,
                record.looked_up_at
            ],
        )?;
        Ok(())
    }
    pub fn get(connection: &Connection, cache_key: &str) -> Result<Option<AvatarCacheRecord>> {
        connection
            .query_row(
                "SELECT cache_key,outcome,image_path,looked_up_at FROM avatar_cache WHERE cache_key=?1",
                [cache_key],
                |row| {
                    let outcome: String = row.get(1)?;
                    Ok(AvatarCacheRecord {
                        cache_key: row.get(0)?,
                        outcome: AvatarCacheOutcome::from_db_str(&outcome),
                        image_path: row.get(2)?,
                        looked_up_at: row.get(3)?,
                    })
                },
            )
            .optional()
    }
}


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

    pub resumed: bool,
}


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
    let sender_identity: String = row.get(10)?;
    let recipient_identity: Option<String> = row.get(11)?;
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
        sender_identity: ThreadIdentity::decode(&sender_identity, ThreadIdentity::no_sender),
        recipient_identity: recipient_identity
            .map(|text| ThreadIdentity::decode(&text, ThreadIdentity::no_recipient)),
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
