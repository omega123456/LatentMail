//! Initial sync: labels -> Inbox message ids -> content retrieval -> storage
//! -> thread derivation, all routed through the queue's background lane.

use latentmail_lib::gmail::GmailClient;
use latentmail_lib::queue::QueueEngine;
use latentmail_lib::storage::{
    Account, AccountRepository, LabelRepository, MessageRepository, Storage, ThreadRepository,
};
use latentmail_lib::sync::{noop_event_sink, SyncEngine, SyncState, WorkRegistry};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

fn engine_with_storage() -> (std::sync::Arc<SyncEngine>, Storage, tempfile::TempDir) {
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
    let engine = SyncEngine::new(storage.clone(), queue, registry, noop_event_sink());
    (engine, storage, directory)
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
                {"mimeType":"application/pdf","filename":"doc.pdf","body":{}}
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
    // Plus an auto-created "UNREAD" placeholder — m1 carries that label id,
    // but the `labels.list` fixture above only returns "INBOX"; see
    // `LabelRepository::ensure_placeholder`.
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
async fn initial_sync_leaves_the_checkpoint_untouched_on_failure() {
    let server = MockServer::start().await;
    // No mocks mounted: every request fails (connection refused after the
    // server is dropped) — simulate by mounting only profile+labels but not
    // the message list, which 404s against wiremock's default "no match".
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
    let (engine, storage, _directory) = engine_with_storage();
    let client = GmailClient::with_base_url("token", server.uri());

    let result = engine.initial_sync("account", client).await;
    assert!(result.is_err());

    let connection = storage.connection().unwrap();
    let account = AccountRepository::get(&connection, "account")
        .unwrap()
        .unwrap();
    assert_eq!(account.history_id, None);
    let status = engine.status("account").await;
    assert_eq!(status.state, SyncState::Error);
    assert!(status.last_error.is_some());
}
