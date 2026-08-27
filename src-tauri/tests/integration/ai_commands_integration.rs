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

#[tokio::test]
async fn commands_persist_config_manage_credentials_and_validate_models() {
    credentials::clear("account").unwrap();
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": [{"id": "chat"}, {"id": "embedding", "owned_by": "local"}]
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
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
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
    app.manage(AiService::new(storage));
    app.manage(sync);

    assert_eq!(
        commands::read_ai_configs(app.state()).await.unwrap().len(),
        1
    );
    commands::set_ai_enabled(app.handle().clone(), app.state(), "account".into(), true)
        .await
        .unwrap();
    commands::set_ai_base_url(
        app.handle().clone(),
        app.state(),
        "account".into(),
        format!("{}/v1", server.uri()),
    )
    .await
    .unwrap();
    assert_eq!(
        commands::set_ai_api_key(
            app.handle().clone(),
            app.state(),
            "account".into(),
            String::new(),
        )
        .await
        .unwrap_err(),
        "API key cannot be empty"
    );
    commands::set_ai_api_key(
        app.handle().clone(),
        app.state(),
        "account".into(),
        "secret".into(),
    )
    .await
    .unwrap();
    assert_eq!(
        commands::test_ai_connection(app.state(), "account".into())
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        commands::list_ai_models(app.state(), "account".into())
            .await
            .unwrap()
            .len(),
        2
    );
    commands::select_ai_chat_model(
        app.handle().clone(),
        app.state(),
        "account".into(),
        Some("chat".into()),
    )
    .await
    .unwrap();
    commands::select_ai_embedding_model(
        app.handle().clone(),
        app.state(),
        app.state(),
        "account".into(),
        "embedding".into(),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if app
                .state::<AiService>()
                .config_for("account")
                .await
                .unwrap()
                .embedding_model
                .as_deref()
                == Some("embedding")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        commands::read_ai_index_status(app.state())
            .await
            .unwrap()
            .len(),
        1
    );
    commands::cancel_ai_index(app.handle().clone(), app.state(), "account".into())
        .await
        .unwrap();
    commands::start_ai_index(
        app.handle().clone(),
        app.state(),
        app.state(),
        "account".into(),
    )
    .await
    .unwrap();
    commands::rebuild_ai_index(
        app.handle().clone(),
        app.state(),
        app.state(),
        "account".into(),
    )
    .await
    .unwrap();
    commands::clear_ai_api_key(app.handle().clone(), app.state(), "account".into())
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
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
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
    app.manage(AiService::new(storage));
    app.manage(sync);
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
        "Provider returned an empty embedding"
    );
}

#[tokio::test]
async fn lifecycle_guards_and_invalid_index_configurations_are_safe() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    AccountRepository::upsert(&storage.connection().unwrap(), &account()).unwrap();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let service = AiService::new(storage.clone());
    let registry = WorkRegistry::new();
    let sync = SyncEngine::new(
        storage.clone(),
        create_queue_engine(250, 250, registry.clone()),
        registry,
        noop_event_sink(),
    );

    service
        .set_enabled(app.handle(), "account".into(), false)
        .await
        .unwrap();
    assert_eq!(
        service.index_state("account").unwrap(),
        Some(IndexState::Unavailable)
    );
    assert!(statuses(&service).await.unwrap().is_empty());
    service.begin_removal("account").unwrap();
    assert!(service.is_removing("account").unwrap());
    assert!(!service.index_ready("account").await.unwrap());
    enqueue(
        app.handle().clone(),
        service.clone(),
        sync.clone(),
        "account".into(),
    )
    .await
    .unwrap();
    build(app.handle(), &service, "account".into())
        .await
        .unwrap();
    service.begin_reconfiguration("account").unwrap();
    assert!(service.is_reconfiguring("account").unwrap());
    service.finish_reconfiguration("account").unwrap();

    let service = AiService::new(storage.clone());
    service
        .set_enabled(app.handle(), "account".into(), true)
        .await
        .unwrap();
    assert_eq!(
        build(app.handle(), &service, "account".into())
            .await
            .unwrap_err(),
        "Select an embedding model first"
    );
    AccountAiConfigRepository::set_embedding_model(
        &storage.connection().unwrap(),
        "account",
        "embedding",
        2,
    )
    .unwrap();
    assert_eq!(
        build(app.handle(), &service, "account".into())
            .await
            .unwrap_err(),
        "Save an API root first"
    );
    EmbeddingRepository::create(&storage.connection().unwrap(), "account", 2).unwrap();
    credentials::save("account", "secret").unwrap();
    cleanup(&service, "account".into()).await.unwrap();
    assert_eq!(credentials::load("account").unwrap(), None);
    assert_eq!(
        embed_with_retry(
            &Provider::new("http://127.0.0.1:9/v1", None).unwrap(),
            "embedding",
            vec!["mail".into()],
            0,
            |_| Duration::ZERO,
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
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    AccountRepository::upsert(&storage.connection().unwrap(), &account()).unwrap();
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
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let service = AiService::new(storage.clone());
    service
        .set_enabled(app.handle(), "account".into(), true)
        .await
        .unwrap();
    service
        .set_base_url(
            app.handle(),
            "account".into(),
            format!("{}/v1", server.uri()),
        )
        .await
        .unwrap();
    service
        .set_embedding_model(app.handle(), "account".into(), "embedding".into(), 2)
        .await
        .unwrap();
    assert_eq!(
        build(app.handle(), &service, "account".into())
            .await
            .unwrap_err(),
        "Provider returned an incomplete embedding batch"
    );
    assert_eq!(
        EmbeddingRepository::count_passages(&storage.connection().unwrap(), "account").unwrap(),
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
        "embedding",
        2,
    )
    .unwrap();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    latentmail_lib::ai::initialize(app.handle(), storage.clone()).unwrap();
    assert!(EmbeddingRepository::nearest(
        &storage.connection().unwrap(),
        "account",
        &[1.0, 0.0],
        1
    )
    .unwrap()
    .is_empty());
}

#[tokio::test]
async fn service_configuration_and_lifecycle_state_are_account_scoped() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    AccountRepository::upsert(&storage.connection().unwrap(), &account()).unwrap();
    let service = AiService::new(storage.clone());
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    credentials::clear("account").unwrap();
    let config = service.configs().await.unwrap().pop().unwrap();
    assert!(!config.enabled);
    assert!(!config.has_api_key);
    service
        .set_enabled(app.handle(), "account".into(), true)
        .await
        .unwrap();
    service
        .set_base_url(
            app.handle(),
            "account".into(),
            "http://127.0.0.1:8080/v1".into(),
        )
        .await
        .unwrap();
    service
        .set_chat_model(app.handle(), "account".into(), Some("chat".into()))
        .await
        .unwrap();
    service
        .set_embedding_model(app.handle(), "account".into(), "embed".into(), 2)
        .await
        .unwrap();
    credentials::save("account", "test-key").unwrap();
    let config = service.configs().await.unwrap().pop().unwrap();
    assert!(config.enabled);
    assert!(config.has_api_key);
    assert_eq!(config.chat_model.as_deref(), Some("chat"));
    assert_eq!(config.embedding_model.as_deref(), Some("embed"));
    assert!(service.index_ready("account").await.unwrap());
    service
        .set_enabled(app.handle(), "account".into(), false)
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
    credentials::clear("account").unwrap();
}
