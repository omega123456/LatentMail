use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension, Result, Statement};

use super::message::message;
use super::shared::{string_pair_row, ChunkedAccountQuery, ChunkedQuery};
use crate::storage::{Message, MessageKey};

mod body;
mod compose;
mod conversation;
mod membership;

pub use membership::{LabelRowStatements, MembershipStatements, ReconciliationStatements};

const DELETE_MESSAGE_RETURNING_THREAD: &str =
    "DELETE FROM messages WHERE account_id=?1 AND id=?2 RETURNING thread_id";

pub struct MessageRepository;

impl MessageRepository {
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
        let mut statement = connection.prepare_cached("SELECT account_id,id,thread_id,rfc_message_id,sender,recipients,subject,sent_at,snippet,html_body,plain_body,has_attachments,is_unread,is_starred,history_id,truncated_body,html_presence FROM messages WHERE account_id=?1 AND thread_id=?2 ORDER BY sent_at")?;
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
        let ids: Vec<&str> = thread_ids.iter().map(String::as_str).collect();
        let rows = ChunkedAccountQuery::new(connection, account_id).query(
            ChunkedQuery {
                ids: &ids,
                tail: &[],
                sql_for_placeholders: |placeholders| {
                    format!(
                        "SELECT account_id,id,thread_id,rfc_message_id,sender,recipients,subject,sent_at,snippet,html_body,plain_body,has_attachments,is_unread,is_starred,history_id,truncated_body,html_presence
                         FROM messages WHERE account_id=? AND thread_id IN ({placeholders})
                         ORDER BY thread_id,sent_at,id"
                    )
                },
            },
            message,
        )?;
        for entry in rows {
            messages
                .entry(entry.thread_id.clone())
                .or_default()
                .push(entry);
        }
        Ok(messages)
    }
    pub fn get_many(
        connection: &Connection,
        account_id: &str,
        ids: &[String],
    ) -> Result<HashMap<String, Message>> {
        let id_refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        let rows = ChunkedAccountQuery::new(connection, account_id).query(
            ChunkedQuery {
                ids: &id_refs,
                tail: &[],
                sql_for_placeholders: |placeholders| {
                    format!(
                        "SELECT account_id,id,thread_id,rfc_message_id,sender,recipients,subject,sent_at,snippet,html_body,plain_body,has_attachments,is_unread,is_starred,history_id,truncated_body,html_presence
                         FROM messages WHERE account_id=? AND id IN ({placeholders})"
                    )
                },
            },
            message,
        )?;
        Ok(rows
            .into_iter()
            .map(|entry| (entry.id.clone(), entry))
            .collect())
    }
    pub fn draft_message_ids_by_thread(
        connection: &Connection,
        account_id: &str,
        thread_ids: &[String],
    ) -> Result<HashMap<String, Vec<String>>> {
        let ids: Vec<&str> = thread_ids.iter().map(String::as_str).collect();
        let rows = ChunkedAccountQuery::new(connection, account_id).query(
            ChunkedQuery {
                ids: &ids,
                tail: &[],
                sql_for_placeholders: |placeholders| {
                    format!(
                        "SELECT m.thread_id,m.id
                         FROM messages m CROSS JOIN message_labels ml
                         WHERE m.account_id=? AND m.thread_id IN ({placeholders})
                           AND ml.account_id=m.account_id AND ml.message_id=m.id AND ml.label_id='DRAFT'
                         ORDER BY m.thread_id,m.sent_at,m.id"
                    )
                },
            },
            string_pair_row,
        )?;
        let mut drafts: HashMap<String, Vec<String>> = HashMap::new();
        for pair in rows {
            drafts.entry(pair.first).or_default().push(pair.second);
        }
        Ok(drafts)
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
        let id_refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        let existing: HashSet<String> = ChunkedAccountQuery::new(connection, account_id)
            .query(
                ChunkedQuery {
                    ids: &id_refs,
                    tail: &[],
                    sql_for_placeholders: |placeholders| {
                        format!(
                            "SELECT id FROM messages WHERE account_id=? AND id IN ({placeholders})"
                        )
                    },
                },
                |row| row.get(0),
            )?
            .into_iter()
            .collect();
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
        message: MessageKey<'_>,
        draft_id: &str,
    ) -> Result<()> {
        connection.execute(
            "UPDATE messages SET draft_id=?1 WHERE account_id=?2 AND id=?3",
            params![draft_id, message.account_id, message.message_id],
        )?;
        Ok(())
    }
    pub fn delete(connection: &Connection, account_id: &str, id: &str) -> Result<Option<String>> {
        let mut statement = connection.prepare_cached(DELETE_MESSAGE_RETURNING_THREAD)?;
        Self::delete_with(&mut statement, account_id, id)
    }
    pub fn delete_many(
        connection: &Connection,
        account_id: &str,
        ids: &[String],
    ) -> Result<HashSet<String>> {
        let mut statement = connection.prepare_cached(DELETE_MESSAGE_RETURNING_THREAD)?;
        let mut threads = HashSet::new();
        for id in ids {
            let deleted_from_thread = Self::delete_with(&mut statement, account_id, id)?;
            threads.extend(deleted_from_thread);
        }
        Ok(threads)
    }
    pub fn delete_with(
        statement: &mut Statement<'_>,
        account_id: &str,
        id: &str,
    ) -> Result<Option<String>> {
        statement
            .query_row(params![account_id, id], |row| row.get(0))
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
}
