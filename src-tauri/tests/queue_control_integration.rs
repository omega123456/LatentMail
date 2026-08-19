use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use latentmail_lib::{
    queue::{
        admit_durable,
        commands::{
            cancel_queue_operation, clear_queue_history, retry_failed_operations,
            retry_queue_operation, set_queue_paused,
        },
        registry::PauseScope,
        Executor, Lane, LaneState, OperationKind, QueueEngine, QueueEventSink, QueueOperation,
    },
    storage::{Account, AccountRepository, Operation, OperationRepository, Storage},
};
use tauri::Manager;
use tokio::sync::{mpsc, oneshot};

fn app() -> tauri::App<tauri::test::MockRuntime> {
    tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap()
}

fn events_channel() -> (
    QueueEventSink,
    mpsc::UnboundedReceiver<(&'static str, serde_json::Value)>,
) {
    let (tx, rx) = mpsc::unbounded_channel();
    let sink: QueueEventSink = Arc::new(move |event, payload| {
        let _ = tx.send((event, payload));
    });
    (sink, rx)
}

async fn wait_for_item_status(
    receiver: &mut mpsc::UnboundedReceiver<(&'static str, serde_json::Value)>,
    id: &str,
    status: &str,
) {
    loop {
        let (event, payload) = receiver.recv().await.expect("event stream stays open");
        if event == "queue://item" && payload["id"] == id && payload["status"] == status {
            return;
        }
    }
}

fn drained_contains_summary(
    receiver: &mut mpsc::UnboundedReceiver<(&'static str, serde_json::Value)>,
) -> bool {
    let mut found = false;
    while let Ok((event, _)) = receiver.try_recv() {
        if event == "queue://summary" {
            found = true;
        }
    }
    found
}

fn controllable_executor() -> (Executor, mpsc::UnboundedReceiver<(String, oneshot::Sender<()>)>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let executor: Executor = Arc::new(move |operation: QueueOperation| {
        let tx = tx.clone();
        Box::pin(async move {
            let (release_tx, release_rx) = oneshot::channel();
            let _ = tx.send((operation.id, release_tx));
            let _ = release_rx.await;
            Ok(())
        })
    });
    (executor, rx)
}

fn operation(id: &str, account_id: &str, lane: Lane, entity_key: &str) -> QueueOperation {
    QueueOperation {
        id: id.into(),
        account_id: account_id.into(),
        lane,
        kind: OperationKind::Sync,
        entity_key: entity_key.into(),
        cost: 0,
        attempts: 0,
        description: "test operation".into(),
    }
}

#[tokio::test]
async fn cancelling_before_execution_evicts_the_hook_and_unwinds_pending_counters() {
    let (release_tx, release_rx) = oneshot::channel::<()>();
    let evicted = Arc::new(std::sync::Mutex::new(Some(release_tx)));
    let evicted_for_hook = Arc::clone(&evicted);
    let executed = Arc::new(AtomicUsize::new(0));
    let executed_for_executor = Arc::clone(&executed);
    let executor: Executor = Arc::new(move |_| {
        executed_for_executor.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    });
    let (events, mut events_rx) = events_channel();
    let queue = QueueEngine::new_with_events_and_hook(
        250,
        250,
        executor,
        events,
        Arc::new(move |_id: &str| {
            evicted_for_hook.lock().unwrap().take();
        }),
    );

    let before = queue.summary().pending;
    queue.pause();
    queue
        .enqueue(operation("cancel-me", "account", Lane::Background, "e1"))
        .await
        .unwrap();
    assert_eq!(queue.summary().pending, before + 1);

    let cancelled = queue.cancel("cancel-me").await;
    assert!(cancelled.is_some());
    assert_eq!(queue.summary().pending, before);
    assert!(drained_contains_summary(&mut events_rx));

    let resolved = release_rx.await;
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
    let (events, mut events_rx) = events_channel();
    let queue = QueueEngine::new_with_events(250, 250, executor, events);

    queue.pause();
    queue
        .enqueue(operation(
            "interactive-cancel",
            "account",
            Lane::Interactive,
            "e1",
        ))
        .await
        .unwrap();
    let cancelled = queue.cancel("interactive-cancel").await;
    assert!(cancelled.is_some());
    queue.resume();

    queue
        .enqueue(operation("background-after", "account", Lane::Background, "e2"))
        .await
        .unwrap();
    wait_for_item_status(&mut events_rx, "background-after", "done").await;
}

#[tokio::test]
async fn cancelling_an_already_executing_operation_reports_not_applied() {
    let (executor, mut started) = controllable_executor();
    let (events, mut events_rx) = events_channel();
    let queue = QueueEngine::new_with_events(250, 250, executor, events);

    queue
        .enqueue(operation("running", "account", Lane::Background, "e1"))
        .await
        .unwrap();
    wait_for_item_status(&mut events_rx, "running", "active").await;

    let cancelled = queue.cancel("running").await;
    assert!(cancelled.is_none());

    let (_, release) = started.recv().await.unwrap();
    release.send(()).unwrap();
    wait_for_item_status(&mut events_rx, "running", "done").await;
}

#[tokio::test]
async fn scoped_lane_pause_holds_only_that_lane_and_resuming_wakes_parked_work() {
    let (executor, mut started) = controllable_executor();
    let (events, _events_rx) = events_channel();
    let queue = QueueEngine::new_with_events(250, 250, executor, events);

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
        .enqueue(operation("parked", "account", Lane::Background, "e1"))
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

    let (id, release) = started.recv().await.expect("scoped resume wakes parked work");
    assert_eq!(id, "parked");
    release.send(()).unwrap();
}

#[tokio::test]
async fn paused_interactive_lane_does_not_hold_back_the_other_lanes() {
    let (executor, mut started) = controllable_executor();
    let (events, _events_rx) = events_channel();
    let queue = QueueEngine::new_with_events(250, 250, executor, events);

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
        .enqueue(operation("parked", "account", Lane::Interactive, "e1"))
        .await
        .unwrap();
    queue
        .enqueue(operation("background", "account", Lane::Background, "e2"))
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
    let (events, mut events_rx) = events_channel();
    let queue = QueueEngine::new_with_events(250, 250, executor, events);

    queue
        .enqueue(operation("acct-1-op", "account-1", Lane::Background, "e1"))
        .await
        .unwrap();
    wait_for_item_status(&mut events_rx, "acct-1-op", "done").await;
    queue
        .enqueue(operation("acct-2-op", "account-2", Lane::Background, "e2"))
        .await
        .unwrap();
    wait_for_item_status(&mut events_rx, "acct-2-op", "done").await;

    let app = app();
    app.manage(Arc::clone(&queue));

    clear_queue_history(app.state(), Some("account-1".into()));
    assert!(drained_contains_summary(&mut events_rx));

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

    clear_queue_history(app.state(), None);
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
    let (events, _events_rx) = events_channel();
    let queue = QueueEngine::new_with_events(250, 250, executor, events);
    queue.pause();
    admit_durable(
        &queue,
        &storage,
        QueueOperation {
            id: "send-cancel".into(),
            account_id: "account".into(),
            lane: Lane::Interactive,
            kind: OperationKind::Send,
            entity_key: "draft:send-cancel".into(),
            cost: 0,
            attempts: 0,
            description: "Send: Hi".into(),
        },
        "{}".into(),
    )
    .await
    .unwrap();

    let app = app();
    app.manage(Arc::clone(&queue));
    app.manage(storage.clone());

    let applied = cancel_queue_operation(app.state(), app.state(), "send-cancel".into())
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
    let (events, _events_rx) = events_channel();
    let queue = QueueEngine::new_with_events(250, 250, executor, events);
    queue.pause();
    queue
        .enqueue(operation("sync-cancel", "account", Lane::Background, "e1"))
        .await
        .unwrap();

    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();

    let app = app();
    app.manage(Arc::clone(&queue));
    app.manage(storage);

    let applied = cancel_queue_operation(app.state(), app.state(), "sync-cancel".into())
        .await
        .unwrap();
    assert!(applied);
    queue.resume();
}

#[tokio::test]
async fn retry_queue_operation_reenqueues_a_failed_send_and_refuses_other_kinds() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account("account")).unwrap();
    OperationRepository::upsert(
        &connection,
        &Operation {
            id: "sync-failed".into(),
            account_id: "account".into(),
            lane: "background".into(),
            kind: "sync".into(),
            entity_key: "sync:account".into(),
            payload: "{}".into(),
            status: "failed".into(),
            attempts: 3,
            next_attempt_at: None,
            error: Some("boom".into()),
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    OperationRepository::upsert(
        &connection,
        &Operation {
            id: "send-still-active".into(),
            account_id: "account".into(),
            lane: "interactive".into(),
            kind: "send".into(),
            entity_key: "draft:send-still-active".into(),
            payload: "{}".into(),
            status: "active".into(),
            attempts: 0,
            next_attempt_at: None,
            error: None,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    drop(connection);

    let calls = Arc::new(AtomicUsize::new(0));
    let calls_for_executor = Arc::clone(&calls);
    let executor: Executor = Arc::new(move |operation: QueueOperation| {
        let calls = Arc::clone(&calls_for_executor);
        Box::pin(async move {
            if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                Err(latentmail_lib::queue::QueueError::Permanent)
            } else {
                let _ = operation;
                Ok(())
            }
        })
    });
    let (events, mut events_rx) = events_channel();
    let queue = QueueEngine::new_with_events(250, 250, executor, events);

    admit_durable(
        &queue,
        &storage,
        QueueOperation {
            id: "send-retry".into(),
            account_id: "account".into(),
            lane: Lane::Interactive,
            kind: OperationKind::Send,
            entity_key: "draft:send-retry".into(),
            cost: 0,
            attempts: 0,
            description: "Send: Hi".into(),
        },
        "{}".into(),
    )
    .await
    .unwrap();
    wait_for_item_status(&mut events_rx, "send-retry", "failed").await;
    storage
        .run(|connection| {
            OperationRepository::mark_terminal(connection, "send-retry", "failed", Some("boom"))
        })
        .await
        .unwrap();

    let app = app();
    app.manage(Arc::clone(&queue));
    app.manage(storage.clone());

    let refused = retry_queue_operation(app.state(), app.state(), "sync-failed".into())
        .await
        .unwrap();
    assert!(!refused);

    let missing = retry_queue_operation(app.state(), app.state(), "does-not-exist".into())
        .await
        .unwrap();
    assert!(!missing);

    let still_active = retry_queue_operation(app.state(), app.state(), "send-still-active".into())
        .await
        .unwrap();
    assert!(!still_active);

    let retried = retry_queue_operation(app.state(), app.state(), "send-retry".into())
        .await
        .unwrap();
    assert!(retried);
    wait_for_item_status(&mut events_rx, "send-retry", "done").await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn retry_failed_operations_retries_every_failed_durable_row_optionally_scoped() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("mail.sqlite")).unwrap();
    let connection = storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account("account-1")).unwrap();
    AccountRepository::upsert(&connection, &account("account-2")).unwrap();
    for (id, account_id) in [("send-a1", "account-1"), ("send-a2", "account-2")] {
        OperationRepository::upsert(
            &connection,
            &Operation {
                id: id.into(),
                account_id: account_id.into(),
                lane: "interactive".into(),
                kind: "send".into(),
                entity_key: format!("draft:{id}"),
                payload: "{}".into(),
                status: "failed".into(),
                attempts: 1,
                next_attempt_at: None,
                error: Some("boom".into()),
                created_at: 1,
                updated_at: 1,
            },
        )
        .unwrap();
    }
    drop(connection);

    let executor: Executor = Arc::new(|_| Box::pin(async { Ok(()) }));
    let (events, mut events_rx) = events_channel();
    let queue = QueueEngine::new_with_events(250, 250, executor, events);

    let app = app();
    app.manage(Arc::clone(&queue));
    app.manage(storage.clone());

    let scoped = retry_failed_operations(app.state(), app.state(), Some("account-1".into()))
        .await
        .unwrap();
    assert_eq!(scoped, 1);
    wait_for_item_status(&mut events_rx, "send-a1", "done").await;

    storage
        .run(|connection| {
            OperationRepository::mark_terminal(connection, "send-a1", "failed", Some("boom"))
        })
        .await
        .unwrap();

    let all = retry_failed_operations(app.state(), app.state(), None)
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
    let (events, _events_rx) = events_channel();
    let queue = QueueEngine::new_with_events(250, 250, executor, events);

    let app = app();
    app.manage(Arc::clone(&queue));
    app.manage(storage);

    let retried = retry_failed_operations(app.state(), app.state(), Some("account-empty".into()))
        .await
        .unwrap();
    assert_eq!(retried, 0);
}

#[tokio::test]
async fn set_queue_paused_command_reports_whether_it_took_effect() {
    let executor: Executor = Arc::new(|_| Box::pin(async { Ok(()) }));
    let (events, _events_rx) = events_channel();
    let queue = QueueEngine::new_with_events(250, 250, executor, events);

    let app = app();
    app.manage(Arc::clone(&queue));

    let applied = set_queue_paused(
        app.state(),
        PauseScope::Account {
            account_id: "account".into(),
        },
        true,
    )
    .await
    .unwrap();
    assert!(applied);

    let no_op = set_queue_paused(
        app.state(),
        PauseScope::Account {
            account_id: "account".into(),
        },
        true,
    )
    .await
    .unwrap();
    assert!(!no_op);

    let released = set_queue_paused(
        app.state(),
        PauseScope::Account {
            account_id: "account".into(),
        },
        false,
    )
    .await
    .unwrap();
    assert!(released);
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

    latentmail_lib::settings::initialize(handle).unwrap();
    latentmail_lib::auth::initialize(handle).unwrap();

    let directory = application.path().app_data_dir().unwrap();
    let seed_storage = Storage::open(directory.join("latentmail.sqlite")).unwrap();
    let connection = seed_storage.connection().unwrap();
    AccountRepository::upsert(&connection, &account("account")).unwrap();
    drop(connection);
    drop(seed_storage);

    latentmail_lib::sync::initialize(handle).unwrap();

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

    let operation_id = loop {
        let snapshot = queue.snapshot().await;
        if let Some(id) = snapshot
            .iter()
            .find(|entry| entry.account_id == "account")
            .and_then(|entry| entry.lanes.iter().flat_map(|lane| &lane.operations).next())
            .map(|record| record.id.clone())
        {
            break id;
        }
        tokio::task::yield_now().await;
    };

    let applied = queue.cancel(&operation_id).await;
    assert!(applied.is_some());
    queue.resume();

    let result = trigger.await.unwrap();
    assert!(
        result.is_err(),
        "the caller awaiting the evicted closure resolves with an error instead of hanging"
    );
}
