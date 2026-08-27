use std::sync::Arc;

use chrono::Duration;

use latentmail_lib::{
    os::lifecycle::{ExitDecision, Lifecycle},
    queue::{Lane, OperationKind, QueueEngine, QueueOperation},
};

fn operation(id: &str, kind: OperationKind) -> QueueOperation {
    QueueOperation {
        id: id.into(),
        account_id: "account".into(),
        lane: Lane::Interactive,
        kind,
        entity_key: id.into(),
        cost: 0,
        attempts: 0,
        description: id.into(),
    }
}

#[tokio::test]
async fn only_executing_sends_warrant_a_quit_confirmation() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let executor_gate = Arc::clone(&gate);
    let queue = QueueEngine::new(
        250,
        250,
        Arc::new(move |_| {
            let gate = Arc::clone(&executor_gate);
            Box::pin(async move {
                gate.notified().await;
                Ok(())
            })
        }),
    );
    queue
        .enqueue(operation("send", OperationKind::Send))
        .await
        .unwrap();
    queue
        .enqueue(operation("draft", OperationKind::Draft))
        .await
        .unwrap();
    tokio::time::timeout(Duration::seconds(1).to_std().unwrap(), async {
        while queue.executing_sends() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let lifecycle = Lifecycle::new(
        Arc::clone(&queue),
        Duration::zero(),
        Arc::new(|| Box::pin(async {})),
    );
    assert_eq!(
        lifecycle.exit_decision(false),
        ExitDecision::Confirm {
            count: 1,
            message: "1 message is still sending. Close anyway?".into()
        }
    );
    assert_eq!(lifecycle.exit_decision(true), ExitDecision::Exit);
    lifecycle.confirm_close();
    assert_eq!(lifecycle.exit_decision(false), ExitDecision::Exit);
    gate.notify_waiters();
}

#[tokio::test]
async fn no_active_send_exits_and_multiple_sends_use_plural_wording() {
    let empty_queue = QueueEngine::no_op();
    let empty_lifecycle = Lifecycle::new(
        Arc::clone(&empty_queue),
        Duration::zero(),
        Arc::new(|| Box::pin(async {})),
    );
    assert_eq!(empty_lifecycle.exit_decision(false), ExitDecision::Exit);

    let gate = Arc::new(tokio::sync::Notify::new());
    let executor_gate = Arc::clone(&gate);
    let queue = QueueEngine::new(
        250,
        250,
        Arc::new(move |_| {
            let gate = Arc::clone(&executor_gate);
            Box::pin(async move {
                gate.notified().await;
                Ok(())
            })
        }),
    );
    queue
        .enqueue(operation("first", OperationKind::Send))
        .await
        .unwrap();
    queue
        .enqueue(operation("second", OperationKind::Send))
        .await
        .unwrap();
    tokio::time::timeout(Duration::seconds(1).to_std().unwrap(), async {
        while queue.executing_sends() != 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let lifecycle = Lifecycle::new(
        Arc::clone(&queue),
        Duration::zero(),
        Arc::new(|| Box::pin(async {})),
    );
    assert_eq!(
        lifecycle.exit_decision(false),
        ExitDecision::Confirm {
            count: 2,
            message: "2 messages are still sending. Close anyway?".into()
        }
    );
    gate.notify_waiters();
}
