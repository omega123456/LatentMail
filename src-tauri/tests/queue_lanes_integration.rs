use std::sync::Arc;

use latentmail_lib::queue::{Executor, Lane, OperationKind, QueueEngine, QueueOperation};
use tokio::sync::mpsc;

fn operation(id: &str, lane: Lane, entity: &str) -> QueueOperation {
    QueueOperation {
        id: id.into(),
        account_id: "account".into(),
        lane,
        kind: OperationKind::Noop,
        entity_key: entity.into(),
        cost: 1,
        attempts: 0,
    }
}

#[tokio::test]
async fn no_op_queue_executes_enqueued_work() {
    let queue = QueueEngine::no_op();
    queue
        .enqueue(operation("noop", Lane::Interactive, "entity"))
        .await
        .unwrap();
    tokio::task::yield_now().await;
    assert_eq!(queue.summary().pending, 0);
}

#[tokio::test(start_paused = true)]
async fn pause_halts_work_and_resume_dispatches_all_three_lanes() {
    let (started, mut receiver) = mpsc::unbounded_channel();
    let executor: Executor = Arc::new(move |operation| {
        let started = started.clone();
        Box::pin(async move {
            started.send(operation.id).unwrap();
            Ok(())
        })
    });
    let queue = QueueEngine::new(250, 250, executor);
    queue.pause();
    queue
        .enqueue(operation("background", Lane::Background, "one"))
        .await
        .unwrap();
    queue
        .enqueue(operation("interactive", Lane::Interactive, "two"))
        .await
        .unwrap();
    queue
        .enqueue(operation("traversal", Lane::Traversal, "three"))
        .await
        .unwrap();
    tokio::task::yield_now().await;
    assert!(receiver.try_recv().is_err());
    queue.resume();
    let mut dispatched = vec![
        receiver.recv().await.unwrap(),
        receiver.recv().await.unwrap(),
        receiver.recv().await.unwrap(),
    ];
    // Interactive always goes first (it's what every other lane yields to);
    // background and traversal are independent lanes with no dispatch-order
    // guarantee between them.
    assert_eq!(dispatched.remove(0), "interactive");
    dispatched.sort();
    assert_eq!(
        dispatched,
        vec!["background".to_owned(), "traversal".to_owned()]
    );
}

#[tokio::test]
async fn same_entity_serializes_while_other_entities_start() {
    let (started, mut receiver) = mpsc::unbounded_channel();
    let executor: Executor = Arc::new(move |operation| {
        let started = started.clone();
        Box::pin(async move {
            started.send(operation.id).unwrap();
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            Ok(())
        })
    });
    let queue = QueueEngine::new(250, 250, executor);
    queue
        .enqueue(operation("first", Lane::Interactive, "same"))
        .await
        .unwrap();
    queue
        .enqueue(operation("second", Lane::Interactive, "same"))
        .await
        .unwrap();
    queue
        .enqueue(operation("other", Lane::Interactive, "other"))
        .await
        .unwrap();
    let first_two = [
        receiver.recv().await.unwrap(),
        receiver.recv().await.unwrap(),
    ];
    assert!(first_two.contains(&"first".to_owned()));
    assert!(first_two.contains(&"other".to_owned()));
}
