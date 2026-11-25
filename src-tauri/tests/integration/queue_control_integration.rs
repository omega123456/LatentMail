use crate::support::fail_first_call_executor;
use latentmail_lib::ipc::{AppServices, CommandPayload};
use latentmail_lib::queue::commands::SetQueuePausedPayload;
use latentmail_lib::queue::{DurableSubmission, QueueConfig};
use latentmail_lib::storage::TerminalOutcome;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use crate::support::{app, controllable_executor, events_channel, wait_for_item_status};
use latentmail_lib::{
    queue::{
        admit_durable,
        commands::{
            cancel_queue_operation, clear_queue_history, retry_failed_operations,
            retry_queue_operation, set_queue_paused,
        },
        registry::PauseScope,
        Executor, Lane, LaneState, OperationKind, QueueEngine, QueueOperation,
    },
    storage::{Account, AccountRepository, Operation, OperationRepository, Storage},
};
use tauri::Manager;
use tokio::sync::{mpsc, oneshot};

fn drained_contains_summary(
    receiver: &mut mpsc::UnboundedReceiver<(&'static str, serde_json::Value)>,
) -> bool {
    let mut found = false;
    while let Ok((event, _)) = receiver.try_recv() {
        if event == latentmail_lib::events::QUEUE_SUMMARY {
            found = true;
        }
    }
    found
}

struct OperationSeed<'a> {
    id: &'a str,
    account_id: &'a str,
    lane: Lane,
    entity_key: &'a str,
}

fn operation(
    OperationSeed {
        id,
        account_id,
        lane,
        entity_key,
    }: OperationSeed<'_>,
) -> QueueOperation {
    QueueOperation {
        id: id.into(),
        account_id: account_id.into(),
        lane: lane,
        kind: OperationKind::Sync,
        entity_key: entity_key.into(),
        cost: 0,
        attempts: 0,
        description: "test operation".into(),
    }
}

fn counting_executor(executed: Arc<AtomicUsize>) -> Executor {
    Arc::new(move |_| {
        executed.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    })
}

fn queue_with_events(
    events: latentmail_lib::queue::QueueEventSink,
    executor: Executor,
) -> Arc<QueueEngine> {
    QueueEngine::with_config(
        QueueConfig {
            rate_per_second: 250,
            burst: 250,
            events: events,
            ..QueueConfig::default()
        },
        executor,
    )
}

#[tokio::test]
async fn cancelling_before_execution_evicts_the_hook_and_unwinds_pending_counters() {
    let (release_sender, release_receiver) = oneshot::channel::<()>();
    let evicted = Arc::new(std::sync::Mutex::new(Some(release_sender)));
    let evicted_for_hook = Arc::clone(&evicted);
    let executed = Arc::new(AtomicUsize::new(0));
    let (events, mut events_receiver) = events_channel();
    let queue = QueueEngine::with_config(
        QueueConfig {
            rate_per_second: 250,
            burst: 250,
            events: events,
            cancellation_hook: Arc::new(move |_| {
                evicted_for_hook.lock().unwrap().take();
            }),
        },
        counting_executor(Arc::clone(&executed)),
    );

    let before = queue.summary().pending;
    queue.pause();
    queue
        .enqueue(operation(OperationSeed {
            id: "cancel-me",
            account_id: "account",
            lane: Lane::Background,
            entity_key: "e1",
        }))
        .await
        .unwrap();
    assert_eq!(queue.summary().pending, before + 1);

    let cancelled = queue.cancel("cancel-me").await;
    assert!(cancelled.is_some());
    assert_eq!(queue.summary().pending, before);
    assert!(drained_contains_summary(&mut events_receiver));

    let resolved = release_receiver.await;
    assert!(resolved.is_err(), "evicted closure drops its sender");

    queue.resume();
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    assert_eq!(
        executed.load(Ordering::SeqCst),
        0,
        "the worker discovers the cancellation instead of executing"
    );
}

#[tokio::test]
async fn cancelling_an_interactive_operation_does_not_block_that_accounts_other_lanes() {
    let executor: Executor = Arc::new(|_| Box::pin(async { Ok(()) }));
    let (events, mut events_receiver) = events_channel();
    let queue = QueueEngine::with_config(
        QueueConfig {
            rate_per_second: 250,
            burst: 250,
            events: events,
            ..QueueConfig::default()
        },
        executor,
    );

    queue.pause();
    queue
        .enqueue(operation(OperationSeed {
            id: "interactive-cancel",
            account_id: "account",
            lane: Lane::Interactive,
            entity_key: "e1",
        }))
        .await
        .unwrap();
    let cancelled = queue.cancel("interactive-cancel").await;
    assert!(cancelled.is_some());
    queue.resume();

    queue
        .enqueue(operation(OperationSeed {
            id: "background-after",
            account_id: "account",
            lane: Lane::Background,
            entity_key: "e2",
        }))
        .await
        .unwrap();
    wait_for_item_status(&mut events_receiver, "background-after", "done").await;
}

#[tokio::test]
async fn cancelling_an_already_executing_operation_reports_not_applied() {
    let (executor, mut started) = controllable_executor();
    let (events, mut events_receiver) = events_channel();
    let queue = QueueEngine::with_config(
        QueueConfig {
            rate_per_second: 250,
            burst: 250,
            events: events,
            ..QueueConfig::default()
        },
        executor,
    );

    queue
        .enqueue(operation(OperationSeed {
            id: "running",
            account_id: "account",
            lane: Lane::Background,
            entity_key: "e1",
        }))
        .await
        .unwrap();
    wait_for_item_status(&mut events_receiver, "running", "active").await;

    let cancelled = queue.cancel("running").await;
    assert!(cancelled.is_none());

    let (_, release) = started.recv().await.unwrap();
    release.send(()).unwrap();
    wait_for_item_status(&mut events_receiver, "running", "done").await;
}

#[tokio::test]
async fn scoped_lane_pause_holds_only_that_lane_and_resuming_wakes_parked_work() {
    let (executor, mut started) = controllable_executor();
    let (events, _events_receiver) = events_channel();
    let queue = QueueEngine::with_config(
        QueueConfig {
            rate_per_second: 250,
            burst: 250,
            events: events,
            ..QueueConfig::default()
        },
        executor,
    );

    let paused = queue
        .set_paused(
            &PauseScope::Lane {
                account_id: "account".into(),
                lane: Lane::Background,
            },
            true,
        )
        .await;
    assert!(paused);

    queue
        .enqueue(operation(OperationSeed {
            id: "parked",
            account_id: "account",
            lane: Lane::Background,
            entity_key: "e1",
        }))
        .await
        .unwrap();

    for _ in 0..25 {
        assert!(started.try_recv().is_err());
        tokio::task::yield_now().await;
    }

    let resumed = queue
        .set_paused(
            &PauseScope::Lane {
                account_id: "account".into(),
                lane: Lane::Background,
            },
            false,
        )
        .await;
    assert!(resumed);

    let (id, release) = started
        .recv()
        .await
        .expect("scoped resume wakes parked work");
    assert_eq!(id, "parked");
    release.send(()).unwrap();
}

#[tokio::test]
async fn paused_interactive_lane_does_not_hold_back_the_other_lanes() {
    let (executor, mut started) = controllable_executor();
    let (events, _events_receiver) = events_channel();
    let queue = QueueEngine::with_config(
        QueueConfig {
            rate_per_second: 250,
            burst: 250,
            events: events,
            ..QueueConfig::default()
        },
        executor,
    );

    queue
        .set_paused(
            &PauseScope::Lane {
                account_id: "account".into(),
                lane: Lane::Interactive,
            },
            true,
        )
        .await;

    queue
        .enqueue(operation(OperationSeed {
            id: "parked",
            account_id: "account",
            lane: Lane::Interactive,
            entity_key: "e1",
        }))
        .await
        .unwrap();
    queue
        .enqueue(operation(OperationSeed {
            id: "background",
            account_id: "account",
            lane: Lane::Background,
            entity_key: "e2",
        }))
        .await
        .unwrap();

    let (id, release) = started
        .recv()
        .await
        .expect("background work runs while interactive is paused");
    assert_eq!(id, "background");
    release.send(()).unwrap();

    let snapshot = queue.snapshot().await;
    let lanes = &snapshot.first().expect("account snapshot").lanes;
    let background = lanes
        .iter()
        .find(|lane| lane.lane == Lane::Background)
        .expect("background lane");
    assert_ne!(background.state, LaneState::Blocked);
}

#[tokio::test]
async fn clear_queue_history_removes_terminal_records_optionally_scoped_to_an_account() {
    let executor: Executor = Arc::new(|_| Box::pin(async { Ok(()) }));
    let (events, mut events_receiver) = events_channel();
    let queue = QueueEngine::with_config(
        QueueConfig {
            rate_per_second: 250,
            burst: 250,
            events: events,
            ..QueueConfig::default()
        },
        executor,
    );

    queue
        .enqueue(operation(OperationSeed {
            id: "acct-1-op",
            account_id: "account-1",
            lane: Lane::Background,
            entity_key: "e1",
        }))
        .await
        .unwrap();
    wait_for_item_status(&mut events_receiver, "acct-1-op", "done").await;
    queue
        .enqueue(operation(OperationSeed {
            id: "acct-2-op",
            account_id: "account-2",
            lane: Lane::Background,
            entity_key: "e2",
        }))
        .await
        .unwrap();
    wait_for_item_status(&mut events_receiver, "acct-2-op", "done").await;

    let app = app();
    app.manage(Arc::clone(&queue));

    clear_queue_history(AppServices::new(app.handle()), Some("account-1".into())).unwrap();
    assert!(drained_contains_summary(&mut events_receiver));

    let snapshot = queue.snapshot().await;
    let account_one_has_history = snapshot
        .iter()
        .find(|account| account.account_id == "account-1")
        .is_some_and(|account| account.lanes.iter().any(|lane| !lane.operations.is_empty()));
    assert!(!account_one_has_history);
    let account_two = snapshot
        .iter()
        .find(|account| account.account_id == "account-2")
        .unwrap();
    assert!(account_two
        .lanes
        .iter()
        .any(|lane| !lane.operations.is_empty()));

    clear_queue_history(AppServices::new(app.handle()), None).unwrap();
    let snapshot = queue.snapshot().await;
    for account in &snapshot {
        assert!(account.lanes.iter().all(|lane| lane.operations.is_empty()));
    }
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

#[tokio::test]
async fn cancel_queue_operation_command_marks_a_cancelled_durable_send_terminal() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account("account")).unwrap();
    drop(connection);

    let executor: Executor = Arc::new(|_| Box::pin(async { Ok(()) }));
    let (events, _events_receiver) = events_channel();
    let queue = QueueEngine::with_config(
        QueueConfig {
            rate_per_second: 250,
            burst: 250,
            events: events,
            ..QueueConfig::default()
        },
        executor,
    );
    queue.pause();
    admit_durable(
        &queue,
        &storage,
        DurableSubmission {
            operation: QueueOperation {
                id: "send-cancel".into(),
                account_id: "account".into(),
                lane: Lane::Interactive,
                kind: OperationKind::Send,
                entity_key: "draft:send-cancel".into(),
                cost: 0,
                attempts: 0,
                description: "Send: Hi".into(),
            },
            payload: "{}".into(),
        },
    )
    .await
    .unwrap();

    let app = app();
    app.manage(Arc::clone(&queue));
    app.manage(storage.clone());

    let applied = cancel_queue_operation(AppServices::new(app.handle()), "send-cancel".into())
        .await
        .unwrap();
    assert!(applied);

    let row = storage
        .run(|connection| OperationRepository::get(connection, "send-cancel"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.status, "cancelled");
    queue.resume();
}

#[tokio::test]
async fn cancel_queue_operation_command_reports_true_without_touching_storage_for_a_non_persisting_kind(
) {
    let executor: Executor = Arc::new(|_| Box::pin(async { Ok(()) }));
    let (events, _events_receiver) = events_channel();
    let queue = QueueEngine::with_config(
        QueueConfig {
            rate_per_second: 250,
            burst: 250,
            events: events,
            ..QueueConfig::default()
        },
        executor,
    );
    queue.pause();
    queue
        .enqueue(operation(OperationSeed {
            id: "sync-cancel",
            account_id: "account",
            lane: Lane::Background,
            entity_key: "e1",
        }))
        .await
        .unwrap();

    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();

    let app = app();
    app.manage(Arc::clone(&queue));
    app.manage(storage);

    let applied = cancel_queue_operation(AppServices::new(app.handle()), "sync-cancel".into())
        .await
        .unwrap();
    assert!(applied);
    queue.resume();
}

struct StoredOperationSeed<'a> {
    id: &'a str,
    account_id: &'a str,
    lane: &'a str,
    kind: &'a str,
    entity_key: &'a str,
    status: &'a str,
    attempts: i64,
    error: Option<&'a str>,
}

fn stored_operation(seed: StoredOperationSeed<'_>) -> Operation {
    Operation {
        id: seed.id.into(),
        account_id: seed.account_id.into(),
        lane: seed.lane.into(),
        kind: seed.kind.into(),
        entity_key: seed.entity_key.into(),
        payload: "{}".into(),
        status: seed.status.into(),
        attempts: seed.attempts,
        next_attempt_at: None,
        error: seed.error.map(str::to_owned),
        created_at: 1,
        updated_at: 1,
    }
}

fn storage_with_accounts(accounts: &[&str]) -> (Storage, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    for id in accounts {
        AccountRepository::upsert(&connection, &account(id)).unwrap();
    }
    drop(connection);
    (storage, directory)
}

async fn mark_failed(storage: &Storage, id: &str) {
    let operation_id = id.to_owned();
    storage
        .run(move |connection| {
            OperationRepository::mark_terminal(
                connection,
                &operation_id,
                TerminalOutcome {
                    status: "failed",
                    error: Some("boom"),
                },
            )
        })
        .await
        .unwrap();
}

fn seed_unretryable_operations(storage: &Storage) {
    let connection = storage.connection().unwrap();
    OperationRepository::upsert(
        &connection,
        &stored_operation(StoredOperationSeed {
            id: "sync-failed",
            account_id: "account",
            lane: "background",
            kind: "sync",
            entity_key: "sync:account",
            status: "failed",
            attempts: 3,
            error: Some("boom"),
        }),
    )
    .unwrap();
    OperationRepository::upsert(
        &connection,
        &stored_operation(StoredOperationSeed {
            id: "send-still-active",
            account_id: "account",
            lane: "interactive",
            kind: "send",
            entity_key: "draft:send-still-active",
            status: "active",
            attempts: 0,
            error: None,
        }),
    )
    .unwrap();
}

async fn admit_send_retry(queue: &Arc<QueueEngine>, storage: &Storage) {
    admit_durable(
        queue,
        storage,
        DurableSubmission {
            operation: QueueOperation {
                id: "send-retry".into(),
                account_id: "account".into(),
                lane: Lane::Interactive,
                kind: OperationKind::Send,
                entity_key: "draft:send-retry".into(),
                cost: 0,
                attempts: 0,
                description: "Send: Hi".into(),
            },
            payload: "{}".into(),
        },
    )
    .await
    .unwrap();
}

async fn assert_retry_is_refused(app: &tauri::App<tauri::test::MockRuntime>, operation_id: &str) {
    let retried = retry_queue_operation(AppServices::new(app.handle()), operation_id.into())
        .await
        .unwrap();
    assert!(!retried, "{operation_id}");
}

#[tokio::test]
async fn retry_queue_operation_reenqueues_a_failed_send_and_refuses_other_kinds() {
    let (storage, _directory) = storage_with_accounts(&["account"]);
    seed_unretryable_operations(&storage);

    let calls = Arc::new(AtomicUsize::new(0));
    let (events, mut events_receiver) = events_channel();
    let queue = queue_with_events(
        events,
        fail_first_call_executor(
            Arc::clone(&calls),
            latentmail_lib::queue::QueueError::Permanent,
        ),
    );

    admit_send_retry(&queue, &storage).await;
    wait_for_item_status(&mut events_receiver, "send-retry", "failed").await;
    mark_failed(&storage, "send-retry").await;

    let app = app();
    app.manage(Arc::clone(&queue));
    app.manage(storage.clone());

    for operation_id in ["sync-failed", "does-not-exist", "send-still-active"] {
        assert_retry_is_refused(&app, operation_id).await;
    }
    assert!(
        retry_queue_operation(AppServices::new(app.handle()), "send-retry".into())
            .await
            .unwrap()
    );
    wait_for_item_status(&mut events_receiver, "send-retry", "done").await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn retry_failed_operations_retries_every_failed_durable_row_optionally_scoped() {
    let (storage, _directory) = storage_with_accounts(&["account-1", "account-2"]);
    let connection = storage.connection().unwrap();
    for (id, account_id) in [("send-a1", "account-1"), ("send-a2", "account-2")] {
        let entity_key = format!("draft:{id}");
        OperationRepository::upsert(
            &connection,
            &stored_operation(StoredOperationSeed {
                id: id,
                account_id: account_id,
                lane: "interactive",
                kind: "send",
                entity_key: &entity_key,
                status: "failed",
                attempts: 1,
                error: Some("boom"),
            }),
        )
        .unwrap();
    }
    drop(connection);

    let (events, mut events_receiver) = events_channel();
    let queue = queue_with_events(events, Arc::new(|_| Box::pin(async { Ok(()) })));

    let app = app();
    app.manage(Arc::clone(&queue));
    app.manage(storage.clone());

    let scoped = retry_failed_operations(AppServices::new(app.handle()), Some("account-1".into()))
        .await
        .unwrap();
    assert_eq!(scoped, 1);
    wait_for_item_status(&mut events_receiver, "send-a1", "done").await;

    mark_failed(&storage, "send-a1").await;

    let all = retry_failed_operations(AppServices::new(app.handle()), None)
        .await
        .unwrap();
    assert_eq!(all, 2);
}

#[tokio::test]
async fn retry_failed_operations_command_is_a_no_op_when_no_rows_match_the_scope() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account("account-empty")).unwrap();
    drop(connection);

    let executor: Executor = Arc::new(|_| Box::pin(async { Ok(()) }));
    let (events, _events_receiver) = events_channel();
    let queue = QueueEngine::with_config(
        QueueConfig {
            rate_per_second: 250,
            burst: 250,
            events: events,
            ..QueueConfig::default()
        },
        executor,
    );

    let app = app();
    app.manage(Arc::clone(&queue));
    app.manage(storage);

    let retried =
        retry_failed_operations(AppServices::new(app.handle()), Some("account-empty".into()))
            .await
            .unwrap();
    assert_eq!(retried, 0);
}

#[tokio::test]
async fn set_queue_paused_command_reports_whether_it_took_effect() {
    let executor: Executor = Arc::new(|_| Box::pin(async { Ok(()) }));
    let (events, _events_receiver) = events_channel();
    let queue = QueueEngine::with_config(
        QueueConfig {
            rate_per_second: 250,
            burst: 250,
            events: events,
            ..QueueConfig::default()
        },
        executor,
    );

    let app = app();
    app.manage(Arc::clone(&queue));

    let applied = set_queue_paused(
        AppServices::new(app.handle()),
        CommandPayload(SetQueuePausedPayload {
            scope: PauseScope::Account {
                account_id: "account".into(),
            },
            paused: true,
        }),
    )
    .await
    .unwrap();
    assert!(applied);

    let no_op = set_queue_paused(
        AppServices::new(app.handle()),
        CommandPayload(SetQueuePausedPayload {
            scope: PauseScope::Account {
                account_id: "account".into(),
            },
            paused: true,
        }),
    )
    .await
    .unwrap();
    assert!(!no_op);

    let released = set_queue_paused(
        AppServices::new(app.handle()),
        CommandPayload(SetQueuePausedPayload {
            scope: PauseScope::Account {
                account_id: "account".into(),
            },
            paused: false,
        }),
    )
    .await
    .unwrap();
    assert!(released);
}

async fn wait_for_first_operation_id(queue: &QueueEngine, account_id: &str) -> String {
    loop {
        let snapshot = queue.snapshot().await;
        let found = snapshot
            .iter()
            .find(|entry| entry.account_id == account_id)
            .and_then(|entry| entry.lanes.iter().flat_map(|lane| &lane.operations).next())
            .map(|record| record.id.clone());
        if let Some(id) = found {
            return id;
        }
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn the_production_cancellation_hook_wired_in_initialize_evicts_a_real_work_registry_entry() {
    let home = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", home.path());
    std::env::set_var("APPDATA", home.path());
    std::env::set_var("XDG_DATA_HOME", home.path());

    let application = app();
    tauri::WebviewWindowBuilder::new(&application, "main", Default::default())
        .visible(false)
        .build()
        .unwrap();
    let handle = application.handle();

    let directory = application.path().app_data_dir().unwrap();
    std::fs::create_dir_all(&directory).unwrap();
    let seed_storage = Storage::open(directory.join("latentmail.sqlite")).unwrap();
    application.manage(seed_storage.clone());
    latentmail_lib::settings::initialize(handle, seed_storage.clone()).unwrap();
    latentmail_lib::auth::initialize(handle, seed_storage.clone()).unwrap();
    let connection = seed_storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account("account")).unwrap();
    drop(connection);
    latentmail_lib::sync::initialize(handle, seed_storage).unwrap();

    let queue = application.state::<Arc<QueueEngine>>().inner().clone();
    let sync_engine = application
        .state::<Arc<latentmail_lib::sync::SyncEngine>>()
        .inner()
        .clone();
    queue.pause();

    let client = latentmail_lib::gmail::GmailClient::with_base_url(
        "placeholder-token",
        "http://127.0.0.1:1".to_owned(),
    );
    let trigger = tokio::spawn(async move { sync_engine.run_sync("account", client).await });

    let operation_id = wait_for_first_operation_id(&queue, "account").await;

    let applied = queue.cancel(&operation_id).await;
    assert!(applied.is_some());
    queue.resume();

    let result = trigger.await.unwrap();
    assert!(
        result.is_err(),
        "the caller awaiting the evicted closure resolves with an error instead of hanging"
    );
}
