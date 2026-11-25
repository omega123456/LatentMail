use latentmail_lib::ipc::{AppServices, CommandPayload};
use latentmail_lib::sync::commands::{
    CreateLabelRequest, DeleteLabelRequest, RecolorLabelRequest, RenameLabelRequest,
};
use latentmail_lib::sync::SyncEngineDeps;
use latentmail_lib::{
    auth::{save_refresh_token, AuthService},
    storage::{Account, AccountRepository, Storage},
    sync::{
        commands::{create_label, delete_label, recolor_label, rename_label},
        create_queue_engine, noop_event_sink, SyncEngine, WorkRegistry,
    },
};
use tauri::Manager;
use wiremock::{
    matchers::{method, path, path_regex},
    Mock, MockServer, ResponseTemplate,
};

struct Harness {
    app: tauri::App<tauri::test::MockRuntime>,
    database: std::path::PathBuf,
    _directory: tempfile::TempDir,
    _server: MockServer,
}

async fn start_mock_label_server() -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(
                serde_json::json!({ "access_token": "fresh", "token_type": "Bearer" }),
            ),
        )
        .mount(&server)
        .await;
    Mock::given(path_regex(r"^/users/me/labels.*$"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({ "id": "Label_1", "name": "Renamed" })),
        )
        .mount(&server)
        .await;
    server
}

async fn harness(account_id: &str) -> Harness {
    let server = start_mock_label_server().await;
    crate::support::set_env("LATENTMAIL_GOOGLE_CLIENT_ID", "client");
    crate::support::set_env(
        "LATENTMAIL_GOOGLE_TOKEN_URL",
        format!("{}/token", server.uri()),
    );
    crate::support::set_env("LATENTMAIL_GMAIL_BASE_URL", server.uri());
    save_refresh_token(account_id, "refresh").unwrap();

    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("mail.sqlite");
    let storage = Storage::open(&database).unwrap();
    AccountRepository::upsert(
        &storage.connection().unwrap(),
        &Account {
            id: account_id.into(),
            email: format!("{account_id}@example.com"),
            display_name: "Account".into(),
            avatar_url: None,
            history_id: None,
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    let registry = WorkRegistry::new();
    let engine = SyncEngine::new(SyncEngineDeps {
        storage: storage.clone(),
        queue: create_queue_engine(250, 250, registry.clone()),
        registry: registry,
        events: noop_event_sink(),
    });
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(AuthService::new(storage.clone()));
    app.manage(engine);
    app.manage(storage);
    Harness {
        app: app,
        database: database,
        _directory: directory,
        _server: server,
    }
}

#[tokio::test]
async fn creating_and_renaming_a_label_surface_an_unreadable_database_before_calling_gmail() {
    let harness = harness("label-validate").await;
    let app = &harness.app;
    std::fs::write(&harness.database, b"not a database").unwrap();

    assert!(create_label(
        AppServices::new(app.handle()),
        CommandPayload(CreateLabelRequest {
            account_id: "label-validate".into(),
            name: "Receipts".into(),
            color_id: None
        })
    )
    .await
    .is_err());
    assert!(rename_label(
        AppServices::new(app.handle()),
        CommandPayload(RenameLabelRequest {
            account_id: "label-validate".into(),
            label_id: "Label_1".into(),
            name: "Receipts".into()
        })
    )
    .await
    .is_err());
}

#[tokio::test]
async fn recoloring_and_deleting_a_label_surface_an_unreadable_database_after_calling_gmail() {
    let harness = harness("label-persist").await;
    let app = &harness.app;
    std::fs::write(&harness.database, b"not a database").unwrap();

    assert!(recolor_label(
        AppServices::new(app.handle()),
        CommandPayload(RecolorLabelRequest {
            account_id: "label-persist".into(),
            label_id: "Label_1".into(),
            color_id: "red".into()
        })
    )
    .await
    .is_err());
    assert!(delete_label(
        AppServices::new(app.handle()),
        CommandPayload(DeleteLabelRequest {
            account_id: "label-persist".into(),
            label_id: "Label_1".into()
        })
    )
    .await
    .is_err());
}

#[tokio::test]
async fn recoloring_a_label_rejects_an_unrecognised_colour() {
    let harness = harness("label-colour").await;
    let app = &harness.app;

    assert_eq!(
        recolor_label(
            AppServices::new(app.handle()),
            CommandPayload(RecolorLabelRequest {
                account_id: "label-colour".into(),
                label_id: "Label_1".into(),
                color_id: "chartreuse".into()
            })
        )
        .await
        .unwrap_err(),
        "'chartreuse' is not a recognised label colour"
    );
}
