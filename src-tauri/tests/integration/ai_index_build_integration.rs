use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use latentmail_lib::{
    ai::{
        credentials,
        index::{build, embed_with_retry, enqueue, rebuild, status},
        provider::Provider,
        AiService, IndexState,
    },
    queue::{Executor, Lane, OperationKind, QueueEngine, QueueError, QueueOperation},
    storage::{
        Account, AccountAiConfigRepository, AccountRepository, EmbeddingRepository, HtmlPresence,
        Message, MessageEmbedding, MessageRepository, Storage,
    },
    sync::{create_queue_engine, noop_event_sink, SyncEngine, WorkRegistry},
};
use wiremock::{
    matchers::{body_string_contains, method, path},
    Mock, MockServer, ResponseTemplate,
};

#[test]
fn embedding_operations_are_not_durable() {
    let connection = Storage::in_memory().unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM message_embeddings", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
    assert!(!OperationKind::Embed.persists());
}

#[tokio::test]
async fn index_status_exposes_only_the_owning_accounts_ephemeral_failure() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.db")).unwrap();
    storage
        .run(|connection| {
            latentmail_lib::storage::AccountRepository::upsert(
                connection,
                &latentmail_lib::storage::Account {
                    id: "one".into(),
                    email: "one@example.com".into(),
                    display_name: "one".into(),
                    avatar_url: None,
                    history_id: None,
                    needs_reauthentication: false,
                    created_at: 1,
                    updated_at: 1,
                },
            )?;
            latentmail_lib::storage::AccountAiConfigRepository::ensure(connection, "one")
        })
        .await
        .unwrap();
    let service = AiService::new(storage);
    service
        .set_index_error("one", "Provider returned HTTP 429".into())
        .unwrap();
    let current = status(&service, "one".into()).await.unwrap();
    assert_eq!(current.error.as_deref(), Some("Provider returned HTTP 429"));
    assert_eq!(current.state, IndexState::Interrupted);
    assert_eq!(
        (
            current.indexed_messages,
            current.total_eligible_messages,
            current.indexed_passages,
        ),
        (0, 0, 0)
    );
    service.clear_index_error("one").unwrap();
    assert_eq!(status(&service, "one".into()).await.unwrap().error, None);
}

#[tokio::test]
async fn disabled_ai_is_not_ready_for_automatic_indexing_and_reports_unavailable() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.db")).unwrap();
    storage
        .run(|connection| {
            latentmail_lib::storage::AccountRepository::upsert(
                connection,
                &latentmail_lib::storage::Account {
                    id: "one".into(),
                    email: "one@example.com".into(),
                    display_name: "one".into(),
                    avatar_url: None,
                    history_id: None,
                    needs_reauthentication: false,
                    created_at: 1,
                    updated_at: 1,
                },
            )?;
            latentmail_lib::storage::AccountAiConfigRepository::set_base_url(
                connection,
                "one",
                "http://localhost/v1/",
            )?;
            latentmail_lib::storage::AccountAiConfigRepository::set_embedding_model(
                connection, "one", "embed", 3,
            )
        })
        .await
        .unwrap();
    let service = AiService::new(storage);
    assert!(!service.index_ready("one").await.unwrap());
    assert_eq!(
        status(&service, "one".into()).await.unwrap().state,
        IndexState::Unavailable
    );
}

#[tokio::test]
async fn paused_index_state_wins_over_live_state_and_survives_restart() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.db")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account("paused")).unwrap();
    AccountAiConfigRepository::set_enabled(&connection, "paused", true).unwrap();
    AccountAiConfigRepository::set_embedding_model(&connection, "paused", "embed", 2).unwrap();
    EmbeddingRepository::create(&connection, "paused", 2).unwrap();
    drop(connection);
    let service = AiService::new(storage.clone());
    service
        .set_index_state("paused", IndexState::Building)
        .unwrap();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    latentmail_lib::ai::index::set_paused(app.handle(), &service, "paused".into(), true)
        .await
        .unwrap();
    assert_eq!(
        status(&service, "paused".into()).await.unwrap().state,
        IndexState::Paused
    );
    let restarted = AiService::new(storage);
    assert_eq!(
        status(&restarted, "paused".into()).await.unwrap().state,
        IndexState::Paused
    );
}

#[tokio::test]
async fn incomplete_unpaused_index_without_a_live_chain_reports_interrupted() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.db")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account("interrupted")).unwrap();
    MessageRepository::write_full_state(&connection, &message("interrupted", "one")).unwrap();
    AccountAiConfigRepository::set_enabled(&connection, "interrupted", true).unwrap();
    AccountAiConfigRepository::set_embedding_model(&connection, "interrupted", "embed", 2).unwrap();
    EmbeddingRepository::create(&connection, "interrupted", 2).unwrap();
    drop(connection);
    assert_eq!(
        status(&AiService::new(storage), "interrupted".into())
            .await
            .unwrap()
            .state,
        IndexState::Interrupted
    );
}

#[tokio::test]
async fn model_change_unpauses_the_owning_index_before_rebuilding() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.db")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account("model")).unwrap();
    AccountAiConfigRepository::set_index_paused(&connection, "model", true).unwrap();
    drop(connection);
    let service = AiService::new(storage.clone());
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    service
        .set_embedding_model(app.handle(), "model".into(), "embed".into(), 2)
        .await
        .unwrap();
    assert!(
        !AccountAiConfigRepository::get(&storage.connection().unwrap(), "model")
            .unwrap()
            .unwrap()
            .index_paused
    );
}

#[tokio::test(start_paused = true)]
async fn embedding_operations_fail_without_queue_retry_or_gmail_cost() {
    let calls = Arc::new(AtomicUsize::new(0));
    let executor_calls = Arc::clone(&calls);
    let executor: Executor = Arc::new(move |_| {
        let calls = Arc::clone(&executor_calls);
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Err(QueueError::Http(429))
        })
    });
    let queue = QueueEngine::new(1, 0, executor);
    queue
        .enqueue(QueueOperation {
            id: "embed".into(),
            account_id: "account".into(),
            lane: Lane::Embedding,
            kind: OperationKind::Embed,
            entity_key: "embedding:account".into(),
            cost: 0,
            attempts: 0,
            description: "Build semantic index".into(),
        })
        .await
        .unwrap();
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(1)).await;
    tokio::task::yield_now().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(queue.summary().failed, 1);
}

fn account(id: &str) -> Account {
    Account {
        id: id.into(),
        email: format!("{id}@example.com"),
        display_name: id.into(),
        avatar_url: None,
        history_id: None,
        needs_reauthentication: false,
        created_at: 1,
        updated_at: 1,
    }
}

fn message(account_id: &str, id: &str) -> Message {
    Message {
        account_id: account_id.into(),
        id: id.into(),
        thread_id: format!("thread-{id}"),
        rfc_message_id: None,
        sender: "sender@example.com".into(),
        recipients: "recipient@example.com".into(),
        subject: "Subject".into(),
        sent_at: 1,
        snippet: "Snippet".into(),
        html_body: None,
        plain_body: Some("Body".into()),
        has_attachments: false,
        is_unread: false,
        is_starred: false,
        history_id: 1,
        truncated_body: Some("Body".into()),
        html_presence: HtmlPresence::Absent,
    }
}

#[tokio::test]
async fn rebuild_recreates_only_its_account_and_restarts_the_embedding_chain() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            serde_json::json!({"data":[{"embedding":[1.0,2.0]},{"embedding":[1.0,2.0]}]}),
        ))
        .mount(&server)
        .await;
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.db")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account("rebuild")).unwrap();
    AccountRepository::upsert(&connection, &account("other")).unwrap();
    for id in ["first", "second"] {
        MessageRepository::write_full_state(&connection, &message("rebuild", id)).unwrap();
    }
    MessageRepository::write_full_state(&connection, &message("other", "kept")).unwrap();
    let base_url = format!("{}/v1/", server.uri());
    AccountAiConfigRepository::set_enabled(&connection, "rebuild", true).unwrap();
    AccountAiConfigRepository::set_base_url(&connection, "rebuild", &base_url).unwrap();
    AccountAiConfigRepository::set_embedding_model(&connection, "rebuild", "embed", 2).unwrap();
    AccountAiConfigRepository::set_index_paused(&connection, "rebuild", true).unwrap();
    EmbeddingRepository::create(&connection, "rebuild", 2).unwrap();
    EmbeddingRepository::create(&connection, "other", 2).unwrap();
    let first = EmbeddingRepository::backlog(&connection, "rebuild", 1).unwrap();
    EmbeddingRepository::write(
        &connection,
        "rebuild",
        &[MessageEmbedding {
            message_seq: first[0].message_seq,
            chunk_index: 0,
            vector: vec![9.0, 9.0],
        }],
    )
    .unwrap();
    let other = EmbeddingRepository::backlog(&connection, "other", 1).unwrap();
    EmbeddingRepository::write(
        &connection,
        "other",
        &[MessageEmbedding {
            message_seq: other[0].message_seq,
            chunk_index: 0,
            vector: vec![3.0, 3.0],
        }],
    )
    .unwrap();
    drop(connection);
    credentials::save("rebuild", "test-key").unwrap();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let registry = WorkRegistry::new();
    let queue = create_queue_engine(250, 250, registry.clone());
    let sync = SyncEngine::new(storage.clone(), queue, registry, noop_event_sink());
    let service = AiService::new(storage.clone());
    service
        .set_index_error("rebuild", "previous error".into())
        .unwrap();
    service
        .set_index_state("rebuild", IndexState::Paused)
        .unwrap();
    rebuild(app.handle(), &service, sync, "rebuild".into())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_millis(1500), async {
        loop {
            let current = status(&service, "rebuild".into()).await.unwrap();
            if current.state == IndexState::Complete && current.indexed == 2 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    let connection = storage.connection().unwrap();
    assert!(
        !AccountAiConfigRepository::get(&connection, "rebuild")
            .unwrap()
            .unwrap()
            .index_paused
    );
    assert_eq!(service.index_error("rebuild").unwrap(), None);
    assert_eq!(
        EmbeddingRepository::counts(&connection, "other")
            .unwrap()
            .indexed_messages,
        1
    );
    credentials::clear("rebuild").unwrap();
}

#[tokio::test]
async fn a_running_index_stalled_by_removal_reports_partial_then_complete_progress() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.db")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account("stall")).unwrap();
    MessageRepository::write_full_state(&connection, &message("stall", "one")).unwrap();
    AccountAiConfigRepository::ensure(&connection, "stall").unwrap();
    EmbeddingRepository::create(&connection, "stall", 2).unwrap();
    drop(connection);
    let service = AiService::new(storage.clone());
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let registry = WorkRegistry::new();
    let sync = SyncEngine::new(
        storage.clone(),
        create_queue_engine(250, 250, registry.clone()),
        registry,
        noop_event_sink(),
    );

    service.begin_removal("stall").unwrap();
    service
        .set_index_state("stall", IndexState::Building)
        .unwrap();
    enqueue(
        app.handle().clone(),
        service.clone(),
        sync.clone(),
        "stall".into(),
    )
    .await
    .unwrap();
    assert_eq!(
        service.index_state("stall").unwrap(),
        Some(IndexState::Partial)
    );

    let connection = storage.connection().unwrap();
    let backlog = EmbeddingRepository::backlog(&connection, "stall", 10).unwrap();
    EmbeddingRepository::write(
        &connection,
        "stall",
        &[MessageEmbedding {
            message_seq: backlog[0].message_seq,
            chunk_index: 0,
            vector: vec![1.0, 1.0],
        }],
    )
    .unwrap();
    drop(connection);
    service
        .set_index_state("stall", IndexState::Building)
        .unwrap();
    enqueue(app.handle().clone(), service.clone(), sync, "stall".into())
        .await
        .unwrap();
    assert_eq!(
        service.index_state("stall").unwrap(),
        Some(IndexState::Complete)
    );
}

#[tokio::test]
async fn a_running_index_stalled_by_disabling_ai_reports_complete_with_no_eligible_messages() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.db")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account("stall-disabled")).unwrap();
    AccountAiConfigRepository::ensure(&connection, "stall-disabled").unwrap();
    EmbeddingRepository::create(&connection, "stall-disabled", 2).unwrap();
    drop(connection);
    let service = AiService::new(storage.clone());
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let registry = WorkRegistry::new();
    let sync = SyncEngine::new(
        storage,
        create_queue_engine(250, 250, registry.clone()),
        registry,
        noop_event_sink(),
    );

    service
        .set_index_state("stall-disabled", IndexState::Building)
        .unwrap();
    enqueue(
        app.handle().clone(),
        service.clone(),
        sync,
        "stall-disabled".into(),
    )
    .await
    .unwrap();
    assert_eq!(
        service.index_state("stall-disabled").unwrap(),
        Some(IndexState::Complete)
    );
}

#[tokio::test]
async fn build_skips_a_message_whose_chunks_alone_exceed_the_batch_budget() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.db")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account("chunky")).unwrap();
    let mut oversized = message("chunky", "huge");
    let body = "word ".repeat(9_800);
    oversized.plain_body = Some(body.clone());
    oversized.truncated_body = Some(body);
    MessageRepository::write_full_state(&connection, &oversized).unwrap();
    AccountAiConfigRepository::set_enabled(&connection, "chunky", true).unwrap();
    AccountAiConfigRepository::set_base_url(&connection, "chunky", "http://127.0.0.1:9/v1/")
        .unwrap();
    AccountAiConfigRepository::set_embedding_model(&connection, "chunky", "embed", 2).unwrap();
    EmbeddingRepository::create(&connection, "chunky", 2).unwrap();
    drop(connection);
    let service = AiService::new(storage.clone());
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    build(app.handle(), &service, "chunky".into())
        .await
        .unwrap();
    assert_eq!(
        EmbeddingRepository::count_passages(&storage.connection().unwrap(), "chunky").unwrap(),
        0
    );
}

struct FlakyThenOk(std::sync::atomic::AtomicUsize);
impl wiremock::Respond for FlakyThenOk {
    fn respond(&self, _request: &wiremock::Request) -> ResponseTemplate {
        if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
            ResponseTemplate::new(500)
        } else {
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"data":[{"embedding":[1.0,2.0]}]}))
        }
    }
}

#[tokio::test]
async fn embed_with_retry_recovers_after_a_transient_server_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(FlakyThenOk(AtomicUsize::new(0)))
        .mount(&server)
        .await;
    let provider = Provider::new(&format!("{}/v1", server.uri()), None).unwrap();
    let vectors = embed_with_retry(&provider, "embed", vec!["hello".into()], 2, |_| {
        Duration::from_millis(1)
    })
    .await
    .unwrap();
    assert_eq!(vectors, vec![vec![1.0, 2.0]]);
}

#[tokio::test]
async fn a_persistently_failing_provider_interrupts_the_index_and_records_the_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.db")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account("failing")).unwrap();
    MessageRepository::write_full_state(&connection, &message("failing", "one")).unwrap();
    drop(connection);
    let service = AiService::new(storage.clone());
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    service
        .set_enabled(app.handle(), "failing".into(), true)
        .await
        .unwrap();
    service
        .set_base_url(
            app.handle(),
            "failing".into(),
            format!("{}/v1", server.uri()),
        )
        .await
        .unwrap();
    service
        .set_embedding_model(app.handle(), "failing".into(), "embed".into(), 2)
        .await
        .unwrap();
    credentials::save("failing", "key").unwrap();
    let registry = WorkRegistry::new();
    let queue = create_queue_engine(250, 250, registry.clone());
    let sync = SyncEngine::new(storage.clone(), queue.clone(), registry, noop_event_sink());
    enqueue(
        app.handle().clone(),
        service.clone(),
        sync,
        "failing".into(),
    )
    .await
    .unwrap();
    queue
        .wait_for_account_lane("failing", Lane::Embedding)
        .await;
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if status(&service, "failing".into()).await.unwrap().state == IndexState::Interrupted {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(service.index_error("failing").unwrap().is_some());
    credentials::clear("failing").unwrap();
}

fn service_with_model_but_no_dimensions() -> (AiService, Storage, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.db")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(
        &connection,
        &Account {
            id: "account".into(),
            email: "account@example.com".into(),
            display_name: "Account".into(),
            avatar_url: None,
            history_id: None,
            needs_reauthentication: false,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    AccountAiConfigRepository::set_base_url(&connection, "account", "http://127.0.0.1:1/v1")
        .unwrap();
    AccountAiConfigRepository::set_enabled(&connection, "account", true).unwrap();
    AccountAiConfigRepository::set_embedding_model(&connection, "account", "embedding", 2).unwrap();
    connection
        .execute(
            "UPDATE account_ai_config SET embedding_dimensions = NULL WHERE account_id = 'account'",
            [],
        )
        .unwrap();
    drop(connection);
    let service = AiService::new(storage.clone());
    (service, storage, directory)
}

#[tokio::test]
async fn building_an_index_requires_stored_embedding_dimensions() {
    let (service, _storage, _directory) = service_with_model_but_no_dimensions();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();

    assert_eq!(
        build(tauri::Manager::app_handle(&app), &service, "account".into())
            .await
            .unwrap_err(),
        "Embedding dimensions are missing"
    );
}

#[tokio::test]
async fn rebuilding_an_index_requires_stored_embedding_dimensions() {
    let (service, storage, _directory) = service_with_model_but_no_dimensions();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let registry = WorkRegistry::new();
    let sync = SyncEngine::new(
        storage,
        create_queue_engine(250, 250, registry.clone()),
        registry,
        noop_event_sink(),
    );

    assert_eq!(
        rebuild(
            tauri::Manager::app_handle(&app),
            &service,
            sync,
            "account".into(),
        )
        .await
        .unwrap_err(),
        "Embedding dimensions are missing"
    );
}

#[tokio::test]
async fn a_message_the_provider_rejects_is_skipped_instead_of_interrupting_the_index() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .and(body_string_contains("Huge"))
        .respond_with(ResponseTemplate::new(400).set_body_json(
            serde_json::json!({"error":{"message":"input size exceed the context limit"}}),
        ))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"data":[{"embedding":[1.0,2.0]}]})),
        )
        .mount(&server)
        .await;
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.db")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account("skip")).unwrap();
    MessageRepository::write_full_state(
        &connection,
        &Message {
            subject: "Small".into(),
            ..message("skip", "small")
        },
    )
    .unwrap();
    MessageRepository::write_full_state(
        &connection,
        &Message {
            subject: "Huge".into(),
            ..message("skip", "huge")
        },
    )
    .unwrap();
    AccountAiConfigRepository::set_enabled(&connection, "skip", true).unwrap();
    AccountAiConfigRepository::set_base_url(&connection, "skip", &format!("{}/v1/", server.uri()))
        .unwrap();
    AccountAiConfigRepository::set_embedding_model(&connection, "skip", "embed", 2).unwrap();
    drop(connection);
    credentials::save("skip", "key").unwrap();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let service = AiService::new(storage.clone());

    build(app.handle(), &service, "skip".into()).await.unwrap();

    let connection = storage.connection().unwrap();
    let sequence: i64 = connection
        .query_row("SELECT seq FROM accounts WHERE id='skip'", [], |row| {
            row.get(0)
        })
        .unwrap();
    let vectors: i64 = connection
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM {}",
                EmbeddingRepository::table_name(sequence)
            ),
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(vectors, 1);
    assert_eq!(
        EmbeddingRepository::counts(&connection, "skip")
            .unwrap()
            .indexed_messages,
        2
    );
    assert!(EmbeddingRepository::backlog(&connection, "skip", 10)
        .unwrap()
        .is_empty());
    assert_eq!(status(&service, "skip".into()).await.unwrap().error, None);
}

struct RejectThenEmpty(AtomicUsize);
impl wiremock::Respond for RejectThenEmpty {
    fn respond(&self, _request: &wiremock::Request) -> ResponseTemplate {
        if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
            ResponseTemplate::new(400)
        } else {
            ResponseTemplate::new(200).set_body_json(serde_json::json!({"data":[]}))
        }
    }
}

#[tokio::test]
async fn a_per_message_retry_that_returns_no_vectors_fails_the_whole_build() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(RejectThenEmpty(AtomicUsize::new(0)))
        .mount(&server)
        .await;
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.db")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account("empty")).unwrap();
    MessageRepository::write_full_state(&connection, &message("empty", "one")).unwrap();
    AccountAiConfigRepository::set_enabled(&connection, "empty", true).unwrap();
    AccountAiConfigRepository::set_base_url(&connection, "empty", &format!("{}/v1/", server.uri()))
        .unwrap();
    AccountAiConfigRepository::set_embedding_model(&connection, "empty", "embed", 2).unwrap();
    drop(connection);
    credentials::save("empty", "key").unwrap();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let service = AiService::new(storage.clone());

    assert_eq!(
        build(app.handle(), &service, "empty".into())
            .await
            .unwrap_err(),
        "Provider returned an incomplete embedding batch"
    );
    let connection = storage.connection().unwrap();
    assert_eq!(
        EmbeddingRepository::count_indexed(&connection, "empty").unwrap(),
        0
    );
    credentials::clear("empty").unwrap();
}

#[tokio::test]
async fn a_queued_build_without_an_api_root_reports_unavailable_instead_of_running() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.db")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account("rootless")).unwrap();
    MessageRepository::write_full_state(&connection, &message("rootless", "one")).unwrap();
    AccountAiConfigRepository::set_enabled(&connection, "rootless", true).unwrap();
    AccountAiConfigRepository::set_embedding_model(&connection, "rootless", "embed", 2).unwrap();
    drop(connection);
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let service = AiService::new(storage.clone());
    let registry = WorkRegistry::new();
    let queue = create_queue_engine(250, 250, registry.clone());
    let sync = SyncEngine::new(storage.clone(), queue.clone(), registry, noop_event_sink());

    enqueue(
        app.handle().clone(),
        service.clone(),
        sync,
        "rootless".into(),
    )
    .await
    .unwrap();

    queue
        .wait_for_account_lane("rootless", Lane::Embedding)
        .await;
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if status(&service, "rootless".into()).await.unwrap().state == IndexState::Unavailable {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(service.index_error("rootless").unwrap().is_none());
}
