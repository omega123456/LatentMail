use crate::support::fail_first_call_executor;
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use chrono::Duration as ChronoDuration;
use latentmail_lib::queue::{
    retry_delay, Executor, Lane, OperationKind, QueueEngine, QueueError, QueueOperation,
};
use tokio::sync::mpsc;

fn recording_executor(started: mpsc::UnboundedSender<String>) -> Executor {
    Arc::new(move |operation| {
        let started = started.clone();
        Box::pin(async move {
            started.send(operation.id).unwrap();
            Ok(())
        })
    })
}

fn permanent_failure_executor(finished: mpsc::UnboundedSender<()>) -> Executor {
    Arc::new(move |_| {
        let finished = finished.clone();
        Box::pin(async move {
            finished.send(()).unwrap();
            Err(QueueError::Permanent)
        })
    })
}

fn interactive_operation(id: &str, entity_key: &str, kind: OperationKind) -> QueueOperation {
    QueueOperation {
        id: id.into(),
        account_id: "account".into(),
        lane: Lane::Interactive,
        kind: kind,
        entity_key: entity_key.into(),
        cost: 1,
        attempts: 0,
        description: "test operation".into(),
    }
}

#[tokio::test(start_paused = true)]
async fn retries_only_retryable_errors_with_exponential_backoff() {
    let calls = Arc::new(AtomicUsize::new(0));
    let queue = QueueEngine::new(
        250,
        250,
        fail_first_call_executor(Arc::clone(&calls), QueueError::Http(429)),
    );
    queue
        .enqueue(interactive_operation("retry", "retry", OperationKind::Noop))
        .await
        .unwrap();
    tokio::task::yield_now().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    tokio::time::advance(retry_delay(1)).await;
    tokio::task::yield_now().await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(queue.summary().done, 1);

    assert_eq!(retry_delay(6).as_secs(), 32);
    assert_eq!(retry_delay(7).as_secs(), 60);
    assert_eq!(retry_delay(10).as_secs(), 60);
}

#[tokio::test(start_paused = true)]
async fn rate_limited_operations_wait_for_the_token_bucket_to_refill() {
    let (started, mut receiver) = mpsc::unbounded_channel();
    let queue = QueueEngine::new(1, 1, recording_executor(started));
    queue
        .enqueue(interactive_operation("first", "one", OperationKind::Noop))
        .await
        .unwrap();
    queue
        .enqueue(interactive_operation("second", "two", OperationKind::Noop))
        .await
        .unwrap();

    assert_eq!(receiver.recv().await.as_deref(), Some("first"));
    assert!(receiver.try_recv().is_err());

    tokio::time::advance(Duration::from_secs(1)).await;

    assert_eq!(receiver.recv().await.as_deref(), Some("second"));
}

#[tokio::test(start_paused = true)]
async fn suspension_while_waiting_for_tokens_prevents_executor_start_until_resumed() {
    let (started, mut receiver) = mpsc::unbounded_channel();
    let queue = QueueEngine::new(1, 1, recording_executor(started));
    for id in ["first", "second"] {
        queue
            .enqueue(interactive_operation(id, id, OperationKind::Noop))
            .await
            .unwrap();
    }

    assert_eq!(receiver.recv().await.as_deref(), Some("first"));
    tokio::task::yield_now().await;
    queue.set_suspended(true);
    tokio::time::advance(ChronoDuration::seconds(1).to_std().unwrap()).await;
    tokio::task::yield_now().await;
    assert!(receiver.try_recv().is_err());

    queue.set_suspended(false);
    assert_eq!(receiver.recv().await.as_deref(), Some("second"));
}

#[tokio::test]
async fn non_retryable_operations_increment_the_failed_counter_without_retrying() {
    let (finished, mut receiver) = mpsc::unbounded_channel();
    let queue = QueueEngine::new(250, 250, permanent_failure_executor(finished));

    queue
        .enqueue(interactive_operation("send", "send", OperationKind::Send))
        .await
        .unwrap();

    receiver.recv().await.unwrap();
    tokio::task::yield_now().await;

    assert_eq!(queue.summary().failed, 1);
    assert_eq!(queue.summary().done, 0);
}
