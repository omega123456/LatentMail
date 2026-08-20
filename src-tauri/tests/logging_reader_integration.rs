use chrono::NaiveDate;
use latentmail_lib::logging::{parse_entries, read_entries, subscriber};
use std::fs;
use tracing_subscriber::filter::LevelFilter;

#[test]
fn parse_round_trips_against_real_subscriber_output() {
    let directory = tempfile::tempdir().unwrap();
    let (dispatch, guard, _handle) = subscriber(directory.path(), LevelFilter::INFO).unwrap();

    tracing::dispatcher::with_default(&dispatch, || {
        tracing::info!(target: "sync", "applied 14 history records");
        tracing::warn!(target: "gmail", "quota window at 9412/10000 units");
        tracing::error!(target: "sync", "history sync failed for alex@example.com");
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
    let entries = parse_entries(&contents);

    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].level, "INFO");
    assert!(entries[0].message.contains("applied 14 history records"));
    assert_eq!(entries[1].level, "WARN");
    assert!(entries[1]
        .message
        .contains("quota window at 9412/10000 units"));
    assert_eq!(entries[2].level, "ERROR");
    assert!(entries[2]
        .message
        .contains("history sync failed for alex@example.com"));
    assert!(entries[0].timestamp_millis > 0);
    assert!(entries[1].timestamp_millis >= entries[0].timestamp_millis);
}

#[test]
fn a_continuation_line_folds_into_the_preceding_entry() {
    let contents = "2026-08-19T09:38:11.365123Z ERROR frontend: load_conversation failed: database is locked\n    at dispatchInvoke (commands.ts:14:11)\n    at useConversationQuery (hooks.ts:212:24)\n2026-08-19T09:38:04.219000Z  INFO sync: applied 14 history records\n";

    let entries = parse_entries(contents);

    assert_eq!(entries.len(), 2);
    assert_eq!(
        entries[0].message,
        "frontend: load_conversation failed: database is locked\n    at dispatchInvoke (commands.ts:14:11)\n    at useConversationQuery (hooks.ts:212:24)"
    );
    assert_eq!(entries[1].message, "sync: applied 14 history records");
}

#[test]
fn lines_before_the_first_parseable_entry_are_dropped() {
    let contents = "not a timestamp, a stray line\n2026-08-19T09:38:04.219000Z  INFO sync: applied 14 history records\n";

    let entries = parse_entries(contents);

    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].message, "sync: applied 14 history records");
}

fn write_entries(directory: &std::path::Path, date: NaiveDate, count: usize) {
    let mut contents = String::new();
    for index in 0..count {
        contents.push_str(&format!(
            "{}T09:{:02}:00.000000Z  INFO sync: entry {index}\n",
            date.format("%Y-%m-%d"),
            index % 60,
        ));
    }
    fs::write(
        directory.join(format!("latentmail.{}.log", date.format("%Y-%m-%d"))),
        contents,
    )
    .unwrap();
}

#[test]
fn todays_file_longer_than_the_minimum_returns_all_of_it_newest_first() {
    let directory = tempfile::tempdir().unwrap();
    let today = NaiveDate::from_ymd_opt(2026, 8, 19).unwrap();
    write_entries(directory.path(), today, 120);

    let entries = read_entries(directory.path(), today, 100);

    assert_eq!(entries.len(), 120);
    assert!(entries[0].message.contains("entry 119"));
    assert!(entries[119].message.contains("entry 0"));
}

#[test]
fn todays_file_shorter_than_the_minimum_tops_up_from_yesterday_to_exactly_the_minimum() {
    let directory = tempfile::tempdir().unwrap();
    let today = NaiveDate::from_ymd_opt(2026, 8, 19).unwrap();
    let yesterday = today.pred_opt().unwrap();
    write_entries(directory.path(), today, 40);
    write_entries(directory.path(), yesterday, 200);

    let entries = read_entries(directory.path(), today, 100);

    assert_eq!(entries.len(), 100);
    assert!(entries[0].message.contains("entry 39"));
    assert!(entries[39].message.contains("entry 0"));
    assert!(entries[40].message.contains("entry 199"));
}

#[test]
fn a_missing_directory_or_unparseable_file_returns_empty_without_an_error() {
    let directory = tempfile::tempdir().unwrap();
    let missing = directory.path().join("does-not-exist");
    let today = NaiveDate::from_ymd_opt(2026, 8, 19).unwrap();

    assert!(read_entries(&missing, today, 100).is_empty());

    fs::write(
        directory
            .path()
            .join(format!("latentmail.{}.log", today.format("%Y-%m-%d"))),
        "not a log line at all\nnor this one\n",
    )
    .unwrap();
    assert!(read_entries(directory.path(), today, 100).is_empty());
}
