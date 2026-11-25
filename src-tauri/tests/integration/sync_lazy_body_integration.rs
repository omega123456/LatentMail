use crate::support::{app, sync_engine as engine};
use latentmail_lib::auth::AuthService;
use latentmail_lib::ipc::{AccountMessageRequest, AppServices, CommandPayload};
use latentmail_lib::storage::{
    Account, AccountRepository, AttachmentRepository, HtmlPresence, Message, MessageRepository,
    Storage,
};
use latentmail_lib::storage::{MessageBodyUpdate, MessageKey};
use latentmail_lib::sync::commands::fetch_message_body;
use tauri::Manager;
use wiremock::{
    matchers::{method, path, query_param},
    Mock, MockServer, ResponseTemplate,
};

fn message(presence: HtmlPresence) -> Message {
    Message {
        truncated_body: Some("cut off embedding text".into()),
        html_presence: presence,
        ..crate::support::message("account", "message", "thread")
    }
}

fn test_account() -> Account {
    Account {
        id: "account".into(),
        email: "me@example.com".into(),
        display_name: String::new(),
        avatar_url: None,
        history_id: None,
        needs_reauthentication: false,
        created_at: 1,
        updated_at: 1,
    }
}

fn storage_with_message(stored: &Message) -> (Storage, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &test_account()).unwrap();
    MessageRepository::write_full_state(&connection, stored).unwrap();
    drop(connection);
    (storage, directory)
}

fn managed_app(storage: &Storage) -> tauri::App<tauri::test::MockRuntime> {
    let sync_engine = engine(storage);
    let application = app();
    application.manage(AuthService::new(storage.clone()));
    application.manage(sync_engine);
    application.manage(storage.clone());
    application
}

async fn mount_token_and_configure_env(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "fresh-access-token",
            "token_type": "Bearer",
        })))
        .mount(server)
        .await;
    crate::support::set_env("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    crate::support::set_env(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    crate::support::set_env("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    latentmail_lib::auth::save_refresh_token("account", "stored-refresh-token").unwrap();
}

async fn invoke_fetch_body(application: &tauri::App<tauri::test::MockRuntime>, message_id: &str) {
    fetch_message_body(
        AppServices::new(application.handle()),
        CommandPayload(AccountMessageRequest {
            account_id: "account".into(),
            message_id: message_id.into(),
        }),
    )
    .await
    .unwrap();
}

fn cid_stored_message() -> Message {
    let mut stored = message(HtmlPresence::Present);
    stored.id = "m1".into();
    stored.thread_id = "t1".into();
    stored.html_body = Some("<img src=\"cid:logo@example.com\">".into());
    stored.truncated_body = None;
    stored
}

#[test]
fn lazy_body_cache_distinguishes_never_fetched_present_and_absent() {
    let (storage, _directory) = storage_with_message(&message(HtmlPresence::NeverFetched));
    let connection = storage.connection().unwrap();
    let initial = MessageRepository::get(&connection, "account", "message")
        .unwrap()
        .unwrap();
    assert_eq!(initial.html_presence, HtmlPresence::NeverFetched);
    assert!(initial.body_is_empty());

    let key = MessageKey {
        account_id: "account",
        message_id: "message",
    };
    MessageRepository::set_body(
        &connection,
        key,
        MessageBodyUpdate {
            html_body: Some("<p>full body</p>"),
            plain_body: None,
            presence: HtmlPresence::Present,
        },
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
        key,
        MessageBodyUpdate {
            html_body: None,
            plain_body: Some("plain-only bounce notice"),
            presence: HtmlPresence::Absent,
        },
    )
    .unwrap();
    let absent = MessageRepository::get(&connection, "account", "message")
        .unwrap()
        .unwrap();
    assert_eq!(absent.html_presence, HtmlPresence::Absent);
    assert!(absent.html_body.is_none());
    assert_eq!(
        absent.plain_body.as_deref(),
        Some("plain-only bounce notice")
    );
    assert!(!absent.body_is_empty());
}

async fn mount_oversize_message_mocks(server: &MockServer) {
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
        .mount(server)
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
        .mount(server)
        .await;
}

#[tokio::test]
async fn fetch_message_body_persists_too_large_and_never_redownloads_it() {
    let server = MockServer::start().await;
    mount_token_and_configure_env(&server).await;
    mount_oversize_message_mocks(&server).await;

    let stored = Message {
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
    };
    let (storage, _directory) = storage_with_message(&stored);
    let application = managed_app(&storage);

    invoke_fetch_body(&application, "m1").await;

    let stored = MessageRepository::get(&storage.connection().unwrap(), "account", "m1")
        .unwrap()
        .unwrap();
    assert_eq!(stored.html_presence, HtmlPresence::TooLarge);
    assert!(stored.html_body.is_none());

    invoke_fetch_body(&application, "m1").await;
    server.verify().await;
}

#[tokio::test]
async fn a_stored_body_with_an_unresolved_cid_downloads_the_inline_image() {
    let server = MockServer::start().await;
    mount_token_and_configure_env(&server).await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "m1", "threadId": "t1", "historyId": "2", "labelIds": ["INBOX"],
            "snippet": "hello", "internalDate": "0",
            "payload": {
                "mimeType": "multipart/related",
                "headers": [],
                "parts": [
                    {
                        "mimeType": "text/html",
                        "body": { "data": "PGltZyBzcmM9ImNpZDpsb2dvQGV4YW1wbGUuY29tIj4" }
                    },
                    {
                        "mimeType": "image/png",
                        "filename": "logo.png",
                        "headers": [{ "name": "Content-ID", "value": "<logo@example.com>" }],
                        "body": { "attachmentId": "att-1", "size": 9 }
                    }
                ]
            }
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1/attachments/att-1"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({ "size": 9, "data": "cG5nLWJ5dGVz" })),
        )
        .expect(1)
        .mount(&server)
        .await;

    let (storage, _directory) = storage_with_message(&cid_stored_message());
    let application = managed_app(&storage);
    invoke_fetch_body(&application, "m1").await;

    let connection = storage.connection().unwrap();
    let parts = MessageRepository::inline_parts(&connection, "account", "m1").unwrap();
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0].content_id, "logo@example.com");
    assert_eq!(parts[0].bytes, b"png-bytes");
    let attachments = AttachmentRepository::for_message(&connection, "account", "m1").unwrap();
    assert_eq!(attachments.len(), 1);
    assert_eq!(attachments[0].filename, "logo.png");
    server.verify().await;
}

#[tokio::test]
async fn an_inline_image_that_will_not_download_stores_no_inline_part() {
    let server = MockServer::start().await;
    mount_token_and_configure_env(&server).await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "m1", "threadId": "t1", "historyId": "2", "labelIds": ["INBOX"],
            "snippet": "hello", "internalDate": "0",
            "payload": {
                "mimeType": "multipart/related",
                "headers": [],
                "parts": [
                    {
                        "mimeType": "text/html",
                        "body": { "data": "PGltZyBzcmM9ImNpZDpsb2dvQGV4YW1wbGUuY29tIj4" }
                    },
                    {
                        "mimeType": "image/png",
                        "filename": "logo.png",
                        "headers": [{ "name": "Content-ID", "value": "<logo@example.com>" }],
                        "body": { "attachmentId": "att-1", "size": 9 }
                    },
                    {
                        "mimeType": "application/pdf",
                        "filename": "invoice.pdf",
                        "body": { "attachmentId": "att-2", "size": 4096 }
                    }
                ]
            }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1/attachments/att-1"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    let (storage, _directory) = storage_with_message(&cid_stored_message());
    let application = managed_app(&storage);
    invoke_fetch_body(&application, "m1").await;

    let connection = storage.connection().unwrap();
    assert!(
        MessageRepository::inline_parts(&connection, "account", "m1")
            .unwrap()
            .is_empty()
    );
    let attachments = AttachmentRepository::for_message(&connection, "account", "m1").unwrap();
    let names = attachments
        .iter()
        .map(|attachment| attachment.filename.as_str())
        .collect::<Vec<_>>();
    assert_eq!(names, vec!["logo.png", "invoice.pdf"]);
}
