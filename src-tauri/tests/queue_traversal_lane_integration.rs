use std::sync::Arc;

use latentmail_lib::queue::{
    Executor, Lane, OperationKind, QueueEngine, QueueError, QueueOperation,
};
use tokio::sync::mpsc;

fn operation(id: &str, lane: Lane, entity: &str) -> QueueOperation {
    QueueOperation {
        id: id.into(),
        account_id: "account".into(),
        lane,
        kind: OperationKind::Traversal,
        entity_key: entity.into(),
        cost: 1,
        attempts: 0,
        description: "test operation".into(),
    }
}

#[tokio::test(start_paused = true)]
async fn traversal_and_background_have_independent_concurrency() {
    let (started, mut receiver) = mpsc::unbounded_channel();
    let executor: Executor = Arc::new(move |operation| {
        let started = started.clone();
        Box::pin(async move {
            started.send(operation.id).unwrap();

            std::future::pending::<Result<(), QueueError>>().await
        })
    });
    let queue = QueueEngine::new(250, 250, executor);
    queue
        .enqueue(operation("background-stuck", Lane::Background, "bg"))
        .await
        .unwrap();
    queue
        .enqueue(operation("traversal-a", Lane::Traversal, "tv-a"))
        .await
        .unwrap();
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
    let mut seen = vec![
        receiver.recv().await.unwrap(),
        receiver.recv().await.unwrap(),
    ];
    seen.sort();
    assert_eq!(
        seen,
        vec!["background-stuck".to_owned(), "traversal-a".to_owned()]
    );
}

#[tokio::test(start_paused = true)]
async fn traversal_yields_to_interactive_like_background() {
    let (started, mut receiver) = mpsc::unbounded_channel();
    let executor: Executor = Arc::new(move |operation| {
        let started = started.clone();
        Box::pin(async move {
            started.send(operation.id).unwrap();
            std::future::pending::<Result<(), QueueError>>().await
        })
    });
    let queue = QueueEngine::new(250, 250, executor);
    for index in 0..5 {
        queue
            .enqueue(operation(
                &format!("interactive-{index}"),
                Lane::Interactive,
                "same-entity",
            ))
            .await
            .unwrap();
    }
    queue
        .enqueue(operation("traversal", Lane::Traversal, "elsewhere"))
        .await
        .unwrap();
    assert_eq!(receiver.recv().await.as_deref(), Some("interactive-0"));
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    assert!(
        receiver.try_recv().is_err(),
        "traversal must not dispatch while interactive work is still pending"
    );
}

#[tokio::test(start_paused = true)]
async fn interactive_dispatches_promptly_with_many_traversal_operations_queued() {
    let interactive_started = Arc::new(tokio::sync::Notify::new());
    let notify_for_executor = Arc::clone(&interactive_started);
    let executor: Executor = Arc::new(move |operation| {
        let notify = Arc::clone(&notify_for_executor);
        Box::pin(async move {
            if operation.lane == Lane::Interactive {
                notify.notify_one();
                Ok(())
            } else {
                std::future::pending::<Result<(), QueueError>>().await
            }
        })
    });
    let queue = QueueEngine::new(1_000, 1_000, executor);
    for index in 0..200 {
        queue
            .enqueue(operation(
                &format!("traversal-{index}"),
                Lane::Traversal,
                &format!("traversal-{index}"),
            ))
            .await
            .unwrap();
    }
    queue
        .enqueue(operation("interactive", Lane::Interactive, "thread"))
        .await
        .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_millis(250),
        interactive_started.notified(),
    )
    .await
    .expect("interactive must dispatch promptly even with traversal saturated");
}
