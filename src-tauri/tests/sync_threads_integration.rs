//! The Mail read commands (`list_labels`, `list_threads`, `load_conversation`)
//! and the Sync commands (`trigger_sync`, `read_sync_status`), plus thread
//! aggregation (read/starred/attachment/draft state) and pagination.

use std::sync::Arc;

use latentmail_lib::auth::AuthService;
use latentmail_lib::storage::{
    Account, AccountRepository, InlinePart, Label, LabelRepository, Message, MessageRepository,
    Storage, Thread, ThreadRepository,
};
use latentmail_lib::sync::commands::{
    list_labels, list_threads, load_conversation, read_sync_status, trigger_sync,
};
use latentmail_lib::sync::{noop_event_sink, SyncEngine, SyncState, ThreadCursor, WorkRegistry};
use tauri::Manager;
use wiremock::{
    matchers::{method, path},
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

fn seed_account(connection: &rusqlite::Connection) {
    AccountRepository::upsert(
        connection,
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
}

fn thread(id: &str, latest_at: i64, has_draft: bool) -> Thread {
    Thread {
        account_id: "account".into(),
        id: id.into(),
        subject: format!("Subject {id}"),
        participants: "Alice <a@example.com>".into(),
        latest_at,
        message_count: 1,
        is_unread: false,
        is_starred: false,
        has_attachments: false,
        has_draft,
    }
}

#[tokio::test]
async fn list_labels_returns_stored_counts() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    seed_account(&connection);
    LabelRepository::upsert(
        &connection,
        &Label {
            account_id: "account".into(),
            id: "INBOX".into(),
            name: "Inbox".into(),
            kind: "system".into(),
            color: None,
            message_count: 5,
            unread_count: 2,
        },
    )
    .unwrap();
    drop(connection);
    let application = app();
    application.manage(storage);

    let labels = list_labels(application.state(), "account".into())
        .await
        .unwrap();
    assert_eq!(labels.len(), 1);
    assert_eq!(labels[0].id, "INBOX");
    assert_eq!(labels[0].message_count, 5);
    assert_eq!(labels[0].unread_count, 2);
}

#[tokio::test]
async fn list_threads_paginates_newest_first_and_filters_by_label() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    seed_account(&connection);
    for (id, at) in [("t1", 1), ("t2", 2), ("t3", 3)] {
        ThreadRepository::upsert(&connection, &thread(id, at, id == "t2")).unwrap();
    }
    drop(connection);
    let application = app();
    application.manage(storage);

    let first_page = list_threads(application.state(), "account".into(), None, None, Some(2))
        .await
        .unwrap();
    assert_eq!(first_page.items.len(), 2);
    assert_eq!(first_page.items[0].id, "t3");
    assert_eq!(first_page.items[1].id, "t2");
    assert!(first_page.items[1].has_draft);
    let cursor = first_page.next_cursor.clone().expect("more pages remain");
    assert_eq!(cursor.id, "t2");

    let second_page = list_threads(
        application.state(),
        "account".into(),
        None,
        Some(cursor),
        Some(2),
    )
    .await
    .unwrap();
    assert_eq!(second_page.items.len(), 1);
    assert_eq!(second_page.items[0].id, "t1");
    assert!(second_page.next_cursor.is_none());
}

#[tokio::test]
async fn list_threads_cursor_type_round_trips_through_serde() {
    let cursor = ThreadCursor {
        latest_at: 10,
        id: "t1".into(),
    };
    let json = serde_json::to_value(&cursor).unwrap();
    assert_eq!(json["latestAt"], 10);
    let round_tripped: ThreadCursor = serde_json::from_value(json).unwrap();
    assert_eq!(round_tripped, cursor);
}

#[tokio::test]
async fn load_conversation_sanitizes_html_and_resolves_inline_cid_images() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    seed_account(&connection);
    LabelRepository::upsert(
        &connection,
        &Label {
            account_id: "account".into(),
            id: "INBOX".into(),
            name: "Inbox".into(),
            kind: "system".into(),
            color: None,
            message_count: 0,
            unread_count: 0,
        },
    )
    .unwrap();
    ThreadRepository::upsert(&connection, &thread("t1", 1, false)).unwrap();
    MessageRepository::write_full_state(
        &connection,
        &Message {
            account_id: "account".into(),
            id: "m1".into(),
            thread_id: "t1".into(),
            rfc_message_id: None,
            sender: "alice@example.com".into(),
            recipients: "me@example.com, cc@example.com".into(),
            subject: "Subject t1".into(),
            sent_at: 1,
            snippet: "hi".into(),
            html_body: Some(r#"<p>hi</p><img src="cid:img1"><script>alert(1)</script>"#.into()),
            plain_body: Some("hi".into()),
            has_attachments: false,
            is_unread: false,
            is_starred: false,
            history_id: 1,
        },
    )
    .unwrap();
    MessageRepository::set_label_membership(&connection, "account", "m1", "INBOX", true).unwrap();
    MessageRepository::replace_inline_parts(
        &connection,
        "account",
        "m1",
        &[InlinePart {
            content_id: "img1".into(),
            mime_type: "image/png".into(),
            bytes: vec![1, 2, 3],
        }],
    )
    .unwrap();
    drop(connection);
    let application = app();
    application.manage(storage);

    let conversation = load_conversation(application.state(), "account".into(), "t1".into())
        .await
        .unwrap();

    assert_eq!(conversation.subject, "Subject t1");
    assert_eq!(conversation.messages.len(), 1);
    let message = &conversation.messages[0];
    assert_eq!(message.label_ids, vec!["INBOX".to_owned()]);
    assert_eq!(
        message.recipients,
        vec!["me@example.com".to_owned(), "cc@example.com".to_owned()]
    );
    let html = message.html_body.as_deref().unwrap();
    assert!(!html.contains("<script>"), "sanitize must strip scripts");
    assert!(
        html.contains("data:image/png;base64,"),
        "cid: source must resolve to inline data"
    );
    assert!(!html.contains("cid:img1"));
}

#[tokio::test]
async fn trigger_sync_runs_initial_sync_and_read_sync_status_reflects_it() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let auth_service = AuthService::new(storage.clone());
    let account_id = {
        auth_service
            .save_account("me@example.com".into(), "refresh-token".into(), None)
            .await
            .unwrap();
        auth_service.accounts().await.unwrap()[0].id.clone()
    };

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "fresh-token", "token_type": "Bearer"
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "emailAddress": "me@example.com", "messagesTotal": 0, "threadsTotal": 0, "historyId": "1"
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"labels": []})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"messages": []})))
        .mount(&server)
        .await;
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    latentmail_lib::auth::save_refresh_token(&account_id, "refresh-token").unwrap();

    let sync_engine = engine(&storage);
    let application = app();
    application.manage(auth_service);
    application.manage(sync_engine);

    let status = trigger_sync(
        application.handle().clone(),
        application.state(),
        application.state(),
        account_id.clone(),
    )
    .await
    .unwrap();
    assert_eq!(status.state, SyncState::Idle);
    assert!(status.last_synced_at.is_some());

    let read_back = read_sync_status(application.state(), account_id)
        .await
        .unwrap();
    assert_eq!(read_back.state, SyncState::Idle);
    assert_eq!(read_back, status);

    let connection = storage.connection().unwrap();
    let account = AccountRepository::get(&connection, "me@example.com")
        .unwrap()
        .unwrap();
    assert_eq!(account.history_id, Some(1));
}

/// The read commands (`list_labels`, `list_threads`, `load_conversation`)
/// resolve `State<Storage>`, which no test that manages state by hand can
/// prove is wired: a missing `manage` only shows up at runtime as
/// "state not managed for field `storage`".
#[tokio::test]
async fn initialize_manages_the_storage_the_read_commands_resolve() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    // Redirects the OS per-user data directory at an isolated temp dir so the
    // test never touches the real machine, as in the other initialize tests.
    let home = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", home.path());
    std::env::set_var("APPDATA", home.path());
    std::env::set_var("XDG_DATA_HOME", home.path());

    let application = app();
    // `settings::initialize` restores window geometry, so it needs the main
    // window to exist.
    tauri::WebviewWindowBuilder::new(&application, "main", Default::default())
        .visible(false)
        .build()
        .unwrap();
    let handle = application.handle();
    latentmail_lib::settings::initialize(handle).unwrap();
    latentmail_lib::auth::initialize(handle).unwrap();

    latentmail_lib::sync::initialize(handle).unwrap();

    assert!(application.try_state::<Storage>().is_some());
}

/// Storage holds epoch seconds, but the frontend hands these straight to
/// `new Date(...)`, which reads milliseconds — the mismatch rendered every
/// row as January 1970.
#[tokio::test]
async fn thread_and_message_timestamps_cross_ipc_in_milliseconds() {
    let seconds = 1_755_000_000;
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    seed_account(&connection);
    LabelRepository::upsert(
        &connection,
        &Label {
            account_id: "account".into(),
            id: "INBOX".into(),
            name: "Inbox".into(),
            kind: "system".into(),
            color: None,
            message_count: 1,
            unread_count: 0,
        },
    )
    .unwrap();
    ThreadRepository::upsert(&connection, &thread("t1", seconds, false)).unwrap();
    MessageRepository::write_full_state(
        &connection,
        &Message {
            account_id: "account".into(),
            id: "m1".into(),
            thread_id: "t1".into(),
            rfc_message_id: None,
            sender: "alice@example.com".into(),
            recipients: "me@example.com".into(),
            subject: "Subject t1".into(),
            sent_at: seconds,
            snippet: "hi".into(),
            html_body: None,
            plain_body: Some("hi".into()),
            has_attachments: false,
            is_unread: false,
            is_starred: false,
            history_id: 1,
        },
    )
    .unwrap();
    MessageRepository::set_label_membership(&connection, "account", "m1", "INBOX", true).unwrap();
    drop(connection);
    let application = app();
    application.manage(storage);

    let page = list_threads(
        application.state(),
        "account".into(),
        Some("INBOX".into()),
        None,
        None,
    )
    .await
    .unwrap();
    let conversation = load_conversation(application.state(), "account".into(), "t1".into())
        .await
        .unwrap();

    assert_eq!(page.items[0].latest_at, seconds * 1000);
    assert_eq!(conversation.messages[0].sent_at, seconds * 1000);
    // The cursor still travels in the storage unit — it is compared against
    // the `latest_at` column, not turned into a Date.
    assert_eq!(page.next_cursor.map(|cursor| cursor.latest_at), None);
}
