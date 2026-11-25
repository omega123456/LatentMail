use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use tokio::sync::Mutex as AsyncMutex;

use super::events::EventSink;
use super::queue_bridge::WorkRegistry;
use crate::sync::traversal;
use crate::{
    gmail::GmailClient,
    queue::{QueueEngine, QueueError, QueueOperation, QueueRoute},
    storage::Storage,
};

#[derive(Clone)]
pub(super) struct BackfillRequest {
    pub(super) account_id: String,
    pub(super) client: GmailClient,
    pub(super) resumed: bool,
}

pub(super) fn enqueue_backfill_step(
    handles: BackfillHandles,
    request: BackfillRequest,
) -> Pin<Box<dyn Future<Output = ()> + Send>> {
    Box::pin(async move {
        let operation_id = format!(
            "traversal:{}:{}",
            request.account_id,
            handles.operation_counter.fetch_add(1, Ordering::Relaxed)
        );
        let step_handles = handles.clone();
        let step_request = request.clone();
        handles.registry.register(
            operation_id.clone(),
            Box::new(move || Box::pin(execute_backfill_step(step_handles, step_request))),
        );
        let enqueue_result = handles
            .queue
            .enqueue(QueueOperation::new(
                operation_id,
                request.account_id.clone(),
                QueueRoute::traversal(&request.account_id, "Backfill mailbox history"),
            ))
            .await;
        if enqueue_result.is_err() {
            handles
                .active_backfills
                .lock()
                .await
                .remove(&request.account_id);
        }
    })
}

async fn execute_backfill_step(
    handles: BackfillHandles,
    request: BackfillRequest,
) -> Result<(), QueueError> {
    let traversal_client = request.client.traversal_scoped();
    let step_result = traversal::run_backfill_step(traversal::BackfillStepContext {
        storage: &handles.storage,
        client: &traversal_client,
        account_id: &request.account_id,
        events: &handles.events,
        resumed: request.resumed,
        cache: handles.attachment_cache.clone(),
    })
    .await;
    let Ok(completed) = step_result else {
        handles
            .active_backfills
            .lock()
            .await
            .remove(&request.account_id);
        return Err(QueueError::Permanent);
    };
    if completed {
        handles
            .active_backfills
            .lock()
            .await
            .remove(&request.account_id);
        return Ok(());
    }
    enqueue_backfill_step(handles, request).await;
    Ok(())
}

#[derive(Clone)]
pub(super) struct BackfillHandles {
    pub(super) queue: Arc<QueueEngine>,
    pub(super) registry: Arc<WorkRegistry>,
    pub(super) storage: Storage,
    pub(super) events: EventSink,
    pub(super) operation_counter: Arc<AtomicU64>,
    pub(super) active_backfills: Arc<AsyncMutex<std::collections::HashSet<String>>>,
    pub(super) attachment_cache: Option<crate::attachments::AttachmentCache>,
}
