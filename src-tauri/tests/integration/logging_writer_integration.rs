use chrono::NaiveDate;
use latentmail_lib::ipc::{write_frontend_log, FrontendLogLevel};
use latentmail_lib::logging::{cleanup, init, subscriber};
use std::fs;
use tracing::Level;
use tracing_subscriber::filter::LevelFilter;

#[test]
fn writer_records_frontend_messages_but_filters_debug() {
    let directory = tempfile::tempdir().unwrap();
    let (subscriber, guard, _handle) = subscriber(directory.path(), LevelFilter::INFO).unwrap();

    tracing::dispatcher::with_default(&subscriber, || {
        write_frontend_log(FrontendLogLevel::Debug, "filtered record".into());
        write_frontend_log(FrontendLogLevel::Info, "info record".into());
        write_frontend_log(FrontendLogLevel::Warn, "warn record".into());
        write_frontend_log(FrontendLogLevel::Error, "error record".into());
        tracing::event!(Level::DEBUG, "filtered record");
    });

    drop(guard);

    let path = fs::read_dir(directory.path())
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(path.extension().unwrap(), "log");
    assert_eq!(
        path.file_stem().unwrap().to_str().unwrap(),
        format!("latentmail.{}", chrono::Utc::now().format("%Y-%m-%d"))
    );

    let contents = fs::read_to_string(path).unwrap();
    assert!(contents.contains("info record"));
    assert!(contents.contains("warn record"));
    assert!(contents.contains("error record"));
    assert!(!contents.contains("filtered record"));
}

#[test]
fn init_installs_a_global_dispatcher_and_creates_the_log_directory() {
    let directory = tempfile::tempdir().unwrap();
    let log_directory = directory.path().join("nested");

    let (guard, _handle) = init(&log_directory).unwrap();

    tracing::info!("routed through the global dispatcher");
    drop(guard);

    assert!(fs::read_dir(&log_directory).unwrap().next().is_some());
}

#[test]
fn reload_handle_changes_the_level_without_a_restart() {
    let directory = tempfile::tempdir().unwrap();
    let (subscriber, guard, handle) = subscriber(directory.path(), LevelFilter::INFO).unwrap();

    tracing::dispatcher::with_default(&subscriber, || {
        tracing::event!(Level::DEBUG, "before reload");
    });
    handle.reload(LevelFilter::DEBUG).unwrap();
    tracing::dispatcher::with_default(&subscriber, || {
        tracing::event!(Level::DEBUG, "after reload");
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
    assert!(!contents.contains("before reload"));
    assert!(contents.contains("after reload"));
}

#[test]
fn cleanup_removes_files_older_than_seven_days() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(directory.path().join("latentmail.2026-08-03.log"), "old").unwrap();
    fs::write(directory.path().join("latentmail.2026-08-04.log"), "kept").unwrap();
    fs::write(directory.path().join("latentmail.2026-08-03.txt"), "other").unwrap();

    cleanup(
        directory.path(),
        NaiveDate::from_ymd_opt(2026, 8, 11).unwrap(),
    )
    .unwrap();

    assert!(!directory.path().join("latentmail.2026-08-03.log").exists());
    assert!(directory.path().join("latentmail.2026-08-04.log").exists());
    assert!(directory.path().join("latentmail.2026-08-03.txt").exists());
}
