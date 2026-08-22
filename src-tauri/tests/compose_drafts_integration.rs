use std::sync::LazyLock;
use std::time::Duration;

use latentmail_lib::sync::{noop_event_sink, SyncEngine, WorkRegistry};
use latentmail_lib::{
    auth::AuthService,
    compose::{
        drafts::{self, DraftOperationMode, DraftOperationPayload, SaveCoalescer},
        staging::{StagedPart, Staging},
    },
    queue::{Lane, OperationKind, QueueEngine, QueueError, QueueOperation},
    storage::{
        Account, AccountRepository, ComposeDraftMetadata, ComposeDraftMetadataRepository,
        HtmlPresence, InlinePart, Message, MessageRepository, Operation, OperationRepository,
        Storage,
    },
};
use tauri::{
    ipc::{CallbackFn, InvokeBody},
    test::INVOKE_KEY,
    webview::InvokeRequest,
    Listener, Manager,
};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

static APP_ENV: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

fn draft_response(id: &str, message_id: &str, thread_id: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "message": {
            "id": message_id,
            "threadId": thread_id,
            "historyId": "1",
            "labelIds": ["DRAFT"],
            "payload": { "headers": [{"name": "Subject", "value": "Hello"}] }
        }
    })
}

#[tokio::test]
async fn discard_marks_queued_and_active_session_creates_for_cancellation() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    AccountRepository::upsert(
        &storage.connection().unwrap(),
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
    for (id, status) in [
        ("queued", "queued"),
        ("active", "active"),
        ("other", "queued"),
    ] {
        OperationRepository::upsert(
            &storage.connection().unwrap(),
            &Operation {
                id: id.into(),
                account_id: "account".into(),
                lane: "interactive".into(),
                kind: "draft".into(),
                entity_key: if id == "other" {
                    "other".into()
                } else {
                    "session".into()
                },
                payload: "{}".into(),
                status: status.into(),
                attempts: 0,
                next_attempt_at: None,
                error: None,
                created_at: 1,
                updated_at: 1,
            },
        )
        .unwrap();
    }
    storage
        .run(|connection| {
            OperationRepository::discard_session_creates(connection, "account", "session")
        })
        .await
        .unwrap();
    for id in ["queued", "active"] {
        let id = id.to_owned();
        assert_eq!(
            storage
                .run(move |connection| Ok::<_, rusqlite::Error>(
                    OperationRepository::get(connection, &id)?.unwrap().status
                ))
                .await
                .unwrap(),
            "discarded"
        );
    }
    assert_eq!(
        storage
            .run(|connection| Ok::<_, rusqlite::Error>(
                OperationRepository::get(connection, "other")?
                    .unwrap()
                    .status
            ))
            .await
            .unwrap(),
        "queued"
    );
}

fn base_payload(mode: DraftOperationMode, draft_id: Option<&str>) -> DraftOperationPayload {
    DraftOperationPayload {
        mode,
        draft_id: draft_id.map(str::to_owned),
        thread_id: None,
        from: "me@example.com".into(),
        to: vec!["them@example.com".into()],
        cc: Vec::new(),
        bcc: Vec::new(),
        subject: "Hello".into(),
        html: "<p>Hi</p>".into(),
        quote_html: None,
        in_reply_to: None,
        references: Vec::new(),
        metadata_mode: "new".into(),
        original_message_id: None,
        original_gmail_message_id: None,
        editable_body_fingerprint: None,
        quote_plain: None,
        coalescing_generation: 0,
    }
}

#[tokio::test]
async fn generated_ids_are_prefixed_and_coalescing_is_scoped_to_each_draft() {
    let first = drafts::generate_id("draft");
    let second = drafts::generate_id("draft");
    assert!(first.starts_with("draft-"));
    assert!(second.starts_with("draft-"));
    assert_ne!(first, second);

    let coalescer = SaveCoalescer::new();
    let first_generation = coalescer.schedule("draft:a").await;
    assert!(coalescer.is_current("draft:a", first_generation).await);
    let second_generation = coalescer.schedule("draft:a").await;
    assert!(!coalescer.is_current("draft:a", first_generation).await);
    assert!(coalescer.is_current("draft:a", second_generation).await);
    assert!(!coalescer.is_current("draft:b", second_generation).await);
    assert!(coalescer.draft_id("draft:a").await.is_none());
    coalescer
        .set_draft_id("draft:a", "gmail-draft".into())
        .await;
    assert_eq!(
        coalescer.draft_id("draft:a").await.as_deref(),
        Some("gmail-draft")
    );
}

#[tokio::test]
async fn admitting_a_draft_requires_all_staged_parts_to_exist() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let queue = QueueEngine::no_op();
    let staging = Staging::new(directory.path().join("staged"));
    let coalescer = SaveCoalescer::new();

    let error = drafts::admit(
        &queue,
        &storage,
        &staging,
        &coalescer,
        "operation".into(),
        "account".into(),
        "session".into(),
        base_payload(DraftOperationMode::Create, None),
        &[StagedPart {
            id: "missing".into(),
            filename: "missing.txt".into(),
            mime_type: "text/plain".into(),
            path: directory.path().join("missing.txt"),
            content_id: None,
            size: 0,
        }],
    )
    .await
    .unwrap_err();

    assert!(!error.is_empty());
}

fn invoke(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    tauri::test::get_ipc_response(
        webview,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|response| response.deserialize::<serde_json::Value>().unwrap())
}

#[tokio::test]
async fn compose_save_and_send_commands_persist_their_respective_durable_modes() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    AccountRepository::upsert(
        &storage.connection().unwrap(),
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
    let queue = QueueEngine::no_op();
    queue.pause();
    let app = latentmail_lib::ipc::register(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(storage.clone());
    app.manage(queue);
    app.manage(std::sync::Arc::new(Staging::new(
        directory.path().join("staged"),
    )));
    app.manage(std::sync::Arc::new(SaveCoalescer::new()));
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let request = |draft_id: Option<&str>| {
        serde_json::json!({
            "sessionId": "session", "accountId": "account", "draftId": draft_id,
            "from": "me@example.com", "to": ["them@example.com"], "cc": [], "bcc": [],
            "subject": "Subject", "html": "<p>Body</p>", "quoteHtml": null,
            "quotePlain": null, "mode": "new", "threadId": null, "inReplyTo": null,
            "references": [], "originalMessageId": null, "originalGmailMessageId": null,
            "attachments": []
        })
    };

    let created = invoke(
        &webview,
        "save_compose_draft",
        serde_json::json!({ "draft": request(None) }),
    )
    .unwrap();
    let updated = invoke(
        &webview,
        "save_compose_draft",
        serde_json::json!({ "draft": request(Some("d1")) }),
    )
    .unwrap();
    let sent = invoke(
        &webview,
        "send_compose_draft",
        serde_json::json!({ "draft": request(Some("d1")) }),
    )
    .unwrap();
    assert!(created["draftId"].is_null());
    assert_eq!(updated["draftId"], "d1");
    assert_eq!(sent["draftId"], "d1");

    let staged = invoke(
        &webview,
        "stage_attachment_from_bytes",
        serde_json::json!({
            "accountId": "account", "owner": "session", "filename": "inline.png",
            "mimeType": "image/png", "contentId": "inline-1", "bytes": [1, 2, 3]
        }),
    )
    .unwrap();
    assert_eq!(staged["size"], 3);
    let mut with_part = request(None);
    with_part["attachments"] = serde_json::json!([{
        "id": staged["id"],
        "filename": "inline.png",
        "mimeType": "image/png",
        "contentId": "inline-1",
    }]);
    assert!(invoke(
        &webview,
        "save_compose_draft",
        serde_json::json!({ "draft": with_part }),
    )
    .is_ok());
    let mut missing_part = request(None);
    missing_part["attachments"] = serde_json::json!([{
        "id": "never-staged",
        "filename": "gone.txt",
        "mimeType": "text/plain",
        "contentId": null,
    }]);
    assert!(invoke(
        &webview,
        "save_compose_draft",
        serde_json::json!({ "draft": missing_part }),
    )
    .is_err());
    invoke(
        &webview,
        "release_staged_attachment",
        serde_json::json!({ "accountId": "account", "owner": "session", "id": staged["id"] }),
    )
    .unwrap();

    for (result, expected_mode) in [(&created, "create"), (&updated, "update"), (&sent, "send")] {
        let operation_id = result["operationId"].as_str().unwrap().to_owned();
        let operation = storage
            .run(move |connection| {
                latentmail_lib::storage::OperationRepository::get(connection, &operation_id)
            })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&operation.payload).unwrap()["mode"],
            expected_mode
        );
    }
}

#[tokio::test]
async fn compose_and_mail_command_wrappers_dispatch_with_managed_test_state() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let app = latentmail_lib::ipc::register(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(AuthService::new(storage.clone()));
    app.manage(SyncEngine::new(
        storage.clone(),
        queue,
        registry,
        noop_event_sink(),
    ));
    app.manage(storage);
    app.manage(std::sync::Arc::new(Staging::new(
        directory.path().join("staged"),
    )));
    app.manage(std::sync::Arc::new(SaveCoalescer::new()));
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    for (command, body) in [
        ("list_labels", serde_json::json!({ "accountId": "account" })),
        (
            "lookup_contacts",
            serde_json::json!({ "accountId": "account", "query": "al" }),
        ),
        (
            "reply_context",
            serde_json::json!({ "accountId": "account", "messageId": "missing", "accountEmail": "me@example.com", "replyAll": false, "forward": false, "owner": "owner" }),
        ),
        (
            "stage_attachment_from_path",
            serde_json::json!({ "accountId": "account", "owner": "draft", "path": "/missing", "mimeType": "text/plain", "contentId": null }),
        ),
        (
            "list_threads",
            serde_json::json!({ "accountId": "account", "labelId": null, "cursor": null, "limit": null }),
        ),
        (
            "load_conversation",
            serde_json::json!({ "accountId": "account", "threadId": "missing" }),
        ),
        (
            "fetch_message_body",
            serde_json::json!({ "accountId": "account", "messageId": "missing" }),
        ),
        (
            "trigger_sync",
            serde_json::json!({ "accountId": "account" }),
        ),
        (
            "read_sync_status",
            serde_json::json!({ "accountId": "account" }),
        ),
        (
            "star_thread",
            serde_json::json!({ "accountId": "account", "threadId": "missing" }),
        ),
        (
            "unstar_thread",
            serde_json::json!({ "accountId": "account", "threadId": "missing" }),
        ),
        (
            "mark_thread_read",
            serde_json::json!({ "accountId": "account", "threadId": "missing" }),
        ),
        (
            "mark_thread_unread",
            serde_json::json!({ "accountId": "account", "threadId": "missing" }),
        ),
        (
            "mutate_threads",
            serde_json::json!({ "accountId": "account", "threadIds": ["missing"], "add": ["DRAFT"], "remove": [] }),
        ),
        (
            "mutate_messages",
            serde_json::json!({ "accountId": "account", "messageIds": ["missing"], "add": ["DRAFT"], "remove": [] }),
        ),
        (
            "delete_draft",
            serde_json::json!({ "accountId": "account", "messageId": "missing" }),
        ),
        (
            "create_label",
            serde_json::json!({ "accountId": "account", "name": "Label", "colorId": "invalid" }),
        ),
        (
            "rename_label",
            serde_json::json!({ "accountId": "account", "labelId": "missing", "name": "Label" }),
        ),
        (
            "recolor_label",
            serde_json::json!({ "accountId": "account", "labelId": "missing", "colorId": "invalid" }),
        ),
        (
            "delete_label",
            serde_json::json!({ "accountId": "account", "labelId": "missing" }),
        ),
        (
            "read_traversal_status",
            serde_json::json!({ "accountId": "account" }),
        ),
    ] {
        let _ = invoke(&webview, command, body);
    }

    for (command, body) in [
        (
            "create_label",
            serde_json::json!({ "accountId": "account", "name": "Label", "colorId": "invalid" }),
        ),
        (
            "rename_label",
            serde_json::json!({ "accountId": "account", "labelId": "missing", "name": "Label" }),
        ),
        (
            "recolor_label",
            serde_json::json!({ "accountId": "account", "labelId": "missing", "colorId": "invalid" }),
        ),
        (
            "delete_label",
            serde_json::json!({ "accountId": "account", "labelId": "missing" }),
        ),
        (
            "star_thread",
            serde_json::json!({ "accountId": "account", "threadId": "missing" }),
        ),
        (
            "unstar_thread",
            serde_json::json!({ "accountId": "account", "threadId": "missing" }),
        ),
        (
            "mark_thread_read",
            serde_json::json!({ "accountId": "account", "threadId": "missing" }),
        ),
        (
            "mark_thread_unread",
            serde_json::json!({ "accountId": "account", "threadId": "missing" }),
        ),
    ] {
        assert!(invoke(&webview, command, body).is_err(), "{command}");
    }
}

#[tokio::test]
async fn malformed_or_missing_draft_snapshots_fail_durably_before_gmail_is_contacted() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    AccountRepository::upsert(
        &storage.connection().unwrap(),
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
    let staging = std::sync::Arc::new(Staging::new(directory.path().join("staged")));
    let coalescer = std::sync::Arc::new(SaveCoalescer::new());
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(AuthService::new(storage.clone()));
    let queue = QueueEngine::new(
        250,
        250,
        drafts::build_executor(
            app.handle().clone(),
            storage.clone(),
            std::sync::Arc::clone(&staging),
            std::sync::Arc::clone(&coalescer),
            "http://not-contacted".into(),
        ),
    );
    queue.pause();

    for (id, key) in [
        ("bad-payload", "draft:bad"),
        ("missing-manifest", "draft:missing"),
        ("missing-token", "draft:token"),
        ("discarded", "draft:discarded"),
    ] {
        drafts::admit(
            &queue,
            &storage,
            &staging,
            &coalescer,
            id.into(),
            "account".into(),
            key.into(),
            base_payload(DraftOperationMode::Create, None),
            &[],
        )
        .await
        .unwrap();
    }
    storage
        .connection()
        .unwrap()
        .execute(
            "UPDATE operations SET payload='{bad json' WHERE id='bad-payload'",
            [],
        )
        .unwrap();
    staging.release_snapshot("missing-manifest").unwrap();
    storage
        .connection()
        .unwrap()
        .execute(
            "UPDATE operations SET status='discarded' WHERE id='discarded'",
            [],
        )
        .unwrap();
    queue
        .enqueue(QueueOperation {
            id: "missing-row".into(),
            account_id: "account".into(),
            lane: Lane::Interactive,
            kind: OperationKind::Draft,
            entity_key: "draft:missing-row".into(),
            cost: 0,
            attempts: 0,
            description: "test operation".into(),
        })
        .await
        .unwrap();
    let reported = std::sync::Arc::new(std::sync::Mutex::new(Vec::<serde_json::Value>::new()));
    let sink = std::sync::Arc::clone(&reported);
    app.handle().listen("compose://failed", move |event| {
        sink.lock()
            .unwrap()
            .push(serde_json::from_str(event.payload()).unwrap());
    });
    queue.resume();

    wait_for(|| {
        ["bad-payload", "missing-manifest", "missing-token"]
            .into_iter()
            .all(|id| {
                storage
                    .connection()
                    .unwrap()
                    .query_row("SELECT status FROM operations WHERE id=?1", [id], |row| {
                        row.get::<_, String>(0)
                    })
                    .unwrap()
                    == "failed"
            })
    })
    .await;
    wait_for(|| reported.lock().unwrap().len() == 3).await;
    wait_for(|| staging.snapshot_manifest("discarded").is_err()).await;
    for event in reported.lock().unwrap().iter() {
        assert_eq!(event["accountId"], "account");
        assert_eq!(event["kind"], "draft");
        assert!(event["sessionId"].as_str().unwrap().starts_with("draft:"));
        assert!(!event["error"].as_str().unwrap().is_empty());
    }
}

fn boot(server: &MockServer) -> (tauri::App<tauri::test::MockRuntime>, tempfile::TempDir) {
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
    (application, home)
}

fn boot_with_dead_gmail_base(
    server: &MockServer,
) -> (tauri::App<tauri::test::MockRuntime>, tempfile::TempDir) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let dead_port = listener.local_addr().unwrap().port();
    drop(listener);

    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var(
        "LATENTMAIL_GMAIL_BASE_URL",
        format!("http://127.0.0.1:{dead_port}"),
    );
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
    (application, home)
}

fn mock_token(server: &MockServer) -> Mock {
    let _ = server;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "fresh-access-token",
            "token_type": "Bearer",
        })))
}

async fn wait_for<F: Fn() -> bool>(condition: F) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
    while !condition() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "condition never became true within the test budget"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn create_recovers_from_a_simulated_interruption_using_only_the_persisted_manifest() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    mock_token(&server).mount(&server).await;
    Mock::given(method("POST"))
        .and(path("/upload/gmail/v1/users/me/drafts"))
        .respond_with(ResponseTemplate::new(200).set_body_json(draft_response("d1", "m1", "t1")))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/drafts/d1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(draft_response("d1", "m1", "t1")))
        .mount(&server)
        .await;
    let (app, _home) = boot(&server);
    let handle = app.handle();
    let directory = app.path().app_data_dir().unwrap();
    let storage = Storage::open(directory.join("latentmail.sqlite")).unwrap();
    let staging = handle.state::<std::sync::Arc<Staging>>().inner().clone();
    MessageRepository::write_full_state(
        &storage.connection().unwrap(),
        &Message {
            account_id: "account".into(),
            id: "original".into(),
            thread_id: "thread-original".into(),
            rfc_message_id: None,
            sender: "sender@example.com".into(),
            recipients: "me@example.com".into(),
            subject: "Original".into(),
            sent_at: 1,
            snippet: "original".into(),
            html_body: Some("<p>Original</p>".into()),
            plain_body: None,
            has_attachments: false,
            is_unread: false,
            is_starred: false,
            history_id: 1,
            truncated_body: None,
            html_presence: HtmlPresence::Present,
        },
    )
    .unwrap();

    MessageRepository::replace_inline_parts(
        &storage.connection().unwrap(),
        "account",
        "original",
        &[InlinePart {
            content_id: "logo".into(),
            mime_type: "image/png".into(),
            bytes: vec![1, 2, 3],
        }],
    )
    .unwrap();
    let source = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(source.path(), b"attachment bytes").unwrap();
    let part = staging
        .stage_path(
            "account",
            "local-session",
            source.path(),
            "part-1",
            "text/plain".into(),
            None,
        )
        .unwrap();

    staging.snapshot("op-create", &[part]).unwrap();
    std::fs::remove_file(source.path()).ok();
    let coalescer = handle
        .state::<std::sync::Arc<SaveCoalescer>>()
        .inner()
        .clone();
    let generation = coalescer.schedule("draft:local-session").await;
    let mut payload = base_payload(DraftOperationMode::Create, None);
    payload.original_message_id = Some("original".into());
    payload.coalescing_generation = generation;
    let payload_json = serde_json::to_string(&payload).unwrap();
    storage
        .run(move |connection| {
            latentmail_lib::storage::OperationRepository::upsert(
                connection,
                &latentmail_lib::storage::Operation {
                    id: "op-create".into(),
                    account_id: "account".into(),
                    lane: "interactive".into(),
                    kind: "draft".into(),
                    entity_key: "draft:local-session".into(),
                    payload: payload_json,
                    status: "queued".into(),
                    attempts: 0,
                    next_attempt_at: None,
                    error: None,
                    created_at: 1,
                    updated_at: 1,
                },
            )
        })
        .await
        .unwrap();

    let queue = handle
        .state::<std::sync::Arc<QueueEngine>>()
        .inner()
        .clone();
    let (recovered, uncertain) = storage
        .run(latentmail_lib::queue::recover_durable_operations)
        .await
        .unwrap();
    assert!(uncertain.is_empty());
    assert_eq!(recovered.len(), 1);
    for operation in &recovered {
        let queue_operation = latentmail_lib::queue::recovered_queue_operation(operation).unwrap();
        queue.enqueue(queue_operation).await.unwrap();
    }

    wait_for(|| queue.summary().pending == 0 && queue.summary().active == 0).await;

    let stored = storage
        .run(|connection| MessageRepository::get(connection, "account", "m1"))
        .await
        .unwrap();
    assert!(
        stored.is_some(),
        "recovered create must materialize the resulting message"
    );
    let metadata = storage
        .run(|connection| ComposeDraftMetadataRepository::get(connection, "account", "d1"))
        .await
        .unwrap();
    assert!(metadata.is_some());
}

#[tokio::test]
async fn compose_hydration_restores_a_remote_draft_and_empty_discard_is_a_no_op() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    mock_token(&server).mount(&server).await;
    let mut hydrated_draft = draft_response("d1", "m1", "t1");
    hydrated_draft["message"]["payload"] = serde_json::json!({
        "mimeType": "text/html",
        "headers": [
            {"name": "Subject", "value": "Hello"},
            {"name": "To", "value": "one@example.com, two@example.com"},
            {"name": "Cc", "value": "copy@example.com"}
        ],
        "body": {"data": "PHA+ZWRpdGFibGU8L3A+PHA+cXVvdGU8L3A+"},
        "parts": [{
            "mimeType": "text/plain",
            "filename": "notes.txt",
            "body": {"attachmentId": "a1"}
        }]
    });
    Mock::given(method("GET"))
        .and(path("/users/me/drafts/d1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(hydrated_draft))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1/attachments/a1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({ "data": "bm90ZXM" })),
        )
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/users/me/drafts/d1"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    AccountRepository::upsert(
        &storage.connection().unwrap(),
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
    ComposeDraftMetadataRepository::upsert(
        &storage.connection().unwrap(),
        &ComposeDraftMetadata {
            account_id: "account".into(),
            draft_id: "d1".into(),
            mode: "reply".into(),
            original_message_id: Some("original".into()),
            original_gmail_message_id: Some("gmail-original".into()),
            target_thread_id: Some("thread-original".into()),
            in_reply_to: Some("<original@example.com>".into()),
            rfc_references: Some("<one> <two>".into()),
            boundary_version: 1,
            editable_body_fingerprint: Some("stale".into()),
            quote_html: Some("<p>quote</p>".into()),
            quote_plain: Some("quote".into()),
        },
    )
    .unwrap();
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    latentmail_lib::auth::save_refresh_token("account", "refresh-token").unwrap();
    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let app = latentmail_lib::ipc::register(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(AuthService::new(storage.clone()));
    app.manage(SyncEngine::new(
        storage.clone(),
        queue,
        registry,
        noop_event_sink(),
    ));
    app.manage(storage);
    app.manage(std::sync::Arc::new(Staging::new(
        directory.path().join("staged"),
    )));
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    assert!(
        latentmail_lib::sync::commands::list_labels(app.state(), "account".into())
            .await
            .unwrap()
            .is_empty()
    );
    assert!(latentmail_lib::sync::commands::lookup_contacts(
        app.state(),
        "account".into(),
        "x".into(),
    )
    .await
    .unwrap()
    .is_empty());
    assert!(latentmail_lib::sync::commands::list_threads(
        app.state(),
        "account".into(),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap()
    .items
    .is_empty());
    assert!(latentmail_lib::sync::commands::load_conversation(
        app.state(),
        "account".into(),
        "missing".into(),
        None,
        None,
    )
    .await
    .unwrap()
    .messages
    .is_empty());
    assert_eq!(
        serde_json::to_value(
            latentmail_lib::sync::commands::read_traversal_status(app.state(), "account".into(),)
                .await
                .unwrap()
        )
        .unwrap()["accountId"],
        "account"
    );
    assert!(invoke(
        &webview,
        "mutate_messages",
        serde_json::json!({
            "accountId": "account",
            "messageIds": ["missing"],
            "add": ["DRAFT"],
            "remove": []
        }),
    )
    .is_err());
    assert!(invoke(
        &webview,
        "create_label",
        serde_json::json!({
            "accountId": "account",
            "name": "Label",
            "colorId": "not-a-colour"
        }),
    )
    .is_err());
    assert!(invoke(
        &webview,
        "recolor_label",
        serde_json::json!({
            "accountId": "account",
            "labelId": "Label_1",
            "colorId": "not-a-colour"
        }),
    )
    .is_err());

    let hydrated = invoke(
        &webview,
        "hydrate_compose_draft",
        serde_json::json!({ "accountId": "account", "draftId": "d1" }),
    )
    .unwrap();
    assert_eq!(hydrated["draftId"], "d1");
    assert_eq!(hydrated["mode"], "draft");
    assert_eq!(hydrated["attachments"][0]["filename"], "notes.txt");
    assert!(ComposeDraftMetadataRepository::get(
        &app.state::<Storage>().connection().unwrap(),
        "account",
        "d1",
    )
    .unwrap()
    .is_none());
    ComposeDraftMetadataRepository::upsert(
        &app.state::<Storage>().connection().unwrap(),
        &ComposeDraftMetadata {
            account_id: "account".into(),
            draft_id: "d1".into(),
            mode: "reply".into(),
            original_message_id: Some("original".into()),
            original_gmail_message_id: Some("gmail-original".into()),
            target_thread_id: Some("thread-original".into()),
            in_reply_to: Some("<original@example.com>".into()),
            rfc_references: Some("<one> <two>".into()),
            boundary_version: 1,
            editable_body_fingerprint: Some(String::new()),
            quote_html: Some(String::new()),
            quote_plain: Some("quote".into()),
        },
    )
    .unwrap();
    let restored = invoke(
        &webview,
        "hydrate_compose_draft",
        serde_json::json!({ "accountId": "account", "draftId": "d1" }),
    )
    .unwrap();
    assert_eq!(restored["html"], "");
    assert_eq!(restored["quoteHtml"], "");
    assert_eq!(
        restored["references"],
        serde_json::json!(["<one>", "<two>"])
    );

    invoke(
        &webview,
        "discard_compose_draft",
        serde_json::json!({ "accountId": "account", "draftId": null, "sessionId": "session" }),
    )
    .unwrap();
    invoke(
        &webview,
        "discard_compose_draft",
        serde_json::json!({ "accountId": "account", "draftId": "d1", "sessionId": "session" }),
    )
    .unwrap();
}

#[tokio::test]
async fn hydrate_stages_a_draft_attachment_that_carries_its_bytes_inline() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    mock_token(&server).mount(&server).await;
    let mut hydrated_draft = draft_response("d1", "m1", "t1");
    hydrated_draft["message"]["payload"] = serde_json::json!({
        "mimeType": "multipart/mixed",
        "headers": [{"name": "Subject", "value": "Hello"}],
        "parts": [
            { "mimeType": "text/plain", "body": { "data": "aGVsbG8" } },
            {
                "mimeType": "image/jpeg",
                "filename": "inline.jpg",
                "body": { "data": "cGhvdG8" }
            }
        ]
    });
    Mock::given(method("GET"))
        .and(path("/users/me/drafts/d1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(hydrated_draft))
        .mount(&server)
        .await;

    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    AccountRepository::upsert(
        &storage.connection().unwrap(),
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
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    latentmail_lib::auth::save_refresh_token("account", "refresh-token").unwrap();
    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let app = latentmail_lib::ipc::register(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(AuthService::new(storage.clone()));
    app.manage(SyncEngine::new(
        storage.clone(),
        queue,
        registry,
        noop_event_sink(),
    ));
    app.manage(storage);
    app.manage(std::sync::Arc::new(Staging::new(
        directory.path().join("staged"),
    )));
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let hydrated = invoke(
        &webview,
        "hydrate_compose_draft",
        serde_json::json!({ "accountId": "account", "draftId": "d1" }),
    )
    .unwrap();
    assert_eq!(hydrated["attachments"][0]["filename"], "inline.jpg");
    assert_eq!(hydrated["attachments"][0]["size"], "photo".len() as u64);
}

#[tokio::test]
async fn first_create_stably_promotes_later_session_save_to_update_and_retains_parts() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    mock_token(&server).mount(&server).await;
    Mock::given(method("POST"))
        .and(path("/upload/gmail/v1/users/me/drafts"))
        .respond_with(ResponseTemplate::new(200).set_body_json(draft_response("d1", "m1", "t1")))
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path("/upload/gmail/v1/users/me/drafts/d1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(draft_response("d1", "m2", "t1")))
        .mount(&server)
        .await;
    let hydrate_calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    Mock::given(method("GET"))
        .and(path("/gmail/v1/users/me/drafts/d1"))
        .respond_with(move |_: &wiremock::Request| {
            let call = hydrate_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let message_id = if call == 0 { "m1" } else { "m2" };
            ResponseTemplate::new(200).set_body_json(draft_response("d1", message_id, "t1"))
        })
        .mount(&server)
        .await;

    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    AccountRepository::upsert(
        &storage.connection().unwrap(),
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
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    latentmail_lib::auth::save_refresh_token("account", "stored-refresh-token").unwrap();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let staging = std::sync::Arc::new(Staging::new(directory.path().join("staged")));
    let coalescer = std::sync::Arc::new(SaveCoalescer::new());
    let queue = QueueEngine::new(
        250,
        250,
        drafts::build_executor(
            app.handle().clone(),
            storage.clone(),
            std::sync::Arc::clone(&staging),
            std::sync::Arc::clone(&coalescer),
            format!("{}/gmail/v1", server.uri()),
        ),
    );
    app.manage(AuthService::new(storage.clone()));

    let source = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(source.path(), b"canonical bytes").unwrap();
    let part = staging
        .stage_path(
            "account",
            "local-session",
            source.path(),
            "part-1",
            "text/plain".into(),
            None,
        )
        .unwrap();

    drafts::admit(
        &queue,
        &storage,
        &staging,
        &coalescer,
        "op-1".into(),
        "account".into(),
        "draft:local-session".into(),
        base_payload(DraftOperationMode::Create, None),
        std::slice::from_ref(&part),
    )
    .await
    .unwrap();
    wait_for(|| queue.summary().pending == 0 && queue.summary().active == 0).await;
    let first = storage
        .run(|connection| OperationRepository::get(connection, "op-1"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first.status, "done", "{first:?}");
    assert!(
        MessageRepository::get(&storage.connection().unwrap(), "account", "m1")
            .unwrap()
            .is_some()
    );
    assert!(
        staging.snapshot_manifest("op-1").is_err(),
        "a completed create removes its own snapshot"
    );
    assert!(part.path.exists(), "canonical draft-owned data survives");

    drafts::admit(
        &queue,
        &storage,
        &staging,
        &coalescer,
        "op-coalesced-create".into(),
        "account".into(),
        "draft:local-session".into(),
        base_payload(DraftOperationMode::Create, None),
        std::slice::from_ref(&part),
    )
    .await
    .unwrap();
    wait_for(|| queue.summary().pending == 0 && queue.summary().active == 0).await;
    assert_eq!(
        storage
            .run(|connection| OperationRepository::get(connection, "op-coalesced-create"))
            .await
            .unwrap()
            .unwrap()
            .status,
        "done"
    );

    for (op_id, message_id) in [("op-2", "m2"), ("op-3", "m2")] {
        drafts::admit(
            &queue,
            &storage,
            &staging,
            &coalescer,
            op_id.into(),
            "account".into(),
            "draft:d1".into(),
            base_payload(DraftOperationMode::Update, Some("d1")),
            std::slice::from_ref(&part),
        )
        .await
        .unwrap();
        wait_for(|| queue.summary().pending == 0 && queue.summary().active == 0).await;
        assert!(
            MessageRepository::get(&storage.connection().unwrap(), "account", message_id)
                .unwrap()
                .is_some(),
            "operation {op_id} must materialize {message_id}"
        );
        assert!(staging.snapshot_manifest(op_id).is_err());
    }
    assert!(part.path.exists(), "canonical parts survive both updates");
    let requests = server.received_requests().await.unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.method.as_str() == "POST"
                && request.url.path() == "/upload/gmail/v1/users/me/drafts")
            .count(),
        1,
        "the overlapping session save must not create a second Gmail draft"
    );
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.method.as_str() == "PUT"
                && request.url.path() == "/upload/gmail/v1/users/me/drafts/d1")
            .count(),
        3
    );
}

#[tokio::test]
async fn send_consumes_the_draft_and_releases_canonical_staging() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    mock_token(&server).mount(&server).await;

    let call_order = std::sync::Arc::new(std::sync::Mutex::new(Vec::<&'static str>::new()));
    let update_order = std::sync::Arc::clone(&call_order);
    Mock::given(method("PUT"))
        .and(path("/upload/gmail/v1/users/me/drafts/d1"))
        .respond_with(move |_: &wiremock::Request| {
            update_order.lock().unwrap().push("update");
            ResponseTemplate::new(200).set_body_json(draft_response("d1", "m-updated", "t1"))
        })
        .mount(&server)
        .await;
    let send_order = std::sync::Arc::clone(&call_order);
    let sends = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let sent_count = std::sync::Arc::clone(&sends);
    Mock::given(method("POST"))
        .and(path("/users/me/drafts/send"))
        .respond_with(move |_: &wiremock::Request| {
            send_order.lock().unwrap().push("send");
            let message_id = if sent_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                "sent-1"
            } else {
                "sent-2"
            };
            ResponseTemplate::new(200)
                .set_body_json(draft_response("ignored", message_id, "t1")["message"].clone())
        })
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/upload/gmail/v1/users/me/drafts"))
        .respond_with(ResponseTemplate::new(200).set_body_json(draft_response("d2", "m2", "t2")))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/sent-1"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(draft_response("ignored", "sent-1", "t1")["message"].clone()),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/sent-2"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(draft_response("ignored", "sent-2", "t2")["message"].clone()),
        )
        .mount(&server)
        .await;

    let (app, _home) = boot(&server);
    let handle = app.handle();
    let directory = app.path().app_data_dir().unwrap();
    let storage = Storage::open(directory.join("latentmail.sqlite")).unwrap();
    let staging = handle.state::<std::sync::Arc<Staging>>().inner().clone();
    let coalescer = handle
        .state::<std::sync::Arc<SaveCoalescer>>()
        .inner()
        .clone();
    let queue = handle
        .state::<std::sync::Arc<QueueEngine>>()
        .inner()
        .clone();

    let source = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(source.path(), b"final bytes").unwrap();
    let part = staging
        .stage_path(
            "account",
            "d1",
            source.path(),
            "part-1",
            "text/plain".into(),
            None,
        )
        .unwrap();

    drafts::admit(
        &queue,
        &storage,
        &staging,
        &coalescer,
        "op-send".into(),
        "account".into(),
        "draft:d1".into(),
        base_payload(DraftOperationMode::Send, Some("d1")),
        std::slice::from_ref(&part),
    )
    .await
    .unwrap();
    wait_for(|| queue.summary().pending == 0 && queue.summary().active == 0).await;

    assert!(
        MessageRepository::get(&storage.connection().unwrap(), "account", "sent-1")
            .unwrap()
            .is_some()
    );
    assert!(
        ComposeDraftMetadataRepository::get(&storage.connection().unwrap(), "account", "d1")
            .unwrap()
            .is_none(),
        "a confirmed send removes compose-draft metadata for the consumed draft"
    );
    assert!(
        !part.path.exists(),
        "a confirmed send releases canonical staging"
    );
    assert_eq!(
        *call_order.lock().unwrap(),
        vec!["update", "send"],
        "send must upload the current assembled document to the existing draft \
         before promoting it — never promote a stale draft"
    );

    let first_click_part = staging
        .stage_path(
            "account",
            "session-2",
            source.path(),
            "part-2",
            "text/plain".into(),
            None,
        )
        .unwrap();
    drafts::admit(
        &queue,
        &storage,
        &staging,
        &coalescer,
        "op-first-send".into(),
        "account".into(),
        "session-2".into(),
        base_payload(DraftOperationMode::Send, None),
        std::slice::from_ref(&first_click_part),
    )
    .await
    .unwrap();
    wait_for(|| queue.summary().pending == 0 && queue.summary().active == 0).await;
    assert!(
        MessageRepository::get(&storage.connection().unwrap(), "account", "sent-2")
            .unwrap()
            .is_some()
    );
    assert!(!first_click_part.path.exists());
}

#[tokio::test]
async fn discard_racing_an_active_create_deletes_the_returned_draft() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    mock_token(&server).mount(&server).await;
    let (app, _home) = boot(&server);
    let handle = app.handle();
    let directory = app.path().app_data_dir().unwrap();
    let storage = Storage::open(directory.join("latentmail.sqlite")).unwrap();
    let staging = handle.state::<std::sync::Arc<Staging>>().inner().clone();
    let coalescer = handle
        .state::<std::sync::Arc<SaveCoalescer>>()
        .inner()
        .clone();
    let queue = handle
        .state::<std::sync::Arc<QueueEngine>>()
        .inner()
        .clone();

    let storage_for_create = storage.clone();
    Mock::given(method("POST"))
        .and(path("/upload/gmail/v1/users/me/drafts"))
        .respond_with(move |_: &wiremock::Request| {
            storage_for_create
                .connection()
                .unwrap()
                .execute(
                    "UPDATE operations SET status='discarded' WHERE id='op-race'",
                    [],
                )
                .unwrap();
            ResponseTemplate::new(200).set_body_json(draft_response("d1", "m1", "t1"))
        })
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/drafts/d1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(draft_response("d1", "m1", "t1")))
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/gmail/v1/users/me/drafts/d1"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    drafts::admit(
        &queue,
        &storage,
        &staging,
        &coalescer,
        "op-race".into(),
        "account".into(),
        "session-race".into(),
        base_payload(DraftOperationMode::Create, None),
        &[],
    )
    .await
    .unwrap();
    wait_for(|| queue.summary().pending == 0 && queue.summary().active == 0).await;

    assert!(
        MessageRepository::get(&storage.connection().unwrap(), "account", "m1")
            .unwrap()
            .is_none()
    );
    assert!(staging.snapshot_manifest("op-race").is_err());
}

#[tokio::test]
async fn a_save_superseded_before_it_runs_is_coalesced_rather_than_uploaded() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    mock_token(&server).mount(&server).await;
    let (app, _home) = boot(&server);
    let handle = app.handle();
    let directory = app.path().app_data_dir().unwrap();
    let storage = Storage::open(directory.join("latentmail.sqlite")).unwrap();
    let staging = handle.state::<std::sync::Arc<Staging>>().inner().clone();
    let coalescer = handle
        .state::<std::sync::Arc<SaveCoalescer>>()
        .inner()
        .clone();
    let queue = handle
        .state::<std::sync::Arc<QueueEngine>>()
        .inner()
        .clone();

    queue.pause();
    drafts::admit(
        &queue,
        &storage,
        &staging,
        &coalescer,
        "op-stale".into(),
        "account".into(),
        "draft:local-session".into(),
        base_payload(DraftOperationMode::Create, None),
        &[],
    )
    .await
    .unwrap();
    Mock::given(method("POST"))
        .and(path("/upload/gmail/v1/users/me/drafts"))
        .respond_with(ResponseTemplate::new(200).set_body_json(draft_response("d1", "m1", "t1")))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/drafts/d1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(draft_response("d1", "m1", "t1")))
        .mount(&server)
        .await;
    drafts::admit(
        &queue,
        &storage,
        &staging,
        &coalescer,
        "op-fresh".into(),
        "account".into(),
        "draft:local-session".into(),
        base_payload(DraftOperationMode::Create, None),
        &[],
    )
    .await
    .unwrap();
    queue.resume();

    wait_for(|| queue.summary().pending == 0 && queue.summary().active == 0).await;

    let stale = storage
        .run(|connection| latentmail_lib::storage::OperationRepository::get(connection, "op-stale"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stale.status, "superseded");
    let fresh = storage
        .run(|connection| latentmail_lib::storage::OperationRepository::get(connection, "op-fresh"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(fresh.status, "done");
}

#[tokio::test]
async fn delete_reuses_the_existing_endpoint_and_removes_local_state() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    Mock::given(method("DELETE"))
        .and(path("/gmail/v1/users/me/drafts/d1"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;
    let client = latentmail_lib::gmail::GmailClient::with_base_url(
        "token",
        format!("{}/gmail/v1", server.uri()),
    );
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
    latentmail_lib::storage::MessageRepository::write_full_state(
        &connection,
        &latentmail_lib::storage::Message {
            account_id: "account".into(),
            id: "local-1".into(),
            thread_id: "t1".into(),
            rfc_message_id: None,
            sender: "me@example.com".into(),
            recipients: "them@example.com".into(),
            subject: "Draft".into(),
            sent_at: 1,
            snippet: String::new(),
            html_body: None,
            plain_body: None,
            has_attachments: false,
            is_unread: false,
            is_starred: false,
            history_id: 1,
            truncated_body: None,
            html_presence: latentmail_lib::storage::HtmlPresence::Present,
        },
    )
    .unwrap();
    latentmail_lib::storage::MessageRepository::set_draft_id(
        &connection,
        "account",
        "local-1",
        "d1",
    )
    .unwrap();
    ComposeDraftMetadataRepository::upsert(
        &connection,
        &latentmail_lib::storage::ComposeDraftMetadata {
            account_id: "account".into(),
            draft_id: "d1".into(),
            mode: "new".into(),
            original_message_id: None,
            original_gmail_message_id: None,
            target_thread_id: None,
            in_reply_to: None,
            rfc_references: None,
            boundary_version: 1,
            editable_body_fingerprint: None,
            quote_html: None,
            quote_plain: None,
        },
    )
    .unwrap();
    drop(connection);

    drafts::delete(&client, &storage, "account", "d1")
        .await
        .unwrap();

    let connection = storage.connection().unwrap();
    assert!(MessageRepository::get(&connection, "account", "local-1")
        .unwrap()
        .is_none());
    assert!(
        ComposeDraftMetadataRepository::get(&connection, "account", "d1")
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn hydrate_fetches_the_full_gmail_draft() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/gmail/v1/users/me/drafts/d1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(draft_response("d1", "m1", "t1")))
        .mount(&server)
        .await;
    let client = latentmail_lib::gmail::GmailClient::with_base_url(
        "token",
        format!("{}/gmail/v1", server.uri()),
    );
    let draft = drafts::hydrate(&client, "d1").await.unwrap();
    assert_eq!(draft.id, "d1");
    assert_eq!(draft.message.id, "m1");
}

#[tokio::test]
async fn a_retryable_gmail_failure_is_reported_as_failed_rather_than_silently_stuck() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    AccountRepository::upsert(
        &storage.connection().unwrap(),
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
    let executor_storage = storage.clone();
    let queue = QueueEngine::new(
        250,
        250,
        std::sync::Arc::new(move |operation| {
            let storage = executor_storage.clone();
            Box::pin(async move {
                storage
                    .run(move |connection| {
                        latentmail_lib::storage::OperationRepository::mark_terminal(
                            connection,
                            &operation.id,
                            "failed",
                            Some("Gmail returned HTTP 500"),
                        )
                    })
                    .await
                    .unwrap();
                Err(QueueError::Http(500))
            })
        }),
    );
    latentmail_lib::queue::admit_durable(
        &queue,
        &storage,
        QueueOperation {
            id: "op-failing".into(),
            account_id: "account".into(),
            lane: Lane::Interactive,
            kind: OperationKind::Draft,
            entity_key: "draft:local-session".into(),
            cost: 0,
            attempts: 9,
            description: "test operation".into(),
        },
        serde_json::json!({}).to_string(),
    )
    .await
    .unwrap();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let operation = storage
            .run(|connection| {
                latentmail_lib::storage::OperationRepository::get(connection, "op-failing")
            })
            .await
            .unwrap()
            .unwrap();
        if operation.status == "failed" {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "operation never reached a terminal failed state"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn a_gmail_server_error_during_create_is_classified_as_retryable_and_recorded() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    mock_token(&server).mount(&server).await;
    Mock::given(method("POST"))
        .and(path("/upload/gmail/v1/users/me/drafts"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    let (app, _home) = boot(&server);
    let handle = app.handle();
    let directory = app.path().app_data_dir().unwrap();
    let storage = Storage::open(directory.join("latentmail.sqlite")).unwrap();
    let staging = handle.state::<std::sync::Arc<Staging>>().inner().clone();
    staging.snapshot("op-gmail-500", &[]).unwrap();

    let coalescer = handle
        .state::<std::sync::Arc<SaveCoalescer>>()
        .inner()
        .clone();
    let generation = coalescer.schedule("draft:failing-session").await;
    let mut payload = base_payload(DraftOperationMode::Create, None);
    payload.coalescing_generation = generation;

    let queue = handle
        .state::<std::sync::Arc<QueueEngine>>()
        .inner()
        .clone();
    latentmail_lib::queue::admit_durable(
        &queue,
        &storage,
        QueueOperation {
            id: "op-gmail-500".into(),
            account_id: "account".into(),
            lane: Lane::Interactive,
            kind: OperationKind::Draft,
            entity_key: "draft:failing-session".into(),
            cost: 0,
            attempts: 9,
            description: "test operation".into(),
        },
        serde_json::to_string(&payload).unwrap(),
    )
    .await
    .unwrap();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let operation = storage
            .run(|connection| OperationRepository::get(connection, "op-gmail-500"))
            .await
            .unwrap()
            .unwrap();
        if operation.status == "failed" {
            assert_eq!(
                operation.error.as_deref(),
                Some("Gmail request failed with status 500")
            );
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "operation never reached a terminal failed state"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn a_connection_refused_during_create_is_classified_as_a_network_error() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    mock_token(&server).mount(&server).await;
    let (app, _home) = boot_with_dead_gmail_base(&server);
    let handle = app.handle();
    let directory = app.path().app_data_dir().unwrap();
    let storage = Storage::open(directory.join("latentmail.sqlite")).unwrap();
    let staging = handle.state::<std::sync::Arc<Staging>>().inner().clone();
    staging.snapshot("op-gmail-network", &[]).unwrap();

    let coalescer = handle
        .state::<std::sync::Arc<SaveCoalescer>>()
        .inner()
        .clone();
    let generation = coalescer.schedule("draft:network-failing-session").await;
    let mut payload = base_payload(DraftOperationMode::Create, None);
    payload.coalescing_generation = generation;

    let queue = handle
        .state::<std::sync::Arc<QueueEngine>>()
        .inner()
        .clone();
    latentmail_lib::queue::admit_durable(
        &queue,
        &storage,
        QueueOperation {
            id: "op-gmail-network".into(),
            account_id: "account".into(),
            lane: Lane::Interactive,
            kind: OperationKind::Draft,
            entity_key: "draft:network-failing-session".into(),
            cost: 0,
            attempts: 9,
            description: "test operation".into(),
        },
        serde_json::to_string(&payload).unwrap(),
    )
    .await
    .unwrap();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let operation = storage
            .run(|connection| OperationRepository::get(connection, "op-gmail-network"))
            .await
            .unwrap()
            .unwrap();
        if operation.status == "failed" {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "operation never reached a terminal failed state"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn a_broken_metadata_table_fails_the_operation_after_a_successful_gmail_exchange() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    mock_token(&server).mount(&server).await;
    Mock::given(method("POST"))
        .and(path("/upload/gmail/v1/users/me/drafts"))
        .respond_with(ResponseTemplate::new(200).set_body_json(draft_response(
            "d-meta-fail",
            "m-meta-fail",
            "t-meta-fail",
        )))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/drafts/d-meta-fail"))
        .respond_with(ResponseTemplate::new(200).set_body_json(draft_response(
            "d-meta-fail",
            "m-meta-fail",
            "t-meta-fail",
        )))
        .mount(&server)
        .await;
    let (app, _home) = boot(&server);
    let handle = app.handle();
    let directory = app.path().app_data_dir().unwrap();
    let storage = Storage::open(directory.join("latentmail.sqlite")).unwrap();
    let staging = handle.state::<std::sync::Arc<Staging>>().inner().clone();
    staging.snapshot("op-meta-fail", &[]).unwrap();

    {
        let connection = storage.connection().unwrap();
        connection
            .execute("DROP TABLE compose_draft_metadata", [])
            .unwrap();
        connection
            .execute(
                "CREATE TABLE compose_draft_metadata (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    account_id TEXT NOT NULL,
                    draft_id TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    original_message_id TEXT,
                    original_gmail_message_id TEXT,
                    target_thread_id TEXT,
                    in_reply_to TEXT,
                    rfc_references TEXT,
                    boundary_version INTEGER NOT NULL,
                    editable_body_fingerprint TEXT,
                    quote_html TEXT,
                    quote_plain TEXT
                )",
                [],
            )
            .unwrap();
    }

    let coalescer = handle
        .state::<std::sync::Arc<SaveCoalescer>>()
        .inner()
        .clone();
    let generation = coalescer.schedule("draft:meta-fail-session").await;
    let mut payload = base_payload(DraftOperationMode::Create, None);
    payload.coalescing_generation = generation;

    let queue = handle
        .state::<std::sync::Arc<QueueEngine>>()
        .inner()
        .clone();
    latentmail_lib::queue::admit_durable(
        &queue,
        &storage,
        QueueOperation {
            id: "op-meta-fail".into(),
            account_id: "account".into(),
            lane: Lane::Interactive,
            kind: OperationKind::Draft,
            entity_key: "draft:meta-fail-session".into(),
            cost: 0,
            attempts: 0,
            description: "test operation".into(),
        },
        serde_json::to_string(&payload).unwrap(),
    )
    .await
    .unwrap();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let operation = storage
            .run(|connection| OperationRepository::get(connection, "op-meta-fail"))
            .await
            .unwrap()
            .unwrap();
        if operation.status == "failed" {
            assert!(operation
                .error
                .as_deref()
                .unwrap_or_default()
                .to_lowercase()
                .contains("conflict"));
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "operation never reached a terminal failed state"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
