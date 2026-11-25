use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex as StdMutex},
};

use tokio::sync::oneshot;

use crate::queue::{
    Executor, Lane, OperationFuture, OperationKind, QueueConfig, QueueEngine, QueueError,
    QueueEventSink, QueueOperation, QueueRoute,
};
use crate::sync::{traversal, LabelDelta, SyncError};

pub(super) type BoxFuture = Pin<Box<dyn Future<Output = Result<(), QueueError>> + Send>>;

pub(super) type OneShotWork = Box<dyn FnOnce() -> BoxFuture + Send>;

impl QueueRoute {
    pub(super) fn sync(account_id: &str) -> Self {
        Self {
            lane: Lane::Background,
            kind: OperationKind::Sync,
            entity_key: format!("sync:{account_id}"),
            description: "Sync mailbox".to_owned(),
        }
    }

    pub(super) fn traversal(account_id: &str, description: &str) -> Self {
        Self {
            lane: Lane::Traversal,
            kind: OperationKind::Traversal,
            entity_key: traversal::traversal_entity_key(account_id),
            description: description.to_owned(),
        }
    }

    pub(super) fn embedding(account_id: &str, description: String) -> Self {
        Self {
            lane: Lane::Embedding,
            kind: OperationKind::Embed,
            entity_key: format!("embedding:{account_id}"),
            description: description,
        }
    }
}

#[derive(Default)]
pub struct WorkRegistry {
    pub(super) work: StdMutex<std::collections::HashMap<String, OneShotWork>>,
}

impl WorkRegistry {
    pub fn new() -> Arc<Self> {
        Arc::default()
    }
    pub(super) fn register(&self, id: String, work: OneShotWork) {
        self.work
            .lock()
            .expect("work registry lock poisoned")
            .insert(id, work);
    }
    pub(super) fn take(&self, id: &str) -> Option<OneShotWork> {
        self.work
            .lock()
            .expect("work registry lock poisoned")
            .remove(id)
    }
}

#[derive(Clone, Copy)]
pub struct QueueRateConfig {
    pub rate_per_second: u32,
    pub burst: u32,
}

pub fn create_queue_engine(
    rate_per_second: u32,
    burst: u32,
    registry: Arc<WorkRegistry>,
) -> Arc<QueueEngine> {
    create_queue_engine_with_events(
        QueueRateConfig {
            rate_per_second: rate_per_second,
            burst: burst,
        },
        registry,
        Arc::new(|_, _| {}),
    )
}

pub fn create_queue_engine_with_events(
    config: QueueRateConfig,
    registry: Arc<WorkRegistry>,
    events: QueueEventSink,
) -> Arc<QueueEngine> {
    let hook_registry = Arc::clone(&registry);
    let cancellation_hook: crate::queue::CancellationHook = Arc::new(move |operation| {
        hook_registry.take(&operation.id);
    });
    QueueEngine::with_config(
        QueueConfig {
            rate_per_second: config.rate_per_second,
            burst: config.burst,
            events: events,
            cancellation_hook: cancellation_hook,
        },
        registry_executor(registry),
    )
}

pub(super) fn registry_executor(registry: Arc<WorkRegistry>) -> Executor {
    Arc::new(move |operation: QueueOperation| -> OperationFuture {
        let registry = Arc::clone(&registry);
        Box::pin(async move {
            match registry.take(&operation.id) {
                Some(work) => work().await,
                None => Ok(()),
            }
        })
    })
}

pub(super) fn gmail_base_url() -> String {
    std::env::var("LATENTMAIL_GMAIL_BASE_URL")
        .unwrap_or_else(|_| crate::gmail::GMAIL_API_BASE_URL.into())
}

pub(super) struct QueueDispatch<'a> {
    pub(super) queue: &'a Arc<QueueEngine>,
    pub(super) registry: &'a Arc<WorkRegistry>,
}

pub(super) struct QueuedWork {
    pub(super) account_id: String,
    pub(super) operation_id: String,
    pub(super) route: QueueRoute,
}

pub(super) async fn run_via_queue_on<F, T>(
    dispatch: QueueDispatch<'_>,
    work: QueuedWork,
    future: F,
) -> Result<T, SyncError>
where
    F: Future<Output = Result<T, SyncError>> + Send + 'static,
    T: Send + 'static,
{
    let (sender, receiver) = oneshot::channel::<Result<T, SyncError>>();
    dispatch.registry.register(
        work.operation_id.clone(),
        Box::new(move || {
            Box::pin(async move {
                let result = future.await;
                let queue_outcome = result
                    .as_ref()
                    .map(|_| ())
                    .map_err(|_| QueueError::Permanent);
                let _ = sender.send(result);
                queue_outcome
            })
        }),
    );
    let operation = QueueOperation::new(work.operation_id, work.account_id, work.route);
    dispatch
        .queue
        .enqueue(operation)
        .await
        .map_err(|_| SyncError::QueueStopped)?;
    receiver.await.map_err(|_| SyncError::QueueStopped)?
}

#[derive(Clone, Copy)]
enum LabelRuleSide {
    Added,
    Removed,
}

const OPERATION_KIND_RULES: &[(LabelRuleSide, &str, OperationKind)] = &[
    (LabelRuleSide::Added, "STARRED", OperationKind::Star),
    (LabelRuleSide::Removed, "STARRED", OperationKind::Unstar),
    (LabelRuleSide::Removed, "UNREAD", OperationKind::MarkRead),
    (LabelRuleSide::Added, "UNREAD", OperationKind::MarkUnread),
    (LabelRuleSide::Added, "TRASH", OperationKind::Delete),
    (LabelRuleSide::Added, "SPAM", OperationKind::Spam),
    (LabelRuleSide::Removed, "SPAM", OperationKind::NotSpam),
];

pub(super) fn derive_operation_kind(delta: &LabelDelta) -> OperationKind {
    for &(side, label, kind) in OPERATION_KIND_RULES {
        let labels = match side {
            LabelRuleSide::Added => &delta.additions,
            LabelRuleSide::Removed => &delta.removals,
        };
        if labels.contains(label) {
            return kind;
        }
    }
    let is_move = !delta.additions.is_empty() && !delta.removals.is_empty();
    if is_move {
        return OperationKind::Move;
    }
    OperationKind::LabelMutation
}
