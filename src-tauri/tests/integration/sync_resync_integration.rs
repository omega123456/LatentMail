use latentmail_lib::gmail::GmailClient;
use latentmail_lib::storage::{
    Account, AccountRepository, HtmlPresence, Message, MessageRepository, Storage, ThreadRepository,
};
use latentmail_lib::sync::{noop_event_sink, SyncEngine, SyncState, WorkRegistry};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

fn engine_with_stale_checkpoint() -> (std::sync::Arc<SyncEngine>, Storage, tempfile::TempDir) {
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
            history_id: Some(999),
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();

    MessageRepository::write_full_state(
        &connection,
        &Message {
            account_id: "account".into(),
            id: "retained".into(),
            thread_id: "retained-thread".into(),
            rfc_message_id: None,
            sender: "old@example.com".into(),
            recipients: "me@example.com".into(),
            subject: "Old".into(),
            sent_at: 1,
            snippet: String::new(),
            html_body: None,
            plain_body: None,
            has_attachments: false,
            is_unread: false,
            is_starred: false,
            history_id: 1,
            truncated_body: None,
            html_presence: HtmlPresence::Absent,
        },
    )
    .unwrap();
    ThreadRepository::recompute(&connection, "account", "retained-thread").unwrap();
    drop(connection);

    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let engine = SyncEngine::new(storage.clone(), queue, registry, noop_event_sink());
    (engine, storage, directory)
}

async fn mount_expired_then_full_resync_fixture(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(ResponseTemplate::new(404))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "emailAddress": "me@example.com", "messagesTotal": 1, "threadsTotal": 1, "historyId": "777"
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "labels": [{"id":"INBOX","name":"Inbox","type":"system","messagesTotal":1,"messagesUnread":0}]
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "messages": [
                {"id":"fresh","threadId":"fresh-thread"},
                {"id":"retained","threadId":"retained-thread"}
            ]
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/fresh"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id":"fresh","threadId":"fresh-thread","historyId":"777","labelIds":["INBOX"],"snippet":"hi",
            "internalDate":"5000",
            "payload":{"mimeType":"text/plain","headers":[
                {"name":"From","value":"New <new@example.com>"},
                {"name":"Subject","value":"Fresh"}
            ],"body":{"data":"aGk"}}
        })))
        .mount(server)
        .await;
}

#[tokio::test]
async fn expired_checkpoint_repairs_in_place_and_adopts_a_fresh_checkpoint() {
    let server = MockServer::start().await;
    mount_expired_then_full_resync_fixture(&server).await;
    let (engine, storage, _directory) = engine_with_stale_checkpoint();
    let client = GmailClient::with_base_url("token", server.uri());

    engine.run_sync("account", client).await.unwrap();

    let connection = storage.connection().unwrap();
    assert!(MessageRepository::get(&connection, "account", "retained")
        .unwrap()
        .is_some());
    assert!(
        ThreadRepository::get(&connection, "account", "retained-thread")
            .unwrap()
            .is_some()
    );
    assert!(MessageRepository::get(&connection, "account", "fresh")
        .unwrap()
        .is_some());
    assert!(
        ThreadRepository::get(&connection, "account", "fresh-thread")
            .unwrap()
            .is_some()
    );

    let account = AccountRepository::get(&connection, "account")
        .unwrap()
        .unwrap();
    assert_eq!(account.history_id, Some(777));
    let status = engine.status("account").await;
    assert_eq!(status.state, SyncState::Idle);
}
