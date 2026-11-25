use latentmail_lib::storage::{LabelMembershipChange, MessageKey, StagedIds};
use latentmail_lib::sync::{
    EventSink, SyncEngine, SyncEngineDeps, SyncError, SyncScheduler, WorkRegistry,
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use latentmail_lib::gmail::GmailClient;
use latentmail_lib::storage::{
    reconcile_staging::ReconcileStagingRepository, Account, AccountRepository, HtmlPresence, Label,
    LabelRepository, Message, MessageRepository, Operation, OperationRepository, Storage,
    StorageError, ThreadRepository, TraversalCursor, TraversalKind,
};
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

struct SeedMessage<'a> {
    id: &'a str,
    thread_id: &'a str,
    sent_at: i64,
    unread: bool,
}

fn seed_message(
    SeedMessage {
        id,
        thread_id,
        sent_at,
        unread,
    }: SeedMessage<'_>,
) -> Message {
    Message {
        account_id: "account".into(),
        id: id.into(),
        thread_id: thread_id.into(),
        rfc_message_id: None,
        sender: format!("{id}@example.com"),
        recipients: "me@example.com".into(),
        subject: "Existing".into(),
        sent_at: sent_at,
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

fn test_account(history_id: Option<i64>) -> Account {
    Account {
        id: "account".into(),
        email: "me@example.com".into(),
        display_name: String::new(),
        avatar_url: None,
        history_id: history_id,
        needs_reauthentication: false,
        created_at: 1,
        updated_at: 1,
    }
}

fn add_label(connection: &rusqlite::Connection, message_id: &str, label_id: &str) {
    MessageRepository::set_label_membership(
        connection,
        MessageKey {
            account_id: "account",
            message_id: message_id,
        },
        LabelMembershipChange {
            label_id: label_id,
            present: true,
        },
    )
    .unwrap();
}

fn seed_initial_database(connection: &rusqlite::Connection) {
    AccountRepository::upsert(connection, &test_account(Some(40))).unwrap();
    for label_id in ["INBOX", "UNREAD", "STARRED"] {
        LabelRepository::upsert(
            connection,
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
    let seeds = [
        ("existing1", "t1", 1, false, &["INBOX"][..]),
        ("existing2", "t1", 2, true, &["INBOX", "UNREAD"][..]),
        ("existing3", "t3", 1, false, &["INBOX"][..]),
    ];
    for (id, thread_id, sent_at, unread, labels) in seeds {
        let message = seed_message(SeedMessage {
            id: id,
            thread_id: thread_id,
            sent_at: sent_at,
            unread: unread,
        });
        MessageRepository::write_full_state(connection, &message).unwrap();
        for label_id in labels {
            add_label(connection, id, label_id);
        }
    }
    ThreadRepository::recompute(connection, "account", "t1").unwrap();
    ThreadRepository::recompute(connection, "account", "t3").unwrap();
}

fn engine_with_seed() -> (Arc<SyncEngine>, Storage, tempfile::TempDir, FiredEvents) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    seed_initial_database(&connection);
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
    let engine = SyncEngine::new_with_clock(
        SyncEngineDeps {
            storage: storage.clone(),
            queue: queue,
            registry: registry,
            events: sink,
        },
        fixture_now,
    );
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

fn assert_sync_complete_event(events: &FiredEvents, expected_changed: bool) {
    let fired = events.lock().unwrap().clone();
    let complete = fired
        .iter()
        .find(|(name, _)| name == latentmail_lib::events::SYNC_COMPLETE)
        .map(|(_, payload)| payload)
        .expect("sync://complete event emitted");
    assert_eq!(
        complete.get("changed"),
        Some(&serde_json::json!(expected_changed))
    );
    let completed_at = complete
        .get("completedAt")
        .and_then(serde_json::Value::as_i64)
        .unwrap();
    assert!(chrono::DateTime::from_timestamp_millis(completed_at)
        .is_some_and(|moment| moment > chrono::DateTime::UNIX_EPOCH));
}

fn has_event(events: &FiredEvents, expected_name: &str) -> bool {
    events
        .lock()
        .unwrap()
        .iter()
        .any(|(name, _)| name == expected_name)
}

fn arrival_subjects(events: &FiredEvents) -> Vec<String> {
    events
        .lock()
        .unwrap()
        .iter()
        .filter(|(name, _)| name == latentmail_lib::events::MAIL_NEW)
        .flat_map(|(_, payload)| payload["arrivals"].as_array().unwrap().iter())
        .map(|arrival| arrival["subject"].as_str().unwrap().to_owned())
        .collect()
}

async fn mount_empty_labels(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"labels": []})))
        .mount(server)
        .await;
}

#[tokio::test]
async fn incremental_sync_applies_every_delta_type_and_advances_the_checkpoint() {
    let server = MockServer::start().await;
    mount_history_fixture(&server).await;
    let (engine, storage, _directory, events) = engine_with_seed();
    let catch_ups = Arc::new(AtomicUsize::new(0));
    let recorded_catch_ups = Arc::clone(&catch_ups);
    engine.set_ai_catch_up(Arc::new(move |account_id| {
        assert_eq!(account_id, "account");
        recorded_catch_ups.fetch_add(1, Ordering::SeqCst);
    }));
    let client = GmailClient::with_base_url("token", server.uri());

    engine.run_sync("account", client).await.unwrap();

    let connection = storage.connection().unwrap();
    assert!(MessageRepository::get(&connection, "account", "new1")
        .unwrap()
        .is_some());
    assert_eq!(
        ThreadRepository::get(&connection, "account", "t2")
            .unwrap()
            .unwrap()
            .message_count,
        1
    );
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
    assert!(t1.is_starred && !t1.is_unread);
    assert!(MessageRepository::get(&connection, "account", "existing3")
        .unwrap()
        .is_none());
    assert!(ThreadRepository::get(&connection, "account", "t3")
        .unwrap()
        .is_none());
    assert_eq!(
        AccountRepository::get(&connection, "account")
            .unwrap()
            .unwrap()
            .history_id,
        Some(50)
    );
    assert_eq!(catch_ups.load(Ordering::SeqCst), 1);
    assert!(has_event(&events, latentmail_lib::events::MAIL_NEW));
    assert_sync_complete_event(&events, true);
}

struct ArrivalCase {
    id: &'static str,
    thread_id: &'static str,
    labels: &'static [&'static str],
    from: &'static str,
    subject: &'static str,
    internal_date: &'static str,
}

fn arrival_cases() -> Vec<ArrivalCase> {
    vec![
        ArrivalCase {
            id: "arrival",
            thread_id: "t2",
            labels: &["INBOX", "UNREAD"],
            from: "Carol <carol@example.com>",
            subject: "New mail",
            internal_date: "3000",
        },
        ArrivalCase {
            id: "sentcopy",
            thread_id: "t4",
            labels: &["SENT"],
            from: "me@example.com",
            subject: "My own reply",
            internal_date: "3000",
        },
        ArrivalCase {
            id: "alreadyread",
            thread_id: "t5",
            labels: &["INBOX"],
            from: "Dave <dave@example.com>",
            subject: "Read on my phone",
            internal_date: "3000",
        },
        ArrivalCase {
            id: "stale",
            thread_id: "t6",
            labels: &["INBOX", "UNREAD"],
            from: "Eve <eve@example.com>",
            subject: "Old mail",
            internal_date: "-600000",
        },
    ]
}

async fn mount_arrival_message(server: &MockServer, case: ArrivalCase) {
    Mock::given(method("GET"))
        .and(path(format!("/users/me/messages/{}", case.id)))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": case.id, "threadId": case.thread_id, "historyId": "50", "labelIds": case.labels,
            "snippet": "s", "internalDate": case.internal_date,
            "payload": {"mimeType": "text/plain", "headers": [
                {"name": "From", "value": case.from},
                {"name": "Subject", "value": case.subject}
            ], "body": {"data": "bmV3"}}
        })))
        .mount(server)
        .await;
}

async fn mount_arrival_filter_mocks(server: &MockServer) {
    mount_empty_labels(server).await;
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
        .mount(server)
        .await;
    for case in arrival_cases() {
        mount_arrival_message(server, case).await;
    }
}

#[tokio::test]
async fn incremental_sync_reports_only_unread_inbox_arrivals() {
    let server = MockServer::start().await;
    mount_arrival_filter_mocks(&server).await;

    let (engine, _storage, _directory, events) = engine_with_seed();
    engine
        .run_sync("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();

    let fired = events.lock().unwrap().clone();
    let new_mail = fired
        .iter()
        .find(|(name, _)| name == latentmail_lib::events::MAIL_NEW)
        .map(|(_, payload)| payload.clone())
        .expect("mail://new is emitted for the arrival");
    assert_eq!(
        new_mail.get("arrivals"),
        Some(&serde_json::json!([
            {"threadId": "t2", "sender": "Carol <carol@example.com>", "subject": "New mail", "snippet": "s"}
        ]))
    );
}

async fn mount_probe_and_reply_messages(server: &MockServer) {
    mount_empty_labels(server).await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id": "probed", "threadId": "t2"}]
        })))
        .mount(server)
        .await;
    for id in ["probed", "reply"] {
        Mock::given(method("GET"))
            .and(path(format!("/users/me/messages/{id}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": id, "threadId": "t2", "historyId": "50",
                "labelIds": ["INBOX", "UNREAD"], "internalDate": "3000",
                "payload": {"mimeType": "text/plain", "headers": [
                    {"name": "Subject", "value": id}
                ], "body": {"data": "bmV3"}}
            })))
            .mount(server)
            .await;
    }
}

#[tokio::test]
async fn history_does_not_notify_again_for_unread_mail_saved_by_the_probe() {
    let server = MockServer::start().await;
    let (engine, storage, _directory, events) = engine_with_seed();
    mount_probe_and_reply_messages(&server).await;
    engine
        .probe_only("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();
    assert_eq!(arrival_subjects(&events), ["probed"]);
    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "historyId": "60", "history": [{
                "id": "60", "messagesAdded": [
                    {"message": {"id": "probed", "threadId": "t2"}},
                    {"message": {"id": "reply", "threadId": "t2"}},
                    {"message": {"id": "reply", "threadId": "t2"}}
                ],
                "labelsAdded": [{"message": {"id": "probed", "threadId": "t2"}, "labelIds": ["STARRED"]}]
            }]
        })))
        .mount(&server)
        .await;
    for _ in 0..2 {
        engine
            .run_sync("account", GmailClient::with_base_url("token", server.uri()))
            .await
            .unwrap();
        assert_eq!(arrival_subjects(&events), ["probed", "reply"]);
    }
    engine
        .probe_only("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();
    assert_eq!(arrival_subjects(&events), ["probed", "reply"]);
    let connection = storage.connection().unwrap();
    let message = MessageRepository::get(&connection, "account", "probed")
        .unwrap()
        .unwrap();
    assert!(message.is_unread && message.is_starred);
    assert_eq!(
        AccountRepository::get(&connection, "account")
            .unwrap()
            .unwrap()
            .history_id,
        Some(60)
    );
}

async fn mount_lagging_inbox_mocks(server: &MockServer) {
    mount_empty_labels(server).await;
    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"historyId": "70", "history": []})),
        )
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [
                {"id": "lagging", "threadId": "t9"},
                {"id": "existing1", "threadId": "t1"}
            ]
        })))
        .mount(server)
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
        .mount(server)
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
        .mount(server)
        .await;
}

#[tokio::test]
async fn incremental_sync_ingests_inbox_mail_history_has_not_reported_yet() {
    let server = MockServer::start().await;
    mount_lagging_inbox_mocks(&server).await;

    let (engine, storage, _directory, events) = engine_with_seed();
    engine
        .run_sync("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();

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
    assert!(has_event(&events, latentmail_lib::events::MAIL_NEW));
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
    assert!(!has_event(&events, latentmail_lib::events::MAIL_NEW));
    assert_sync_complete_event(&events, false);
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

async fn mount_resumed_reconciliation_mocks(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(ResponseTemplate::new(404))
        .up_to_n_times(1)
        .mount(server)
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
        .mount(server)
        .await;
    mount_empty_labels(server).await;
    for (id, thread_id) in [("reconciled", "reconciled-thread"), ("late", "late-thread")] {
        Mock::given(method("GET"))
            .and(path(format!("/users/me/messages/{id}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": id, "threadId": thread_id, "historyId": "60", "labelIds": [],
                "internalDate": "1000", "payload": {"headers": []}
            })))
            .mount(server)
            .await;
    }
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
        StagedIds {
            account_id: "account",
            ids: &["reconciled".into()],
        },
        &cursor,
    )
    .unwrap();
    drop(connection);

    let server = MockServer::start().await;
    mount_resumed_reconciliation_mocks(&server).await;

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

async fn mount_stale_history_mocks(server: &MockServer) {
    mount_empty_labels(server).await;
    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "historyId": "60",
            "history": [{
                "id": "60",
                "messagesAdded": [{"message": {"id": "raced", "threadId": "t1"}}]
            }]
        })))
        .mount(server)
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
        .mount(server)
        .await;
}

#[tokio::test]
async fn a_stale_full_state_write_from_history_is_rejected_by_the_existing_gate() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &test_account(Some(40))).unwrap();
    let mut ahead = seed_message(SeedMessage {
        id: "raced",
        thread_id: "t1",
        sent_at: 1,
        unread: false,
    });
    ahead.history_id = 100;
    ahead.subject = "Already ahead".into();
    MessageRepository::write_full_state(&connection, &ahead).unwrap();
    ThreadRepository::recompute(&connection, "account", "t1").unwrap();
    drop(connection);

    let server = MockServer::start().await;
    mount_stale_history_mocks(&server).await;

    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let engine = SyncEngine::new(SyncEngineDeps {
        storage: storage.clone(),
        queue: queue,
        registry: registry,
        events: latentmail_lib::sync::noop_event_sink(),
    });
    let client = GmailClient::with_base_url("token", server.uri());
    engine.run_sync("account", client).await.unwrap();

    let connection = storage.connection().unwrap();
    let message = MessageRepository::get(&connection, "account", "raced")
        .unwrap()
        .unwrap();
    assert_eq!(message.history_id, 100);
    assert_eq!(message.subject, "Already ahead");
}

fn channel_scheduler(
    interval: Duration,
    immediate: bool,
) -> (Arc<SyncScheduler>, tokio::sync::mpsc::UnboundedReceiver<()>) {
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel::<()>();
    let scheduler = SyncScheduler::start(interval, immediate, move || {
        let sender = sender.clone();
        async move {
            let _ = sender.send(());
        }
    });
    (scheduler, receiver)
}

#[tokio::test(start_paused = true)]
async fn changing_the_poll_interval_takes_effect_without_waiting_out_the_old_one() {
    let (scheduler, mut receiver) = channel_scheduler(Duration::from_secs(600), false);

    tokio::time::advance(Duration::from_secs(60)).await;
    assert!(receiver.try_recv().is_err(), "should not have ticked yet");

    scheduler.set_interval(Duration::from_secs(120));
    tokio::time::advance(Duration::from_secs(121)).await;
    assert!(
        receiver.recv().await.is_some(),
        "new interval should have fired a tick"
    );
}

#[tokio::test(start_paused = true)]
async fn sync_on_startup_disabled_genuinely_skips_the_immediate_tick() {
    let (_scheduler, mut receiver) = channel_scheduler(Duration::from_secs(600), false);

    tokio::task::yield_now().await;
    assert!(
        receiver.try_recv().is_err(),
        "sync-on-startup=false must not tick immediately"
    );
}

#[tokio::test(start_paused = true)]
async fn sync_on_startup_enabled_ticks_immediately() {
    let (_scheduler, mut receiver) = channel_scheduler(Duration::from_secs(600), true);

    assert!(
        receiver.recv().await.is_some(),
        "sync-on-startup=true must tick immediately"
    );
}

struct StartupFixture {
    application: tauri::App<tauri::test::MockRuntime>,
    database_path: std::path::PathBuf,
    storage: Storage,
    _home: tempfile::TempDir,
}

fn prepare_startup_fixture() -> StartupFixture {
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
    let database_path = directory.join("latentmail.sqlite");
    let storage = Storage::open(&database_path).unwrap();
    application.manage(storage.clone());
    latentmail_lib::settings::initialize(handle, storage.clone()).unwrap();
    latentmail_lib::auth::initialize(handle, storage.clone()).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &test_account(None)).unwrap();
    drop(connection);
    StartupFixture {
        application: application,
        database_path: database_path,
        storage: storage,
        _home: home,
    }
}

async fn mount_startup_sync_mocks(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "fresh-access-token",
            "token_type": "Bearer",
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "emailAddress": "me@example.com",
            "messagesTotal": 0,
            "threadsTotal": 0,
            "historyId": "100"
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "labels": [{"id":"INBOX","name":"Inbox","type":"system","messagesTotal":0,"messagesUnread":0}]
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({ "messages": [] })),
        )
        .mount(server)
        .await;
}

async fn wait_for_history_id(storage: &Storage, expected: i64) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let connection = storage.connection().unwrap();
        let history_id = AccountRepository::get(&connection, "account")
            .unwrap()
            .and_then(|account| account.history_id);
        drop(connection);
        if history_id == Some(expected) {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "scheduler tick never completed initial sync"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn wait_for_operation_status(storage: &Storage, id: &str, expected: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let connection = storage.connection().unwrap();
        let status = OperationRepository::get(&connection, id)
            .unwrap()
            .unwrap()
            .status;
        drop(connection);
        if status == expected {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "startup recovery never marked the interrupted send uncertain"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn active_operation(id: &str, kind: &str, entity_key: &str) -> Operation {
    Operation {
        id: id.into(),
        account_id: "account".into(),
        lane: "interactive".into(),
        kind: kind.into(),
        entity_key: entity_key.into(),
        payload: "{}".into(),
        status: "active".into(),
        attempts: 0,
        next_attempt_at: None,
        error: None,
        created_at: 1,
        updated_at: 1,
    }
}

#[tokio::test]
async fn initialize_with_sync_on_startup_actually_runs_a_scheduler_tick() {
    let server = MockServer::start().await;
    mount_startup_sync_mocks(&server).await;

    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());

    let fixture = prepare_startup_fixture();
    latentmail_lib::auth::save_refresh_token("account", "stored-refresh-token").unwrap();
    latentmail_lib::sync::initialize(fixture.application.handle(), fixture.storage).unwrap();

    let poll_storage = Storage::open(&fixture.database_path).unwrap();
    wait_for_history_id(&poll_storage, 100).await;
}

#[tokio::test]
async fn startup_recovery_marks_an_interrupted_send_uncertain_and_requeues_an_interrupted_draft() {
    let fixture = prepare_startup_fixture();
    let connection = fixture.storage.connection().unwrap();
    OperationRepository::upsert(
        &connection,
        &active_operation("op-send-interrupted", "send", "send:session"),
    )
    .unwrap();
    OperationRepository::upsert(
        &connection,
        &active_operation("op-draft-interrupted", "draft", "draft:session"),
    )
    .unwrap();
    drop(connection);
    latentmail_lib::sync::initialize(fixture.application.handle(), fixture.storage).unwrap();

    let poll_storage = Storage::open(&fixture.database_path).unwrap();
    wait_for_operation_status(&poll_storage, "op-send-interrupted", "failed").await;

    let connection = poll_storage.connection().unwrap();
    let send_op = OperationRepository::get(&connection, "op-send-interrupted")
        .unwrap()
        .unwrap();
    assert_eq!(
        send_op.error.as_deref(),
        Some("May have been sent; retry manually")
    );
}
