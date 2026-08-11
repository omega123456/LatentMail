use rusqlite::{params, Connection, OptionalExtension, Result};

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Label {
    pub account_id: String,
    pub id: String,
    pub name: String,
    pub kind: String,
    pub color: Option<String>,
    pub message_count: i64,
    pub unread_count: i64,
}
pub struct LabelRepository;
impl LabelRepository {
    pub fn upsert(connection: &Connection, label: &Label) -> Result<()> {
        connection.execute("INSERT INTO labels (account_id,id,name,kind,color,message_count,unread_count) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(account_id,id) DO UPDATE SET name=excluded.name,kind=excluded.kind,color=excluded.color,message_count=excluded.message_count,unread_count=excluded.unread_count", params![label.account_id,label.id,label.name,label.kind,label.color,label.message_count,label.unread_count])?;
        Ok(())
    }
    pub fn list(connection: &Connection, account_id: &str) -> Result<Vec<Label>> {
        let mut statement = connection.prepare("SELECT account_id,id,name,kind,color,message_count,unread_count FROM labels WHERE account_id=?1 ORDER BY name")?;
        let labels = statement.query_map([account_id], label)?.collect();
        labels
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
            "INSERT OR IGNORE INTO labels (account_id,id,name,kind,color,message_count,unread_count) VALUES (?1,?2,?2,'system',NULL,0,0)",
            params![account_id, id],
        )?;
        Ok(())
    }
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
}
pub struct MessageRepository;
impl MessageRepository {
    pub fn write_full_state(connection: &Connection, message: &Message) -> Result<bool> {
        let changed = connection.execute("INSERT INTO messages (account_id,id,thread_id,rfc_message_id,sender,recipients,subject,sent_at,snippet,html_body,plain_body,has_attachments,is_unread,is_starred,history_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15) ON CONFLICT(account_id,id) DO UPDATE SET thread_id=excluded.thread_id,rfc_message_id=excluded.rfc_message_id,sender=excluded.sender,recipients=excluded.recipients,subject=excluded.subject,sent_at=excluded.sent_at,snippet=excluded.snippet,html_body=excluded.html_body,plain_body=excluded.plain_body,has_attachments=excluded.has_attachments,is_unread=excluded.is_unread,is_starred=excluded.is_starred,history_id=excluded.history_id WHERE excluded.history_id > messages.history_id", params![message.account_id,message.id,message.thread_id,message.rfc_message_id,message.sender,message.recipients,message.subject,message.sent_at,message.snippet,message.html_body,message.plain_body,message.has_attachments,message.is_unread,message.is_starred,message.history_id])?;
        Ok(changed == 1)
    }
    pub fn get(connection: &Connection, account_id: &str, id: &str) -> Result<Option<Message>> {
        connection.query_row("SELECT account_id,id,thread_id,rfc_message_id,sender,recipients,subject,sent_at,snippet,html_body,plain_body,has_attachments,is_unread,is_starred,history_id FROM messages WHERE account_id=?1 AND id=?2", params![account_id,id], message).optional()
    }
    pub fn list_by_thread(
        connection: &Connection,
        account_id: &str,
        thread_id: &str,
    ) -> Result<Vec<Message>> {
        let mut statement = connection.prepare("SELECT account_id,id,thread_id,rfc_message_id,sender,recipients,subject,sent_at,snippet,html_body,plain_body,has_attachments,is_unread,is_starred,history_id FROM messages WHERE account_id=?1 AND thread_id=?2 ORDER BY sent_at")?;
        let messages = statement
            .query_map(params![account_id, thread_id], message)?
            .collect();
        messages
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
            "SELECT EXISTS(SELECT 1 FROM message_labels ml JOIN messages m ON m.account_id=ml.account_id AND m.id=ml.message_id WHERE ml.account_id=?1 AND ml.label_id='DRAFT' AND m.thread_id=?2)",
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
               AND (?2 IS NULL OR EXISTS(
                 SELECT 1 FROM message_labels ml JOIN messages m ON m.account_id=ml.account_id AND m.id=ml.message_id
                 WHERE ml.account_id=t.account_id AND ml.label_id=?2 AND m.thread_id=t.id
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
    pub fn mark_interrupted_sends_uncertain(connection: &Connection) -> Result<usize> {
        connection.execute("UPDATE operations SET status='failed', error='May have been sent; retry manually', updated_at=strftime('%s','now') WHERE kind='send' AND status='active'", [])
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
    Ok(Label {
        account_id: row.get(0)?,
        id: row.get(1)?,
        name: row.get(2)?,
        kind: row.get(3)?,
        color: row.get(4)?,
        message_count: row.get(5)?,
        unread_count: row.get(6)?,
    })
}
fn message(row: &rusqlite::Row<'_>) -> Result<Message> {
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
