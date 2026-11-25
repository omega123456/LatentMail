use rusqlite::{params, Connection, OptionalExtension, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AvatarCacheOutcome {
    Hit,
    Miss,
}

impl AvatarCacheOutcome {
    fn as_db_str(self) -> &'static str {
        match self {
            Self::Hit => "hit",
            Self::Miss => "miss",
        }
    }
    fn from_db_str(value: &str) -> Self {
        match value {
            "hit" => Self::Hit,
            _ => Self::Miss,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvatarCacheRecord {
    pub cache_key: String,
    pub outcome: AvatarCacheOutcome,

    pub image_path: Option<String>,
    pub looked_up_at: i64,
}

pub struct AvatarCacheRepository;

impl AvatarCacheRepository {
    pub fn upsert(connection: &Connection, record: &AvatarCacheRecord) -> Result<()> {
        connection.execute(
            "INSERT INTO avatar_cache (cache_key,outcome,image_path,looked_up_at) VALUES (?1,?2,?3,?4)
             ON CONFLICT(cache_key) DO UPDATE SET outcome=excluded.outcome,image_path=excluded.image_path,looked_up_at=excluded.looked_up_at",
            params![
                record.cache_key,
                record.outcome.as_db_str(),
                record.image_path,
                record.looked_up_at
            ],
        )?;
        Ok(())
    }
    pub fn get(connection: &Connection, cache_key: &str) -> Result<Option<AvatarCacheRecord>> {
        connection
            .query_row(
                "SELECT cache_key,outcome,image_path,looked_up_at FROM avatar_cache WHERE cache_key=?1",
                [cache_key],
                |row| {
                    let outcome: String = row.get(1)?;
                    Ok(AvatarCacheRecord {
                        cache_key: row.get(0)?,
                        outcome: AvatarCacheOutcome::from_db_str(&outcome),
                        image_path: row.get(2)?,
                        looked_up_at: row.get(3)?,
                    })
                },
            )
            .optional()
    }
}
