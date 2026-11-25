use rusqlite::{params, Connection, OptionalExtension, Result};

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
