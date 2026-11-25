use latentmail_lib::compose::drafts::{DraftExecutorContext, DraftTarget};
use latentmail_lib::compose::staging::{OwnerScope, StagePathRequest};
use latentmail_lib::sync::{noop_event_sink, SyncEngine, SyncEngineDeps, WorkRegistry};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use latentmail_lib::{
    auth::AuthService,
    compose::{
        drafts::{self, DraftOperationMode, DraftOperationPayload, SaveCoalescer},
        staging::{StagedPart, Staging},
    },
    queue::QueueEngine,
    storage::{
        Account, AccountRepository, ComposeDraftMetadataRepository, HtmlPresence, InlinePart,
        Message, MessageKey, MessageRepository, Operation, OperationRepository, Storage,
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

pub(super) static APP_ENV: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

pub(super) struct BootedDraftApp {
    pub(super) app: tauri::App<tauri::test::MockRuntime>,
    pub(super) _home: tempfile::TempDir,
    pub(super) storage: Storage,
    pub(super) staging: Arc<Staging>,
    pub(super) coalescer: Arc<SaveCoalescer>,
    pub(super) queue: Arc<QueueEngine>,
}

pub(super) fn compose_dispatch_builder() -> tauri::Builder<tauri::test::MockRuntime> {
    tauri::test::mock_builder().invoke_handler(tauri::generate_handler![
        latentmail_lib::sync::commands::list_labels,
        latentmail_lib::sync::commands::lookup_contacts,
        latentmail_lib::sync::commands::reply_context,
        latentmail_lib::sync::commands::stage_attachment_from_path,
        latentmail_lib::sync::commands::stage_attachment_from_bytes,
        latentmail_lib::sync::commands::release_staged_attachment,
        latentmail_lib::sync::commands::save_compose_draft,
        latentmail_lib::sync::commands::send_compose_draft,
        latentmail_lib::sync::commands::discard_compose_draft,
        latentmail_lib::sync::commands::hydrate_compose_draft,
        latentmail_lib::sync::commands::list_threads,
        latentmail_lib::sync::commands::load_conversation,
        latentmail_lib::sync::commands::fetch_message_body,
        latentmail_lib::sync::commands::trigger_sync,
        latentmail_lib::sync::commands::read_sync_status,
        latentmail_lib::sync::commands::star_thread,
        latentmail_lib::sync::commands::unstar_thread,
        latentmail_lib::sync::commands::mark_thread_read,
        latentmail_lib::sync::commands::mark_thread_unread,
        latentmail_lib::sync::commands::mutate_threads,
        latentmail_lib::sync::commands::mutate_messages,
        latentmail_lib::sync::commands::delete_draft,
        latentmail_lib::sync::commands::create_label,
        latentmail_lib::sync::commands::rename_label,
        latentmail_lib::sync::commands::recolor_label,
        latentmail_lib::sync::commands::delete_label,
        latentmail_lib::sync::commands::read_traversal_status,
    ])
}

pub(super) fn draft_response(id: &str, message_id: &str, thread_id: &str) -> serde_json::Value {
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

pub(super) fn base_payload(
    mode: DraftOperationMode,
    draft_id: Option<&str>,
) -> DraftOperationPayload {
    DraftOperationPayload {
        mode: mode,
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

pub(super) fn upsert_default_account(connection: &rusqlite::Connection) {
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

pub(super) fn invoke(
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

fn boot_with_gmail_base(token_url: String, gmail_base_url: String) -> BootedDraftApp {
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var("LATENTMAIL_GOOGLE_TOKEN_URL", token_url);
    std::env::set_var("LATENTMAIL_GMAIL_BASE_URL", gmail_base_url);
    let home = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", home.path());
    std::env::set_var("APPDATA", home.path());
    std::env::set_var("XDG_DATA_HOME", home.path());

    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .visible(false)
        .build()
        .unwrap();
    let handle = app.handle();
    let directory = app.path().app_data_dir().unwrap();
    std::fs::create_dir_all(&directory).unwrap();
    let storage = Storage::open(directory.join("latentmail.sqlite")).unwrap();
    app.manage(storage.clone());
    latentmail_lib::settings::initialize(handle, storage.clone()).unwrap();
    latentmail_lib::auth::initialize(handle, storage.clone()).unwrap();
    upsert_default_account(&storage.connection().unwrap());
    latentmail_lib::auth::save_refresh_token("account", "stored-refresh-token").unwrap();
    latentmail_lib::sync::initialize(handle, storage.clone()).unwrap();

    let staging = handle.state::<Arc<Staging>>().inner().clone();
    let coalescer = handle.state::<Arc<SaveCoalescer>>().inner().clone();
    let queue = handle.state::<Arc<QueueEngine>>().inner().clone();
    BootedDraftApp {
        app: app,
        _home: home,
        storage: storage,
        staging: staging,
        coalescer: coalescer,
        queue: queue,
    }
}

pub(super) fn boot(server: &MockServer) -> BootedDraftApp {
    boot_with_gmail_base(format!("{}/token", server.uri()), server.uri())
}

pub(super) fn boot_with_dead_gmail_base(server: &MockServer) -> BootedDraftApp {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let dead_port = listener.local_addr().unwrap().port();
    drop(listener);
    boot_with_gmail_base(
        format!("{}/token", server.uri()),
        format!("http://127.0.0.1:{dead_port}"),
    )
}

pub(super) fn mock_token() -> Mock {
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "fresh-access-token",
            "token_type": "Bearer",
        })))
}

pub(super) async fn wait_for<F: Fn() -> bool>(condition: F) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
    while !condition() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "condition never became true within the test budget"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

pub(super) async fn wait_for_queue_idle(queue: &QueueEngine) {
    wait_for(|| queue.summary().pending == 0 && queue.summary().active == 0).await;
}

pub(super) fn failed_reports(
    app: &tauri::App<tauri::test::MockRuntime>,
) -> Arc<Mutex<Vec<serde_json::Value>>> {
    let reported = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let sink = Arc::clone(&reported);
    app.handle()
        .listen(latentmail_lib::events::COMPOSE_FAILED, move |event| {
            sink.lock()
                .unwrap()
                .push(serde_json::from_str(event.payload()).unwrap());
        });
    reported
}

pub(super) fn operation_status(storage: &Storage, id: &str) -> String {
    OperationRepository::get(&storage.connection().unwrap(), id)
        .unwrap()
        .unwrap()
        .status
}

pub(super) fn stage_text_file(
    staging: &Staging,
    owner: &str,
    id: &str,
) -> (tempfile::NamedTempFile, StagedPart) {
    let source = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(source.path(), b"canonical bytes").unwrap();
    let part = staging
        .stage_path(StagePathRequest {
            scope: OwnerScope {
                account_id: "account",
                owner: owner,
            },
            source: source.path(),
            id: id,
            mime_type: "text/plain".into(),
            content_id: None,
        })
        .unwrap();
    (source, part)
}

pub(super) async fn admit_on_booted(
    booted: &BootedDraftApp,
    admission: drafts::DraftAdmission,
    parts: &[StagedPart],
) {
    drafts::admit(
        &drafts::AdmissionServices {
            queue: &booted.queue,
            storage: &booted.storage,
            staging: &booted.staging,
            coalescer: &booted.coalescer,
        },
        admission,
        parts,
    )
    .await
    .unwrap();
}

pub(super) fn default_target() -> DraftTarget<'static> {
    DraftTarget {
        account_id: "account",
        draft_id: "d1",
    }
}

fn compose_request_json(draft_id: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "sessionId": "session", "accountId": "account", "draftId": draft_id,
        "from": "me@example.com", "to": ["them@example.com"], "cc": [], "bcc": [],
        "subject": "Subject", "html": "<p>Body</p>", "quoteHtml": null,
        "quotePlain": null, "mode": "new", "threadId": null, "inReplyTo": null,
        "references": [], "originalMessageId": null, "originalGmailMessageId": null,
        "attachments": []
    })
}

async fn operation_mode(storage: &Storage, operation_id: String) -> serde_json::Value {
    let operation = storage
        .run(move |connection| OperationRepository::get(connection, &operation_id))
        .await
        .unwrap()
        .unwrap();
    serde_json::from_str::<serde_json::Value>(&operation.payload).unwrap()["mode"].clone()
}

fn seed_original_message_with_inline(storage: &Storage) {
    let connection = storage.connection().unwrap();
    MessageRepository::write_full_state(
        &connection,
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
        &connection,
        MessageKey {
            account_id: "account",
            message_id: "original",
        },
        &[InlinePart {
            content_id: "logo".into(),
            mime_type: "image/png".into(),
            bytes: vec![1, 2, 3],
        }],
    )
    .unwrap();
}

fn assert_staged_save_and_release(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>) {
    let staged = invoke(
        webview,
        "stage_attachment_from_bytes",
        serde_json::json!({
            "accountId": "account", "owner": "session", "filename": "inline.png",
            "mimeType": "image/png", "contentId": "inline-1", "bytes": [1, 2, 3]
        }),
    )
    .unwrap();
    assert_eq!(staged["size"], 3);
    let mut with_part = compose_request_json(None);
    with_part["attachments"] = serde_json::json!([{
        "id": staged["id"],
        "filename": "inline.png",
        "mimeType": "image/png",
        "contentId": "inline-1",
    }]);
    assert!(invoke(
        webview,
        "save_compose_draft",
        serde_json::json!({ "draft": with_part }),
    )
    .is_ok());
    let mut missing_part = compose_request_json(None);
    missing_part["attachments"] = serde_json::json!([{
        "id": "never-staged",
        "filename": "gone.txt",
        "mimeType": "text/plain",
        "contentId": null,
    }]);
    assert!(invoke(
        webview,
        "save_compose_draft",
        serde_json::json!({ "draft": missing_part }),
    )
    .is_err());
    invoke(
        webview,
        "release_staged_attachment",
        serde_json::json!({ "accountId": "account", "owner": "session", "id": staged["id"] }),
    )
    .unwrap();
}

fn wrapper_dispatch_cases() -> Vec<(&'static str, serde_json::Value)> {
    let mut cases = read_wrapper_dispatch_cases();
    cases.extend(mutation_wrapper_dispatch_cases());
    cases
}

fn read_wrapper_dispatch_cases() -> Vec<(&'static str, serde_json::Value)> {
    vec![
        ("list_labels", serde_json::json!({ "accountId": "account" })),
        (
            "lookup_contacts",
            serde_json::json!({ "accountId": "account", "query": "al" }),
        ),
        (
            "reply_context",
            serde_json::json!({ "accountId": "account", "messageId": "missing", "accountEmail": "me@example.com", "replyAll": false, "forward": false }),
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
            "read_traversal_status",
            serde_json::json!({ "accountId": "account" }),
        ),
    ]
}

fn mutation_wrapper_dispatch_cases() -> Vec<(&'static str, serde_json::Value)> {
    vec![
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
    ]
}

fn failing_wrapper_cases() -> Vec<(&'static str, serde_json::Value)> {
    vec![
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
    ]
}

async fn mount_create_and_update_mocks(server: &MockServer) {
    mock_token().mount(server).await;
    Mock::given(method("POST"))
        .and(path("/upload/gmail/v1/users/me/drafts"))
        .respond_with(ResponseTemplate::new(200).set_body_json(draft_response("d1", "m1", "t1")))
        .mount(server)
        .await;
    Mock::given(method("PUT"))
        .and(path("/upload/gmail/v1/users/me/drafts/d1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(draft_response("d1", "m2", "t1")))
        .mount(server)
        .await;
    let hydrate_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    Mock::given(method("GET"))
        .and(path("/gmail/v1/users/me/drafts/d1"))
        .respond_with(move |_: &wiremock::Request| {
            let call = hydrate_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let message_id = match call {
                0 => "m1",
                _ => "m2",
            };
            ResponseTemplate::new(200).set_body_json(draft_response("d1", message_id, "t1"))
        })
        .mount(server)
        .await;
}

struct DirectExecutorHarness {
    _directory: tempfile::TempDir,
    storage: Storage,
    staging: Arc<Staging>,
    coalescer: Arc<SaveCoalescer>,
    queue: Arc<QueueEngine>,
    _app: tauri::App<tauri::test::MockRuntime>,
}

fn build_direct_executor_harness(server: &MockServer) -> DirectExecutorHarness {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    upsert_default_account(&storage.connection().unwrap());
    std::env::set_var("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    std::env::set_var(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    latentmail_lib::auth::save_refresh_token("account", "stored-refresh-token").unwrap();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let staging = Arc::new(Staging::new(directory.path().join("staged")));
    let coalescer = Arc::new(SaveCoalescer::new());
    let queue = QueueEngine::new(
        250,
        250,
        drafts::build_executor(DraftExecutorContext {
            app: app.handle().clone(),
            storage: storage.clone(),
            staging: Arc::clone(&staging),
            coalescer: Arc::clone(&coalescer),
            base_url: format!("{}/gmail/v1", server.uri()),
        }),
    );
    app.manage(AuthService::new(storage.clone()));
    DirectExecutorHarness {
        _directory: directory,
        storage: storage,
        staging: staging,
        coalescer: coalescer,
        queue: queue,
        _app: app,
    }
}

async fn admit_direct(
    harness: &DirectExecutorHarness,
    admission: drafts::DraftAdmission,
    parts: &[StagedPart],
) {
    drafts::admit(
        &drafts::AdmissionServices {
            queue: &harness.queue,
            storage: &harness.storage,
            staging: &harness.staging,
            coalescer: &harness.coalescer,
        },
        admission,
        parts,
    )
    .await
    .unwrap();
    wait_for_queue_idle(&harness.queue).await;
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

    let services = drafts::AdmissionServices {
        queue: &queue,
        storage: &storage,
        staging: &staging,
        coalescer: &coalescer,
    };
    let admission = drafts::DraftAdmission {
        id: "operation".into(),
        account_id: "account".into(),
        entity_key: "session".into(),
        payload: base_payload(DraftOperationMode::Create, None),
    };
    let error = drafts::admit(
        &services,
        admission,
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

#[tokio::test]
async fn compose_save_and_send_commands_persist_their_respective_durable_modes() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    upsert_default_account(&storage.connection().unwrap());
    let queue = QueueEngine::no_op();
    queue.pause();
    let app = compose_dispatch_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(storage.clone());
    app.manage(queue);
    app.manage(Arc::new(Staging::new(directory.path().join("staged"))));
    app.manage(Arc::new(SaveCoalescer::new()));
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let created = invoke(
        &webview,
        "save_compose_draft",
        serde_json::json!({ "draft": compose_request_json(None) }),
    )
    .unwrap();
    let updated = invoke(
        &webview,
        "save_compose_draft",
        serde_json::json!({ "draft": compose_request_json(Some("d1")) }),
    )
    .unwrap();
    let sent = invoke(
        &webview,
        "send_compose_draft",
        serde_json::json!({ "draft": compose_request_json(Some("d1")) }),
    )
    .unwrap();
    assert!(created["draftId"].is_null());
    assert_eq!(updated["draftId"], "d1");
    assert_eq!(sent["draftId"], "d1");

    assert_staged_save_and_release(&webview);

    for (result, expected_mode) in [(&created, "create"), (&updated, "update"), (&sent, "send")] {
        let operation_id = result["operationId"].as_str().unwrap().to_owned();
        assert_eq!(operation_mode(&storage, operation_id).await, expected_mode);
    }
}

#[tokio::test]
async fn compose_and_mail_command_wrappers_dispatch_with_managed_test_state() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let registry = WorkRegistry::new();
    let queue = latentmail_lib::sync::create_queue_engine(250, 250, registry.clone());
    let app = compose_dispatch_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(AuthService::new(storage.clone()));
    app.manage(SyncEngine::new(SyncEngineDeps {
        storage: storage.clone(),
        queue: queue,
        registry: registry,
        events: noop_event_sink(),
    }));
    app.manage(storage);
    app.manage(Arc::new(Staging::new(directory.path().join("staged"))));
    app.manage(Arc::new(SaveCoalescer::new()));
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    for (command, body) in wrapper_dispatch_cases() {
        let _ = invoke(&webview, command, body);
    }
    for (command, body) in failing_wrapper_cases() {
        assert!(invoke(&webview, command, body).is_err(), "{command}");
    }
}

async fn mount_create_and_fetch_draft_mocks(server: &MockServer) {
    mock_token().mount(server).await;
    Mock::given(method("POST"))
        .and(path("/upload/gmail/v1/users/me/drafts"))
        .respond_with(ResponseTemplate::new(200).set_body_json(draft_response("d1", "m1", "t1")))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/drafts/d1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(draft_response("d1", "m1", "t1")))
        .mount(server)
        .await;
}

async fn persist_interrupted_create_operation(booted: &BootedDraftApp) {
    let generation = booted.coalescer.schedule("draft:local-session").await;
    let mut payload = base_payload(DraftOperationMode::Create, None);
    payload.original_message_id = Some("original".into());
    payload.coalescing_generation = generation;
    let payload_json = serde_json::to_string(&payload).unwrap();
    OperationRepository::upsert(
        &booted.storage.connection().unwrap(),
        &Operation {
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
    .unwrap();
}

async fn recover_and_replay_durable_operations(booted: &BootedDraftApp) {
    let recovered = booted
        .storage
        .run(latentmail_lib::queue::recover_durable_operations)
        .await
        .unwrap();
    assert!(recovered.uncertain_accounts.is_empty());
    assert_eq!(recovered.pending.len(), 1);
    for operation in &recovered.pending {
        let queue_operation = latentmail_lib::queue::recovered_queue_operation(operation).unwrap();
        booted.queue.enqueue(queue_operation).await.unwrap();
    }
    wait_for_queue_idle(&booted.queue).await;
}

#[tokio::test]
async fn create_recovers_from_a_simulated_interruption_using_only_the_persisted_manifest() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    mount_create_and_fetch_draft_mocks(&server).await;
    let booted = boot(&server);
    seed_original_message_with_inline(&booted.storage);
    let (source, part) = stage_text_file(&booted.staging, "local-session", "part-1");
    booted.staging.snapshot("op-create", &[part]).unwrap();
    std::fs::remove_file(source.path()).ok();

    persist_interrupted_create_operation(&booted).await;
    recover_and_replay_durable_operations(&booted).await;

    let connection = booted.storage.connection().unwrap();
    assert!(
        MessageRepository::get(&connection, "account", "m1")
            .unwrap()
            .is_some(),
        "recovered create must materialize the resulting message"
    );
    assert!(
        ComposeDraftMetadataRepository::get(&connection, "account", "d1")
            .unwrap()
            .is_some()
    );
}

async fn admit_local_session_create(
    harness: &DirectExecutorHarness,
    operation_id: &str,
    part: &StagedPart,
) {
    admit_direct(
        harness,
        drafts::DraftAdmission {
            id: operation_id.into(),
            account_id: "account".into(),
            entity_key: "draft:local-session".into(),
            payload: base_payload(DraftOperationMode::Create, None),
        },
        std::slice::from_ref(part),
    )
    .await;
}

struct ExpectedUpdate<'a> {
    operation_id: &'a str,
    message_id: &'a str,
}

async fn admit_update_and_assert_materialized(
    harness: &DirectExecutorHarness,
    expected: ExpectedUpdate<'_>,
    part: &StagedPart,
) {
    admit_direct(
        harness,
        drafts::DraftAdmission {
            id: expected.operation_id.into(),
            account_id: "account".into(),
            entity_key: "draft:d1".into(),
            payload: base_payload(DraftOperationMode::Update, Some("d1")),
        },
        std::slice::from_ref(part),
    )
    .await;
    assert!(
        MessageRepository::get(
            &harness.storage.connection().unwrap(),
            "account",
            expected.message_id
        )
        .unwrap()
        .is_some(),
        "operation {} must materialize {}",
        expected.operation_id,
        expected.message_id
    );
    assert!(harness
        .staging
        .snapshot_manifest(expected.operation_id)
        .is_err());
}

struct RequestRoute<'a> {
    method: &'a str,
    path: &'a str,
}

fn request_matches_route(request: &wiremock::Request, route: &RequestRoute<'_>) -> bool {
    let method_matches = request.method.as_str() == route.method;
    let path_matches = request.url.path() == route.path;
    method_matches && path_matches
}

fn count_requests(requests: &[wiremock::Request], route: RequestRoute<'_>) -> usize {
    requests
        .iter()
        .filter(|request| request_matches_route(request, &route))
        .count()
}

#[tokio::test]
async fn first_create_stably_promotes_later_session_save_to_update_and_retains_parts() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    mount_create_and_update_mocks(&server).await;
    let harness = build_direct_executor_harness(&server);
    let (_source, part) = stage_text_file(&harness.staging, "local-session", "part-1");

    admit_local_session_create(&harness, "op-1", &part).await;
    assert_eq!(operation_status(&harness.storage, "op-1"), "done");
    assert!(
        MessageRepository::get(&harness.storage.connection().unwrap(), "account", "m1")
            .unwrap()
            .is_some()
    );
    assert!(
        harness.staging.snapshot_manifest("op-1").is_err(),
        "a completed create removes its own snapshot"
    );
    assert!(part.path.exists(), "canonical draft-owned data survives");

    admit_local_session_create(&harness, "op-coalesced-create", &part).await;
    assert_eq!(
        operation_status(&harness.storage, "op-coalesced-create"),
        "done"
    );

    for (operation_id, message_id) in [("op-2", "m2"), ("op-3", "m2")] {
        let expected = ExpectedUpdate {
            operation_id: operation_id,
            message_id: message_id,
        };
        admit_update_and_assert_materialized(&harness, expected, &part).await;
    }
    assert!(part.path.exists(), "canonical parts survive both updates");
    let requests = server.received_requests().await.unwrap();
    let create_route = RequestRoute {
        method: "POST",
        path: "/upload/gmail/v1/users/me/drafts",
    };
    assert_eq!(
        count_requests(&requests, create_route),
        1,
        "the overlapping session save must not create a second Gmail draft"
    );
    let update_route = RequestRoute {
        method: "PUT",
        path: "/upload/gmail/v1/users/me/drafts/d1",
    };
    assert_eq!(count_requests(&requests, update_route), 3);
}

#[tokio::test]
async fn a_save_superseded_before_it_runs_is_coalesced_rather_than_uploaded() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    mock_token().mount(&server).await;
    let booted = boot(&server);

    booted.queue.pause();
    admit_on_booted(
        &booted,
        drafts::DraftAdmission {
            id: "op-stale".into(),
            account_id: "account".into(),
            entity_key: "draft:local-session".into(),
            payload: base_payload(DraftOperationMode::Create, None),
        },
        &[],
    )
    .await;
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
    admit_on_booted(
        &booted,
        drafts::DraftAdmission {
            id: "op-fresh".into(),
            account_id: "account".into(),
            entity_key: "draft:local-session".into(),
            payload: base_payload(DraftOperationMode::Create, None),
        },
        &[],
    )
    .await;
    booted.queue.resume();
    wait_for_queue_idle(&booted.queue).await;

    assert_eq!(operation_status(&booted.storage, "op-stale"), "superseded");
    assert_eq!(operation_status(&booted.storage, "op-fresh"), "done");
}
