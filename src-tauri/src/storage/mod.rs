pub mod addresses;
mod repositories;

pub use repositories::{
    truncate_body, Account, AccountRepository, AvatarCacheOutcome, AvatarCacheRecord,
    AvatarCacheRepository, ComposeDraftMetadata, ComposeDraftMetadataRepository,
    ComposeMessageContext, ConversationMessage, HtmlPresence, InlinePart, Label, LabelColor,
    LabelNameError, LabelRepository, Message, MessageRepository, Operation, OperationRepository,
    ReconciliationMessage, SearchRepository, SettingRepository, Thread, ThreadIdentity,
    ThreadListRow, ThreadRepository, TraversalCursor, TraversalCursorRepository, TraversalKind,
};

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use rusqlite::Connection;
use thiserror::Error;


const BUSY_TIMEOUT: Duration = Duration::from_secs(5);


const STATEMENT_CACHE_CAPACITY: usize = 48;

fn configure(connection: &Connection) -> rusqlite::Result<()> {
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.busy_timeout(BUSY_TIMEOUT)?;
    connection.set_prepared_statement_cache_capacity(STATEMENT_CACHE_CAPACITY);
    Ok(())
}


fn configure_database(connection: &Connection) -> rusqlite::Result<()> {
    configure(connection)?;
    connection.pragma_update(None, "journal_mode", "WAL")
}

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
        let mut connection = Connection::open(storage.path.as_ref())?;
        configure_database(&connection)?;
        embedded::migrations::runner().run(&mut connection)?;
        Ok(storage)
    }

    pub fn in_memory() -> Result<Connection, StorageError> {
        let mut connection = Connection::open_in_memory()?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.set_prepared_statement_cache_capacity(STATEMENT_CACHE_CAPACITY);
        embedded::migrations::runner().run(&mut connection)?;
        Ok(connection)
    }

    pub fn connection(&self) -> Result<Connection, StorageError> {
        let connection = Connection::open(self.path.as_ref())?;
        configure(&connection)?;
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
            configure(&connection)?;
            task(&connection)
        })
        .await?
        .map_err(StorageError::from)
    }
}
