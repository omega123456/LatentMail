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

#[test]
fn a_read_completes_while_a_sustained_write_transaction_is_in_flight() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("mail.sqlite");
    let storage = Storage::open(&path).unwrap();

    let (writer_ready_sender, writer_ready_receiver) = mpsc::channel::<()>();
    let (release_writer_sender, release_writer_receiver) = mpsc::channel::<()>();
    let (writer_done_sender, writer_done_receiver) = mpsc::channel::<()>();

    let writer_path = path.clone();
    let writer = std::thread::spawn(move || {
        let storage = Storage::open(&writer_path).unwrap();
        let mut connection = storage.connection().unwrap();
        let transaction = connection.transaction().unwrap();
        AccountRepository::upsert(&transaction, &account("writer")).unwrap();

        writer_ready_sender.send(()).unwrap();
        release_writer_receiver.recv().unwrap();
        transaction.commit().unwrap();
        writer_done_sender.send(()).unwrap();
    });

    writer_ready_receiver.recv().unwrap();

    let connection = storage.connection().unwrap();
    let read_result = connection.query_row("SELECT COUNT(*) FROM accounts", [], |row| {
        row.get::<_, i64>(0)
    });
    assert!(
        read_result.is_ok(),
        "a read must complete while a write transaction is in flight under WAL"
    );

    release_writer_sender.send(()).unwrap();
    writer_done_receiver.recv().unwrap();
    writer.join().unwrap();

    let connection = storage.connection().unwrap();
    assert!(AccountRepository::get(&connection, "writer")
        .unwrap()
        .is_some());
}

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
