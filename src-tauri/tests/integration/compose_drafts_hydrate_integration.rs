use crate::compose_drafts_save_integration::{
    compose_dispatch_builder, draft_response, invoke, mock_token, upsert_default_account, APP_ENV,
};
use latentmail_lib::auth::AuthService;
use latentmail_lib::compose::{drafts, staging::Staging};
use latentmail_lib::ipc::{AccountIdRequest, AppServices, CommandPayload};
use latentmail_lib::storage::{ComposeDraftMetadata, ComposeDraftMetadataRepository, Storage};
use latentmail_lib::sync::commands::{
    ListThreadsRequest, LoadConversationRequest, LookupContactsRequest,
};
use latentmail_lib::sync::{noop_event_sink, SyncEngine, SyncEngineDeps, WorkRegistry};
use std::sync::Arc;
use tauri::Manager;
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

struct HydrationApp {
    _directory: tempfile::TempDir,
    app: tauri::App<tauri::test::MockRuntime>,
    webview: tauri::WebviewWindow<tauri::test::MockRuntime>,
}

fn build_hydration_app(server: &MockServer) -> HydrationApp {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    upsert_default_account(&storage.connection().unwrap());
    crate::support::set_env("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    crate::support::set_env(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    crate::support::set_env("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    latentmail_lib::auth::save_refresh_token("account", "refresh-token").unwrap();

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
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    HydrationApp {
        _directory: directory,
        app: app,
        webview: webview,
    }
}

fn upsert_reply_draft_metadata(storage: &Storage, fingerprint: &str, quote_html: &str) {
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
            editable_body_fingerprint: Some(fingerprint.into()),
            quote_html: Some(quote_html.into()),
            quote_plain: Some("quote".into()),
        },
    )
    .unwrap();
}

async fn assert_empty_mail_commands(
    app: &tauri::App<tauri::test::MockRuntime>,
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
) {
    assert_empty_mail_listings(app).await;
    assert_missing_conversation_and_traversal_reads(app).await;
    assert_invalid_mail_mutations_are_rejected(webview);
}

async fn assert_empty_mail_listings(app: &tauri::App<tauri::test::MockRuntime>) {
    assert!(latentmail_lib::sync::commands::list_labels(
        AppServices::new(app.handle()),
        CommandPayload(AccountIdRequest {
            account_id: "account".into()
        })
    )
    .await
    .unwrap()
    .is_empty());
    assert!(latentmail_lib::sync::commands::lookup_contacts(
        AppServices::new(app.handle()),
        CommandPayload(LookupContactsRequest {
            account_id: "account".into(),
            query: "x".into()
        })
    )
    .await
    .unwrap()
    .is_empty());
    assert!(latentmail_lib::sync::commands::list_threads(
        AppServices::new(app.handle()),
        CommandPayload(ListThreadsRequest {
            account_id: "account".into(),
            label_id: None,
            cursor: None,
            direction: None,
            limit: None
        })
    )
    .await
    .unwrap()
    .items
    .is_empty());
}

async fn assert_missing_conversation_and_traversal_reads(
    app: &tauri::App<tauri::test::MockRuntime>,
) {
    assert!(latentmail_lib::sync::commands::load_conversation(
        AppServices::new(app.handle()),
        CommandPayload(LoadConversationRequest {
            account_id: "account".into(),
            thread_id: "missing".into(),
            image_policy: None,
            entry_scope: None
        })
    )
    .await
    .unwrap()
    .messages
    .is_empty());
    assert_eq!(
        serde_json::to_value(
            latentmail_lib::sync::commands::read_traversal_status(
                AppServices::new(app.handle()),
                CommandPayload(AccountIdRequest {
                    account_id: "account".into()
                })
            )
            .await
            .unwrap()
        )
        .unwrap()["accountId"],
        "account"
    );
}

fn assert_invalid_mail_mutations_are_rejected(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
) {
    assert!(invoke(
        webview,
        "mutate_messages",
        serde_json::json!({
            "accountId": "account", "messageIds": ["missing"], "add": ["DRAFT"], "remove": []
        }),
    )
    .is_err());
    assert!(invoke(
        webview,
        "create_label",
        serde_json::json!({ "accountId": "account", "name": "Label", "colorId": "not-a-colour" }),
    )
    .is_err());
    assert!(invoke(
        webview,
        "recolor_label",
        serde_json::json!({ "accountId": "account", "labelId": "Label_1", "colorId": "not-a-colour" }),
    )
    .is_err());
}

async fn mount_remote_draft_mocks(server: &MockServer) {
    mock_token().mount(server).await;
    let mut hydrated_draft = draft_response("d1", "m1", "t1");
    hydrated_draft["message"]["payload"] = serde_json::json!({
        "mimeType": "text/html",
        "headers": [
            {"name": "Subject", "value": "Hello"},
            {"name": "To", "value": "\"Doe, John\" <one@example.com>, two@example.com"},
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
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/users/me/messages/m1/attachments/a1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({ "data": "bm90ZXM" })),
        )
        .mount(server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/users/me/drafts/d1"))
        .respond_with(ResponseTemplate::new(204))
        .mount(server)
        .await;
}

#[tokio::test]
async fn compose_hydration_restores_a_remote_draft_and_empty_discard_is_a_no_op() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    mount_remote_draft_mocks(&server).await;
    let harness = build_hydration_app(&server);
    upsert_reply_draft_metadata(&harness.app.state::<Storage>(), "stale", "<p>quote</p>");
    assert_empty_mail_commands(&harness.app, &harness.webview).await;

    let hydrated = invoke(
        &harness.webview,
        "hydrate_compose_draft",
        serde_json::json!({ "accountId": "account", "draftId": "d1" }),
    )
    .unwrap();
    assert_eq!(hydrated["draftId"], "d1");
    assert_eq!(
        hydrated["to"],
        serde_json::json!(["\"Doe, John\" <one@example.com>", "two@example.com"])
    );
    assert_eq!(hydrated["mode"], "draft");
    assert_eq!(hydrated["attachments"][0]["filename"], "notes.txt");
    assert!(ComposeDraftMetadataRepository::get(
        &harness.app.state::<Storage>().connection().unwrap(),
        "account",
        "d1",
    )
    .unwrap()
    .is_none());

    upsert_reply_draft_metadata(&harness.app.state::<Storage>(), "", "");
    let restored = invoke(
        &harness.webview,
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
        &harness.webview,
        "discard_compose_draft",
        serde_json::json!({ "accountId": "account", "draftId": null, "sessionId": "session" }),
    )
    .unwrap();
    invoke(
        &harness.webview,
        "discard_compose_draft",
        serde_json::json!({ "accountId": "account", "draftId": "d1", "sessionId": "session" }),
    )
    .unwrap();
}

#[tokio::test]
async fn hydrate_stages_a_draft_attachment_that_carries_its_bytes_inline() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    mock_token().mount(&server).await;
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

    let harness = build_hydration_app(&server);
    let hydrated = invoke(
        &harness.webview,
        "hydrate_compose_draft",
        serde_json::json!({ "accountId": "account", "draftId": "d1" }),
    )
    .unwrap();
    assert_eq!(hydrated["attachments"][0]["filename"], "inline.jpg");
    assert_eq!(hydrated["attachments"][0]["size"], "photo".len() as u64);
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
