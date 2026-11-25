use std::{
    future::Future,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use tokio::sync::{oneshot, Mutex as AsyncMutex};

use super::backfill::{enqueue_backfill_step, BackfillHandles, BackfillRequest};
use super::events::{
    emit_complete, emit_progress, EventSink, SyncCompleteEvent, SyncProgressEvent,
};
use super::full_sync::{
    emit_new_mail_if_present, full_sync_body, probe_only_body, FullSyncOutcome, NewMailNotice,
    SyncContext,
};
use super::incremental::{incremental_body, IncrementalOutcome};
use super::queue_bridge::{run_via_queue_on, QueueDispatch, QueuedWork, WorkRegistry};
use crate::sync::{dto, mutations, reconcile, AccountStatus, SyncError, SyncState, SyncStatusDto};
use crate::{
    gmail::{AccountClientConfig, GmailClient, GmailRateLimiters},
    queue::{Lane, QueueEngine, QueueError, QueueOperation, QueueRoute},
    storage::{AccountRepository, Storage},
};

pub struct SyncEngineDeps {
    pub storage: Storage,
    pub queue: Arc<QueueEngine>,
    pub registry: Arc<WorkRegistry>,
    pub events: EventSink,
}

pub struct EmbeddingJob<'a> {
    pub account_id: &'a str,
    pub description: String,
}

struct IdleCompletion<'a> {
    pub(super) account_id: &'a str,
    pub(super) history_id: i64,
    pub(super) added_count: u32,
    pub(super) now: i64,
    pub(super) changed: bool,
}

struct IncrementalTarget<'a> {
    pub(super) account_id: &'a str,
    pub(super) checkpoint: i64,
}

pub struct SyncEngine {
    pub(super) storage: Storage,
    pub(super) queue: Arc<QueueEngine>,
    pub(super) registry: Arc<WorkRegistry>,
    pub(super) events: EventSink,
    pub(super) status: AsyncMutex<std::collections::HashMap<String, AccountStatus>>,
    pub(super) operation_counter: Arc<AtomicU64>,
    pub(super) pending: AsyncMutex<mutations::PendingMutations>,
    pub(super) gmail_limiters: GmailRateLimiters,
    pub(super) active_backfills: Arc<AsyncMutex<std::collections::HashSet<String>>>,
    pub(super) attachment_cache: std::sync::OnceLock<crate::attachments::AttachmentCache>,
    pub(super) ai_catch_up: std::sync::OnceLock<Arc<dyn Fn(String) + Send + Sync>>,
    pub(super) clock: fn() -> chrono::DateTime<chrono::Utc>,
}

impl SyncEngine {
    pub fn new(deps: SyncEngineDeps) -> Arc<Self> {
        Self::with_clock(deps, chrono::Utc::now)
    }

    fn with_clock(deps: SyncEngineDeps, clock: fn() -> chrono::DateTime<chrono::Utc>) -> Arc<Self> {
        Self::with_clock_and_limiters(deps, clock, GmailRateLimiters::default())
    }

    fn with_clock_and_limiters(
        deps: SyncEngineDeps,
        clock: fn() -> chrono::DateTime<chrono::Utc>,
        gmail_limiters: GmailRateLimiters,
    ) -> Arc<Self> {
        Arc::new(Self {
            storage: deps.storage,
            queue: deps.queue,
            registry: deps.registry,
            events: deps.events,
            status: AsyncMutex::new(std::collections::HashMap::new()),
            operation_counter: Arc::new(AtomicU64::new(0)),
            pending: AsyncMutex::new(std::collections::HashMap::new()),
            gmail_limiters: gmail_limiters,
            active_backfills: Arc::new(AsyncMutex::new(std::collections::HashSet::new())),
            attachment_cache: std::sync::OnceLock::new(),
            ai_catch_up: std::sync::OnceLock::new(),
            clock: clock,
        })
    }

    #[cfg(feature = "test-utils")]
    pub fn new_with_clock(
        deps: SyncEngineDeps,
        clock: fn() -> chrono::DateTime<chrono::Utc>,
    ) -> Arc<Self> {
        Self::with_clock(deps, clock)
    }

    #[cfg(feature = "test-utils")]
    pub fn new_with_unmetered_gmail(deps: SyncEngineDeps) -> Arc<Self> {
        Self::with_clock_and_limiters(deps, chrono::Utc::now, GmailRateLimiters::unmetered())
    }

    pub fn set_attachment_cache(&self, cache: crate::attachments::AttachmentCache) {
        let _ = self.attachment_cache.set(cache);
    }

    pub fn set_ai_catch_up(&self, catch_up: Arc<dyn Fn(String) + Send + Sync>) {
        let _ = self.ai_catch_up.set(catch_up);
    }

    pub fn attachment_cache(&self) -> Option<&crate::attachments::AttachmentCache> {
        self.attachment_cache.get()
    }

    pub async fn gmail_client(&self, config: AccountClientConfig<'_>) -> GmailClient {
        GmailClient::for_account(config, &self.gmail_limiters).await
    }

    fn next_operation_id(&self, account_id: &str) -> String {
        let sequence = self.operation_counter.fetch_add(1, Ordering::Relaxed);
        format!("sync:{account_id}:{sequence}")
    }

    pub async fn enqueue_embedding<F>(
        &self,
        job: EmbeddingJob<'_>,
        future: F,
    ) -> Result<(), SyncError>
    where
        F: Future<Output = Result<(), String>> + Send + 'static,
    {
        let id = self.next_operation_id(job.account_id);
        self.registry.register(
            id.clone(),
            Box::new(move || Box::pin(run_embedding_future(future))),
        );
        self.queue
            .enqueue(QueueOperation::new(
                id,
                job.account_id.to_owned(),
                QueueRoute::embedding(job.account_id, job.description),
            ))
            .await
            .map_err(|_| SyncError::QueueStopped)
    }

    pub async fn cancel_embedding(&self, account_id: &str) {
        self.queue
            .cancel_account_lane_operations(account_id, Lane::Embedding)
            .await;
    }

    pub async fn enqueue_embedding_barrier<F>(
        &self,
        job: EmbeddingJob<'_>,
        future: F,
    ) -> Result<(), String>
    where
        F: Future<Output = Result<(), String>> + Send + 'static,
    {
        let (sent, received) = oneshot::channel();
        self.enqueue_embedding(job, async move {
            let result = future.await;
            let _ = sent.send(result.as_ref().map(|_| ()).map_err(Clone::clone));
            result
        })
        .await
        .map_err(|error| error.to_string())?;
        received
            .await
            .map_err(|_| "Embedding barrier was cancelled".to_owned())?
    }

    pub async fn status(&self, account_id: &str) -> SyncStatusDto {
        let status = self.status.lock().await;
        let account = status.get(account_id).cloned().unwrap_or_default();
        SyncStatusDto {
            account_id: account_id.to_owned(),
            state: account.state.unwrap_or(SyncState::Idle),
            last_synced_at: account.last_synced_at.map(dto::to_millis),
            last_error: account.last_error,
        }
    }

    async fn set_syncing(&self, account_id: &str) {
        let mut status = self.status.lock().await;
        let entry = status.entry(account_id.to_owned()).or_default();
        entry.state = Some(SyncState::Syncing);
        entry.last_error = None;
        drop(status);
        emit_progress(
            &self.events,
            SyncProgressEvent {
                account_id: account_id.to_owned(),
                state: SyncState::Syncing,
            },
        );
    }

    async fn set_idle(&self, completion: IdleCompletion<'_>) {
        {
            let mut status = self.status.lock().await;
            let entry = status.entry(completion.account_id.to_owned()).or_default();
            entry.state = Some(SyncState::Idle);
            entry.last_synced_at = Some(completion.now);
            entry.last_error = None;
        }
        emit_complete(
            &self.events,
            SyncCompleteEvent {
                account_id: completion.account_id.to_owned(),
                history_id: completion.history_id,
                added_count: completion.added_count,
                changed: completion.changed,
                completed_at: dto::to_millis(completion.now),
            },
        );
    }

    async fn set_error(&self, account_id: &str, error: &SyncError) {
        {
            let mut status = self.status.lock().await;
            let entry = status.entry(account_id.to_owned()).or_default();
            entry.state = Some(SyncState::Error);
            entry.last_error = Some(error.to_string());
        }
        tracing::error!(target: "sync", "sync for {account_id} failed: {error}");
        emit_progress(
            &self.events,
            SyncProgressEvent {
                account_id: account_id.to_owned(),
                state: SyncState::Error,
            },
        );
    }

    pub async fn run_sync(&self, account_id: &str, client: GmailClient) -> Result<(), SyncError> {
        let account = self
            .storage
            .run({
                let account_id = account_id.to_owned();
                move |connection| AccountRepository::get(connection, &account_id)
            })
            .await?
            .ok_or(SyncError::UnknownAccount)?;
        match account.history_id {
            None => {
                tracing::info!(target: "sync", "{account_id}: no checkpoint, running initial sync");
                self.initial_sync(account_id, client).await
            }
            Some(checkpoint) => {
                tracing::info!(target: "sync", "{account_id}: incremental sync from checkpoint {checkpoint}");
                self.incremental_sync(
                    IncrementalTarget {
                        account_id: account_id,
                        checkpoint: checkpoint,
                    },
                    client,
                )
                .await
            }
        }
    }

    pub async fn initial_sync(
        &self,
        account_id: &str,
        client: GmailClient,
    ) -> Result<(), SyncError> {
        self.set_syncing(account_id).await;
        let operation_id = self.next_operation_id(account_id);
        let storage = self.storage.clone();
        let account_owned = account_id.to_owned();
        let backfill_client = client.clone();
        let cache = self.attachment_cache().cloned();
        let outcome = run_via_queue_on(
            QueueDispatch {
                queue: &self.queue,
                registry: &self.registry,
            },
            QueuedWork {
                account_id: account_id.to_owned(),
                operation_id: operation_id,
                route: QueueRoute::sync(account_id),
            },
            async move {
                full_sync_body(SyncContext {
                    storage: &storage,
                    client: &client,
                    account_id: &account_owned,
                    cache: cache,
                })
                .await
            },
        )
        .await;
        let result = self.finish(account_id, outcome).await;
        if result.is_ok() {
            self.enqueue_backfill(account_id, backfill_client).await;
        }
        result
    }

    async fn try_claim_backfill(&self, account_id: &str) -> bool {
        self.active_backfills
            .lock()
            .await
            .insert(account_id.to_owned())
    }

    pub async fn enqueue_backfill(&self, account_id: &str, client: GmailClient) {
        if !self.try_claim_backfill(account_id).await {
            return;
        }
        let cursor = load_backfill_cursor(&self.storage, account_id).await;
        if cursor.as_ref().is_some_and(|cursor| cursor.completed) {
            self.active_backfills.lock().await.remove(account_id);
            return;
        }
        let resumed = cursor.is_some_and(|cursor| cursor.position.is_some());
        enqueue_backfill_step(
            BackfillHandles {
                queue: Arc::clone(&self.queue),
                registry: Arc::clone(&self.registry),
                storage: self.storage.clone(),
                events: Arc::clone(&self.events),
                operation_counter: Arc::clone(&self.operation_counter),
                active_backfills: Arc::clone(&self.active_backfills),
                attachment_cache: self.attachment_cache().cloned(),
            },
            BackfillRequest {
                account_id: account_id.to_owned(),
                client: client,
                resumed: resumed,
            },
        )
        .await;
    }

    async fn incremental_sync(
        &self,
        target: IncrementalTarget<'_>,
        client: GmailClient,
    ) -> Result<(), SyncError> {
        self.set_syncing(target.account_id).await;
        let operation_id = self.next_operation_id(target.account_id);
        let execution = IncrementalExecution {
            storage: self.storage.clone(),
            queue: Arc::clone(&self.queue),
            registry: Arc::clone(&self.registry),
            events: Arc::clone(&self.events),
            account_id: target.account_id.to_owned(),
            client: client,
            cache: self.attachment_cache().cloned(),
            checkpoint: target.checkpoint,
            now: (self.clock)(),
        };
        let outcome = run_via_queue_on(
            QueueDispatch {
                queue: &self.queue,
                registry: &self.registry,
            },
            QueuedWork {
                account_id: target.account_id.to_owned(),
                operation_id: operation_id,
                route: QueueRoute::sync(target.account_id),
            },
            execute_incremental_or_reconcile(execution),
        )
        .await;
        self.finish(target.account_id, outcome).await
    }

    async fn finish(
        &self,
        account_id: &str,
        outcome: Result<FullSyncOutcome, SyncError>,
    ) -> Result<(), SyncError> {
        match outcome {
            Ok(result) => self.complete(account_id, result).await,
            Err(error) => {
                self.set_error(account_id, &error).await;
                Err(error)
            }
        }
    }

    async fn complete(&self, account_id: &str, outcome: FullSyncOutcome) -> Result<(), SyncError> {
        let FullSyncOutcome {
            history_id,
            added_count,
            thread_ids,
            changed,
            arrivals,
        } = outcome;
        save_history_checkpoint(&self.storage, account_id, history_id).await?;
        let now = chrono::Utc::now().timestamp();
        tracing::info!(
            target: "sync",
            "{account_id}: complete — checkpoint now {history_id}, {added_count} new message(s) across {} thread(s)",
            thread_ids.len(),
        );
        self.set_idle(IdleCompletion {
            account_id: account_id,
            history_id: history_id,
            added_count: added_count,
            now: now,
            changed: changed,
        })
        .await;
        emit_new_mail_if_present(
            &self.events,
            NewMailNotice {
                account_id: account_id,
                thread_ids: thread_ids,
                arrivals: arrivals,
                added_count: added_count,
            },
        );
        if let Some(catch_up) = self.ai_catch_up.get() {
            catch_up(account_id.to_owned());
        }
        Ok(())
    }

    pub fn storage(&self) -> &Storage {
        &self.storage
    }

    pub async fn probe_only(&self, account_id: &str, client: GmailClient) -> Result<(), SyncError> {
        let operation_id = self.next_operation_id(account_id);
        let storage = self.storage.clone();
        let account_owned = account_id.to_owned();
        let cache = self.attachment_cache().cloned();
        let now = (self.clock)();
        let outcome = run_via_queue_on(
            QueueDispatch {
                queue: &self.queue,
                registry: &self.registry,
            },
            QueuedWork {
                account_id: account_id.to_owned(),
                operation_id: operation_id,
                route: QueueRoute::sync(account_id),
            },
            async move {
                probe_only_body(
                    SyncContext {
                        storage: &storage,
                        client: &client,
                        account_id: &account_owned,
                        cache: cache,
                    },
                    now,
                )
                .await
            },
        )
        .await;
        match outcome {
            Ok(batch) => {
                emit_new_mail_if_present(
                    &self.events,
                    NewMailNotice {
                        account_id: account_id,
                        thread_ids: batch.thread_ids,
                        arrivals: batch.arrivals,
                        added_count: batch.added_count,
                    },
                );
                Ok(())
            }
            Err(error) => {
                tracing::warn!(target: "sync", "{account_id}: inbox probe cadence failed: {error}");
                Err(error)
            }
        }
    }
}

struct IncrementalExecution {
    storage: Storage,
    queue: Arc<QueueEngine>,
    registry: Arc<WorkRegistry>,
    events: EventSink,
    account_id: String,
    client: GmailClient,
    cache: Option<crate::attachments::AttachmentCache>,
    checkpoint: i64,
    now: chrono::DateTime<chrono::Utc>,
}

async fn run_embedding_future<F>(future: F) -> Result<(), QueueError>
where
    F: Future<Output = Result<(), String>> + Send + 'static,
{
    future.await.map_err(|_| QueueError::Permanent)
}

async fn load_backfill_cursor(
    storage: &Storage,
    account_id: &str,
) -> Option<crate::storage::TraversalCursor> {
    let account = account_id.to_owned();
    storage
        .run(move |connection| {
            crate::storage::TraversalCursorRepository::get(
                connection,
                &account,
                crate::storage::TraversalKind::Backfill,
            )
        })
        .await
        .ok()
        .flatten()
}

async fn save_history_checkpoint(
    storage: &Storage,
    account_id: &str,
    history_id: i64,
) -> Result<(), SyncError> {
    let account_id = account_id.to_owned();
    storage
        .run(move |connection| {
            AccountRepository::set_history_id(connection, &account_id, history_id)
        })
        .await?;
    Ok(())
}

async fn execute_incremental_or_reconcile(
    execution: IncrementalExecution,
) -> Result<FullSyncOutcome, SyncError> {
    let context = SyncContext {
        storage: &execution.storage,
        client: &execution.client,
        account_id: &execution.account_id,
        cache: execution.cache.clone(),
    };
    match incremental_body(context, execution.checkpoint, execution.now).await? {
        IncrementalOutcome::Updated {
            history_id,
            added_count,
            thread_ids,
            changed,
            arrivals,
        } => Ok(FullSyncOutcome {
            history_id,
            added_count,
            thread_ids,
            changed,
            arrivals,
        }),
        IncrementalOutcome::Expired => run_reconciliation_via_queue(execution).await,
    }
}

async fn run_reconciliation_via_queue(
    execution: IncrementalExecution,
) -> Result<FullSyncOutcome, SyncError> {
    let reconciliation_client = execution.client.traversal_scoped();
    let reconciliation_storage = execution.storage.clone();
    let reconciliation_account = execution.account_id.clone();
    let reconciliation_queue = Arc::clone(&execution.queue);
    let reconciliation_events = execution.events;
    let reconciliation_cache = execution.cache;
    run_via_queue_on(
        QueueDispatch {
            queue: &execution.queue,
            registry: &execution.registry,
        },
        QueuedWork {
            account_id: execution.account_id.clone(),
            operation_id: format!(
                "reconcile:{}:{}",
                execution.account_id, execution.checkpoint
            ),
            route: QueueRoute::traversal(&execution.account_id, "Traverse mailbox history"),
        },
        async move {
            reconcile::run(reconcile::ReconciliationContext {
                storage: &reconciliation_storage,
                client: &reconciliation_client,
                account_id: &reconciliation_account,
                events: &reconciliation_events,
                queue: Some(&reconciliation_queue),
                cache: reconciliation_cache,
            })
            .await
        },
    )
    .await
}
