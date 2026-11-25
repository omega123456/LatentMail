use latentmail_lib::queue::registry::TerminalTransition;
use latentmail_lib::queue::QueueConfig;
use std::sync::Arc;

use crate::support::{controllable_executor, events_channel, wait_for_item_status};
use latentmail_lib::queue::{
    registry::{LaneState, OperationStatus, QueueRegistry},
    Executor, Lane, OperationKind, QueueEngine, QueueOperation,
};

struct OperationSeed<'a> {
    id: &'a str,
    account_id: &'a str,
    lane: Lane,
    entity_key: &'a str,
    description: &'a str,
}

fn operation(
    OperationSeed {
        id,
        account_id,
        lane,
        entity_key,
        description,
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
        description: description.into(),
    }
}

#[tokio::test]
async fn enqueuing_creates_a_record_that_transitions_through_its_lifecycle() {
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
            id: "op-1",
            account_id: "account-1",
            lane: Lane::Background,
            entity_key: "entity-1",
            description: "Sync mailbox",
        }))
        .await
        .unwrap();

    wait_for_item_status(&mut events_receiver, "op-1", "active").await;

    let snapshot = queue.snapshot().await;
    let account = snapshot
        .iter()
        .find(|account| account.account_id == "account-1")
        .expect("account present");
    let lane = account
        .lanes
        .iter()
        .find(|lane| lane.lane == Lane::Background)
        .expect("background lane present");
    let record = lane
        .operations
        .iter()
        .find(|record| record.id == "op-1")
        .expect("record present");
    assert_eq!(record.account_id, "account-1");
    assert_eq!(record.lane, Lane::Background);
    assert_eq!(record.kind, OperationKind::Sync);
    assert_eq!(record.description, "Sync mailbox");
    assert_eq!(record.status, OperationStatus::Active);
    assert_eq!(lane.active, 1);
    assert_eq!(lane.backlog, 0);

    let (_, release) = started.recv().await.expect("executor started");
    release.send(()).unwrap();
    wait_for_item_status(&mut events_receiver, "op-1", "done").await;

    let snapshot = queue.snapshot().await;
    let account = snapshot
        .iter()
        .find(|account| account.account_id == "account-1")
        .expect("account present");
    let lane = account
        .lanes
        .iter()
        .find(|lane| lane.lane == Lane::Background)
        .expect("background lane present");
    let record = lane
        .operations
        .iter()
        .find(|record| record.id == "op-1")
        .expect("record present in history");
    assert_eq!(record.status, OperationStatus::Done);
    assert_eq!(lane.active, 0);
    assert_eq!(lane.backlog, 0);
}

#[tokio::test]
async fn a_lane_lists_the_most_recently_finished_operation_first() {
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

    for id in ["op-1", "op-2", "op-3"] {
        queue
            .enqueue(operation(OperationSeed {
                id: id,
                account_id: "account-1",
                lane: Lane::Background,
                entity_key: id,
                description: "Sync mailbox",
            }))
            .await
            .unwrap();
        wait_for_item_status(&mut events_receiver, id, "done").await;
    }

    let snapshot = queue.snapshot().await;
    let lane = find_lane(&snapshot, "account-1", Lane::Background);
    let ids: Vec<&str> = lane
        .operations
        .iter()
        .map(|record| record.id.as_str())
        .collect();
    assert_eq!(ids, vec!["op-3", "op-2", "op-1"]);
}

#[tokio::test]
async fn history_caps_at_two_hundred_records_per_account_evicting_oldest_first() {
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

    for index in 0..205 {
        let id = format!("op-{index}");
        queue
            .enqueue(operation(OperationSeed {
                id: &id,
                account_id: "account-1",
                lane: Lane::Background,
                entity_key: &id,
                description: "Sync mailbox",
            }))
            .await
            .unwrap();
        wait_for_item_status(&mut events_receiver, &id, "done").await;
    }

    let snapshot = queue.snapshot().await;
    let account = snapshot
        .iter()
        .find(|account| account.account_id == "account-1")
        .expect("account present");
    let lane = account
        .lanes
        .iter()
        .find(|lane| lane.lane == Lane::Background)
        .expect("background lane present");
    assert_eq!(lane.operations.len(), 200);
    assert!(!lane
        .operations
        .iter()
        .any(|record| record.id == "op-0" || record.id == "op-4"));
    assert!(lane.operations.iter().any(|record| record.id == "op-204"));
}

#[tokio::test]
async fn snapshot_groups_records_by_account_then_lane() {
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
            id: "a1-interactive",
            account_id: "account-1",
            lane: Lane::Interactive,
            entity_key: "a1-interactive",
            description: "d",
        }))
        .await
        .unwrap();
    wait_for_item_status(&mut events_receiver, "a1-interactive", "done").await;
    queue
        .enqueue(operation(OperationSeed {
            id: "a2-background",
            account_id: "account-2",
            lane: Lane::Background,
            entity_key: "a2-background",
            description: "d",
        }))
        .await
        .unwrap();
    wait_for_item_status(&mut events_receiver, "a2-background", "done").await;

    let snapshot = queue.snapshot().await;
    let account_ids: Vec<&str> = snapshot
        .iter()
        .map(|account| account.account_id.as_str())
        .collect();
    assert_eq!(account_ids, ["account-1", "account-2"]);
    for account in &snapshot {
        let lanes: Vec<Lane> = account.lanes.iter().map(|lane| lane.lane).collect();
        assert_eq!(
            lanes,
            [
                Lane::Interactive,
                Lane::Background,
                Lane::Traversal,
                Lane::Embedding,
            ]
        );
    }
}

fn find_lane<'a>(
    snapshot: &'a [latentmail_lib::queue::registry::AccountQueueSnapshot],
    account_id: &str,
    lane: Lane,
) -> &'a latentmail_lib::queue::registry::LaneSnapshot {
    snapshot
        .iter()
        .find(|account| account.account_id == account_id)
        .expect("account present")
        .lanes
        .iter()
        .find(|entry| entry.lane == lane)
        .expect("lane present")
}

#[tokio::test]
async fn lane_state_resolves_running_idle_paused_and_background_blocked_by_interactive() {
    use latentmail_lib::queue::PauseScope;

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

    for index in 0..5 {
        let id = format!("interactive-{index}");
        queue
            .enqueue(operation(OperationSeed {
                id: &id,
                account_id: "account-1",
                lane: Lane::Interactive,
                entity_key: &id,
                description: "interactive work",
            }))
            .await
            .unwrap();
    }

    let mut releases = Vec::new();
    for _ in 0..4 {
        let (_, release) = started.recv().await.expect("four interactive slots run");
        releases.push(release);
    }
    assert!(started.try_recv().is_err());

    let interactive_snapshot = queue.snapshot().await;
    let interactive_lane = find_lane(&interactive_snapshot, "account-1", Lane::Interactive);
    assert_eq!(interactive_lane.state, LaneState::Running);
    assert_eq!(interactive_lane.active, 4);

    queue
        .enqueue(operation(OperationSeed {
            id: "background-blocked",
            account_id: "account-1",
            lane: Lane::Background,
            entity_key: "background-blocked",
            description: "background work",
        }))
        .await
        .unwrap();
    let blocked_snapshot = queue.snapshot().await;
    let background_lane = find_lane(&blocked_snapshot, "account-1", Lane::Background);
    assert_eq!(background_lane.state, LaneState::Blocked);
    assert_eq!(background_lane.backlog, 1);

    let account_paused = queue
        .set_paused(
            &PauseScope::Account {
                account_id: "account-1".into(),
            },
            true,
        )
        .await;
    assert!(account_paused);
    let paused_snapshot = queue.snapshot().await;
    assert_eq!(
        find_lane(&paused_snapshot, "account-1", Lane::Background).state,
        LaneState::Paused
    );
    assert_eq!(
        find_lane(&paused_snapshot, "account-1", Lane::Interactive).state,
        LaneState::Paused
    );
    queue
        .set_paused(
            &PauseScope::Account {
                account_id: "account-1".into(),
            },
            false,
        )
        .await;

    for release in releases.drain(..) {
        release.send(()).unwrap();
    }
    let (_, background_release) = started.recv().await.expect("background operation unblocks");
    background_release.send(()).unwrap();

    let (_, fifth_release) = started
        .recv()
        .await
        .expect("fifth interactive operation runs");
    fifth_release.send(()).unwrap();

    let mut settled = false;
    for _ in 0..50 {
        let snapshot = queue.snapshot().await;
        let lane = find_lane(&snapshot, "account-1", Lane::Traversal);
        if lane.state == LaneState::Idle {
            settled = true;
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(settled, "traversal lane settles to idle once no work runs");
}

#[test]
fn discard_removes_a_record_that_never_reached_the_channel() {
    let registry = QueueRegistry::new();
    let queued = operation(OperationSeed {
        id: "discarded",
        account_id: "account-discard",
        lane: Lane::Background,
        entity_key: "entity-discard",
        description: "d",
    });
    registry.record_enqueued(&queued);
    let before = registry.snapshot(false, &Default::default());
    let has_record_before = before
        .iter()
        .find(|account| account.account_id == "account-discard")
        .is_some_and(|account| account.lanes.iter().any(|lane| !lane.operations.is_empty()));
    assert!(has_record_before);

    registry.discard("discarded");

    let snapshot = registry.snapshot(false, &Default::default());
    assert!(!snapshot
        .iter()
        .any(|account| account.account_id == "account-discard"));
}

#[test]
fn re_enqueuing_a_retried_operation_evicts_its_stale_terminal_history_entry() {
    let registry = QueueRegistry::new();
    let failing = operation(OperationSeed {
        id: "retried-op",
        account_id: "account-retry",
        lane: Lane::Interactive,
        entity_key: "entity-retry",
        description: "Send",
    });
    registry.record_enqueued(&failing);
    registry.transition_terminal(
        &failing,
        TerminalTransition {
            status: OperationStatus::Failed,
            error: Some("boom".to_owned()),
        },
    );

    registry.record_enqueued(&failing);

    let snapshot = registry.snapshot(false, &Default::default());
    let account = snapshot
        .iter()
        .find(|account| account.account_id == "account-retry")
        .expect("account present");
    let matching: Vec<_> = account
        .lanes
        .iter()
        .flat_map(|lane| &lane.operations)
        .filter(|record| record.id == "retried-op")
        .collect();
    assert_eq!(
        matching.len(),
        1,
        "exactly one record must exist for a retried operation id, not a stale failed one plus a fresh queued one"
    );
    assert_eq!(matching[0].status, OperationStatus::Queued);
}
