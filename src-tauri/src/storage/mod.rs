mod repositories;

pub use repositories::{
    truncate_body, Account, AccountRepository, HtmlPresence, InlinePart, Label, LabelColor,
    LabelNameError, LabelRepository, Message, MessageRepository, Operation, OperationRepository,
    SettingRepository, Thread, ThreadRepository, TraversalCursor, TraversalCursorRepository,
    TraversalKind,
};

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use rusqlite::Connection;
use thiserror::Error;

/// How long a connection blocks on a lock held by another connection before
/// giving up (D8) — matters most for a writer briefly holding SQLite's
/// single write lock while readers proceed under WAL.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Applied to every file-backed connection: foreign keys on, WAL journaling
/// (a persistent database-level property, set once here rather than per
/// transaction) and a busy timeout so a momentary lock conflict waits
/// instead of erroring immediately. WAL is what lets a read complete while a
/// write transaction is in flight — the default rollback journal blocks
/// readers for the duration of a writer's transaction. In-memory databases
/// cannot use WAL (see [`Storage::in_memory`]), so this is never called for
/// them.
fn configure(connection: &Connection) -> rusqlite::Result<()> {
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.busy_timeout(BUSY_TIMEOUT)?;
    Ok(())
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
