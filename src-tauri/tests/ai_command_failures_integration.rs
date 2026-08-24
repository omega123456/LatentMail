use latentmail_lib::{
    ai::{commands, AiService},
    storage::{Account, AccountRepository, Storage},
    sync::{create_queue_engine, noop_event_sink, SyncEngine, WorkRegistry},
};
use tauri::Manager;
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

fn account() -> Account {
    Account {
        id: "account".into(),
        email: "account@example.com".into(),
        display_name: "Account".into(),
        avatar_url: None,
        history_id: None,
        needs_reauthentication: false,
        created_at: 1,
        updated_at: 1,
    }
}

struct Harness {
    app: tauri::App<tauri::test::MockRuntime>,
    database: std::path::PathBuf,
    _directory: tempfile::TempDir,
}

fn harness() -> Harness {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("mail.sqlite");
    let storage = Storage::open(&database).unwrap();
    AccountRepository::upsert(&storage.connection().unwrap(), &account()).unwrap();
    let registry = WorkRegistry::new();
    let sync = SyncEngine::new(
        storage.clone(),
        create_queue_engine(250, 250, registry.clone()),
        registry,
        noop_event_sink(),
    );
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(AiService::new(storage.clone()));
    app.manage(sync);
    Harness {
        app,
        database,
        _directory: directory,
    }
}

#[tokio::test]
async fn provider_commands_require_a_saved_api_root() {
    let harness = harness();
    let app = &harness.app;
    commands::set_ai_enabled(app.handle().clone(), app.state(), "account".into(), true)
        .await
        .unwrap();

    assert_eq!(
        commands::test_ai_connection(app.state(), "account".into())
            .await
            .unwrap_err(),
        "Save an API root first"
    );
    assert_eq!(
        commands::list_ai_models(app.state(), "account".into())
            .await
            .unwrap_err(),
        "Save an API root first"
    );
    assert_eq!(
        commands::select_ai_embedding_model(
            app.handle().clone(),
            app.state(),
            app.state(),
            "account".into(),
            "embedding".into(),
        )
        .await
        .unwrap_err(),
        "Save an API root first"
    );
}

#[tokio::test]
async fn provider_commands_surface_a_failing_model_catalogue() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    let harness = harness();
    let app = &harness.app;
    commands::set_ai_base_url(
        app.handle().clone(),
        app.state(),
        "account".into(),
        format!("{}/v1", server.uri()),
    )
    .await
    .unwrap();

    assert!(commands::test_ai_connection(app.state(), "account".into())
        .await
        .is_err());
    assert!(commands::list_ai_models(app.state(), "account".into())
        .await
        .is_err());
}

#[tokio::test]
async fn selecting_an_embedding_model_surfaces_a_failing_provider() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    let harness = harness();
    let app = &harness.app;
    commands::set_ai_base_url(
        app.handle().clone(),
        app.state(),
        "account".into(),
        format!("{}/v1", server.uri()),
    )
    .await
    .unwrap();

    assert!(commands::select_ai_embedding_model(
        app.handle().clone(),
        app.state(),
        app.state(),
        "account".into(),
        "embedding".into(),
    )
    .await
    .is_err());
}

#[tokio::test]
async fn selecting_an_embedding_model_rejects_a_missing_vector_from_the_provider() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": []})),
        )
        .mount(&server)
        .await;
    let harness = harness();
    let app = &harness.app;
    commands::set_ai_base_url(
        app.handle().clone(),
        app.state(),
        "account".into(),
        format!("{}/v1", server.uri()),
    )
    .await
    .unwrap();

    assert_eq!(
        commands::select_ai_embedding_model(
            app.handle().clone(),
            app.state(),
            app.state(),
            "account".into(),
            "embedding".into(),
        )
        .await
        .unwrap_err(),
        "Provider returned no embedding"
    );
}

#[tokio::test]
async fn ai_commands_surface_an_unreadable_database_instead_of_panicking() {
    let harness = harness();
    let app = &harness.app;
    std::fs::write(&harness.database, b"this is not a database").unwrap();

    assert!(commands::read_ai_configs(app.state()).await.is_err());
    assert!(
        commands::set_ai_enabled(app.handle().clone(), app.state(), "account".into(), true)
            .await
            .is_err()
    );
    assert!(commands::set_ai_base_url(
        app.handle().clone(),
        app.state(),
        "account".into(),
        "http://127.0.0.1:1/v1".into(),
    )
    .await
    .is_err());
    assert!(commands::select_ai_chat_model(
        app.handle().clone(),
        app.state(),
        "account".into(),
        Some("chat".into()),
    )
    .await
    .is_err());
    assert!(commands::read_ai_index_status(app.state()).await.is_err());
    assert!(commands::start_ai_index(
        app.handle().clone(),
        app.state(),
        app.state(),
        "account".into(),
    )
    .await
    .is_err());
    assert!(commands::cancel_ai_index(app.handle().clone(), app.state(), "account".into())
        .await
        .is_err());
    assert!(commands::rebuild_ai_index(
        app.handle().clone(),
        app.state(),
        app.state(),
        "account".into(),
    )
    .await
    .is_err());
}
