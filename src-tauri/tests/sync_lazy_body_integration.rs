
use std::sync::Arc;

use latentmail_lib::auth::AuthService;
use latentmail_lib::storage::{
    Account, AccountRepository, HtmlPresence, Message, MessageRepository, Storage,
};
use latentmail_lib::sync::commands::fetch_message_body;
use latentmail_lib::sync::{noop_event_sink, SyncEngine, WorkRegistry};
use tauri::Manager;
use wiremock::{
    matchers::{method, path, query_param},
    Mock, MockServer, ResponseTemplate,
};

fn app() -> tauri::App<tauri::test::MockRuntime> {
    tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap()
}

fn engine(storage: &Storage) -> Arc<SyncEngine> {
    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    SyncEngine::new(storage.clone(), queue, registry, noop_event_sink())
}

fn message(presence: HtmlPresence) -> Message {
    Message {
        account_id: "account".into(),
        id: "message".into(),
        thread_id: "thread".into(),
        rfc_message_id: None,
        sender: "sender@example.com".into(),
        recipients: String::new(),
        subject: "Subject".into(),
        sent_at: 1,
        snippet: "snippet".into(),
        html_body: None,
        plain_body: None,
        has_attachments: false,
        is_unread: false,
        is_starred: false,
        history_id: 1,
        truncated_body: Some("cut off embedding text".into()),
        html_presence: presence,
    }
}

#[test]
fn lazy_body_cache_distinguishes_never_fetched_present_and_absent() {
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
    MessageRepository::write_full_state(&connection, &message(HtmlPresence::NeverFetched)).unwrap();
    assert_eq!(
        MessageRepository::get(&connection, "account", "message")
            .unwrap()
            .unwrap()
            .html_presence,
        HtmlPresence::NeverFetched
    );
    assert!(MessageRepository::get(&connection, "account", "message")
        .unwrap()
        .unwrap()
        .body_is_empty());
    MessageRepository::set_body(
        &connection,
        "account",
        "message",
        Some("<p>full body</p>"),
        None,
        HtmlPresence::Present,
    )
    .unwrap();
    let cached = MessageRepository::get(&connection, "account", "message")
        .unwrap()
        .unwrap();
    assert_eq!(cached.html_body.as_deref(), Some("<p>full body</p>"));
    assert_eq!(cached.html_presence, HtmlPresence::Present);
    assert!(!cached.body_is_empty());
    MessageRepository::set_body(
        &connection,
        "account",
        "message",
        None,
        Some("plain-only bounce notice"),
        HtmlPresence::Absent,
    )
    .unwrap();
    let absent = MessageRepository::get(&connection, "account", "message")
        .unwrap()
        .unwrap();
    assert_eq!(absent.html_presence, HtmlPresence::Absent);
    assert!(absent.html_body.is_none());

    assert_eq!(absent.plain_body.as_deref(), Some("plain-only bounce notice"));
    assert!(!absent.body_is_empty());
}

#[tokio::test]
async fn fetch_message_body_persists_too_large_and_never_redownloads_it() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "fresh-access-token",
            "token_type": "Bearer",
        })))
        .mount(&server)
        .await;
    let full_fields = "id,threadId,historyId,labelIds,snippet,internalDate,payload(headers,body,parts,filename,mimeType,partId)";
    let metadata_fields = "id,threadId,historyId,labelIds,snippet,internalDate,payload(headers)";
    let big_data = "a".repeat(11 * 1024 * 1024);
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .and(query_param("fields", full_fields))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "m1", "threadId": "t1", "historyId": "2", "labelIds": ["INBOX"],
            "snippet": "hello", "internalDate": "0",
            "payload": {
                "mimeType": "text/html",
                "headers": [],
                "body": { "data": big_data }
            }
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .and(query_param("format", "metadata"))
        .and(query_param("fields", metadata_fields))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "m1", "threadId": "t1", "historyId": "2", "labelIds": ["INBOX"],
            "snippet": "hello", "internalDate": "0",
            "payload": { "headers": [] }
        })))
        .expect(1)
        .mount(&server)
        .await;
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    latentmail_lib::auth::save_refresh_token("account", "stored-refresh-token").unwrap();

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
    MessageRepository::write_full_state(
        &connection,
        &Message {
            account_id: "account".into(),
            id: "m1".into(),
            thread_id: "t1".into(),
            rfc_message_id: None,
            sender: "Alice <a@example.com>".into(),
            recipients: "me@example.com".into(),
            subject: "Subject".into(),
            sent_at: 0,
            snippet: "hello".into(),
            html_body: None,
            plain_body: None,
            has_attachments: false,
            is_unread: false,
            is_starred: false,
            history_id: 1,
            truncated_body: None,
            html_presence: HtmlPresence::NeverFetched,
        },
    )
    .unwrap();
    drop(connection);

    let sync_engine = engine(&storage);
    let application = app();
    application.manage(AuthService::new(storage.clone()));
    application.manage(sync_engine);
    application.manage(storage.clone());

    fetch_message_body(
        application.handle().clone(),
        application.state(),
        application.state(),
        application.state(),
        "account".into(),
        "m1".into(),
    )
    .await
    .unwrap();

    let stored = MessageRepository::get(&storage.connection().unwrap(), "account", "m1")
        .unwrap()
        .unwrap();
    assert_eq!(stored.html_presence, HtmlPresence::TooLarge);
    assert!(stored.html_body.is_none());

    fetch_message_body(
        application.handle().clone(),
        application.state(),
        application.state(),
        application.state(),
        "account".into(),
        "m1".into(),
    )
    .await
    .unwrap();

    server.verify().await;
}
