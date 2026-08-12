//! WAL journaling and the busy timeout (D8, Phase 1 AC1). In-memory SQLite
//! cannot use WAL, so this test — and only this test — uses a temporary
//! file-backed database (`Storage::open`, never `Storage::in_memory`).

use std::sync::mpsc;

use latentmail_lib::storage::{Account, AccountRepository, Storage};

fn account(id: &str) -> Account {
    Account {
        id: id.into(),
        email: format!("{id}@example.com"),
        display_name: "A".into(),
        avatar_url: None,
        history_id: None,
        needs_reauthentication: false,
        created_at: 0,
        updated_at: 0,
    }
}

#[test]
fn a_file_backed_database_reports_wal_enabled() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    let mode: String = connection
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .unwrap();
    assert_eq!(mode.to_ascii_lowercase(), "wal");
}

/// Under the default rollback journal a write transaction blocks readers for
/// its whole duration; under WAL a reader proceeds from the last committed
/// snapshot regardless. Synchronization is via channels (never a sleep) so
/// the writer's transaction is provably still open when the read runs.
#[test]
fn a_read_completes_while_a_sustained_write_transaction_is_in_flight() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("mail.sqlite");
    let storage = Storage::open(&path).unwrap();

    let (writer_ready_tx, writer_ready_rx) = mpsc::channel::<()>();
    let (release_writer_tx, release_writer_rx) = mpsc::channel::<()>();
    let (writer_done_tx, writer_done_rx) = mpsc::channel::<()>();

    let writer_path = path.clone();
    let writer = std::thread::spawn(move || {
        let storage = Storage::open(&writer_path).unwrap();
        let mut connection = storage.connection().unwrap();
        let transaction = connection.transaction().unwrap();
        AccountRepository::upsert(&transaction, &account("writer")).unwrap();
        // Deliberately left uncommitted: the write lock stays held until the
        // reader has proven it can proceed, then `release_writer_rx` fires.
        writer_ready_tx.send(()).unwrap();
        release_writer_rx.recv().unwrap();
        transaction.commit().unwrap();
        writer_done_tx.send(()).unwrap();
    });

    writer_ready_rx.recv().unwrap();
    // Bounded, not a sleep: proves the read isn't blocked by the still-open
    // writer, without depending on real timing beyond "reasonably prompt".
    let connection = storage.connection().unwrap();
    let read_result = connection.query_row("SELECT COUNT(*) FROM accounts", [], |row| {
        row.get::<_, i64>(0)
    });
    assert!(
        read_result.is_ok(),
        "a read must complete while a write transaction is in flight under WAL"
    );

    release_writer_tx.send(()).unwrap();
    writer_done_rx.recv().unwrap();
    writer.join().unwrap();

    let connection = storage.connection().unwrap();
    assert!(AccountRepository::get(&connection, "writer")
        .unwrap()
        .is_some());
}

/// The busy timeout is set per connection (not database-wide), so a
/// momentary lock conflict waits instead of failing immediately with
/// `SQLITE_BUSY`.
#[test]
fn a_connection_reports_a_nonzero_busy_timeout() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    let timeout_ms: i64 = connection
        .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
        .unwrap();
    assert!(timeout_ms > 0);
}
