use chrono::NaiveDate;
use latentmail_lib::ipc::{write_frontend_log, FrontendLogLevel};
use latentmail_lib::logging::{cleanup, init, subscriber};
use std::fs;
use tracing::Level;
use tracing_subscriber::filter::LevelFilter;

#[test]
fn writer_records_frontend_messages_but_filters_debug() {
    let directory = tempfile::tempdir().unwrap();
    let (subscriber, guard) = subscriber(directory.path(), LevelFilter::INFO).unwrap();

    tracing::dispatcher::with_default(&subscriber, || {
        write_frontend_log(FrontendLogLevel::Debug, "filtered record".into());
        write_frontend_log(FrontendLogLevel::Info, "info record".into());
        write_frontend_log(FrontendLogLevel::Warn, "warn record".into());
        write_frontend_log(FrontendLogLevel::Error, "error record".into());
        tracing::event!(Level::DEBUG, "filtered record");
    });

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
fn init_installs_a_global_dispatcher_and_creates_the_log_directory() {
    let directory = tempfile::tempdir().unwrap();
    let log_directory = directory.path().join("nested");

    let guard = init(&log_directory).unwrap();

    tracing::info!("routed through the global dispatcher");
    drop(guard);

    assert!(fs::read_dir(&log_directory).unwrap().next().is_some());
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
