use latentmail_lib::storage::{vacuum_interval, Storage};

#[test]
fn vacuum_interval_is_six_hours() {
    assert_eq!(
        vacuum_interval(),
        chrono::Duration::hours(6).to_std().unwrap()
    );
}

#[test]
fn a_new_database_opens_in_incremental_auto_vacuum_mode() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    let mode: i64 = connection
        .query_row("PRAGMA auto_vacuum", [], |row| row.get(0))
        .unwrap();

    assert_eq!(mode, 2);
}

#[tokio::test]
async fn vacuum_drains_the_free_list() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    connection
        .execute_batch(
            "CREATE TABLE vacuum_test (value BLOB NOT NULL);\
             INSERT INTO vacuum_test VALUES (zeroblob(1048576));\
             DELETE FROM vacuum_test;",
        )
        .unwrap();
    let free_pages: u64 = connection
        .query_row("PRAGMA freelist_count", [], |row| row.get(0))
        .unwrap();
    drop(connection);

    assert!(free_pages > 0);
    assert_eq!(storage.vacuum().await.unwrap(), free_pages);

    let connection = storage.connection().unwrap();
    let remaining_pages: u64 = connection
        .query_row("PRAGMA freelist_count", [], |row| row.get(0))
        .unwrap();
    assert_eq!(remaining_pages, 0);
}

#[tokio::test]
async fn vacuum_reclaims_nothing_when_auto_vacuum_is_disabled() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    connection
        .execute_batch("PRAGMA auto_vacuum=NONE; VACUUM;")
        .unwrap();
    drop(connection);

    assert_eq!(storage.vacuum().await.unwrap(), 0);
}
