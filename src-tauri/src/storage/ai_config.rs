use rusqlite::{params, Connection, OptionalExtension, Result};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountAiConfig {
    pub account_id: String,
    pub enabled: bool,
    pub index_paused: bool,
    pub base_url: Option<String>,
    pub chat_model: Option<String>,
    pub embedding_model: Option<String>,
    pub embedding_dimensions: Option<i64>,
}

pub struct AccountAiConfigRepository;

impl AccountAiConfigRepository {
    pub fn list(connection: &Connection) -> Result<Vec<AccountAiConfig>> {
        let mut statement = connection.prepare_cached("SELECT account_id,enabled,index_paused,base_url,chat_model,embedding_model,embedding_dimensions FROM account_ai_config")?;
        let configs = statement.query_map([], config)?.collect();
        configs
    }

    pub fn get(connection: &Connection, account_id: &str) -> Result<Option<AccountAiConfig>> {
        let mut statement = connection.prepare_cached("SELECT account_id,enabled,index_paused,base_url,chat_model,embedding_model,embedding_dimensions FROM account_ai_config WHERE account_id=?1")?;
        statement.query_row([account_id], config).optional()
    }

    pub fn ensure(connection: &Connection, account_id: &str) -> Result<()> {
        connection
            .prepare_cached("INSERT OR IGNORE INTO account_ai_config (account_id) VALUES (?1)")?
            .execute([account_id])?;
        Ok(())
    }

    pub fn set_enabled(connection: &Connection, account_id: &str, enabled: bool) -> Result<()> {
        Self::ensure(connection, account_id)?;
        connection
            .prepare_cached("UPDATE account_ai_config SET enabled=?1 WHERE account_id=?2")?
            .execute(params![enabled, account_id])?;
        Ok(())
    }

    pub fn set_base_url(connection: &Connection, account_id: &str, base_url: &str) -> Result<()> {
        Self::ensure(connection, account_id)?;
        connection
            .prepare_cached("UPDATE account_ai_config SET base_url=?1 WHERE account_id=?2")?
            .execute(params![base_url, account_id])?;
        Ok(())
    }

    pub fn set_chat_model(
        connection: &Connection,
        account_id: &str,
        model: Option<&str>,
    ) -> Result<()> {
        Self::ensure(connection, account_id)?;
        connection
            .prepare_cached("UPDATE account_ai_config SET chat_model=?1 WHERE account_id=?2")?
            .execute(params![model, account_id])?;
        Ok(())
    }

    pub fn set_embedding_model(
        connection: &Connection,
        account_id: &str,
        model: &str,
        dimensions: i64,
    ) -> Result<()> {
        Self::ensure(connection, account_id)?;
        connection.prepare_cached("UPDATE account_ai_config SET embedding_model=?1,embedding_dimensions=?2 WHERE account_id=?3")?.execute(params![model, dimensions, account_id])?;
        Ok(())
    }
    pub fn set_index_paused(connection: &Connection, account_id: &str, paused: bool) -> Result<()> {
        Self::ensure(connection, account_id)?;
        connection
            .prepare_cached("UPDATE account_ai_config SET index_paused=?1 WHERE account_id=?2")?
            .execute(params![paused, account_id])?;
        Ok(())
    }
}

fn config(row: &rusqlite::Row<'_>) -> Result<AccountAiConfig> {
    Ok(AccountAiConfig {
        account_id: row.get(0)?,
        enabled: row.get(1)?,
        index_paused: row.get(2)?,
        base_url: row.get(3)?,
        chat_model: row.get(4)?,
        embedding_model: row.get(5)?,
        embedding_dimensions: row.get(6)?,
    })
}
