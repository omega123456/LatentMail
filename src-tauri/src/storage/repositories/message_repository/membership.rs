use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension, Result, Statement};

use super::super::shared::{string_pair_row, ChunkedAccountQuery, ChunkedQuery};
use super::MessageRepository;
use crate::storage::{
    LabelMembershipChange, MessageKey, MutationHistoryUpdate, ReconciliationMessage,
};

pub struct MembershipStatements<'a> {
    pub delete: Statement<'a>,
    pub insert: Statement<'a>,
    pub flags: Statement<'a>,
}

impl<'a> MembershipStatements<'a> {
    pub fn prepare(connection: &'a Connection) -> Result<Self> {
        Ok(Self {
            delete: connection.prepare(DELETE_MESSAGE_MEMBERSHIP)?,
            insert: connection.prepare(INSERT_MESSAGE_LABEL)?,
            flags: connection.prepare(UPDATE_MESSAGE_LABEL_FLAGS)?,
        })
    }
}

pub struct ReconciliationStatements<'a> {
    pub message: Statement<'a>,
    pub labels: Statement<'a>,
}

impl<'a> ReconciliationStatements<'a> {
    pub fn prepare(connection: &'a Connection) -> Result<Self> {
        Ok(Self {
            message: connection.prepare(SELECT_RECONCILIATION_MESSAGE)?,
            labels: connection.prepare(SELECT_MESSAGE_LABEL_IDS)?,
        })
    }
}

const INSERT_MESSAGE_LABEL: &str =
    "INSERT OR IGNORE INTO message_labels (account_id,message_id,label_id) VALUES (?1,?2,?3)";

const DELETE_MESSAGE_LABEL: &str =
    "DELETE FROM message_labels WHERE account_id=?1 AND message_id=?2 AND label_id=?3";

const DENORMALISED_LABEL_FLAG_SQL: &[(&str, &str)] = &[
    (
        "UNREAD",
        "UPDATE messages SET is_unread=?1 WHERE account_id=?2 AND id=?3",
    ),
    (
        "STARRED",
        "UPDATE messages SET is_starred=?1 WHERE account_id=?2 AND id=?3",
    ),
];

const SELECT_MESSAGE_LABEL_IDS: &str =
    "SELECT label_id FROM message_labels WHERE account_id=?1 AND message_id=?2 ORDER BY label_id";

const SELECT_RECONCILIATION_MESSAGE: &str =
    "SELECT thread_id,sender,sent_at,to_recipients,cc_recipients FROM messages WHERE account_id=?1 AND id=?2";

const DELETE_MESSAGE_MEMBERSHIP: &str =
    "DELETE FROM message_labels WHERE account_id=?1 AND message_id=?2";

const UPDATE_MESSAGE_LABEL_FLAGS: &str =
    "UPDATE messages SET is_unread=?1,is_starred=?2 WHERE account_id=?3 AND id=?4";

fn label_membership_sql(present: bool) -> &'static str {
    if present {
        return INSERT_MESSAGE_LABEL;
    }
    DELETE_MESSAGE_LABEL
}

fn denormalised_flag_sql(label_id: &str) -> Option<&'static str> {
    DENORMALISED_LABEL_FLAG_SQL
        .iter()
        .find(|(candidate, _)| *candidate == label_id)
        .map(|(_, sql)| *sql)
}

impl MessageRepository {
    pub fn label_ids_by_thread(
        connection: &Connection,
        account_id: &str,
        thread_ids: &[String],
    ) -> Result<HashMap<String, HashSet<String>>> {
        let ids: Vec<&str> = thread_ids.iter().map(String::as_str).collect();
        let rows = ChunkedAccountQuery::new(connection, account_id).query(
            ChunkedQuery {
                ids: &ids,
                tail: &[],
                sql_for_placeholders: |placeholders| {
                    format!(
                        "SELECT DISTINCT m.thread_id,ml.label_id
                         FROM messages m CROSS JOIN message_labels ml
                         WHERE m.account_id=? AND m.thread_id IN ({placeholders})
                           AND ml.account_id=m.account_id AND ml.message_id=m.id"
                    )
                },
            },
            string_pair_row,
        )?;
        let mut membership: HashMap<String, HashSet<String>> = HashMap::new();
        for pair in rows {
            membership
                .entry(pair.first)
                .or_default()
                .insert(pair.second);
        }
        Ok(membership)
    }

    pub fn label_ids_by_message(
        connection: &Connection,
        account_id: &str,
        message_ids: &[String],
    ) -> Result<HashMap<String, HashSet<String>>> {
        let ids: Vec<&str> = message_ids.iter().map(String::as_str).collect();
        let rows = ChunkedAccountQuery::new(connection, account_id).query(
            ChunkedQuery {
                ids: &ids,
                tail: &[],
                sql_for_placeholders: |placeholders| {
                    format!(
                        "SELECT message_id,label_id FROM message_labels
                         WHERE account_id=? AND message_id IN ({placeholders})"
                    )
                },
            },
            string_pair_row,
        )?;
        let mut membership: HashMap<String, HashSet<String>> = HashMap::new();
        for pair in rows {
            membership
                .entry(pair.first)
                .or_default()
                .insert(pair.second);
        }
        Ok(membership)
    }

    pub fn overwrite_membership(
        connection: &Connection,
        message: MessageKey<'_>,
        label_ids: &[String],
    ) -> Result<()> {
        let mut statements = MembershipStatements {
            delete: connection.prepare(DELETE_MESSAGE_MEMBERSHIP)?,
            insert: connection.prepare(INSERT_MESSAGE_LABEL)?,
            flags: connection.prepare(UPDATE_MESSAGE_LABEL_FLAGS)?,
        };
        Self::overwrite_membership_with(&mut statements, message, label_ids)
    }

    pub fn overwrite_membership_with(
        statements: &mut MembershipStatements<'_>,
        message: MessageKey<'_>,
        label_ids: &[String],
    ) -> Result<()> {
        statements
            .delete
            .execute(params![message.account_id, message.message_id])?;
        for label_id in label_ids {
            statements
                .insert
                .execute(params![message.account_id, message.message_id, label_id])?;
        }
        statements.flags.execute(params![
            label_ids.iter().any(|id| id == "UNREAD"),
            label_ids.iter().any(|id| id == "STARRED"),
            message.account_id,
            message.message_id
        ])?;
        Ok(())
    }

    pub fn write_mutation_history(
        connection: &Connection,
        account_id: &str,
        update: MutationHistoryUpdate<'_>,
    ) -> Result<usize> {
        let mut statement = connection.prepare(
            "UPDATE messages SET history_id=?1 WHERE account_id=?2 AND id=?3 AND history_id < ?1",
        )?;
        update.ids.iter().try_fold(0, |count, id| {
            statement
                .execute(params![update.history_id, account_id, id])
                .map(|changed| count + changed)
        })
    }

    pub fn set_label_membership(
        connection: &Connection,
        message: MessageKey<'_>,
        change: LabelMembershipChange<'_>,
    ) -> Result<()> {
        let membership_sql = label_membership_sql(change.present);
        connection.prepare_cached(membership_sql)?.execute(params![
            message.account_id,
            message.message_id,
            change.label_id
        ])?;
        if let Some(sql) = denormalised_flag_sql(change.label_id) {
            connection.prepare_cached(sql)?.execute(params![
                change.present,
                message.account_id,
                message.message_id
            ])?;
        }
        Ok(())
    }

    pub fn label_ids(connection: &Connection, account_id: &str, id: &str) -> Result<Vec<String>> {
        let mut statement = connection.prepare_cached(SELECT_MESSAGE_LABEL_IDS)?;
        Self::label_ids_with(&mut statement, account_id, id)
    }

    pub fn label_ids_with(
        statement: &mut Statement<'_>,
        account_id: &str,
        id: &str,
    ) -> Result<Vec<String>> {
        let labels = statement
            .query_map(params![account_id, id], |row| row.get(0))?
            .collect();
        labels
    }

    pub fn reconciliation_message(
        connection: &Connection,
        account_id: &str,
        id: &str,
    ) -> Result<Option<ReconciliationMessage>> {
        let mut statements = ReconciliationStatements::prepare(connection)?;
        Self::reconciliation_message_with(
            &mut statements,
            MessageKey {
                account_id: account_id,
                message_id: id,
            },
        )
    }

    pub fn reconciliation_message_with(
        statements: &mut ReconciliationStatements<'_>,
        message: MessageKey<'_>,
    ) -> Result<Option<ReconciliationMessage>> {
        let record = statements
            .message
            .query_row(params![message.account_id, message.message_id], |row| {
                Ok(ReconciliationMessage {
                    thread_id: row.get(0)?,
                    sender: row.get(1)?,
                    sent_at: row.get(2)?,
                    to_recipients: row.get(3)?,
                    cc_recipients: row.get(4)?,
                    label_ids: Vec::new(),
                })
            })
            .optional()?;
        let Some(mut record) = record else {
            return Ok(None);
        };
        record.label_ids = Self::label_ids_with(
            &mut statements.labels,
            message.account_id,
            message.message_id,
        )?;
        Ok(Some(record))
    }
}
