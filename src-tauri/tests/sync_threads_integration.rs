
use std::sync::Arc;

use latentmail_lib::auth::AuthService;
use latentmail_lib::storage::{
    Account, AccountRepository, HtmlPresence, InlinePart, Label, LabelRepository, Message,
    MessageRepository, Storage, Thread, ThreadIdentity, ThreadRepository,
};
use latentmail_lib::sync::commands::{
    fetch_message_body, list_labels, list_threads, load_conversation, read_sync_status,
    trigger_sync,
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
        sender_identity: ThreadIdentity {
            display: "Alice".into(),
            address: Some("a@example.com".into()),
        },
        recipient_identity: None,
    }
}

fn labelled_message(
    connection: &rusqlite::Connection,
    id: &str,
    thread_id: &str,
    label_ids: &[&str],
) {
    MessageRepository::write_full_state(
        connection,
        &Message {
            account_id: "account".into(),
            id: id.into(),
            thread_id: thread_id.into(),
            rfc_message_id: None,
            sender: "alice@example.com".into(),
            recipients: "me@example.com".into(),
            subject: format!("Subject {thread_id}"),
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
    for label_id in label_ids {
        LabelRepository::ensure_placeholder(connection, "account", label_id).unwrap();
        MessageRepository::set_label_membership(connection, "account", id, label_id, true).unwrap();
    }
    ThreadRepository::recompute(connection, "account", thread_id).unwrap();
}

#[tokio::test]
async fn list_labels_counts_unread_threads_per_label() {
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
        },
    )
    .unwrap();
    labelled_message(&connection, "m1", "t1", &["INBOX", "UNREAD"]);
    labelled_message(&connection, "m2", "t2", &["INBOX", "UNREAD"]);
    labelled_message(&connection, "m3", "t3", &["INBOX"]);
    labelled_message(&connection, "m4", "t4", &["INBOX", "TRASH", "UNREAD"]);
    drop(connection);
    let application = app();
    application.manage(storage);

    let labels = list_labels(application.state(), "account".into())
        .await
        .unwrap();
    let inbox = labels.iter().find(|label| label.id == "INBOX").unwrap();
    assert_eq!(inbox.message_count, 5);
    assert_eq!(inbox.unread_count, 2);
    let trash = labels.iter().find(|label| label.id == "TRASH").unwrap();
    assert_eq!(trash.unread_count, 1);
}

#[tokio::test]
async fn list_labels_drops_unread_count_when_the_thread_is_read() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    seed_account(&connection);
    labelled_message(&connection, "m1", "t1", &["INBOX", "UNREAD"]);
    MessageRepository::set_label_membership(&connection, "account", "m1", "UNREAD", false).unwrap();
    ThreadRepository::recompute(&connection, "account", "t1").unwrap();
    drop(connection);
    let application = app();
    application.manage(storage);

    let labels = list_labels(application.state(), "account".into())
        .await
        .unwrap();
    let inbox = labels.iter().find(|label| label.id == "INBOX").unwrap();
    assert_eq!(inbox.unread_count, 0);
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
    LabelRepository::upsert(
        &connection,
        &Label {
            account_id: "account".into(),
            id: "Label_Project".into(),
            name: "Project".into(),
            kind: "user".into(),
            color: None,
            message_count: 2,
        },
    )
    .unwrap();
    let latest = Message {
        account_id: "account".into(),
        id: "m2".into(),
        thread_id: "t2".into(),
        rfc_message_id: None,
        sender: "alice@example.com".into(),
        recipients: "me@example.com".into(),
        subject: "Subject t2".into(),
        sent_at: 2,
        snippet: "latest snippet".into(),
        html_body: None,
        plain_body: None,
        has_attachments: false,
        is_unread: false,
        is_starred: false,
        history_id: 2,
        truncated_body: None,
        html_presence: HtmlPresence::Absent,
    };
    let older = Message {
        id: "m2-old".into(),
        sent_at: 1,
        snippet: "old snippet".into(),
        ..latest.clone()
    };
    for message in [older, latest] {
        MessageRepository::write_full_state(&connection, &message).unwrap();
        MessageRepository::set_label_membership(
            &connection,
            "account",
            &message.id,
            "Label_Project",
            true,
        )
        .unwrap();
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
    assert_eq!(first_page.items[1].snippet, "latest snippet");
    assert_eq!(first_page.items[1].label_indicators, ["Project"]);
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
            truncated_body: None,
            html_presence: HtmlPresence::Absent,
        },
    )
    .unwrap();
    MessageRepository::set_label_membership(&connection, "account", "m1", "INBOX", true).unwrap();
    MessageRepository::set_recipient_roles(
        &connection,
        "account",
        "m1",
        "me@example.com",
        "cc@example.com",
        "bcc@example.com",
        None,
    )
    .unwrap();
    MessageRepository::set_draft_id(&connection, "account", "m1", "draft-1").unwrap();
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

    let conversation = load_conversation(application.state(), "account".into(), "t1".into(), None)
        .await
        .unwrap();

    assert_eq!(conversation.subject, "Subject t1");
    assert_eq!(conversation.messages.len(), 1);
    let message = &conversation.messages[0];
    assert_eq!(message.label_ids, vec!["INBOX".to_owned()]);
    assert_eq!(message.to_recipients, ["me@example.com"]);
    assert_eq!(message.cc_recipients, ["cc@example.com"]);
    assert_eq!(message.bcc_recipients, ["bcc@example.com"]);
    assert_eq!(message.draft_id.as_deref(), Some("draft-1"));
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

    let home = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", home.path());
    std::env::set_var("APPDATA", home.path());
    std::env::set_var("XDG_DATA_HOME", home.path());

    let application = app();

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
            truncated_body: None,
            html_presence: HtmlPresence::Absent,
        },
    )
    .unwrap();
    MessageRepository::set_label_membership(&connection, "account", "m1", "INBOX", true).unwrap();
    ThreadRepository::recompute(&connection, "account", "t1").unwrap();
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
    let conversation = load_conversation(application.state(), "account".into(), "t1".into(), None)
        .await
        .unwrap();

    assert_eq!(page.items[0].latest_at, seconds * 1000);
    assert_eq!(conversation.messages[0].sent_at, seconds * 1000);

    assert_eq!(page.next_cursor.map(|cursor| cursor.latest_at), None);
}

#[tokio::test]
async fn fetch_message_body_hydrates_and_persists_an_unfetched_message_via_a_direct_call() {
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
        .and(path("/users/me/messages/m1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "m1", "threadId": "t1", "historyId": "2", "labelIds": ["INBOX"],
            "snippet": "hello", "internalDate": "0",
            "payload": {
                "mimeType": "text/html",
                "headers": [],
                "body": { "data": "aGVsbG8td29ybGQ" }
            }
        })))
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
    seed_account(&connection);
    LabelRepository::ensure_placeholder(&connection, "account", "INBOX").unwrap();
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
    assert_eq!(stored.html_body.as_deref(), Some("hello-world"));
    assert_eq!(stored.html_presence, HtmlPresence::Present);
}
