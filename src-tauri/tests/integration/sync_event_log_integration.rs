use latentmail_lib::sync::emitting_event_sink;
use tracing_subscriber::filter::LevelFilter;

const PRIVATE_SUBJECT: &str = "Quarterly salary review";
const PRIVATE_SNIPPET: &str = "Your new salary is";

#[test]
fn emitted_events_are_logged_by_name_and_size_without_their_mail_content() {
    let application = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let sink = emitting_event_sink(application.handle().clone());
    let logs = tempfile::tempdir().unwrap();
    let log_parts = latentmail_lib::logging::subscriber(logs.path(), LevelFilter::DEBUG).unwrap();
    tracing::dispatcher::with_default(&log_parts.dispatch, || {
        sink(
            latentmail_lib::events::MAIL_NEW,
            serde_json::json!({
                "accountId": "account",
                "sender": "boss@example.com",
                "subject": PRIVATE_SUBJECT,
                "snippet": PRIVATE_SNIPPET,
            }),
        );
    });
    drop(log_parts.guard);

    let log_path = std::fs::read_dir(logs.path())
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let log = std::fs::read_to_string(log_path).unwrap();
    assert!(log.contains(latentmail_lib::events::MAIL_NEW), "{log}");
    assert!(log.contains("bytes"), "{log}");
    assert!(!log.contains(PRIVATE_SUBJECT), "{log}");
    assert!(!log.contains(PRIVATE_SNIPPET), "{log}");
    assert!(!log.contains("boss@example.com"), "{log}");
}
