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
        let mut statement = connection.prepare_cached("SELECT id,email,display_name,avatar_url,history_id,needs_reauthentication,created_at,updated_at FROM accounts ORDER BY created_at")?;
        statement.query_map([], account)?.collect()
    }
    pub fn delete(connection: &Connection, id: &str) -> Result<usize> {
        connection.execute("DELETE FROM accounts WHERE id=?1", params![id])
    }
}

pub(super) fn account(row: &rusqlite::Row<'_>) -> Result<Account> {
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
