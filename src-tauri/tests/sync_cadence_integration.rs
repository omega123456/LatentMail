use std::sync::{Arc, Mutex};
use std::time::Duration;

use latentmail_lib::gmail::GmailClient;
use latentmail_lib::storage::{
    Account, AccountRepository, HtmlPresence, Label, LabelRepository, Message, MessageRepository,
    Storage, ThreadRepository,
};
use latentmail_lib::sync::{EventSink, SyncEngine, SyncScheduler, WorkRegistry};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

fn seed_message(id: &str, thread_id: &str, sent_at: i64) -> Message {
    Message {
        account_id: "account".into(),
        id: id.into(),
        thread_id: thread_id.into(),
        rfc_message_id: None,
        sender: format!("{id}@example.com"),
        recipients: "me@example.com".into(),
        subject: "Existing".into(),
        sent_at,
        snippet: String::new(),
        html_body: None,
        plain_body: None,
        has_attachments: false,
        is_unread: false,
        is_starred: false,
        history_id: 1,
        truncated_body: None,
        html_presence: HtmlPresence::Absent,
    }
}

type FiredEvents = Arc<Mutex<Vec<(String, serde_json::Value)>>>;

fn engine_with_seed() -> (Arc<SyncEngine>, Storage, tempfile::TempDir, FiredEvents) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: "account".into(),
            email: "me@example.com".into(),
            display_name: String::new(),
            avatar_url: None,
            history_id: Some(40),
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    for label_id in ["INBOX", "UNREAD"] {
        LabelRepository::upsert(
            &connection,
            &Label {
                account_id: "account".into(),
                id: label_id.into(),
                name: label_id.into(),
                kind: "system".into(),
                color: None,
                message_count: 0,
            },
        )
        .unwrap();
    }
    MessageRepository::write_full_state(&connection, &seed_message("existing1", "t1", 1)).unwrap();
    MessageRepository::set_label_membership(&connection, "account", "existing1", "INBOX", true)
        .unwrap();
    ThreadRepository::recompute(&connection, "account", "t1").unwrap();
    drop(connection);

    let events = Arc::new(Mutex::new(Vec::new()));
    let events_for_sink = Arc::clone(&events);
    let sink: EventSink = Arc::new(move |name, payload| {
        events_for_sink
            .lock()
            .unwrap()
            .push((name.to_owned(), payload));
    });
    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let engine = SyncEngine::new(storage.clone(), queue, registry, sink);
    (engine, storage, directory, events)
}

#[tokio::test]
async fn probe_only_never_advances_the_history_checkpoint_while_run_sync_does() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id": "probed", "threadId": "t2"}]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/probed"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "probed", "threadId": "t2", "historyId": "999", "labelIds": ["INBOX", "UNREAD"], "snippet": "s",
            "internalDate": "3000",
            "payload": {"mimeType": "text/plain", "headers": [
                {"name": "From", "value": "Carol <carol@example.com>"},
                {"name": "Subject", "value": "Discovered by probe"}
            ], "body": {"data": "bmV3"}}
        })))
        .mount(&server)
        .await;

    let (engine, storage, _directory, events) = engine_with_seed();
    let client = GmailClient::with_base_url("token", server.uri());

    engine.probe_only("account", client).await.unwrap();

    let connection = storage.connection().unwrap();
    assert_eq!(
        AccountRepository::get(&connection, "account")
            .unwrap()
            .unwrap()
            .history_id,
        Some(40),
        "the fast probe cadence must never advance the history checkpoint"
    );
    assert!(MessageRepository::get(&connection, "account", "probed")
        .unwrap()
        .is_some());
    drop(connection);

    let fired = events.lock().unwrap().clone();
    assert!(fired.iter().any(|(name, _)| name == "mail://new"));
    assert!(!fired.iter().any(|(name, _)| name == "sync://complete"));
}

#[tokio::test]
async fn run_sync_advances_the_checkpoint_through_the_full_incremental_path() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"labels": []})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "historyId": "50",
            "history": [{"id": "50"}]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({ "messages": [] })),
        )
        .mount(&server)
        .await;

    let (engine, storage, _directory, _events) = engine_with_seed();
    let client = GmailClient::with_base_url("token", server.uri());

    engine.run_sync("account", client).await.unwrap();

    let connection = storage.connection().unwrap();
    assert_eq!(
        AccountRepository::get(&connection, "account")
            .unwrap()
            .unwrap()
            .history_id,
        Some(50),
        "the periodic cadence's full incremental sync advances the checkpoint"
    );
}

#[tokio::test(start_paused = true)]
async fn the_fast_and_periodic_cadences_tick_independently_and_only_the_periodic_one_retimes() {
    let (fast_tx, mut fast_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let fast = SyncScheduler::start(
        Duration::from_secs(latentmail_lib::sync::FAST_PROBE_INTERVAL_SECS),
        true,
        move || {
            let fast_tx = fast_tx.clone();
            async move {
                let _ = fast_tx.send(());
            }
        },
    );

    let (periodic_tx, mut periodic_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let periodic = SyncScheduler::start(Duration::from_secs(300), false, move || {
        let periodic_tx = periodic_tx.clone();
        async move {
            let _ = periodic_tx.send(());
        }
    });

    assert!(
        fast_rx.recv().await.is_some(),
        "the fast cadence ticks immediately regardless of sync-on-startup"
    );
    assert!(
        periodic_rx.try_recv().is_err(),
        "the periodic cadence must not tick immediately when sync-on-startup is disabled"
    );

    periodic.set_interval(Duration::from_secs(60));
    assert_eq!(
        fast.interval(),
        Duration::from_secs(latentmail_lib::sync::FAST_PROBE_INTERVAL_SECS),
        "retiming the periodic cadence must not affect the fixed fast cadence"
    );

    tokio::time::advance(Duration::from_secs(61)).await;
    assert!(
        periodic_rx.recv().await.is_some(),
        "the periodic cadence should tick at its newly configured interval"
    );

    tokio::time::advance(Duration::from_secs(30)).await;
    assert!(
        fast_rx.recv().await.is_some(),
        "the fast cadence keeps ticking on its own fixed schedule"
    );
}
