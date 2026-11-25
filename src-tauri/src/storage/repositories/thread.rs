use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};

use super::shared::{ChunkedAccountQuery, ChunkedQuery};
use crate::storage::{addresses, ThreadKey};

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadPageCursor {
    pub latest_at: i64,
    pub thread_id: String,
}

pub struct ThreadPageQuery<'a> {
    pub account_id: &'a str,
    pub label_id: Option<&'a str>,
    pub cursor: Option<ThreadPageCursor>,
    pub limit: i64,
    pub direction: crate::sync::ThreadPageDirection,
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
        Self::write_summary(
            connection,
            ThreadKey {
                account_id: account_id,
                thread_id: thread_id,
            },
            &rows,
        )
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
        let results = ChunkedAccountQuery::new(connection, account_id).query(
            ChunkedQuery {
                ids: &ids,
                tail: &[],
                sql_for_placeholders: |placeholders| {
                    format!(
                        "SELECT m.thread_id,m.sender,m.subject,m.sent_at,m.has_attachments,m.is_unread,m.is_starred,
                                EXISTS(SELECT 1 FROM message_labels ml WHERE ml.account_id=m.account_id AND ml.message_id=m.id AND ml.label_id='DRAFT'),
                                m.to_recipients,
                                EXISTS(SELECT 1 FROM message_labels ml WHERE ml.account_id=m.account_id AND ml.message_id=m.id AND ml.label_id='SENT')
                         FROM messages m WHERE m.account_id=? AND m.thread_id IN ({placeholders})
                         ORDER BY m.thread_id,m.sent_at,m.id"
                    )
                },
            },
            |row| Ok((row.get::<_, String>(0)?, thread_message_row_offset(row, 1)?)),
        )?;
        for (thread_id, row) in results {
            rows.get_mut(&thread_id)
                .expect("summary query only returns requested threads")
                .push(row);
        }
        for (thread_id, rows) in rows {
            Self::write_summary(
                connection,
                ThreadKey {
                    account_id: account_id,
                    thread_id: &thread_id,
                },
                &rows,
            )?;
        }
        Ok(())
    }

    fn write_summary(
        connection: &Connection,
        thread: ThreadKey<'_>,
        rows: &[ThreadMessageRow],
    ) -> Result<()> {
        if rows.is_empty() {
            connection
                .prepare_cached("DELETE FROM threads WHERE account_id=?1 AND id=?2")?
                .execute(params![thread.account_id, thread.thread_id])?;
            return Ok(());
        }
        let summary = summarize_thread_messages(rows);
        let latest = rows.last().expect("checked non-empty above");

        let sender_identity =
            ThreadIdentity::from_header(&latest.sender, ThreadIdentity::no_sender);

        let recipient_identity = rows.iter().rev().find(|row| row.is_sent).map(|row| {
            ThreadIdentity::from_header(&row.to_recipients, ThreadIdentity::no_recipient)
        });
        Self::upsert(
            connection,
            &Thread {
                account_id: thread.account_id.to_owned(),
                id: thread.thread_id.to_owned(),
                subject: latest.subject.clone(),
                participants: summary.participants.join(", "),
                latest_at: latest.sent_at,
                message_count: rows.len() as i64,
                is_unread: summary.is_unread,
                is_starred: summary.is_starred,
                has_attachments: summary.has_attachments,
                has_draft: summary.has_draft,
                sender_identity: sender_identity,
                recipient_identity: recipient_identity,
            },
        )?;
        Self::write_label_index(connection, thread.account_id, thread.thread_id)
    }

    fn write_label_index(connection: &Connection, account_id: &str, thread_id: &str) -> Result<()> {
        connection
            .prepare_cached("DELETE FROM thread_labels WHERE account_id=?1 AND thread_id=?2")?
            .execute(params![account_id, thread_id])?;
        connection
            .prepare_cached(
                "INSERT INTO thread_labels (account_id,label_id,thread_id,latest_at)
                 SELECT ?1,
                        CASE
                          WHEN EXISTS (SELECT 1 FROM message_labels x
                                       WHERE x.account_id=?1 AND x.message_id=m.id AND x.label_id='TRASH') THEN 'TRASH'
                          WHEN EXISTS (SELECT 1 FROM message_labels x
                                       WHERE x.account_id=?1 AND x.message_id=m.id AND x.label_id='SPAM') THEN 'SPAM'
                          ELSE ml.label_id
                        END,
                        ?2,MAX(m.sent_at)
                 FROM messages m
                 CROSS JOIN message_labels ml
                   ON ml.account_id=m.account_id AND ml.message_id=m.id
                 WHERE m.account_id=?1 AND m.thread_id=?2
                 GROUP BY 2",
            )?
            .execute(params![account_id, thread_id])?;
        Ok(())
    }
}

struct ThreadSummary {
    participants: Vec<String>,
    is_unread: bool,
    is_starred: bool,
    has_attachments: bool,
    has_draft: bool,
}

fn summarize_thread_messages(rows: &[ThreadMessageRow]) -> ThreadSummary {
    let mut participants = Vec::new();
    let mut is_unread = false;
    let mut is_starred = false;
    let mut has_attachments = false;
    let mut has_draft = false;
    for row in rows {
        push_unique(&mut participants, &row.sender);
        is_unread |= row.is_unread;
        is_starred |= row.is_starred;
        has_attachments |= row.has_attachments;
        has_draft |= row.is_draft;
    }
    ThreadSummary {
        participants: participants,
        is_unread: is_unread,
        is_starred: is_starred,
        has_attachments: has_attachments,
        has_draft: has_draft,
    }
}

fn push_unique(values: &mut Vec<String>, candidate: &str) {
    if values.iter().any(|existing| existing == candidate) {
        return;
    }
    values.push(candidate.to_owned());
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

pub(super) fn thread(row: &rusqlite::Row<'_>) -> Result<Thread> {
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
