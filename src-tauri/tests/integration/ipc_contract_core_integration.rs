use latentmail_lib::ai::credentials;
use latentmail_lib::auth::{AuthService, SaveAccountRequest};
use latentmail_lib::ipc::{
    health_check, health_response, open_external_url, pause_queue, read_queue_summary, register,
    resume_queue, validate_external_url, AppServices,
};
use latentmail_lib::queue::{Lane, PauseScope, QueueEngine};
use latentmail_lib::settings::SettingsService;
use latentmail_lib::storage::{
    Account, AccountRepository, HtmlPresence, LabelMembershipChange, LabelRepository, Message,
    MessageKey, MessageRepository, Storage, Thread, ThreadIdentity, ThreadRepository,
};
use latentmail_lib::sync::{
    create_queue_engine, noop_event_sink, SyncEngine, SyncEngineDeps, WorkRegistry,
};
use std::sync::Arc;
use tauri::{ipc::CallbackFn, ipc::InvokeBody, test::INVOKE_KEY, webview::InvokeRequest, Manager};
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

pub(super) fn app() -> tauri::App<tauri::test::MockRuntime> {
    register(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap()
}

pub(super) fn invoke(
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

pub(super) async fn start_token_server(account_id: &str) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "fresh-token", "token_type": "Bearer"
        })))
        .mount(&server)
        .await;
    crate::support::set_env("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    crate::support::set_env(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    crate::support::set_env("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    latentmail_lib::auth::save_refresh_token(account_id, "refresh-token").unwrap();
    server
}

pub(super) async fn save_test_account(auth_service: &AuthService, email: &str) -> String {
    auth_service
        .save_account(SaveAccountRequest {
            email: email.into(),
            refresh_token: "refresh-token".into(),
            target: None,
        })
        .await
        .unwrap()
        .id
}

pub(super) fn upsert_basic_account(
    connection: &rusqlite::Connection,
    account_id: &str,
    email: &str,
) {
    AccountRepository::upsert(
        connection,
        &Account {
            id: account_id.into(),
            email: email.into(),
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

pub(super) struct SeededThreadMessage<'a> {
    pub(super) account_id: &'a str,
    pub(super) thread_id: &'a str,
    pub(super) message_id: &'a str,
    pub(super) sent_at: i64,
    pub(super) is_unread: bool,
    pub(super) html_presence: HtmlPresence,
    pub(super) plain_body: Option<&'a str>,
    pub(super) truncated_body: Option<&'a str>,
    pub(super) labels: &'a [&'a str],
}

pub(super) fn seed_thread_and_message(
    connection: &rusqlite::Connection,
    seed: SeededThreadMessage<'_>,
) {
    ThreadRepository::upsert(
        connection,
        &Thread {
            account_id: seed.account_id.into(),
            id: seed.thread_id.into(),
            subject: "Subject".into(),
            participants: "Alice <a@example.com>".into(),
            latest_at: seed.sent_at,
            message_count: 1,
            is_unread: seed.is_unread,
            is_starred: false,
            has_attachments: false,
            has_draft: false,
            sender_identity: ThreadIdentity {
                display: "Alice".into(),
                address: Some("a@example.com".into()),
            },
            recipient_identity: None,
        },
    )
    .unwrap();
    MessageRepository::write_full_state(
        connection,
        &Message {
            account_id: seed.account_id.into(),
            id: seed.message_id.into(),
            thread_id: seed.thread_id.into(),
            rfc_message_id: None,
            sender: "alice@example.com".into(),
            recipients: "me@example.com".into(),
            subject: "Subject".into(),
            sent_at: seed.sent_at,
            snippet: "hi".into(),
            html_body: None,
            plain_body: seed.plain_body.map(str::to_owned),
            has_attachments: false,
            is_unread: seed.is_unread,
            is_starred: false,
            history_id: 1,
            truncated_body: seed.truncated_body.map(str::to_owned),
            html_presence: seed.html_presence,
        },
    )
    .unwrap();
    for label_id in seed.labels {
        LabelRepository::ensure_placeholder(connection, seed.account_id, label_id).unwrap();
        MessageRepository::set_label_membership(
            connection,
            MessageKey {
                account_id: seed.account_id,
                message_id: seed.message_id,
            },
            LabelMembershipChange {
                label_id: label_id,
                present: true,
            },
        )
        .unwrap();
    }
    ThreadRepository::recompute(connection, seed.account_id, seed.thread_id).unwrap();
}

pub(super) fn build_mail_webview(
    storage: Storage,
    auth_service: AuthService,
    unmetered_gmail: bool,
) -> (
    tauri::App<tauri::test::MockRuntime>,
    tauri::WebviewWindow<tauri::test::MockRuntime>,
) {
    let registry = WorkRegistry::new();
    let queue = create_queue_engine(250, 250, registry.clone());
    let deps = SyncEngineDeps {
        storage: storage.clone(),
        queue: queue,
        registry: registry,
        events: noop_event_sink(),
    };
    let sync_engine = match unmetered_gmail {
        true => SyncEngine::new_with_unmetered_gmail(deps),
        false => SyncEngine::new(deps),
    };
    let app = app();
    app.manage(storage);
    app.manage(auth_service);
    app.manage(sync_engine);
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (app, webview)
}

fn manage_all_ipc_services(
    app: &tauri::App<tauri::test::MockRuntime>,
    directory: &std::path::Path,
) {
    app.manage(QueueEngine::no_op());
    app.manage(AuthService::new(
        Storage::open(directory.join("mail.sqlite")).unwrap(),
    ));
    app.manage(latentmail_lib::ai::AiService::new(
        Storage::open(directory.join("mail.sqlite")).unwrap(),
    ));
    app.manage(SettingsService::new(
        Storage::open(directory.join("mail.sqlite")).unwrap(),
    ));
    let avatar_storage = Storage::open(directory.join("mail.sqlite")).unwrap();
    let avatar_cache = latentmail_lib::avatars::cache::AvatarCache::new(
        avatar_storage.clone(),
        directory.join("avatar-cache"),
    )
    .unwrap();
    app.manage(latentmail_lib::avatars::AvatarService::new(
        avatar_cache,
        avatar_storage,
        SettingsService::new(Storage::open(directory.join("mail.sqlite")).unwrap()),
    ));
    app.manage(Storage::open(directory.join("mail.sqlite")).unwrap());
    app.manage(Arc::new(latentmail_lib::compose::staging::Staging::new(
        directory.join("compose-staging"),
    )));
    app.manage(
        latentmail_lib::attachments::cache::AttachmentCache::new(
            directory.join("attachment-cache"),
        )
        .unwrap(),
    );
    app.manage(SyncEngine::new(SyncEngineDeps {
        storage: Storage::open(directory.join("mail.sqlite")).unwrap(),
        queue: QueueEngine::no_op(),
        registry: WorkRegistry::new(),
        events: noop_event_sink(),
    }));
}

fn assert_core_and_ai_reachability(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>) {
    assert_eq!(
        invoke(webview, "health_check", serde_json::json!({})).unwrap()["status"],
        "ok"
    );
    assert!(invoke(
        webview,
        "open_external_url",
        serde_json::json!({ "url": "https://example.com" })
    )
    .is_err());
    assert!(invoke(
        webview,
        "write_frontend_log",
        serde_json::json!({ "level": "info", "message": "from ipc" })
    )
    .is_ok());
    for command in ["pause_queue", "resume_queue", "read_queue_summary"] {
        assert_eq!(
            invoke(webview, command, serde_json::json!({}))
                .unwrap()
                .get("pending")
                .unwrap(),
            0
        );
    }
    assert_eq!(
        invoke(webview, "list_accounts", serde_json::json!({})).unwrap(),
        serde_json::json!([])
    );
    assert_eq!(
        invoke(webview, "read_ai_configs", serde_json::json!({})).unwrap(),
        serde_json::json!([])
    );
    assert!(invoke(webview, "read_ai_index_status", serde_json::json!({})).is_ok());
    assert_eq!(
        invoke(
            webview,
            "cancel_ai_chat",
            serde_json::json!({ "requestId": "chat-missing" })
        )
        .unwrap(),
        serde_json::json!(false)
    );
    for (command, body) in missing_account_ai_calls() {
        assert!(invoke(webview, command, body).is_err(), "{command}");
    }
}

fn missing_account_ai_calls() -> Vec<(&'static str, serde_json::Value)> {
    vec![
        (
            "set_ai_enabled",
            serde_json::json!({ "accountId": "missing", "enabled": true }),
        ),
        (
            "set_ai_base_url",
            serde_json::json!({ "accountId": "missing", "baseUrl": "http://127.0.0.1/v1" }),
        ),
        (
            "set_ai_api_key",
            serde_json::json!({ "accountId": "missing", "apiKey": "secret" }),
        ),
        (
            "clear_ai_api_key",
            serde_json::json!({ "accountId": "missing" }),
        ),
        (
            "test_ai_connection",
            serde_json::json!({ "accountId": "missing" }),
        ),
        (
            "list_ai_models",
            serde_json::json!({ "accountId": "missing" }),
        ),
        (
            "select_ai_chat_model",
            serde_json::json!({ "accountId": "missing", "model": "chat" }),
        ),
        (
            "select_ai_embedding_model",
            serde_json::json!({ "accountId": "missing", "model": "embedding" }),
        ),
        (
            "start_ai_index",
            serde_json::json!({ "accountId": "missing" }),
        ),
        (
            "cancel_ai_index",
            serde_json::json!({ "accountId": "missing" }),
        ),
        (
            "rebuild_ai_index",
            serde_json::json!({ "accountId": "missing" }),
        ),
        (
            "start_ai_chat",
            serde_json::json!({ "accountId": "missing", "sessionId": "session", "question": "   " }),
        ),
        (
            "start_ai_chat",
            serde_json::json!({ "accountId": "missing", "sessionId": "session", "question": "what is the deadline" }),
        ),
    ]
}

fn assert_auth_settings_avatar_and_queue_reachability(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
) {
    assert!(invoke(webview, "begin_sign_in", serde_json::json!({})).is_err());
    assert!(invoke(
        webview,
        "begin_reauthentication",
        serde_json::json!({ "accountId": "any" })
    )
    .is_err());
    assert!(invoke(
        webview,
        "remove_account",
        serde_json::json!({ "accountId": "unknown" })
    )
    .is_err());
    assert_settings_and_log_reachability(webview);
    assert_avatar_reachability(webview);
    assert_queue_reachability(webview);
}

fn assert_settings_and_log_reachability(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>) {
    let settings = invoke(webview, "read_settings", serde_json::json!({})).unwrap();
    assert_eq!(settings["theme"], "system");
    assert!(invoke(
        webview,
        "write_setting",
        serde_json::json!({ "key": "theme", "value": "dark" })
    )
    .is_ok());
    assert_eq!(
        invoke(webview, "read_log_entries", serde_json::json!({})).unwrap(),
        serde_json::json!([])
    );
}

fn assert_avatar_reachability(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>) {
    assert_eq!(
        invoke(
            webview,
            "read_sender_avatar",
            serde_json::json!({ "domain": "example.com" })
        )
        .unwrap(),
        serde_json::Value::Null
    );
    assert_eq!(
        invoke(
            webview,
            "read_account_avatar",
            serde_json::json!({ "accountId": "unknown" })
        )
        .unwrap(),
        serde_json::Value::Null
    );
}

fn assert_queue_reachability(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>) {
    assert_eq!(
        invoke(webview, "read_queue_operations", serde_json::json!({})).unwrap(),
        serde_json::json!([])
    );
    assert_eq!(
        invoke(
            webview,
            "cancel_queue_operation",
            serde_json::json!({ "operationId": "missing" })
        )
        .unwrap(),
        false
    );
    assert_eq!(
        invoke(
            webview,
            "retry_queue_operation",
            serde_json::json!({ "operationId": "missing" })
        )
        .unwrap(),
        false
    );
    assert_eq!(
        invoke(
            webview,
            "retry_failed_operations",
            serde_json::json!({ "accountId": null })
        )
        .unwrap(),
        0
    );
    assert!(invoke(
        webview,
        "clear_queue_history",
        serde_json::json!({ "accountId": null })
    )
    .is_ok());
    assert_eq!(
        invoke(
            webview,
            "set_queue_paused",
            serde_json::json!({ "scope": { "scope": "account", "accountId": "account" }, "paused": true }),
        )
        .unwrap(),
        true
    );
}

fn assert_missing_attachment_reachability(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    directory: &std::path::Path,
) {
    let missing_attachment_args = serde_json::json!({
        "accountId": "account",
        "messageId": "missing-message",
        "attachmentId": "missing-attachment"
    });
    assert!(
        invoke(
            webview,
            "ensure_attachment_cached",
            missing_attachment_args.clone()
        )
        .is_err(),
        "reachable through IPC and fails cleanly on missing metadata, not a permission error"
    );
    assert!(invoke(
        webview,
        "read_attachment_bytes",
        missing_attachment_args.clone()
    )
    .is_err());
    assert!(invoke(
        webview,
        "read_attachment_text",
        missing_attachment_args.clone()
    )
    .is_err());
    let mut save_args = missing_attachment_args.clone();
    save_args["destination"] = serde_json::json!(directory.join("saved.bin").to_string_lossy());
    assert!(invoke(webview, "save_attachment_to_path", save_args).is_err());
    let mut stage_args = missing_attachment_args;
    stage_args["owner"] = serde_json::json!("owner");
    assert!(invoke(webview, "stage_attachment_into_draft", stage_args).is_err());
}

fn storage_failure_cases() -> Vec<(&'static str, serde_json::Value)> {
    let mut cases = storage_read_failure_cases();
    cases.extend(storage_mutation_failure_cases());
    cases
}

fn storage_read_failure_cases() -> Vec<(&'static str, serde_json::Value)> {
    vec![
        ("list_accounts", serde_json::json!({})),
        ("read_settings", serde_json::json!({})),
        (
            "write_setting",
            serde_json::json!({ "key": "theme", "value": "dark" }),
        ),
        ("list_labels", serde_json::json!({ "accountId": "account" })),
        (
            "lookup_contacts",
            serde_json::json!({ "accountId": "account", "query": "al" }),
        ),
        (
            "reply_context",
            serde_json::json!({ "accountId": "account", "messageId": "message", "accountEmail": "me@example.com", "replyAll": false, "forward": false }),
        ),
        (
            "stage_attachment_from_path",
            serde_json::json!({ "accountId": "account", "owner": "draft", "path": "/does/not/exist", "mimeType": "text/plain", "contentId": null }),
        ),
        (
            "list_threads",
            serde_json::json!({ "accountId": "account", "labelId": null, "cursor": null, "limit": null }),
        ),
        (
            "search_total",
            serde_json::json!({ "accountId": "account", "query": "hi", "scope": null }),
        ),
        (
            "load_conversation",
            serde_json::json!({ "accountId": "account", "threadId": "thread", "imagePolicy": null }),
        ),
        (
            "load_message_body",
            serde_json::json!({ "accountId": "account", "messageId": "message", "imagePolicy": null }),
        ),
        (
            "fetch_message_body",
            serde_json::json!({ "accountId": "account", "messageId": "message" }),
        ),
    ]
}

fn storage_mutation_failure_cases() -> Vec<(&'static str, serde_json::Value)> {
    vec![
        (
            "create_label",
            serde_json::json!({ "accountId": "account", "name": "Clients", "colorId": null }),
        ),
        (
            "rename_label",
            serde_json::json!({ "accountId": "account", "labelId": "Label_1", "name": "Clients" }),
        ),
        (
            "recolor_label",
            serde_json::json!({ "accountId": "account", "labelId": "Label_1", "colorId": "blue" }),
        ),
        (
            "delete_label",
            serde_json::json!({ "accountId": "account", "labelId": "Label_1" }),
        ),
        (
            "read_traversal_status",
            serde_json::json!({ "accountId": "account" }),
        ),
        (
            "delete_threads",
            serde_json::json!({ "accountId": "account", "threadIds": ["thread"] }),
        ),
        (
            "move_threads",
            serde_json::json!({ "accountId": "account", "threadIds": ["thread"], "destination": "SPAM" }),
        ),
        (
            "delete_messages",
            serde_json::json!({ "accountId": "account", "messageIds": ["message"] }),
        ),
        (
            "move_messages",
            serde_json::json!({ "accountId": "account", "messageIds": ["message"], "destination": "SPAM" }),
        ),
    ]
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
fn health_command_answers_and_external_opening_uses_the_test_safe_boundary() {
    let app = app();

    assert_eq!(
        serde_json::to_value(health_check()).unwrap()["status"],
        "ok"
    );
    assert!(open_external_url(app.handle().clone(), "https://example.com".to_owned()).is_err());
}

#[test]
fn pause_and_resume_queue_commands_emit_summaries_and_toggle_the_engine() {
    let app = app();
    app.manage(QueueEngine::no_op());

    let paused = pause_queue(AppServices::new(app.handle())).unwrap();
    assert_eq!(paused.pending, 0);

    let resumed = resume_queue(AppServices::new(app.handle())).unwrap();
    assert_eq!(resumed.pending, 0);

    let summary = read_queue_summary(AppServices::new(app.handle()));
    assert_eq!(summary.unwrap().pending, 0);
}

#[test]
fn every_registered_command_is_reachable_through_real_ipc_dispatch() {
    let app = app();
    let directory = tempfile::tempdir().unwrap();
    manage_all_ipc_services(&app, directory.path());
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    assert_core_and_ai_reachability(&webview);
    assert_auth_settings_avatar_and_queue_reachability(&webview);
    assert_missing_attachment_reachability(&webview, directory.path());
}

fn manage_ai_ipc_services(
    app: &tauri::App<tauri::test::MockRuntime>,
    storage: Storage,
) -> Arc<QueueEngine> {
    upsert_basic_account(
        &storage.connection().unwrap(),
        "ai-ipc",
        "ai-ipc@example.com",
    );
    let registry = WorkRegistry::new();
    let queue = create_queue_engine(250, 250, registry.clone());
    app.manage(latentmail_lib::ai::AiService::new(storage.clone()));
    app.manage(SyncEngine::new(SyncEngineDeps {
        storage: storage,
        queue: queue.clone(),
        registry: registry,
        events: noop_event_sink(),
    }));
    queue
}

fn configure_ai_through_ipc(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    base_url: String,
) {
    for (command, body) in [
        (
            "set_ai_enabled",
            serde_json::json!({ "accountId": "ai-ipc", "enabled": true }),
        ),
        (
            "set_ai_base_url",
            serde_json::json!({ "accountId": "ai-ipc", "baseUrl": base_url }),
        ),
        (
            "set_ai_api_key",
            serde_json::json!({ "accountId": "ai-ipc", "apiKey": "test-key" }),
        ),
        (
            "select_ai_chat_model",
            serde_json::json!({ "accountId": "ai-ipc", "model": "chat" }),
        ),
        (
            "select_ai_embedding_model",
            serde_json::json!({ "accountId": "ai-ipc", "model": "embedding" }),
        ),
    ] {
        assert!(invoke(webview, command, body).is_ok(), "{command}");
    }
}

fn run_ai_index_commands_through_ipc(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>) {
    for command in [
        "start_ai_index",
        "cancel_ai_index",
        "rebuild_ai_index",
        "clear_ai_api_key",
    ] {
        assert!(
            invoke(
                webview,
                command,
                serde_json::json!({ "accountId": "ai-ipc" })
            )
            .is_ok(),
            "{command}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ai_commands_complete_their_success_paths_through_real_ipc_dispatch() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": [{"id": "chat"}, {"id": "embedding"}]
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": [{"embedding": [1.0, 2.0]}]
        })))
        .mount(&server)
        .await;
    let app = app();
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let queue = manage_ai_ipc_services(&app, storage);
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    credentials::clear("ai-ipc").unwrap();

    configure_ai_through_ipc(&webview, format!("{}/v1", server.uri()));
    queue.wait_for_account_lane("ai-ipc", Lane::Embedding).await;
    run_ai_index_commands_through_ipc(&webview);
}

#[test]
fn pause_scope_deserializes_from_the_exact_json_shape_the_frontend_sends() {
    assert_eq!(
        serde_json::from_value::<PauseScope>(serde_json::json!({ "scope": "global" })).unwrap(),
        PauseScope::Global
    );
    assert_eq!(
        serde_json::from_value::<PauseScope>(
            serde_json::json!({ "scope": "account", "accountId": "account-1" })
        )
        .unwrap(),
        PauseScope::Account {
            account_id: "account-1".into()
        }
    );
    assert_eq!(
        serde_json::from_value::<PauseScope>(serde_json::json!({
            "scope": "lane",
            "accountId": "account-1",
            "lane": "interactive"
        }))
        .unwrap(),
        PauseScope::Lane {
            account_id: "account-1".into(),
            lane: Lane::Interactive
        }
    );
}

#[test]
fn storage_backed_commands_return_database_errors_through_real_ipc() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("mail.sqlite");
    let storage = Storage::open(&database).unwrap();
    let registry = WorkRegistry::new();
    let queue = create_queue_engine(250, 250, registry.clone());
    let engine = SyncEngine::new(SyncEngineDeps {
        storage: storage.clone(),
        queue: queue,
        registry: registry,
        events: noop_event_sink(),
    });
    let app = app();
    app.manage(storage.clone());
    app.manage(AuthService::new(storage.clone()));
    app.manage(SettingsService::new(storage));
    app.manage(engine);
    app.manage(Arc::new(latentmail_lib::compose::staging::Staging::new(
        directory.path().join("staged"),
    )));
    std::fs::remove_dir_all(directory.path()).unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    for (command, body) in storage_failure_cases() {
        assert!(
            invoke(&webview, command, body).is_err(),
            "{command} must surface storage failure"
        );
    }
    for command in ["mutate_threads", "mutate_messages"] {
        assert!(invoke(
            &webview,
            command,
            serde_json::json!({ "accountId": "account", "threadIds": ["thread"], "messageIds": ["message"], "add": ["DRAFT"], "remove": [] }),
        )
        .is_err());
    }
    for (command, body) in [
        (
            "move_threads",
            serde_json::json!({ "accountId": "account", "threadIds": ["thread"], "destination": "DRAFT" }),
        ),
        (
            "move_messages",
            serde_json::json!({ "accountId": "account", "messageIds": ["message"], "destination": "DRAFT" }),
        ),
    ] {
        let error = invoke(&webview, command, body).unwrap_err();
        assert!(error.to_string().contains("not a valid move destination"));
    }
}
