use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use latentmail_lib::queue::{
    retry_delay, Executor, Lane, OperationKind, QueueEngine, QueueError, QueueOperation,
};
use tokio::sync::mpsc;

#[tokio::test(start_paused = true)]
async fn retries_only_retryable_errors_with_exponential_backoff() {
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_for_executor = Arc::clone(&calls);
    let executor: Executor = Arc::new(move |_| {
        let calls = Arc::clone(&calls_for_executor);
        Box::pin(async move {
            if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                Err(QueueError::Http(429))
            } else {
                Ok(())
            }
        })
    });
    let queue = QueueEngine::new(250, 250, executor);
    queue
        .enqueue(QueueOperation {
            id: "retry".into(),
            account_id: "account".into(),
            lane: Lane::Interactive,
            kind: OperationKind::Noop,
            entity_key: "retry".into(),
            cost: 1,
            attempts: 0,
        })
        .await
        .unwrap();
    tokio::task::yield_now().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    tokio::time::advance(retry_delay(1)).await;
    tokio::task::yield_now().await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(queue.summary().done, 1);
    assert_eq!(retry_delay(10).as_secs(), 32);
}

#[tokio::test(start_paused = true)]
async fn rate_limited_operations_wait_for_the_token_bucket_to_refill() {
    let (started, mut receiver) = mpsc::unbounded_channel();
    let executor: Executor = Arc::new(move |operation| {
        let started = started.clone();
        Box::pin(async move {
            started.send(operation.id).unwrap();
            Ok(())
        })
    });
    // 1 token/second with a burst of 1: the second operation (a different
    // entity, so it is not blocked by the same-entity lock) must wait for
    // the bucket to refill before it can run.
    let queue = QueueEngine::new(1, 1, executor);
    queue
        .enqueue(QueueOperation {
            id: "first".into(),
            account_id: "account".into(),
            lane: Lane::Interactive,
            kind: OperationKind::Noop,
            entity_key: "one".into(),
            cost: 1,
            attempts: 0,
        })
        .await
        .unwrap();
    queue
        .enqueue(QueueOperation {
            id: "second".into(),
            account_id: "account".into(),
            lane: Lane::Interactive,
            kind: OperationKind::Noop,
            entity_key: "two".into(),
            cost: 1,
            attempts: 0,
        })
        .await
        .unwrap();

    assert_eq!(receiver.recv().await.as_deref(), Some("first"));
    assert!(receiver.try_recv().is_err());

    tokio::time::advance(Duration::from_secs(1)).await;

    assert_eq!(receiver.recv().await.as_deref(), Some("second"));
}

#[tokio::test]
async fn non_retryable_operations_increment_the_failed_counter_without_retrying() {
    let (finished, mut receiver) = mpsc::unbounded_channel();
    let executor: Executor = Arc::new(move |_| {
        let finished = finished.clone();
        Box::pin(async move {
            finished.send(()).unwrap();
            Err(QueueError::Permanent)
        })
    });
    let queue = QueueEngine::new(250, 250, executor);
    // `Send` operations never retry regardless of the error kind.
    queue
        .enqueue(QueueOperation {
            id: "send".into(),
            account_id: "account".into(),
            lane: Lane::Interactive,
            kind: OperationKind::Send,
            entity_key: "send".into(),
            cost: 1,
            attempts: 0,
        })
        .await
        .unwrap();

    receiver.recv().await.unwrap();
    tokio::task::yield_now().await;

    assert_eq!(queue.summary().failed, 1);
    assert_eq!(queue.summary().done, 0);
}
