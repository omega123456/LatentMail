mod repositories;

pub use repositories::{
    Account, AccountRepository, InlinePart, Label, LabelRepository, Message, MessageRepository,
    Operation, OperationRepository, SettingRepository, Thread, ThreadRepository,
};

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use rusqlite::Connection;
use thiserror::Error;

mod embedded {
    use refinery::embed_migrations;

    embed_migrations!("./migrations");
}

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("migration error: {0}")]
    Migration(#[from] refinery::Error),
    #[error("database task failed: {0}")]
    Task(#[from] tokio::task::JoinError),
}

#[derive(Clone, Debug)]
pub struct Storage {
    path: Arc<PathBuf>,
}

impl Storage {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let storage = Self {
            path: Arc::new(path.as_ref().to_path_buf()),
        };
        let mut connection = storage.connection()?;
        embedded::migrations::runner().run(&mut connection)?;
        Ok(storage)
    }

    pub fn in_memory() -> Result<Connection, StorageError> {
        let mut connection = Connection::open_in_memory()?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        embedded::migrations::runner().run(&mut connection)?;
        Ok(connection)
    }

    pub fn connection(&self) -> Result<Connection, StorageError> {
        let connection = Connection::open(self.path.as_ref())?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        Ok(connection)
    }

    pub async fn run<T, F>(&self, task: F) -> Result<T, StorageError>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T, rusqlite::Error> + Send + 'static,
    {
        let path = Arc::clone(&self.path);
        tokio::task::spawn_blocking(move || {
            let connection = Connection::open(path.as_ref())?;
            connection.pragma_update(None, "foreign_keys", "ON")?;
            task(&connection)
        })
        .await?
        .map_err(StorageError::from)
    }
}
