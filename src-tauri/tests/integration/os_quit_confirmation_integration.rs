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
        kind: kind,
        entity_key: id.into(),
        cost: 0,
        attempts: 0,
        description: id.into(),
    }
}

fn gated_queue(gate: Arc<tokio::sync::Notify>) -> Arc<QueueEngine> {
    QueueEngine::new(
        250,
        250,
        Arc::new(move |_| {
            let gate = Arc::clone(&gate);
            Box::pin(async move {
                gate.notified().await;
                Ok(())
            })
        }),
    )
}

async fn wait_for_executing_sends(queue: &QueueEngine, expected: usize) {
    tokio::time::timeout(Duration::seconds(1).to_std().unwrap(), async {
        while queue.executing_sends() != expected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

fn immediate_lifecycle(queue: &Arc<QueueEngine>) -> Lifecycle {
    Lifecycle::new(
        Arc::clone(queue),
        Duration::zero(),
        Arc::new(|| Box::pin(async {})),
    )
}

#[tokio::test]
async fn only_executing_sends_warrant_a_quit_confirmation() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let queue = gated_queue(Arc::clone(&gate));
    queue
        .enqueue(operation("send", OperationKind::Send))
        .await
        .unwrap();
    queue
        .enqueue(operation("draft", OperationKind::Draft))
        .await
        .unwrap();
    wait_for_executing_sends(&queue, 1).await;
    let lifecycle = immediate_lifecycle(&queue);
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
    let empty_lifecycle = immediate_lifecycle(&empty_queue);
    assert_eq!(empty_lifecycle.exit_decision(false), ExitDecision::Exit);

    let gate = Arc::new(tokio::sync::Notify::new());
    let queue = gated_queue(Arc::clone(&gate));
    queue
        .enqueue(operation("first", OperationKind::Send))
        .await
        .unwrap();
    queue
        .enqueue(operation("second", OperationKind::Send))
        .await
        .unwrap();
    wait_for_executing_sends(&queue, 2).await;
    let lifecycle = immediate_lifecycle(&queue);
    assert_eq!(
        lifecycle.exit_decision(false),
        ExitDecision::Confirm {
            count: 2,
            message: "2 messages are still sending. Close anyway?".into()
        }
    );
    gate.notify_waiters();
}
