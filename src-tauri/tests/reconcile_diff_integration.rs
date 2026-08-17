
use latentmail_lib::{
    gmail::GmailClient,
    storage::{
        Account, AccountRepository, HtmlPresence, Message, MessageRepository, Storage,
        ThreadRepository,
    },
    sync::{create_queue_engine, noop_event_sink, SyncEngine, WorkRegistry},
};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

fn row(id: &str, thread_id: &str) -> Message {
    Message {
        account_id: "account".into(),
        id: id.into(),
        thread_id: thread_id.into(),
        rfc_message_id: None,
        sender: "sender@example.com".into(),
        recipients: "me@example.com".into(),
        subject: id.into(),
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
    }
}

#[tokio::test]
async fn reconciliation_deletes_only_absent_messages_and_fetches_new_ones() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/users/me/history"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "emailAddress":"me@example.com", "messagesTotal":2, "threadsTotal":2, "historyId":"50"
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"labels":[]})))
        .mount(&server)
        .await;
    Mock::given(method("GET")).and(path("/users/me/messages")).respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"messages":[{"id":"kept","threadId":"kept-thread"},{"id":"new","threadId":"new-thread"}]}))).mount(&server).await;
    Mock::given(method("GET")).and(path("/users/me/messages/new")).respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id":"new","threadId":"new-thread","historyId":"50","labelIds":[],"internalDate":"1000","payload":{"headers":[]}}))).mount(&server).await;
    let dir = tempfile::tempdir().unwrap();
    let storage = Storage::open(dir.path().join("mail.sqlite")).unwrap();
    let c = storage.connection().unwrap();
    AccountRepository::upsert(
        &c,
        &Account {
            id: "account".into(),
            email: "me@example.com".into(),
            display_name: String::new(),
            avatar_url: None,
            history_id: Some(1),
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    for (id, thread) in [("kept", "kept-thread"), ("gone", "gone-thread")] {
        MessageRepository::write_full_state(&c, &row(id, thread)).unwrap();
        ThreadRepository::recompute(&c, "account", thread).unwrap();
    }
    drop(c);
    let registry = WorkRegistry::new();
    let engine = SyncEngine::new(
        storage.clone(),
        create_queue_engine(250, 250, registry.clone()),
        registry,
        noop_event_sink(),
    );
    engine
        .run_sync("account", GmailClient::with_base_url("token", server.uri()))
        .await
        .unwrap();
    let c = storage.connection().unwrap();
    assert!(MessageRepository::get(&c, "account", "kept")
        .unwrap()
        .is_some());
    assert!(MessageRepository::get(&c, "account", "gone")
        .unwrap()
        .is_none());
    assert!(MessageRepository::get(&c, "account", "new")
        .unwrap()
        .is_some());
    assert_eq!(
        AccountRepository::get(&c, "account")
            .unwrap()
            .unwrap()
            .history_id,
        Some(50)
    );
}
