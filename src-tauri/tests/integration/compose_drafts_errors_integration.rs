use crate::compose_drafts_save_integration::{
    base_payload, boot, boot_with_dead_gmail_base, draft_response, failed_reports, mock_token,
    operation_status, upsert_default_account, wait_for, BootedDraftApp, APP_ENV,
};
use latentmail_lib::auth::AuthService;
use latentmail_lib::compose::{
    drafts::{self, DraftExecutorContext, DraftOperationMode, SaveCoalescer},
    staging::Staging,
};
use latentmail_lib::queue::{
    DurableSubmission, Lane, OperationKind, QueueEngine, QueueError, QueueOperation,
};
use latentmail_lib::storage::{Operation, OperationRepository, Storage, TerminalOutcome};
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

struct OfflineExecutorHarness {
    _directory: tempfile::TempDir,
    storage: Storage,
    staging: Arc<Staging>,
    coalescer: Arc<SaveCoalescer>,
    app: tauri::App<tauri::test::MockRuntime>,
    executor: latentmail_lib::queue::Executor,
    queue: Arc<QueueEngine>,
}

fn build_offline_executor_harness() -> OfflineExecutorHarness {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    upsert_default_account(&storage.connection().unwrap());
    let staging = Arc::new(Staging::new(directory.path().join("staged")));
    let coalescer = Arc::new(SaveCoalescer::new());
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(AuthService::new(storage.clone()));
    let executor = drafts::build_executor(DraftExecutorContext {
        app: app.handle().clone(),
        storage: storage.clone(),
        staging: Arc::clone(&staging),
        coalescer: Arc::clone(&coalescer),
        base_url: "http://not-contacted".into(),
    });
    let queue = QueueEngine::new(250, 250, Arc::clone(&executor));
    queue.pause();
    OfflineExecutorHarness {
        _directory: directory,
        storage: storage,
        staging: staging,
        coalescer: coalescer,
        app: app,
        executor: executor,
        queue: queue,
    }
}

async fn fail_operation_in_storage(
    storage: Storage,
    operation_id: String,
) -> Result<(), QueueError> {
    storage
        .run(move |connection| {
            OperationRepository::mark_terminal(
                connection,
                &operation_id,
                TerminalOutcome {
                    status: "failed",
                    error: Some("Gmail returned HTTP 500"),
                },
            )
        })
        .await
        .unwrap();
    Err(QueueError::Http(500))
}

async fn wait_for_failed_operation(storage: &Storage, id: &str) -> Operation {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let operation_id = id.to_owned();
        let operation = storage
            .run(move |connection| OperationRepository::get(connection, &operation_id))
            .await
            .unwrap()
            .unwrap();
        if operation.status == "failed" {
            return operation;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "operation never reached a terminal failed state"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

struct DurableCreateSubmission<'a> {
    id: &'a str,
    entity_key: &'a str,
    attempts: u8,
}

async fn admit_scheduled_create(booted: &BootedDraftApp, submission: DurableCreateSubmission<'_>) {
    booted.staging.snapshot(submission.id, &[]).unwrap();
    let generation = booted.coalescer.schedule(submission.entity_key).await;
    let mut payload = base_payload(DraftOperationMode::Create, None);
    payload.coalescing_generation = generation;
    latentmail_lib::queue::admit_durable(
        &booted.queue,
        &booted.storage,
        DurableSubmission {
            operation: QueueOperation {
                id: submission.id.into(),
                account_id: "account".into(),
                lane: Lane::Interactive,
                kind: OperationKind::Draft,
                entity_key: submission.entity_key.into(),
                cost: 0,
                attempts: submission.attempts,
                description: "test operation".into(),
            },
            payload: serde_json::to_string(&payload).unwrap(),
        },
    )
    .await
    .unwrap();
}

fn break_compose_draft_metadata_unique_constraint(storage: &Storage) {
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

fn all_failed(storage: &Storage, ids: &[&str]) -> bool {
    ids.iter()
        .all(|id| operation_status(storage, id) == "failed")
}

async fn admit_drafts_to_corrupt(harness: &OfflineExecutorHarness) {
    for (id, key) in [
        ("bad-payload", "draft:bad"),
        ("missing-manifest", "draft:missing"),
        ("discarded", "draft:discarded"),
    ] {
        drafts::admit(
            &drafts::AdmissionServices {
                queue: &harness.queue,
                storage: &harness.storage,
                staging: &harness.staging,
                coalescer: &harness.coalescer,
            },
            drafts::DraftAdmission {
                id: id.into(),
                account_id: "account".into(),
                entity_key: key.into(),
                payload: base_payload(DraftOperationMode::Create, None),
            },
            &[],
        )
        .await
        .unwrap();
    }
}

fn corrupt_admitted_drafts(harness: &OfflineExecutorHarness) {
    let connection = harness.storage.connection().unwrap();
    connection
        .execute(
            "UPDATE operations SET payload='{bad json' WHERE id='bad-payload'",
            [],
        )
        .unwrap();
    harness
        .staging
        .release_snapshot("missing-manifest")
        .unwrap();
    connection
        .execute(
            "UPDATE operations SET status='discarded' WHERE id='discarded'",
            [],
        )
        .unwrap();
}

async fn enqueue_draft_without_operation_row(harness: &OfflineExecutorHarness) {
    harness
        .queue
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
}

fn assert_failure_report_describes_a_draft(event: &serde_json::Value) {
    assert_eq!(event["accountId"], "account");
    assert_eq!(event["kind"], "draft");
    assert!(event["sessionId"].as_str().unwrap().starts_with("draft:"));
    assert!(!event["error"].as_str().unwrap().is_empty());
}

#[tokio::test]
async fn malformed_or_missing_draft_snapshots_fail_durably_before_gmail_is_contacted() {
    let harness = build_offline_executor_harness();
    admit_drafts_to_corrupt(&harness).await;
    corrupt_admitted_drafts(&harness);
    enqueue_draft_without_operation_row(&harness).await;
    let reported = failed_reports(&harness.app);
    harness.queue.resume();

    wait_for(|| all_failed(&harness.storage, &["bad-payload", "missing-manifest"])).await;
    wait_for(|| reported.lock().unwrap().len() == 2).await;
    wait_for(|| harness.staging.snapshot_manifest("discarded").is_err()).await;
    for event in reported.lock().unwrap().iter() {
        assert_failure_report_describes_a_draft(event);
    }
}

#[tokio::test]
async fn a_retryable_gmail_failure_is_reported_as_failed_rather_than_silently_stuck() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    upsert_default_account(&storage.connection().unwrap());
    let executor_storage = storage.clone();
    let queue = QueueEngine::new(
        250,
        250,
        Arc::new(move |operation| {
            Box::pin(fail_operation_in_storage(
                executor_storage.clone(),
                operation.id,
            ))
        }),
    );
    latentmail_lib::queue::admit_durable(
        &queue,
        &storage,
        DurableSubmission {
            operation: QueueOperation {
                id: "op-failing".into(),
                account_id: "account".into(),
                lane: Lane::Interactive,
                kind: OperationKind::Draft,
                entity_key: "draft:local-session".into(),
                cost: 0,
                attempts: 9,
                description: "test operation".into(),
            },
            payload: serde_json::json!({}).to_string(),
        },
    )
    .await
    .unwrap();

    wait_for_failed_operation(&storage, "op-failing").await;
}

#[tokio::test]
async fn a_gmail_server_error_during_create_is_classified_as_retryable_and_recorded() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    mock_token().mount(&server).await;
    Mock::given(method("POST"))
        .and(path("/upload/gmail/v1/users/me/drafts"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    let booted = boot(&server);
    admit_scheduled_create(
        &booted,
        DurableCreateSubmission {
            id: "op-gmail-500",
            entity_key: "draft:failing-session",
            attempts: 9,
        },
    )
    .await;

    let failed = wait_for_failed_operation(&booted.storage, "op-gmail-500").await;
    assert_eq!(
        failed.error.as_deref(),
        Some("Gmail request failed with status 500")
    );
}

#[tokio::test]
async fn a_connection_refused_during_create_is_classified_as_a_network_error() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    mock_token().mount(&server).await;
    let booted = boot_with_dead_gmail_base(&server);
    admit_scheduled_create(
        &booted,
        DurableCreateSubmission {
            id: "op-gmail-network",
            entity_key: "draft:network-failing-session",
            attempts: 9,
        },
    )
    .await;

    wait_for_failed_operation(&booted.storage, "op-gmail-network").await;
}

#[tokio::test]
async fn a_broken_metadata_table_fails_the_operation_after_a_successful_gmail_exchange() {
    let _environment = APP_ENV.lock().await;
    let server = MockServer::start().await;
    mock_token().mount(&server).await;
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
    let booted = boot(&server);
    break_compose_draft_metadata_unique_constraint(&booted.storage);
    admit_scheduled_create(
        &booted,
        DurableCreateSubmission {
            id: "op-meta-fail",
            entity_key: "draft:meta-fail-session",
            attempts: 0,
        },
    )
    .await;

    let failed = wait_for_failed_operation(&booted.storage, "op-meta-fail").await;
    assert!(failed
        .error
        .as_deref()
        .unwrap_or_default()
        .to_lowercase()
        .contains("conflict"));
}

#[tokio::test]
async fn a_token_failure_is_reported_only_when_the_queue_will_not_retry_it() {
    let harness = build_offline_executor_harness();
    let reported = failed_reports(&harness.app);
    for (id, key, mode) in [
        ("draft-token", "draft:token", DraftOperationMode::Create),
        ("send-token", "draft:send-token", DraftOperationMode::Send),
    ] {
        drafts::admit(
            &drafts::AdmissionServices {
                queue: &harness.queue,
                storage: &harness.storage,
                staging: &harness.staging,
                coalescer: &harness.coalescer,
            },
            drafts::DraftAdmission {
                id: id.into(),
                account_id: "account".into(),
                entity_key: key.into(),
                payload: base_payload(mode, None),
            },
            &[],
        )
        .await
        .unwrap();
    }

    let retried_draft = (harness.executor)(QueueOperation {
        id: "draft-token".into(),
        account_id: "account".into(),
        lane: Lane::Interactive,
        kind: OperationKind::Draft,
        entity_key: "draft:token".into(),
        cost: 0,
        attempts: 0,
        description: "Draft: Hello".into(),
    })
    .await;
    assert_eq!(retried_draft, Err(QueueError::Network));
    assert_ne!(operation_status(&harness.storage, "draft-token"), "failed");
    assert!(reported.lock().unwrap().is_empty());

    let failed_send = (harness.executor)(QueueOperation {
        id: "send-token".into(),
        account_id: "account".into(),
        lane: Lane::Interactive,
        kind: OperationKind::Send,
        entity_key: "draft:send-token".into(),
        cost: 0,
        attempts: 0,
        description: "Send: Hello".into(),
    })
    .await;
    assert_eq!(failed_send, Err(QueueError::Network));
    assert_eq!(operation_status(&harness.storage, "send-token"), "failed");
    let reports = reported.lock().unwrap();
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0]["kind"], "send");
}
