use rusqlite::{params, Connection, OptionalExtension, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingEntry {
    pub key: String,
    pub value: String,
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
    pub fn list(connection: &Connection) -> Result<Vec<SettingEntry>> {
        let mut statement = connection.prepare("SELECT key,value FROM settings")?;
        let settings = statement
            .query_map([], |row| {
                Ok(SettingEntry {
                    key: row.get(0)?,
                    value: row.get(1)?,
                })
            })?
            .collect();
        settings
    }
}
