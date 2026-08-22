use std::sync::{Arc, Mutex};
use std::time::Duration;

use latentmail_lib::gmail::GmailClient;
use latentmail_lib::storage::{
    reconcile_staging::ReconcileStagingRepository, Account, AccountRepository, HtmlPresence, Label,
    LabelRepository, Message, MessageRepository, Operation, OperationRepository, Storage,
    StorageError, ThreadRepository, TraversalCursor, TraversalKind,
};
use latentmail_lib::sync::{EventSink, SyncEngine, SyncError, SyncScheduler, WorkRegistry};
use tauri::Manager;
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

type FiredEvents = Arc<Mutex<Vec<(String, serde_json::Value)>>>;

fn fixture_now() -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::from_timestamp(3, 0).unwrap()
}

#[test]
fn storage_errors_convert_to_sync_errors_with_the_storage_context() {
    let error = SyncError::from(StorageError::Database(rusqlite::Error::InvalidQuery));

    assert!(matches!(error, SyncError::Storage(_)));
    assert!(error.to_string().starts_with("storage error: "));
}

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
        truncated_body: None,
        html_presence: HtmlPresence::Absent,
    }
}

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
    let sink: EventSink = Arc::new(move |name, payload| {
        events_for_sink
            .lock()
            .unwrap()
            .push((name.to_owned(), payload));
    });
    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let engine = SyncEngine::new_with_clock(storage.clone(), queue, registry, sink, fixture_now);
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
    assert!(MessageRepository::get(&connection, "account", "new1")
        .unwrap()
        .is_some());
    let t2 = ThreadRepository::get(&connection, "account", "t2")
        .unwrap()
        .unwrap();
    assert_eq!(t2.message_count, 1);
    assert!(
        MessageRepository::get(&connection, "account", "existing1")
            .unwrap()
            .unwrap()
            .is_starred
    );
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
    assert!(MessageRepository::get(&connection, "account", "existing3")
        .unwrap()
        .is_none());
    assert!(ThreadRepository::get(&connection, "account", "t3")
        .unwrap()
        .is_none());
    let account = AccountRepository::get(&connection, "account")
        .unwrap()
        .unwrap();
    assert_eq!(account.history_id, Some(50));

    let fired = events.lock().unwrap().clone();
    assert!(fired.iter().any(|(name, _)| name == "sync://complete"));
    assert!(fired.iter().any(|(name, _)| name == "mail://new"));
    let complete = fired
        .iter()
        .find(|(name, _)| name == "sync://complete")
        .map(|(_, payload)| payload);
    assert_eq!(
        complete.and_then(|payload| payload.get("changed")),
        Some(&serde_json::json!(true))
    );
}

#[tokio::test]
async fn incremental_sync_reports_only_unread_inbox_arrivals() {
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
            "history": [{
                "id": "50",
                "messagesAdded": [
                    {"message": {"id": "arrival", "threadId": "t2"}},
                    {"message": {"id": "sentcopy", "threadId": "t4"}},
                    {"message": {"id": "alreadyread", "threadId": "t5"}},
                    {"message": {"id": "stale", "threadId": "t6"}}
                ]
            }]
        })))
        .mount(&server)
        .await;
    for (id, thread, labels, from, subject, internal_date) in [
        (
            "arrival",
            "t2",
            serde_json::json!(["INBOX", "UNREAD"]),
            "Carol <carol@example.com>",
            "New mail",
            "3000",
        ),
        (
            "sentcopy",
            "t4",
            serde_json::json!(["SENT"]),
            "me@example.com",
            "My own reply",
            "3000",
        ),
        (
            "alreadyread",
            "t5",
            serde_json::json!(["INBOX"]),
            "Dave <dave@example.com>",
            "Read on my phone",
            "3000",
        ),
        (
            "stale",
            "t6",
            serde_json::json!(["INBOX", "UNREAD"]),
            "Eve <eve@example.com>",
            "Old mail",
            "-600000",
        ),
    ] {
        Mock::given(method("GET"))
            .and(path(format!("/users/me/messages/{id}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": id, "threadId": thread, "historyId": "50", "labelIds": labels, "snippet": "s",
                "internalDate": internal_date,
                "payload": {"mimeType": "text/plain", "headers": [
                    {"name": "From", "value": from},
                    {"name": "Subject", "value": subject}
                ], "body": {"data": "bmV3"}}
            })))
            .mount(&server)
            .await;
    }

    let (engine, _storage, _directory, events) = engine_with_seed();
    engine
        .run_sync("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();

    let fired = events.lock().unwrap().clone();
    let new_mail = fired
        .iter()
        .find(|(name, _)| name == "mail://new")
        .map(|(_, payload)| payload.clone())
        .expect("mail://new is emitted for the arrival");
    assert_eq!(
        new_mail.get("arrivals"),
        Some(&serde_json::json!([
            {"threadId": "t2", "sender": "Carol <carol@example.com>", "subject": "New mail", "snippet": "s"}
        ]))
    );
}

#[tokio::test]
async fn incremental_sync_ingests_inbox_mail_history_has_not_reported_yet() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"labels": []})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"historyId": "70", "history": []})),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [
                {"id": "lagging", "threadId": "t9"},
                {"id": "existing1", "threadId": "t1"}
            ]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/existing1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "existing1", "threadId": "t1", "historyId": "999", "labelIds": ["INBOX"], "snippet": "refetched",
            "internalDate": "1000",
            "payload": {"mimeType": "text/plain", "headers": [
                {"name": "From", "value": "Nobody <nobody@example.com>"},
                {"name": "Subject", "value": "Should not have been fetched"}
            ], "body": {"data": "bm8"}}
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/lagging"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "lagging", "threadId": "t9", "historyId": "70", "labelIds": ["INBOX", "UNREAD"], "snippet": "late",
            "internalDate": "9000",
            "payload": {"mimeType": "text/plain", "headers": [
                {"name": "From", "value": "Dave <dave@example.com>"},
                {"name": "Subject", "value": "Arrived before history said so"}
            ], "body": {"data": "bGF0ZQ"}}
        })))
        .mount(&server)
        .await;

    let (engine, storage, _directory, events) = engine_with_seed();
    let client = GmailClient::with_base_url("token", server.uri());

    engine.run_sync("account", client).await.unwrap();

    let connection = storage.connection().unwrap();
    let message = MessageRepository::get(&connection, "account", "lagging")
        .unwrap()
        .unwrap();
    assert_eq!(message.subject, "Arrived before history said so");
    assert!(ThreadRepository::get(&connection, "account", "t9")
        .unwrap()
        .is_some());
    assert_eq!(
        MessageRepository::get(&connection, "account", "existing1")
            .unwrap()
            .unwrap()
            .subject,
        "Existing"
    );
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|(name, _)| name == "mail://new"));
    assert_eq!(
        AccountRepository::get(&connection, "account")
            .unwrap()
            .unwrap()
            .history_id,
        Some(40)
    );

    drop(connection);
    events.lock().unwrap().clear();
    engine
        .run_sync("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();
    let second = events.lock().unwrap().clone();
    assert!(!second.iter().any(|(name, _)| name == "mail://new"));
    let complete = second
        .iter()
        .find(|(name, _)| name == "sync://complete")
        .map(|(_, payload)| payload);
    assert_eq!(
        complete.and_then(|payload| payload.get("changed")),
        Some(&serde_json::json!(false))
    );
}

#[tokio::test]
async fn a_history_record_carrying_only_messages_is_not_treated_as_a_no_op() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"labels": []})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "historyId": "80",
            "history": [{
                "id": "80",
                "messages": [
                    {"id": "untyped", "threadId": "t8"},
                    {"id": "existing1", "threadId": "t1"}
                ]
            }]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/untyped"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "untyped", "threadId": "t8", "historyId": "80", "labelIds": ["INBOX", "UNREAD"], "snippet": "untyped",
            "internalDate": "8000",
            "payload": {"mimeType": "text/plain", "headers": [
                {"name": "From", "value": "Erin <erin@example.com>"},
                {"name": "Subject", "value": "Reported without a typed delta"}
            ], "body": {"data": "dW50"}}
        })))
        .mount(&server)
        .await;

    let (engine, storage, _directory, _events) = engine_with_seed();
    engine
        .run_sync("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();

    let connection = storage.connection().unwrap();
    assert_eq!(
        MessageRepository::get(&connection, "account", "untyped")
            .unwrap()
            .unwrap()
            .subject,
        "Reported without a typed delta"
    );
    assert!(ThreadRepository::get(&connection, "account", "t8")
        .unwrap()
        .is_some());
    assert_eq!(
        AccountRepository::get(&connection, "account")
            .unwrap()
            .unwrap()
            .history_id,
        Some(80)
    );
}

#[tokio::test]
async fn resumed_reconciliation_leaves_later_history_for_the_next_incremental_sync() {
    let (engine, storage, _directory, _events) = engine_with_seed();
    let cursor = TraversalCursor {
        account_id: "account".into(),
        kind: TraversalKind::Reconciliation,
        position: Some("50|fetch|".into()),
        discovered_count: 1,
        persisted_count: 0,
        completed: false,
        last_advanced_at: 1,
        resumed: false,
    };
    let connection = storage.connection().unwrap();
    ReconcileStagingRepository::begin(&connection, &cursor).unwrap();
    ReconcileStagingRepository::stage_universe_page(
        &connection,
        "account",
        &["reconciled".into()],
        &cursor,
    )
    .unwrap();
    drop(connection);

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(ResponseTemplate::new(404))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "historyId": "60",
            "history": [{
                "id": "60",
                "messagesAdded": [{"message": {"id": "late", "threadId": "late-thread"}}]
            }]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"labels": []})))
        .mount(&server)
        .await;
    for (id, thread_id) in [("reconciled", "reconciled-thread"), ("late", "late-thread")] {
        Mock::given(method("GET"))
            .and(path(format!("/users/me/messages/{id}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": id, "threadId": thread_id, "historyId": "60", "labelIds": [],
                "internalDate": "1000", "payload": {"headers": []}
            })))
            .mount(&server)
            .await;
    }

    engine
        .run_sync("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();
    assert_eq!(
        AccountRepository::get(&storage.connection().unwrap(), "account")
            .unwrap()
            .unwrap()
            .history_id,
        Some(50)
    );
    engine
        .run_sync("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();
    let connection = storage.connection().unwrap();
    assert!(MessageRepository::get(&connection, "account", "late")
        .unwrap()
        .is_some());
    assert_eq!(
        AccountRepository::get(&connection, "account")
            .unwrap()
            .unwrap()
            .history_id,
        Some(60)
    );
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

#[tokio::test]
async fn initialize_with_sync_on_startup_actually_runs_a_scheduler_tick() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "fresh-access-token",
            "token_type": "Bearer",
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "emailAddress": "me@example.com",
            "messagesTotal": 0,
            "threadsTotal": 0,
            "historyId": "100"
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "labels": [{"id":"INBOX","name":"Inbox","type":"system","messagesTotal":0,"messagesUnread":0}]
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

    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    let home = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", home.path());
    std::env::set_var("APPDATA", home.path());
    std::env::set_var("XDG_DATA_HOME", home.path());

    let application = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    tauri::WebviewWindowBuilder::new(&application, "main", Default::default())
        .visible(false)
        .build()
        .unwrap();
    let handle = application.handle();

    let directory = application.path().app_data_dir().unwrap();
    std::fs::create_dir_all(&directory).unwrap();
    let seed_storage = Storage::open(directory.join("latentmail.sqlite")).unwrap();
    application.manage(seed_storage.clone());
    latentmail_lib::settings::initialize(handle, seed_storage.clone()).unwrap();
    latentmail_lib::auth::initialize(handle, seed_storage.clone()).unwrap();
    let connection = seed_storage.connection().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: "account".into(),
            email: "me@example.com".into(),
            display_name: String::new(),
            avatar_url: None,
            history_id: None,
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    drop(connection);
    latentmail_lib::auth::save_refresh_token("account", "stored-refresh-token").unwrap();

    latentmail_lib::sync::initialize(handle, seed_storage).unwrap();

    let poll_storage = Storage::open(directory.join("latentmail.sqlite")).unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let history_id = {
            let connection = poll_storage.connection().unwrap();
            AccountRepository::get(&connection, "account")
                .unwrap()
                .and_then(|account| account.history_id)
        };
        if history_id == Some(100) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "scheduler tick never completed initial sync"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn startup_recovery_marks_an_interrupted_send_uncertain_and_requeues_an_interrupted_draft() {
    let home = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", home.path());
    std::env::set_var("APPDATA", home.path());
    std::env::set_var("XDG_DATA_HOME", home.path());

    let application = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    tauri::WebviewWindowBuilder::new(&application, "main", Default::default())
        .visible(false)
        .build()
        .unwrap();
    let handle = application.handle();

    let directory = application.path().app_data_dir().unwrap();
    std::fs::create_dir_all(&directory).unwrap();
    let seed_storage = Storage::open(directory.join("latentmail.sqlite")).unwrap();
    application.manage(seed_storage.clone());
    latentmail_lib::settings::initialize(handle, seed_storage.clone()).unwrap();
    latentmail_lib::auth::initialize(handle, seed_storage.clone()).unwrap();
    let connection = seed_storage.connection().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: "account".into(),
            email: "me@example.com".into(),
            display_name: String::new(),
            avatar_url: None,
            history_id: None,
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    OperationRepository::upsert(
        &connection,
        &Operation {
            id: "op-send-interrupted".into(),
            account_id: "account".into(),
            lane: "interactive".into(),
            kind: "send".into(),
            entity_key: "send:session".into(),
            payload: "{}".into(),
            status: "active".into(),
            attempts: 0,
            next_attempt_at: None,
            error: None,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    OperationRepository::upsert(
        &connection,
        &Operation {
            id: "op-draft-interrupted".into(),
            account_id: "account".into(),
            lane: "interactive".into(),
            kind: "draft".into(),
            entity_key: "draft:session".into(),
            payload: "{}".into(),
            status: "active".into(),
            attempts: 0,
            next_attempt_at: None,
            error: None,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    drop(connection);
    latentmail_lib::sync::initialize(handle, seed_storage).unwrap();

    let poll_storage = Storage::open(directory.join("latentmail.sqlite")).unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let send_status = {
            let connection = poll_storage.connection().unwrap();
            OperationRepository::get(&connection, "op-send-interrupted")
                .unwrap()
                .unwrap()
                .status
        };
        if send_status == "failed" {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "startup recovery never marked the interrupted send uncertain"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let connection = poll_storage.connection().unwrap();
    let send_op = OperationRepository::get(&connection, "op-send-interrupted")
        .unwrap()
        .unwrap();
    assert_eq!(
        send_op.error.as_deref(),
        Some("May have been sent; retry manually")
    );
}
