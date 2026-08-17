
use latentmail_lib::gmail::GmailClient;
use latentmail_lib::queue::QueueEngine;
use latentmail_lib::storage::{
    Account, AccountRepository, LabelRepository, MessageRepository, Storage, ThreadRepository,
};
use latentmail_lib::sync::{SyncEngine, SyncState, WorkRegistry};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

fn engine_with_storage() -> (std::sync::Arc<SyncEngine>, Storage, tempfile::TempDir) {
    let (engine, storage, directory, _) = engine_with_recorded_events();
    (engine, storage, directory)
}

type RecordedEvents = std::sync::Arc<std::sync::Mutex<Vec<(&'static str, serde_json::Value)>>>;

fn engine_with_recorded_events() -> (
    std::sync::Arc<SyncEngine>,
    Storage,
    tempfile::TempDir,
    RecordedEvents,
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
            history_id: None,
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    let registry = WorkRegistry::new();
    let queue: std::sync::Arc<QueueEngine> =
        latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let events: RecordedEvents = Default::default();
    let recorder = std::sync::Arc::clone(&events);
    let engine = SyncEngine::new(
        storage.clone(),
        queue,
        registry,
        std::sync::Arc::new(move |name, payload| recorder.lock().unwrap().push((name, payload))),
    );
    (engine, storage, directory, events)
}

async fn mount_fixture(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "emailAddress": "me@example.com",
            "messagesTotal": 2,
            "threadsTotal": 1,
            "historyId": "100"
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "labels": [{"id":"INBOX","name":"Inbox","type":"system","messagesTotal":2,"messagesUnread":1}]
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [{"id":"m1","threadId":"t1"},{"id":"m2","threadId":"t1"}]
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id":"m1","threadId":"t1","historyId":"10","labelIds":["INBOX","UNREAD"],"snippet":"hello",
            "internalDate":"1000",
            "payload":{"mimeType":"text/plain","headers":[
                {"name":"From","value":"Alice <alice@example.com>"},
                {"name":"To","value":"me@example.com"},
                {"name":"Subject","value":"Hello"}
            ],"body":{"data":"aGVsbG8"}}
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id":"m2","threadId":"t1","historyId":"11","labelIds":["INBOX"],"snippet":"reply",
            "internalDate":"2000",
            "payload":{"mimeType":"multipart/mixed","headers":[
                {"name":"From","value":"Bob <bob@example.com>"},
                {"name":"To","value":"me@example.com"},
                {"name":"Subject","value":"Re: Hello"}
            ],"parts":[
                {"mimeType":"text/plain","body":{"data":"cmVwbHk"}},
                {"mimeType":"application/pdf","filename":"doc.pdf","body":{}},
                {"mimeType":"image/png","headers":[{"name":"Content-ID","value":"<logo>"}],"body":{"data":"aW1n"}}
            ]}
        })))
        .mount(server)
        .await;
}

#[tokio::test]
async fn initial_sync_populates_labels_messages_membership_and_threads() {
    let server = MockServer::start().await;
    mount_fixture(&server).await;
    let (engine, storage, _directory) = engine_with_storage();
    let client = GmailClient::with_base_url("token", server.uri());

    engine.initial_sync("account", client).await.unwrap();

    let connection = storage.connection().unwrap();
    let labels = LabelRepository::list(&connection, "account").unwrap();

    let inbox = labels.iter().find(|label| label.id == "INBOX").unwrap();
    assert_eq!(inbox.message_count, 2);
    assert_eq!(inbox.unread_count, 1);

    let m1 = MessageRepository::get(&connection, "account", "m1")
        .unwrap()
        .unwrap();
    assert!(m1.is_unread);
    let m2 = MessageRepository::get(&connection, "account", "m2")
        .unwrap()
        .unwrap();
    assert!(m2.has_attachments);
    assert_eq!(
        MessageRepository::label_ids(&connection, "account", "m1").unwrap(),
        vec!["INBOX".to_owned(), "UNREAD".to_owned()]
    );

    let thread = ThreadRepository::get(&connection, "account", "t1")
        .unwrap()
        .unwrap();
    assert_eq!(thread.message_count, 2);
    assert!(thread.is_unread);
    assert!(thread.has_attachments);
    assert_eq!(thread.subject, "Re: Hello");
    assert_eq!(
        thread.participants,
        "Alice <alice@example.com>, Bob <bob@example.com>"
    );

    let account = AccountRepository::get(&connection, "account")
        .unwrap()
        .unwrap();
    assert_eq!(account.history_id, Some(100));

    let status = engine.status("account").await;
    assert_eq!(status.state, SyncState::Idle);
    assert!(status.last_synced_at.is_some());
}


#[tokio::test]
async fn initial_sync_announces_no_arrivals_to_notify_about() {
    let server = MockServer::start().await;
    mount_fixture(&server).await;
    let (engine, _storage, _directory, events) = engine_with_recorded_events();

    engine
        .initial_sync("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();

    let new_mail = events
        .lock()
        .unwrap()
        .iter()
        .find(|(name, _)| *name == "mail://new")
        .map(|(_, payload)| payload.clone())
        .expect("initial sync still announces new mail so the list refreshes");
    assert_eq!(new_mail.get("arrivals"), Some(&serde_json::json!([])));
}


#[tokio::test]
async fn a_message_that_vanishes_between_listing_and_retrieval_is_skipped() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m2"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    mount_fixture(&server).await;
    let (engine, storage, _directory) = engine_with_storage();
    let client = GmailClient::with_base_url("token", server.uri());

    engine.initial_sync("account", client).await.unwrap();

    let connection = storage.connection().unwrap();
    assert!(MessageRepository::get(&connection, "account", "m1")
        .unwrap()
        .is_some());
    assert!(MessageRepository::get(&connection, "account", "m2")
        .unwrap()
        .is_none());
    let thread = ThreadRepository::get(&connection, "account", "t1")
        .unwrap()
        .unwrap();
    assert_eq!(thread.message_count, 1);
    assert_eq!(engine.status("account").await.state, SyncState::Idle);
}

#[tokio::test]
async fn initial_sync_leaves_the_checkpoint_untouched_on_failure() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "emailAddress": "me@example.com", "messagesTotal": 0, "threadsTotal": 0, "historyId": "5"
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(403))
        .mount(&server)
        .await;
    let (engine, storage, _directory, events) = engine_with_recorded_events();
    let client = GmailClient::with_base_url("token", server.uri());

    let result = engine.initial_sync("account", client).await;
    assert!(result.is_err());

    let progress: Vec<_> = events
        .lock()
        .unwrap()
        .iter()
        .filter(|(name, _)| *name == "sync://progress")
        .map(|(_, payload)| payload["state"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(progress, vec!["syncing".to_owned(), "error".to_owned()]);

    let connection = storage.connection().unwrap();
    let account = AccountRepository::get(&connection, "account")
        .unwrap()
        .unwrap();
    assert_eq!(account.history_id, None);
    let status = engine.status("account").await;
    assert_eq!(status.state, SyncState::Error);
    assert!(status.last_error.is_some());
}
