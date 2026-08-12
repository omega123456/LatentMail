use latentmail_lib::auth::AuthService;
use latentmail_lib::ipc::{
    health_check, health_response, open_external_url, pause_queue, read_queue_summary, register,
    resume_queue, validate_external_url,
};
use latentmail_lib::queue::QueueEngine;
use latentmail_lib::settings::SettingsService;
use latentmail_lib::storage::{
    Account, AccountRepository, HtmlPresence, LabelRepository, Message, MessageRepository,
    Storage, Thread, ThreadRepository,
};
use latentmail_lib::sync::{noop_event_sink, SyncEngine, WorkRegistry};
use tauri::{ipc::CallbackFn, ipc::InvokeBody, test::INVOKE_KEY, webview::InvokeRequest, Manager};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

fn app() -> tauri::App<tauri::test::MockRuntime> {
    register(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap()
}

/// Dispatches `cmd` through the real Tauri IPC pipeline (not a direct Rust
/// call) so that the `#[tauri::command]`-generated invoke wrapper — which
/// `register()` wires up for every command — is actually exercised, the
/// same path the frontend uses in production.
fn invoke(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    cmd: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    tauri::test::get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.into(),
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

#[test]
fn health_check_has_an_ok_status() {
    let health = health_response();
    assert_eq!(serde_json::to_value(health).unwrap()["status"], "ok");
}

#[test]
fn external_urls_are_limited_to_http_s() {
    assert!(validate_external_url("https://example.com").is_ok());
    assert!(validate_external_url("file:///tmp/message.html").is_err());
    assert!(validate_external_url("not a URL").is_err());
}

#[test]
fn health_command_emits_and_external_opening_uses_the_test_safe_boundary() {
    let app = app();

    assert_eq!(
        serde_json::to_value(health_check(app.handle().clone()).unwrap()).unwrap()["status"],
        "ok"
    );
    assert!(open_external_url(app.handle().clone(), "https://example.com".to_owned()).is_err());
}

#[test]
fn pause_and_resume_queue_commands_emit_summaries_and_toggle_the_engine() {
    let app = app();
    app.manage(QueueEngine::no_op());

    let paused = pause_queue(app.handle().clone(), app.state()).unwrap();
    assert_eq!(paused.pending, 0);

    let resumed = resume_queue(app.handle().clone(), app.state()).unwrap();
    assert_eq!(resumed.pending, 0);

    let summary = read_queue_summary(app.state());
    assert_eq!(summary.pending, 0);
}

/// Exercises every registered command through the real IPC dispatch path
/// (`register()` wires all of these up), not just direct Rust calls, so the
/// `#[tauri::command]`-generated wrapper for each one is covered too.
#[test]
fn every_registered_command_is_reachable_through_real_ipc_dispatch() {
    let app = app();
    let directory = tempfile::tempdir().unwrap();
    app.manage(QueueEngine::no_op());
    app.manage(AuthService::new(
        Storage::open(directory.path().join("mail.sqlite")).unwrap(),
    ));
    app.manage(SettingsService::new(
        Storage::open(directory.path().join("mail.sqlite")).unwrap(),
    ));
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    assert_eq!(
        invoke(&webview, "health_check", serde_json::json!({})).unwrap()["status"],
        "ok"
    );
    assert!(invoke(
        &webview,
        "open_external_url",
        serde_json::json!({ "url": "https://example.com" })
    )
    .is_err());
    assert!(invoke(
        &webview,
        "write_frontend_log",
        // Exactly the payload `IpcCommandMap['write_frontend_log']` sends —
        // wrapping it in a `record` key here is what hid the argument-name
        // mismatch that silently dropped every frontend log.
        serde_json::json!({ "level": "info", "message": "from ipc" })
    )
    .is_ok());
    assert_eq!(
        invoke(&webview, "pause_queue", serde_json::json!({}))
            .unwrap()
            .get("pending")
            .unwrap(),
        0
    );
    assert_eq!(
        invoke(&webview, "resume_queue", serde_json::json!({}))
            .unwrap()
            .get("pending")
            .unwrap(),
        0
    );
    assert_eq!(
        invoke(&webview, "read_queue_summary", serde_json::json!({}))
            .unwrap()
            .get("pending")
            .unwrap(),
        0
    );
    assert_eq!(
        invoke(&webview, "list_accounts", serde_json::json!({})).unwrap(),
        serde_json::json!([])
    );
    // No client id is configured in tests, so sign-in/reauth always fail
    // fast — that is still real, meaningful coverage of the command's
    // dispatch wiring and error path.
    assert!(invoke(&webview, "begin_sign_in", serde_json::json!({})).is_err());
    assert!(invoke(
        &webview,
        "begin_reauthentication",
        serde_json::json!({ "accountId": "any" })
    )
    .is_err());
    let settings = invoke(&webview, "read_settings", serde_json::json!({})).unwrap();
    assert_eq!(settings["theme"], "system");
    assert!(invoke(
        &webview,
        "write_setting",
        serde_json::json!({ "key": "theme", "value": "dark" })
    )
    .is_ok());
}

/// Phase 3's complete IPC surface — triage mutations over identifier sets,
/// draft deletion, label lifecycle, and traversal status — dispatched
/// through the same real IPC pipeline as every other command, against a
/// fake Gmail server standing in for the real API. No command body here
/// may be a stub: each of these genuinely round-trips to the fake server
/// and back into storage (Phase 3 AC8/AC11).
#[tokio::test]
async fn every_phase_3_command_is_reachable_through_real_ipc_dispatch() {
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
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    latentmail_lib::auth::save_refresh_token(&account_id, "refresh-token").unwrap();

    // Seed a thread with one message so `mutate_threads`/`delete_draft` have
    // something real to act on.
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: account_id.clone(),
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
    for label_id in ["INBOX", "STARRED", "TRASH"] {
        LabelRepository::ensure_placeholder(&connection, &account_id, label_id).unwrap();
    }
    ThreadRepository::upsert(
        &connection,
        &Thread {
            account_id: account_id.clone(),
            id: "thread-1".into(),
            subject: "Subject".into(),
            participants: "Alice <a@example.com>".into(),
            latest_at: 1,
            message_count: 1,
            is_unread: false,
            is_starred: false,
            has_attachments: false,
            has_draft: false,
        },
    )
    .unwrap();
    MessageRepository::write_full_state(
        &connection,
        &Message {
            account_id: account_id.clone(),
            id: "message-1".into(),
            thread_id: "thread-1".into(),
            rfc_message_id: None,
            sender: "alice@example.com".into(),
            recipients: "me@example.com".into(),
            subject: "Subject".into(),
            sent_at: 1,
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
    MessageRepository::set_label_membership(&connection, &account_id, "message-1", "INBOX", true)
        .unwrap();
    drop(connection);

    Mock::given(method("GET"))
        .and(path("/users/me/messages/message-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "message-1", "threadId": "thread-1", "historyId": "5",
            "labelIds": ["INBOX", "STARRED"], "snippet": "hi", "internalDate": "1000",
            "payload": { "mimeType": "text/plain", "headers": [], "body": { "data": "aGk" } }
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/users/me/messages/batchModify"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&server)
        .await;
    // `delete_draft` has no cached draft id for "message-1" yet, so it must
    // resolve one via `GET /users/me/drafts` (the draft id, "draft-9", is
    // deliberately distinct from the message id it maps to — see the item 2
    // fix) before it can call the dedicated drafts-delete endpoint.
    Mock::given(method("GET"))
        .and(path("/users/me/drafts"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "drafts": [{ "id": "draft-9", "message": { "id": "message-1" } }]
        })))
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/users/me/drafts/draft-9"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/users/me/labels"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "Label_1", "name": "Clients", "type": "user",
            "color": { "textColor": "#ffffff", "backgroundColor": "#4a86e8" }
        })))
        .mount(&server)
        .await;
    Mock::given(method("PATCH"))
        .and(path("/users/me/labels/Label_1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "Label_1", "name": "Customers", "type": "user",
            "color": { "textColor": "#ffffff", "backgroundColor": "#fb4c2f" }
        })))
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/users/me/labels/Label_1"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let sync_engine = SyncEngine::new(storage.clone(), queue, registry, noop_event_sink());

    let app = app();
    app.manage(storage);
    app.manage(auth_service);
    app.manage(sync_engine);
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    // Traversal status: real read against an empty cursor table.
    let status = invoke(
        &webview,
        "read_traversal_status",
        serde_json::json!({ "accountId": account_id }),
    )
    .unwrap();
    assert_eq!(status["state"], "notStarted");

    // Label lifecycle.
    let created = invoke(
        &webview,
        "create_label",
        serde_json::json!({ "accountId": account_id, "name": "Clients", "colorId": "blue" }),
    )
    .unwrap();
    assert_eq!(created["id"], "Label_1");
    assert_eq!(created["color"]["background"], "#4a86e8");

    let renamed = invoke(
        &webview,
        "rename_label",
        serde_json::json!({ "accountId": account_id, "labelId": "Label_1", "name": "Customers" }),
    )
    .unwrap();
    assert_eq!(renamed["name"], "Customers");

    let recolored = invoke(
        &webview,
        "recolor_label",
        serde_json::json!({ "accountId": account_id, "labelId": "Label_1", "colorId": "red" }),
    )
    .unwrap();
    assert_eq!(recolored["color"]["background"], "#fb4c2f");

    assert!(invoke(
        &webview,
        "delete_label",
        serde_json::json!({ "accountId": account_id, "labelId": "Label_1" })
    )
    .is_ok());

    // A rejected off-palette colour never reaches the network.
    assert!(invoke(
        &webview,
        "create_label",
        serde_json::json!({ "accountId": account_id, "name": "Bogus", "colorId": "not-real" })
    )
    .is_err());

    // Triage: the generalized mutation over an identifier set.
    let results = invoke(
        &webview,
        "mutate_threads",
        serde_json::json!({
            "accountId": account_id,
            "threadIds": ["thread-1"],
            "add": ["STARRED"],
            "remove": []
        }),
    )
    .unwrap();
    assert_eq!(results[0]["threadId"], "thread-1");
    assert_eq!(results[0]["outcome"], "applied");

    // The documented drafts-deletion exception.
    assert!(invoke(
        &webview,
        "delete_draft",
        serde_json::json!({ "accountId": account_id, "messageId": "message-1" })
    )
    .is_ok());

    // Every label-name-validation rule and the off-palette recolour
    // rejection, exercised through real IPC dispatch too — not just the
    // storage-layer unit tests in `gmail_labels_integration.rs`.
    let second = invoke(
        &webview,
        "create_label",
        serde_json::json!({ "accountId": account_id, "name": "Team A", "colorId": null }),
    )
    .unwrap();
    assert_eq!(second["id"], "Label_1");
    assert!(invoke(
        &webview,
        "recolor_label",
        serde_json::json!({ "accountId": account_id, "labelId": "Label_1", "colorId": "nope" })
    )
    .is_err());
}

/// The read commands (`list_labels`, `list_threads`, `load_conversation`)
/// and the pre-existing single-thread star/read commands, dispatched
/// through the real IPC pipeline — the established convention (see the
/// module doc) that keeps every `#[tauri::command]`-generated invoke
/// wrapper inside the function-coverage gate, not just its inner body
/// (which direct Rust calls in `sync_threads_integration.rs` /
/// `mutations_star_integration.rs` already exercise).
#[tokio::test]
async fn mail_read_and_single_thread_triage_commands_are_reachable_through_real_ipc_dispatch() {
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
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    latentmail_lib::auth::save_refresh_token(&account_id, "refresh-token").unwrap();

    let connection = storage.connection().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: account_id.clone(),
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
    for label_id in ["INBOX", "UNREAD", "STARRED"] {
        LabelRepository::ensure_placeholder(&connection, &account_id, label_id).unwrap();
    }
    ThreadRepository::upsert(
        &connection,
        &Thread {
            account_id: account_id.clone(),
            id: "thread-1".into(),
            subject: "Subject".into(),
            participants: "Alice <a@example.com>".into(),
            latest_at: 1,
            message_count: 1,
            is_unread: true,
            is_starred: false,
            has_attachments: false,
            has_draft: false,
        },
    )
    .unwrap();
    MessageRepository::write_full_state(
        &connection,
        &Message {
            account_id: account_id.clone(),
            id: "message-1".into(),
            thread_id: "thread-1".into(),
            rfc_message_id: None,
            sender: "alice@example.com".into(),
            recipients: "me@example.com".into(),
            subject: "Subject".into(),
            sent_at: 1,
            snippet: "hi".into(),
            html_body: None,
            plain_body: Some("hi".into()),
            has_attachments: false,
            is_unread: true,
            is_starred: false,
            history_id: 1,
            truncated_body: None,
            html_presence: HtmlPresence::Absent,
        },
    )
    .unwrap();
    MessageRepository::set_label_membership(&connection, &account_id, "message-1", "INBOX", true)
        .unwrap();
    MessageRepository::set_label_membership(&connection, &account_id, "message-1", "UNREAD", true)
        .unwrap();
    drop(connection);

    Mock::given(method("GET"))
        .and(path("/users/me/messages/message-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "message-1", "threadId": "thread-1", "historyId": "5",
            "labelIds": ["INBOX"], "snippet": "hi", "internalDate": "1000",
            "payload": { "mimeType": "text/plain", "headers": [], "body": { "data": "aGk" } }
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/users/me/messages/batchModify"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&server)
        .await;

    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let sync_engine = SyncEngine::new(storage.clone(), queue, registry, noop_event_sink());
    let storage_for_cursor = storage.clone();

    let app = app();
    app.manage(storage);
    app.manage(auth_service);
    app.manage(sync_engine);
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let labels = invoke(
        &webview,
        "list_labels",
        serde_json::json!({ "accountId": account_id }),
    )
    .unwrap();
    assert_eq!(labels[0]["id"], "INBOX");

    let threads = invoke(
        &webview,
        "list_threads",
        serde_json::json!({ "accountId": account_id, "labelId": null, "cursor": null, "limit": null }),
    )
    .unwrap();
    assert_eq!(threads["items"][0]["id"], "thread-1");

    let conversation = invoke(
        &webview,
        "load_conversation",
        serde_json::json!({ "accountId": account_id, "threadId": "thread-1" }),
    )
    .unwrap();
    assert_eq!(conversation["messages"][0]["id"], "message-1");

    assert!(invoke(
        &webview,
        "star_thread",
        serde_json::json!({ "accountId": account_id, "threadId": "thread-1" })
    )
    .is_ok());
    assert!(invoke(
        &webview,
        "unstar_thread",
        serde_json::json!({ "accountId": account_id, "threadId": "thread-1" })
    )
    .is_ok());
    assert!(invoke(
        &webview,
        "mark_thread_read",
        serde_json::json!({ "accountId": account_id, "threadId": "thread-1" })
    )
    .is_ok());
    assert!(invoke(
        &webview,
        "mark_thread_unread",
        serde_json::json!({ "accountId": account_id, "threadId": "thread-1" })
    )
    .is_ok());

    // Sync trigger/status through the same real dispatch path — a fresh
    // account with no local rows, so a full initial sync's empty-mailbox
    // path is what gets exercised here.
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
    let status = invoke(
        &webview,
        "trigger_sync",
        serde_json::json!({ "accountId": account_id }),
    )
    .unwrap();
    assert_eq!(status["state"], "idle");
    let read_back = invoke(
        &webview,
        "read_sync_status",
        serde_json::json!({ "accountId": account_id }),
    )
    .unwrap();
    assert_eq!(read_back["state"], "idle");

    // Traversal status once a cursor row exists — the `TraversalCursor ->
    // TraversalStatusDto` conversion path `read_traversal_status` takes
    // once backfill/reconciliation (Phase 4/5) have ever run.
    latentmail_lib::storage::TraversalCursorRepository::upsert(
        &storage_for_cursor.connection().unwrap(),
        &latentmail_lib::storage::TraversalCursor {
            account_id: account_id.clone(),
            kind: latentmail_lib::storage::TraversalKind::Reconciliation,
            position: Some("token".into()),
            discovered_count: 10,
            persisted_count: 4,
            completed: false,
            last_advanced_at: 1_700_000_000,
            // Set directly (this test builds the row by hand rather than
            // through a real backfill run) to exercise the DTO's read side
            // of `TraversalCursor::resumed` — see
            // `traversal_cursor_integration.rs` for coverage of how a real
            // run comes to set this flag correctly in the first place.
            resumed: true,
        },
    )
    .unwrap();
    let mid_status = invoke(
        &webview,
        "read_traversal_status",
        serde_json::json!({ "accountId": account_id }),
    )
    .unwrap();
    assert_eq!(mid_status["state"], "reconciling");
    assert_eq!(mid_status["kind"], "reconciliation");
    assert_eq!(mid_status["discoveredCount"], 10);
    // The DTO surfaces the cursor's persisted `resumed` flag as-is.
    assert_eq!(mid_status["isResumed"], true);
}

/// `mutate_messages` and `fetch_message_body` — registered handlers with no
/// prior coverage in this file's command sweep (plan-adherence audit item
/// 3). Dispatched through the same real IPC pipeline as every command
/// above, against a fake Gmail server, so both `#[tauri::command]`-generated
/// wrappers are genuinely exercised end to end.
#[tokio::test]
async fn message_level_mutation_and_lazy_body_fetch_commands_are_reachable_through_real_ipc_dispatch(
) {
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
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    latentmail_lib::auth::save_refresh_token(&account_id, "refresh-token").unwrap();

    let connection = storage.connection().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: account_id.clone(),
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
    for label_id in ["INBOX", "STARRED"] {
        LabelRepository::ensure_placeholder(&connection, &account_id, label_id).unwrap();
    }
    // `html_presence: NeverFetched` — a whole-mailbox-backfill-only
    // message (Phase 4/6) — is what makes `fetch_message_body` actually
    // contact Gmail rather than short-circuiting.
    MessageRepository::write_full_state(
        &connection,
        &Message {
            account_id: account_id.clone(),
            id: "message-1".into(),
            thread_id: "thread-1".into(),
            rfc_message_id: None,
            sender: "alice@example.com".into(),
            recipients: "me@example.com".into(),
            subject: "Subject".into(),
            sent_at: 1,
            snippet: "hi".into(),
            html_body: None,
            plain_body: None,
            has_attachments: false,
            is_unread: true,
            is_starred: false,
            history_id: 1,
            truncated_body: Some("hi".into()),
            html_presence: HtmlPresence::NeverFetched,
        },
    )
    .unwrap();
    MessageRepository::set_label_membership(&connection, &account_id, "message-1", "INBOX", true)
        .unwrap();
    drop(connection);

    Mock::given(method("GET"))
        .and(path("/users/me/messages/message-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "message-1", "threadId": "thread-1", "historyId": "9",
            "labelIds": ["INBOX", "STARRED"], "snippet": "hi", "internalDate": "1000",
            "payload": {
                "mimeType": "text/html",
                "headers": [],
                "body": { "data": "aGVsbG8" }
            }
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/users/me/messages/batchModify"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&server)
        .await;

    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let sync_engine = SyncEngine::new(storage.clone(), queue, registry, noop_event_sink());

    let app = app();
    app.manage(storage.clone());
    app.manage(auth_service);
    app.manage(sync_engine);
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    assert!(invoke(
        &webview,
        "fetch_message_body",
        serde_json::json!({ "accountId": account_id, "messageId": "message-1" })
    )
    .is_ok());
    let stored = MessageRepository::get(&storage.connection().unwrap(), &account_id, "message-1")
        .unwrap()
        .unwrap();
    assert_eq!(stored.html_body.as_deref(), Some("hello"));
    assert_eq!(stored.html_presence, HtmlPresence::Present);

    assert!(invoke(
        &webview,
        "mutate_messages",
        serde_json::json!({
            "accountId": account_id,
            "messageIds": ["message-1"],
            "add": ["STARRED"],
            "remove": []
        })
    )
    .is_ok());
    assert!(MessageRepository::get(&storage.connection().unwrap(), &account_id, "message-1")
        .unwrap()
        .unwrap()
        .is_starred);
}
