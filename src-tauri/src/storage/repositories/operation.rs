use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Result};

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

pub struct TerminalOutcome<'a> {
    pub status: &'a str,
    pub error: Option<&'a str>,
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

    pub fn failed_durable(
        connection: &Connection,
        account_id: Option<&str>,
    ) -> Result<Vec<Operation>> {
        match account_id {
            Some(account_id) => {
                let mut statement = connection.prepare("SELECT id,account_id,lane,kind,entity_key,payload,status,attempts,next_attempt_at,error,created_at,updated_at FROM operations WHERE kind IN ('send','draft') AND status='failed' AND account_id=?1 ORDER BY created_at")?;
                let rows = statement
                    .query_map(params![account_id], operation)?
                    .collect();
                rows
            }
            None => {
                let mut statement = connection.prepare("SELECT id,account_id,lane,kind,entity_key,payload,status,attempts,next_attempt_at,error,created_at,updated_at FROM operations WHERE kind IN ('send','draft') AND status='failed' ORDER BY created_at")?;
                let rows = statement.query_map([], operation)?.collect();
                rows
            }
        }
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
        outcome: TerminalOutcome<'_>,
    ) -> Result<()> {
        connection.execute(
            "UPDATE operations SET status=?2, error=?3, updated_at=strftime('%s','now') WHERE id=?1",
            params![id, outcome.status, outcome.error],
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

pub(super) fn operation(row: &rusqlite::Row<'_>) -> Result<Operation> {
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
