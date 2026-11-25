use latentmail_lib::ai::commands::{
    SelectAiChatModelPayload, SelectAiEmbeddingModelPayload, SetAiApiKeyPayload,
    SetAiBaseUrlPayload, SetAiEnabledPayload,
};
use latentmail_lib::ai::index::{IndexContext, RetryEmbeddingRequest};
use latentmail_lib::ai::{BaseUrlUpdate, ChatModelUpdate, EmbeddingModelUpdate, EnabledUpdate};
use latentmail_lib::ipc::{AppServices, CommandPayload};
use latentmail_lib::storage::{EmbeddingModelSpec, NearestQuery};
use latentmail_lib::sync::SyncEngineDeps;
use std::time::Duration;

use latentmail_lib::{
    ai::{
        commands, credentials,
        index::{build, cleanup, embed_with_retry, enqueue, statuses},
        provider::Provider,
        AiService, IndexState,
    },
    storage::{
        Account, AccountAiConfigRepository, AccountRepository, EmbeddingRepository, HtmlPresence,
        Message, MessageRepository, Storage,
    },
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

struct TestHarness {
    _directory: tempfile::TempDir,
    storage: Storage,
    app: tauri::App<tauri::test::MockRuntime>,
    service: AiService,
    sync: std::sync::Arc<SyncEngine>,
}

fn build_harness() -> TestHarness {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    AccountRepository::upsert(&storage.connection().unwrap(), &account()).unwrap();
    let registry = WorkRegistry::new();
    let sync = SyncEngine::new(SyncEngineDeps {
        storage: storage.clone(),
        queue: create_queue_engine(250, 250, registry.clone()),
        registry: registry,
        events: noop_event_sink(),
    });
    let service = AiService::new(storage.clone());
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(service.clone());
    app.manage(std::sync::Arc::clone(&sync));
    TestHarness {
        _directory: directory,
        storage: storage,
        app: app,
        service: service,
        sync: sync,
    }
}

async fn has_embedding_model(app: &tauri::App<tauri::test::MockRuntime>, expected: &str) -> bool {
    app.state::<AiService>()
        .config_for("account")
        .await
        .unwrap()
        .embedding_model
        .as_deref()
        == Some(expected)
}

async fn wait_for_embedding_model(app: &tauri::App<tauri::test::MockRuntime>, expected: &str) {
    tokio::time::timeout(Duration::from_secs(1), async {
        while !has_embedding_model(app, expected).await {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

async fn configure_provider_via_commands(
    app: &tauri::App<tauri::test::MockRuntime>,
    base_url: String,
) {
    commands::set_ai_enabled(
        AppServices::new(app.handle()),
        CommandPayload(SetAiEnabledPayload {
            account_id: "account".into(),
            enabled: true,
        }),
    )
    .await
    .unwrap();
    commands::set_ai_base_url(
        AppServices::new(app.handle()),
        CommandPayload(SetAiBaseUrlPayload {
            account_id: "account".into(),
            base_url: base_url,
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        commands::set_ai_api_key(
            AppServices::new(app.handle()),
            CommandPayload(SetAiApiKeyPayload {
                account_id: "account".into(),
                api_key: String::new()
            })
        )
        .await
        .unwrap_err(),
        "API key cannot be empty"
    );
    commands::set_ai_api_key(
        AppServices::new(app.handle()),
        CommandPayload(SetAiApiKeyPayload {
            account_id: "account".into(),
            api_key: "secret".into(),
        }),
    )
    .await
    .unwrap();
}

async fn configure_service_endpoint(
    app: &tauri::App<tauri::test::MockRuntime>,
    service: &AiService,
    base_url: String,
) {
    service
        .set_enabled(
            app.handle(),
            EnabledUpdate {
                account_id: "account".into(),
                enabled: true,
            },
        )
        .await
        .unwrap();
    service
        .set_base_url(
            app.handle(),
            BaseUrlUpdate {
                account_id: "account".into(),
                base_url: base_url,
            },
        )
        .await
        .unwrap();
}

fn seed_plain_message(storage: &Storage) {
    MessageRepository::write_full_state(
        &storage.connection().unwrap(),
        &Message {
            account_id: "account".into(),
            id: "message".into(),
            thread_id: "thread".into(),
            rfc_message_id: None,
            sender: "sender@example.com".into(),
            recipients: "recipient@example.com".into(),
            subject: "Subject".into(),
            sent_at: 1,
            snippet: String::new(),
            html_body: None,
            plain_body: Some("Body".into()),
            has_attachments: false,
            is_unread: false,
            is_starred: false,
            history_id: 1,
            truncated_body: Some("Body".into()),
            html_presence: HtmlPresence::Absent,
        },
    )
    .unwrap();
}

async fn assert_disabled_and_removal_guards(harness: &TestHarness) {
    harness
        .service
        .set_enabled(
            harness.app.handle(),
            EnabledUpdate {
                account_id: "account".into(),
                enabled: false,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        harness.service.index_state("account").unwrap(),
        Some(IndexState::Unavailable)
    );
    assert!(statuses(&harness.service).await.unwrap().is_empty());
    harness.service.begin_removal("account").unwrap();
    assert!(harness.service.is_removing("account").unwrap());
    assert!(!harness.service.index_ready("account").await.unwrap());
    enqueue(
        IndexContext {
            app: harness.app.handle().clone(),
            service: harness.service.clone(),
            sync: harness.sync.clone(),
        },
        "account".into(),
    )
    .await
    .unwrap();
    build(harness.app.handle(), &harness.service, "account".into())
        .await
        .unwrap();
    harness.service.begin_reconfiguration("account").unwrap();
    assert!(harness.service.is_reconfiguring("account").unwrap());
    harness.service.finish_reconfiguration("account").unwrap();
}

async fn assert_service_lifecycle_transitions(
    app: &tauri::App<tauri::test::MockRuntime>,
    service: &AiService,
) {
    service
        .set_enabled(
            app.handle(),
            EnabledUpdate {
                account_id: "account".into(),
                enabled: false,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        service.index_state("account").unwrap(),
        Some(IndexState::Unavailable)
    );
    service.begin_reconfiguration("account").unwrap();
    assert!(service.is_reconfiguring("account").unwrap());
    service.finish_reconfiguration("account").unwrap();
    service
        .set_index_error("account", "interrupted".into())
        .unwrap();
    assert_eq!(
        service.index_state("account").unwrap(),
        Some(IndexState::Interrupted)
    );
    service.clear_index_error("account").unwrap();
    service.clear_index_state("account").unwrap();
    service.begin_removal("account").unwrap();
    assert!(service.is_removing("account").unwrap());
    assert!(!service.index_ready("account").await.unwrap());
}

async fn mount_models_and_embeddings_endpoints(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": [{"id": "chat"}, {"id": "embedding", "owned_by": "local"}]
        })))
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": [{"embedding": [1.0, 2.0]}]
        })))
        .mount(server)
        .await;
}

async fn select_chat_and_embedding_models_via_commands(app: &tauri::App<tauri::test::MockRuntime>) {
    commands::select_ai_chat_model(
        AppServices::new(app.handle()),
        CommandPayload(SelectAiChatModelPayload {
            account_id: "account".into(),
            model: Some("chat".into()),
        }),
    )
    .await
    .unwrap();
    commands::select_ai_embedding_model(
        AppServices::new(app.handle()),
        CommandPayload(SelectAiEmbeddingModelPayload {
            account_id: "account".into(),
            model: "embedding".into(),
        }),
    )
    .await
    .unwrap();
}

async fn run_index_lifecycle_commands(app: &tauri::App<tauri::test::MockRuntime>) {
    commands::cancel_ai_index(AppServices::new(app.handle()), "account".into())
        .await
        .unwrap();
    commands::start_ai_index(AppServices::new(app.handle()), "account".into())
        .await
        .unwrap();
    commands::rebuild_ai_index(AppServices::new(app.handle()), "account".into())
        .await
        .unwrap();
}

#[tokio::test]
async fn commands_persist_config_manage_credentials_and_validate_models() {
    credentials::clear("account").unwrap();
    let server = MockServer::start().await;
    mount_models_and_embeddings_endpoints(&server).await;
    let harness = build_harness();
    let app = &harness.app;

    assert_eq!(
        commands::read_ai_configs(AppServices::new(app.handle()))
            .await
            .unwrap()
            .len(),
        1
    );
    configure_provider_via_commands(app, format!("{}/v1", server.uri())).await;
    assert_eq!(
        commands::test_ai_connection(AppServices::new(app.handle()), "account".into())
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        commands::list_ai_models(AppServices::new(app.handle()), "account".into())
            .await
            .unwrap()
            .len(),
        2
    );
    select_chat_and_embedding_models_via_commands(app).await;
    wait_for_embedding_model(app, "embedding").await;
    assert_eq!(
        commands::read_ai_index_status(AppServices::new(app.handle()))
            .await
            .unwrap()
            .len(),
        1
    );
    run_index_lifecycle_commands(app).await;
    commands::clear_ai_api_key(AppServices::new(app.handle()), "account".into())
        .await
        .unwrap();
    assert_eq!(credentials::load("account").unwrap(), None);
}

#[tokio::test]
async fn selecting_an_embedding_model_rejects_an_empty_vector_from_the_provider() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": [{"embedding": []}]
        })))
        .mount(&server)
        .await;
    let harness = build_harness();
    commands::set_ai_base_url(
        AppServices::new(harness.app.handle()),
        CommandPayload(SetAiBaseUrlPayload {
            account_id: "account".into(),
            base_url: format!("{}/v1", server.uri()),
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        commands::select_ai_embedding_model(
            AppServices::new(harness.app.handle()),
            CommandPayload(SelectAiEmbeddingModelPayload {
                account_id: "account".into(),
                model: "embedding".into()
            })
        )
        .await
        .unwrap_err(),
        "Provider returned an empty embedding"
    );
}

#[tokio::test]
async fn lifecycle_guards_and_invalid_index_configurations_are_safe() {
    let harness = build_harness();
    assert_disabled_and_removal_guards(&harness).await;

    let service = AiService::new(harness.storage.clone());
    service
        .set_enabled(
            harness.app.handle(),
            EnabledUpdate {
                account_id: "account".into(),
                enabled: true,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        build(harness.app.handle(), &service, "account".into())
            .await
            .unwrap_err(),
        "Select an embedding model first"
    );
    AccountAiConfigRepository::set_embedding_model(
        &harness.storage.connection().unwrap(),
        "account",
        EmbeddingModelSpec {
            model: "embedding",
            dimensions: 2,
        },
    )
    .unwrap();
    assert_eq!(
        build(harness.app.handle(), &service, "account".into())
            .await
            .unwrap_err(),
        "Save an API root first"
    );
    EmbeddingRepository::create(&harness.storage.connection().unwrap(), "account", 2).unwrap();
    credentials::save("account", "secret").unwrap();
    cleanup(&service, "account".into()).await.unwrap();
    assert_eq!(credentials::load("account").unwrap(), None);
    assert_eq!(
        embed_with_retry(
            &Provider::new("http://127.0.0.1:9/v1", None).unwrap(),
            RetryEmbeddingRequest {
                model: "embedding",
                input: vec!["mail".into()],
                attempts: 0,
                backoff: |_| Duration::ZERO
            }
        )
        .await
        .unwrap_err(),
        "Provider returned an invalid response"
    );
}

#[tokio::test]
async fn incomplete_provider_batches_fail_without_partial_embedding_writes() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": []})))
        .mount(&server)
        .await;
    let harness = build_harness();
    seed_plain_message(&harness.storage);
    configure_service_endpoint(
        &harness.app,
        &harness.service,
        format!("{}/v1", server.uri()),
    )
    .await;
    harness
        .service
        .set_embedding_model(
            harness.app.handle(),
            EmbeddingModelUpdate {
                account_id: "account".into(),
                model: "embedding".into(),
                dimensions: 2,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        build(harness.app.handle(), &harness.service, "account".into())
            .await
            .unwrap_err(),
        "Provider returned an incomplete embedding batch"
    );
    assert_eq!(
        EmbeddingRepository::count_passages(&harness.storage.connection().unwrap(), "account")
            .unwrap(),
        0
    );
}

#[test]
fn initialization_restores_vectors_for_persisted_model_dimensions() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    AccountRepository::upsert(&storage.connection().unwrap(), &account()).unwrap();
    AccountAiConfigRepository::set_embedding_model(
        &storage.connection().unwrap(),
        "account",
        EmbeddingModelSpec {
            model: "embedding",
            dimensions: 2,
        },
    )
    .unwrap();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    latentmail_lib::ai::initialize(app.handle(), storage.clone()).unwrap();
    assert!(EmbeddingRepository::nearest(
        &storage.connection().unwrap(),
        "account",
        NearestQuery {
            vector: &[1.0, 0.0],
            limit: 1
        }
    )
    .unwrap()
    .is_empty());
}

#[tokio::test]
async fn service_configuration_and_lifecycle_state_are_account_scoped() {
    let harness = build_harness();
    credentials::clear("account").unwrap();
    let config = harness.service.configs().await.unwrap().pop().unwrap();
    assert!(!config.enabled);
    assert!(!config.has_api_key);
    configure_service_endpoint(
        &harness.app,
        &harness.service,
        "http://127.0.0.1:8080/v1".into(),
    )
    .await;
    harness
        .service
        .set_chat_model(
            harness.app.handle(),
            ChatModelUpdate {
                account_id: "account".into(),
                model: Some("chat".into()),
            },
        )
        .await
        .unwrap();
    harness
        .service
        .set_embedding_model(
            harness.app.handle(),
            EmbeddingModelUpdate {
                account_id: "account".into(),
                model: "embed".into(),
                dimensions: 2,
            },
        )
        .await
        .unwrap();
    credentials::save("account", "test-key").unwrap();
    let config = harness.service.configs().await.unwrap().pop().unwrap();
    assert!(config.enabled);
    assert!(config.has_api_key);
    assert_eq!(config.chat_model.as_deref(), Some("chat"));
    assert_eq!(config.embedding_model.as_deref(), Some("embed"));
    assert!(harness.service.index_ready("account").await.unwrap());
    assert_service_lifecycle_transitions(&harness.app, &harness.service).await;
    credentials::clear("account").unwrap();
}
