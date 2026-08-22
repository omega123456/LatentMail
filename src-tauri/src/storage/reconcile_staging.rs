use rusqlite::{params, Connection, Result, Statement};

use super::{TraversalCursor, TraversalCursorRepository, TraversalKind};

pub const RECONCILE_BATCH_SIZE: usize = 100;

pub struct ReconcileStagingRepository;

impl ReconcileStagingRepository {
    pub fn begin(connection: &Connection, cursor: &TraversalCursor) -> Result<()> {
        let transaction = connection.unchecked_transaction()?;
        transaction.execute(
            "DELETE FROM reconcile_remote_labels WHERE account_id=?1",
            [&cursor.account_id],
        )?;
        transaction.execute(
            "DELETE FROM reconcile_remote_messages WHERE account_id=?1",
            [&cursor.account_id],
        )?;
        TraversalCursorRepository::upsert(&transaction, cursor)?;
        transaction.commit()
    }

    pub fn stage_universe_page(
        connection: &Connection,
        account_id: &str,
        ids: &[String],
        cursor: &TraversalCursor,
    ) -> Result<()> {
        let transaction = connection.unchecked_transaction()?;
        let mut statement = transaction.prepare_cached(
            "INSERT OR IGNORE INTO reconcile_remote_messages (account_id,message_id) VALUES (?1,?2)",
        )?;
        for id in ids {
            statement.execute(params![account_id, id])?;
        }
        drop(statement);
        TraversalCursorRepository::upsert(&transaction, cursor)?;
        transaction.commit()
    }

    pub fn stage_label_page(
        connection: &Connection,
        account_id: &str,
        label_id: &str,
        ids: &[String],
        cursor: &TraversalCursor,
    ) -> Result<()> {
        let transaction = connection.unchecked_transaction()?;
        let mut statement = transaction.prepare_cached(
            "INSERT OR IGNORE INTO reconcile_remote_labels (account_id,message_id,label_id) VALUES (?1,?2,?3)",
        )?;
        for id in ids {
            statement.execute(params![account_id, id, label_id])?;
        }
        drop(statement);
        TraversalCursorRepository::upsert(&transaction, cursor)?;
        transaction.commit()
    }

    pub fn new_message_ids(
        connection: &Connection,
        account_id: &str,
        after: Option<&str>,
    ) -> Result<Vec<String>> {
        let mut statement = connection.prepare_cached(
            "SELECT r.message_id FROM reconcile_remote_messages r
             LEFT JOIN messages m ON m.account_id=r.account_id AND m.id=r.message_id
             WHERE r.account_id=?1 AND m.id IS NULL AND r.message_id>COALESCE(?2,'')
             ORDER BY r.message_id LIMIT ?3",
        )?;
        let ids = statement
            .query_map(params![account_id, after, RECONCILE_BATCH_SIZE], |row| {
                row.get(0)
            })?
            .collect();
        ids
    }

    pub fn absent_message_ids(
        connection: &Connection,
        account_id: &str,
        after: Option<&str>,
    ) -> Result<Vec<String>> {
        let mut statement = connection.prepare_cached(
            "SELECT m.id FROM messages m
             LEFT JOIN reconcile_remote_messages r ON r.account_id=m.account_id AND r.message_id=m.id
             WHERE m.account_id=?1 AND r.message_id IS NULL AND m.id>COALESCE(?2,'')
             ORDER BY m.id LIMIT ?3",
        )?;
        let ids = statement
            .query_map(params![account_id, after, RECONCILE_BATCH_SIZE], |row| {
                row.get(0)
            })?
            .collect();
        ids
    }

    pub fn membership_message_ids(
        connection: &Connection,
        account_id: &str,
        after: Option<&str>,
    ) -> Result<Vec<String>> {
        let mut statement = connection.prepare_cached(
            "SELECT r.message_id FROM reconcile_remote_messages r
             JOIN messages m ON m.account_id=r.account_id AND m.id=r.message_id
             WHERE r.account_id=?1 AND r.message_id>COALESCE(?2,'')
               AND (EXISTS (SELECT 1 FROM reconcile_remote_labels l WHERE l.account_id=r.account_id AND l.message_id=r.message_id AND NOT EXISTS (SELECT 1 FROM message_labels ml WHERE ml.account_id=l.account_id AND ml.message_id=l.message_id AND ml.label_id=l.label_id))
                 OR EXISTS (SELECT 1 FROM message_labels ml WHERE ml.account_id=r.account_id AND ml.message_id=r.message_id AND NOT EXISTS (SELECT 1 FROM reconcile_remote_labels l WHERE l.account_id=ml.account_id AND l.message_id=ml.message_id AND l.label_id=ml.label_id)))
             ORDER BY r.message_id LIMIT ?3",
        )?;
        let ids = statement
            .query_map(params![account_id, after, RECONCILE_BATCH_SIZE], |row| {
                row.get(0)
            })?
            .collect();
        ids
    }

    pub fn remote_message_ids(
        connection: &Connection,
        account_id: &str,
        after: Option<&str>,
    ) -> Result<Vec<String>> {
        let mut statement = connection.prepare_cached(
            "SELECT message_id FROM reconcile_remote_messages
             WHERE account_id=?1 AND message_id>COALESCE(?2,'')
             ORDER BY message_id LIMIT ?3",
        )?;
        let ids = statement
            .query_map(params![account_id, after, RECONCILE_BATCH_SIZE], |row| {
                row.get(0)
            })?
            .collect();
        ids
    }

    pub fn labels_for_message(
        connection: &Connection,
        account_id: &str,
        message_id: &str,
    ) -> Result<Vec<String>> {
        let mut statement = connection.prepare_cached(
            "SELECT label_id FROM reconcile_remote_labels WHERE account_id=?1 AND message_id=?2 ORDER BY label_id",
        )?;
        Self::labels_for_message_with(&mut statement, account_id, message_id)
    }

    pub fn labels_for_message_with(
        statement: &mut Statement<'_>,
        account_id: &str,
        message_id: &str,
    ) -> Result<Vec<String>> {
        let labels = statement
            .query_map(params![account_id, message_id], |row| row.get(0))?
            .collect();
        labels
    }

    pub fn clear(connection: &Connection, account_id: &str) -> Result<()> {
        connection.execute(
            "DELETE FROM reconcile_remote_labels WHERE account_id=?1",
            [account_id],
        )?;
        connection.execute(
            "DELETE FROM reconcile_remote_messages WHERE account_id=?1",
            [account_id],
        )?;
        Ok(())
    }

    pub fn counts(connection: &Connection, account_id: &str) -> Result<(i64, i64)> {
        let messages = connection.query_row(
            "SELECT COUNT(*) FROM reconcile_remote_messages WHERE account_id=?1",
            [account_id],
            |row| row.get(0),
        )?;
        let labels = connection.query_row(
            "SELECT COUNT(*) FROM reconcile_remote_labels WHERE account_id=?1",
            [account_id],
            |row| row.get(0),
        )?;
        Ok((messages, labels))
    }

    pub fn reconciliation_cursor(
        connection: &Connection,
        account_id: &str,
    ) -> Result<Option<TraversalCursor>> {
        TraversalCursorRepository::get(connection, account_id, TraversalKind::Reconciliation)
    }
}
