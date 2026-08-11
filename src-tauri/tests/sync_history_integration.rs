//! Incremental sync: history-delta application (label add/remove, message
//! add/delete), plus the poll scheduler's interval-change and
//! sync-on-startup gating (D-requirements: "takes effect immediately" /
//! "genuinely governs startup sync").

use std::sync::{Arc, Mutex};
use std::time::Duration;

use latentmail_lib::gmail::GmailClient;
use latentmail_lib::storage::{
    Account, AccountRepository, Label, LabelRepository, Message, MessageRepository, Storage,
    ThreadRepository,
};
use latentmail_lib::sync::{EventSink, SyncEngine, SyncScheduler, WorkRegistry};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

fn seed_message(id: &str, thread_id: &str, sent_at: i64, unread: bool) -> Message {
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
        is_unread: unread,
        is_starred: false,
        history_id: 1,
    }
}

fn engine_with_seed() -> (
    Arc<SyncEngine>,
    Storage,
    tempfile::TempDir,
    Arc<Mutex<Vec<String>>>,
) {
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
    for label_id in ["INBOX", "UNREAD", "STARRED"] {
        LabelRepository::upsert(
            &connection,
            &Label {
                account_id: "account".into(),
                id: label_id.into(),
                name: label_id.into(),
                kind: "system".into(),
                color: None,
                message_count: 0,
                unread_count: 0,
            },
        )
        .unwrap();
    }
    MessageRepository::write_full_state(&connection, &seed_message("existing1", "t1", 1, false))
        .unwrap();
    MessageRepository::write_full_state(&connection, &seed_message("existing2", "t1", 2, true))
        .unwrap();
    MessageRepository::write_full_state(&connection, &seed_message("existing3", "t3", 1, false))
        .unwrap();
    MessageRepository::set_label_membership(&connection, "account", "existing1", "INBOX", true)
        .unwrap();
    MessageRepository::set_label_membership(&connection, "account", "existing2", "INBOX", true)
        .unwrap();
    MessageRepository::set_label_membership(&connection, "account", "existing2", "UNREAD", true)
        .unwrap();
    MessageRepository::set_label_membership(&connection, "account", "existing3", "INBOX", true)
        .unwrap();
    ThreadRepository::recompute(&connection, "account", "t1").unwrap();
    ThreadRepository::recompute(&connection, "account", "t3").unwrap();
    drop(connection);

    let events = Arc::new(Mutex::new(Vec::new()));
    let events_for_sink = Arc::clone(&events);
    let sink: EventSink = Arc::new(move |name, _payload| {
        events_for_sink.lock().unwrap().push(name.to_owned());
    });
    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let engine = SyncEngine::new(storage.clone(), queue, registry, sink);
    (engine, storage, directory, events)
}

async fn mount_history_fixture(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "labels": [{"id":"INBOX","name":"Inbox","type":"system","messagesTotal":3,"messagesUnread":0}]
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "historyId": "50",
            "history": [{
                "id": "50",
                "messagesAdded": [{"message": {"id": "new1", "threadId": "t2"}}],
                "labelsAdded": [{"message": {"id": "existing1", "threadId": "t1"}, "labelIds": ["STARRED"]}],
                "labelsRemoved": [{"message": {"id": "existing2", "threadId": "t1"}, "labelIds": ["UNREAD"]}],
                "messagesDeleted": [{"message": {"id": "existing3", "threadId": "t3"}}]
            }]
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/new1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "new1", "threadId": "t2", "historyId": "50", "labelIds": ["INBOX"], "snippet": "new",
            "internalDate": "3000",
            "payload": {"mimeType": "text/plain", "headers": [
                {"name": "From", "value": "Carol <carol@example.com>"},
                {"name": "Subject", "value": "New mail"}
            ], "body": {"data": "bmV3"}}
        })))
        .mount(server)
        .await;
}

#[tokio::test]
async fn incremental_sync_applies_every_delta_type_and_advances_the_checkpoint() {
    let server = MockServer::start().await;
    mount_history_fixture(&server).await;
    let (engine, storage, _directory, events) = engine_with_seed();
    let client = GmailClient::with_base_url("token", server.uri());

    engine.run_sync("account", client).await.unwrap();

    let connection = storage.connection().unwrap();
    // Message add.
    assert!(MessageRepository::get(&connection, "account", "new1")
        .unwrap()
        .is_some());
    let t2 = ThreadRepository::get(&connection, "account", "t2")
        .unwrap()
        .unwrap();
    assert_eq!(t2.message_count, 1);
    // Label add.
    assert!(
        MessageRepository::get(&connection, "account", "existing1")
            .unwrap()
            .unwrap()
            .is_starred
    );
    // Label remove.
    assert!(
        !MessageRepository::get(&connection, "account", "existing2")
            .unwrap()
            .unwrap()
            .is_unread
    );
    let t1 = ThreadRepository::get(&connection, "account", "t1")
        .unwrap()
        .unwrap();
    assert!(t1.is_starred);
    assert!(!t1.is_unread);
    // Message delete + emptied-thread removal.
    assert!(MessageRepository::get(&connection, "account", "existing3")
        .unwrap()
        .is_none());
    assert!(ThreadRepository::get(&connection, "account", "t3")
        .unwrap()
        .is_none());
    // Checkpoint advances on completion.
    let account = AccountRepository::get(&connection, "account")
        .unwrap()
        .unwrap();
    assert_eq!(account.history_id, Some(50));

    let fired = events.lock().unwrap().clone();
    assert!(fired.contains(&"sync://complete".to_owned()));
    assert!(fired.contains(&"mail://new".to_owned()));
}

#[tokio::test]
async fn incremental_sync_does_not_advance_the_checkpoint_on_failure() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(403))
        .mount(&server)
        .await;
    let (engine, storage, _directory, _events) = engine_with_seed();
    let client = GmailClient::with_base_url("token", server.uri());

    assert!(engine.run_sync("account", client).await.is_err());

    let connection = storage.connection().unwrap();
    let account = AccountRepository::get(&connection, "account")
        .unwrap()
        .unwrap();
    assert_eq!(account.history_id, Some(40));
}

/// D6: a full-state write only applies when the incoming `historyId` is
/// strictly greater than what is stored — reusing the Phase 5 gate rather
/// than reimplementing it. A history record can report a message as
/// "added" that locally already carries a *newer* `historyId` (e.g. our own
/// star mutation's write-back landed first); the stale fetched copy must be
/// rejected, not clobber the row.
#[tokio::test]
async fn a_stale_full_state_write_from_history_is_rejected_by_the_existing_gate() {
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
    let mut ahead = seed_message("raced", "t1", 1, false);
    ahead.history_id = 100;
    ahead.subject = "Already ahead".into();
    MessageRepository::write_full_state(&connection, &ahead).unwrap();
    ThreadRepository::recompute(&connection, "account", "t1").unwrap();
    drop(connection);

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"labels": []})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "historyId": "60",
            "history": [{
                "id": "60",
                "messagesAdded": [{"message": {"id": "raced", "threadId": "t1"}}]
            }]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/raced"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "raced", "threadId": "t1", "historyId": "60", "labelIds": ["INBOX"], "snippet": "stale",
            "internalDate": "1000",
            "payload": {"mimeType": "text/plain", "headers": [
                {"name": "From", "value": "Stale <stale@example.com>"},
                {"name": "Subject", "value": "Stale fetch"}
            ], "body": {"data": "c3RhbGU"}}
        })))
        .mount(&server)
        .await;

    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let engine = SyncEngine::new(
        storage.clone(),
        queue,
        registry,
        latentmail_lib::sync::noop_event_sink(),
    );
    let client = GmailClient::with_base_url("token", server.uri());
    engine.run_sync("account", client).await.unwrap();

    let connection = storage.connection().unwrap();
    let message = MessageRepository::get(&connection, "account", "raced")
        .unwrap()
        .unwrap();
    assert_eq!(message.history_id, 100);
    assert_eq!(message.subject, "Already ahead");
}

#[tokio::test(start_paused = true)]
async fn changing_the_poll_interval_takes_effect_without_waiting_out_the_old_one() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let scheduler = SyncScheduler::start(Duration::from_secs(600), false, move || {
        let tx = tx.clone();
        async move {
            let _ = tx.send(());
        }
    });

    tokio::time::advance(Duration::from_secs(60)).await;
    assert!(rx.try_recv().is_err(), "should not have ticked yet");

    scheduler.set_interval(Duration::from_secs(120));
    tokio::time::advance(Duration::from_secs(121)).await;
    assert!(
        rx.recv().await.is_some(),
        "new interval should have fired a tick"
    );
}

#[tokio::test(start_paused = true)]
async fn sync_on_startup_disabled_genuinely_skips_the_immediate_tick() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let _scheduler = SyncScheduler::start(Duration::from_secs(600), false, move || {
        let tx = tx.clone();
        async move {
            let _ = tx.send(());
        }
    });

    tokio::task::yield_now().await;
    assert!(
        rx.try_recv().is_err(),
        "sync-on-startup=false must not tick immediately"
    );
}

#[tokio::test(start_paused = true)]
async fn sync_on_startup_enabled_ticks_immediately() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let _scheduler = SyncScheduler::start(Duration::from_secs(600), true, move || {
        let tx = tx.clone();
        async move {
            let _ = tx.send(());
        }
    });

    assert!(
        rx.recv().await.is_some(),
        "sync-on-startup=true must tick immediately"
    );
}
