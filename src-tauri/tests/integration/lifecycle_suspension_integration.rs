use latentmail_lib::queue::QueueConfig;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use chrono::Duration;

use latentmail_lib::{
    os::lifecycle::{settling_delay, Lifecycle, PowerSignal},
    queue::{Lane, QueueEngine, QueueOperation},
};

fn operation(id: &str) -> QueueOperation {
    QueueOperation {
        id: id.into(),
        account_id: "account".into(),
        lane: Lane::Background,
        kind: latentmail_lib::queue::OperationKind::Sync,
        entity_key: id.into(),
        cost: 0,
        attempts: 0,
        description: "Sync".into(),
    }
}

fn expected_settling_seconds() -> i64 {
    if cfg!(target_os = "macos") {
        return 7;
    }
    15
}

#[test]
fn production_settling_delay_matches_the_platform() {
    assert_eq!(
        settling_delay(),
        Duration::seconds(expected_settling_seconds())
    );
}

async fn increment_counter(calls: Arc<AtomicUsize>) {
    calls.fetch_add(1, Ordering::Relaxed);
}

async fn increment_and_succeed(
    calls: Arc<AtomicUsize>,
) -> Result<(), latentmail_lib::queue::QueueError> {
    calls.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

async fn wait_for_done(queue: &QueueEngine, expected: usize) {
    while queue.summary().done != expected {
        tokio::task::yield_now().await;
    }
}

async fn wait_for_calls(calls: &AtomicUsize, expected: usize) {
    while calls.load(Ordering::Relaxed) != expected {
        tokio::task::yield_now().await;
    }
}

#[tokio::test(start_paused = true)]
async fn suspension_is_independent_from_user_pause_and_resume_work_waits_for_settling() {
    let queue = QueueEngine::no_op();
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_for_work = Arc::clone(&calls);
    let lifecycle = Lifecycle::new(
        Arc::clone(&queue),
        Duration::milliseconds(10),
        Arc::new(move || Box::pin(increment_counter(Arc::clone(&calls_for_work)))),
    );
    lifecycle.handle(PowerSignal::Suspend).await;
    assert!(queue.summary().suspended);
    queue.pause();
    let resume = lifecycle.handle(PowerSignal::Resume);
    tokio::pin!(resume);
    assert!(
        tokio::time::timeout(Duration::milliseconds(1).to_std().unwrap(), &mut resume)
            .await
            .is_err()
    );
    tokio::time::advance(Duration::milliseconds(10).to_std().unwrap()).await;
    resume.await;
    assert!(!queue.summary().suspended);
    assert!(queue.summary().paused);
    assert_eq!(calls.load(Ordering::Relaxed), 0);
    queue.resume();
    lifecycle.handle(PowerSignal::Suspend).await;
    lifecycle.handle(PowerSignal::Resume).await;
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn suspension_emits_summary_and_holds_new_work() {
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded = Arc::clone(&events);
    let queue = QueueEngine::with_config(
        QueueConfig {
            rate_per_second: 250,
            burst: 250,
            events: Arc::new(move |event, payload| recorded.lock().unwrap().push((event, payload))),
            ..QueueConfig::default()
        },
        Arc::new(|_| Box::pin(async { Ok(()) })),
    );
    queue.set_suspended(true);
    queue.enqueue(operation("held")).await.unwrap();
    tokio::task::yield_now().await;
    assert_eq!(queue.summary().pending, 1);
    assert!(events.lock().unwrap().iter().any(|(event, payload)| event
        == &latentmail_lib::events::QUEUE_SUMMARY
        && payload["suspended"] == true));
    queue.set_suspended(false);
    tokio::time::timeout(
        Duration::seconds(1).to_std().unwrap(),
        wait_for_done(&queue, 1),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn clearing_user_pause_does_not_release_suspended_work() {
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_for_executor = Arc::clone(&calls);
    let queue = QueueEngine::new(
        250,
        250,
        Arc::new(move |_| Box::pin(increment_and_succeed(Arc::clone(&calls_for_executor)))),
    );
    queue.pause();
    queue.set_suspended(true);
    queue.enqueue(operation("held-by-system")).await.unwrap();
    queue.resume();
    tokio::task::yield_now().await;
    assert_eq!(calls.load(Ordering::Relaxed), 0);
    assert!(queue.summary().suspended);
    queue.set_suspended(false);
    tokio::time::timeout(
        Duration::seconds(1).to_std().unwrap(),
        wait_for_calls(&calls, 1),
    )
    .await
    .unwrap();
}
