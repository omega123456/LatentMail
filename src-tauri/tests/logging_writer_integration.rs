use chrono::NaiveDate;
use latentmail_lib::ipc::{write_frontend_log, FrontendLogLevel, FrontendLogRecord};
use latentmail_lib::logging::{cleanup, subscriber};
use std::fs;
use tracing::Level;
use tracing_subscriber::filter::LevelFilter;

#[test]
fn writer_records_frontend_messages_but_filters_debug() {
    let directory = tempfile::tempdir().unwrap();
    let (subscriber, guard) = subscriber(directory.path(), LevelFilter::INFO).unwrap();

    tracing::dispatcher::with_default(&subscriber, || {
        write_frontend_log(FrontendLogRecord {
            level: FrontendLogLevel::Debug,
            message: "filtered record".into(),
        });
        write_frontend_log(FrontendLogRecord {
            level: FrontendLogLevel::Info,
            message: "info record".into(),
        });
        write_frontend_log(FrontendLogRecord {
            level: FrontendLogLevel::Warn,
            message: "warn record".into(),
        });
        write_frontend_log(FrontendLogRecord {
            level: FrontendLogLevel::Error,
            message: "error record".into(),
        });
        tracing::event!(Level::DEBUG, "filtered record");
    });
    // `WorkerGuard` has no `flush()` method; its `Drop` impl blocks until all
    // buffered lines are written to the underlying file.
    drop(guard);

    let contents = fs::read_to_string(
        fs::read_dir(directory.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path(),
    )
    .unwrap();
    assert!(contents.contains("info record"));
    assert!(contents.contains("warn record"));
    assert!(contents.contains("error record"));
    assert!(!contents.contains("filtered record"));
}

#[test]
fn cleanup_removes_files_older_than_seven_days() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(directory.path().join("latentmail.log.2026-08-03"), "old").unwrap();
    fs::write(directory.path().join("latentmail.log.2026-08-04"), "kept").unwrap();

    cleanup(
        directory.path(),
        NaiveDate::from_ymd_opt(2026, 8, 11).unwrap(),
    )
    .unwrap();

    assert!(!directory.path().join("latentmail.log.2026-08-03").exists());
    assert!(directory.path().join("latentmail.log.2026-08-04").exists());
}
