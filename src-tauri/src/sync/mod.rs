use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::{oneshot, watch, Mutex as AsyncMutex};

use crate::{
    attachments::MessageTarget,
    auth::AuthService,
    compose::drafts::DraftExecutorContext,
    gmail::{
        AccountClientConfig, GmailClient, GmailError, GmailLabel, GmailMessage, GmailRateLimiters,
        MessageListQuery,
    },
    queue::{
        Executor, Lane, OperationFuture, OperationKind, QueueConfig, QueueEngine, QueueError,
        QueueEventSink, QueueOperation, QueueRoute,
    },
    settings::SettingsService,
    storage::{
        AccountRepository, Label, LabelColor, LabelMembershipChange, LabelRepository, MessageKey,
        MessageRepository, Storage, StorageError, ThreadRepository,
    },
};

const FRESH_ARRIVAL_MINUTES: i64 = 10;

pub mod announce;
pub mod commands;
pub mod concurrency;
mod dto;
pub mod materialize;
mod mutations;
mod reconcile;
pub mod traversal;
pub mod triage;

pub use dto::{
    message_dto, thread_page_limit, to_millis, AttachmentDto, ContactSuggestionDto,
    ConversationDto, HtmlPresenceDto, ImagePolicy, ImagePolicyTarget, LabelColorDto, LabelDto,
    MessageBodyDto, MessageBodyFetchedDto, MessageBodyInput, MessageDto, MessageDtoInput,
    MutationOutcomeDto, MutationResultDto, ParsedSearchQueryDto, SearchPredicateDto,
    StagedAttachmentDto, SyncStatusDto, ThreadCursor, ThreadDto, ThreadPage, ThreadPageDirection,
    ThreadRowDetails, ThreadSearchPage, TraversalKind, TraversalState, TraversalStatusDto,
};
pub use mutations::{
    LabelDelta, MessageMutation, MutationOutcome, ThreadMutation, BATCH_MODIFY_CHUNK_SIZE,
};

type BoxFuture = Pin<Box<dyn Future<Output = Result<(), QueueError>> + Send>>;
type OneShotWork = Box<dyn FnOnce() -> BoxFuture + Send>;

impl QueueRoute {
    fn sync(account_id: &str) -> Self {
        Self {
            lane: Lane::Background,
            kind: OperationKind::Sync,
            entity_key: format!("sync:{account_id}"),
            description: "Sync mailbox".to_owned(),
        }
    }

    fn traversal(account_id: &str, description: &str) -> Self {
        Self {
            lane: Lane::Traversal,
            kind: OperationKind::Traversal,
            entity_key: traversal::traversal_entity_key(account_id),
            description: description.to_owned(),
        }
    }

    fn embedding(account_id: &str, description: String) -> Self {
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
    work: StdMutex<std::collections::HashMap<String, OneShotWork>>,
}

impl WorkRegistry {
    pub fn new() -> Arc<Self> {
        Arc::default()
    }
    fn register(&self, id: String, work: OneShotWork) {
        self.work
            .lock()
            .expect("work registry lock poisoned")
            .insert(id, work);
    }
    fn take(&self, id: &str) -> Option<OneShotWork> {
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

fn registry_executor(registry: Arc<WorkRegistry>) -> Executor {
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

fn gmail_base_url() -> String {
    std::env::var("LATENTMAIL_GMAIL_BASE_URL")
        .unwrap_or_else(|_| crate::gmail::GMAIL_API_BASE_URL.into())
}

struct QueueDispatch<'a> {
    queue: &'a Arc<QueueEngine>,
    registry: &'a Arc<WorkRegistry>,
}

struct QueuedWork {
    account_id: String,
    operation_id: String,
    route: QueueRoute,
}

async fn run_via_queue_on<F, T>(
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

fn derive_operation_kind(delta: &LabelDelta) -> OperationKind {
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

#[derive(Debug)]
pub enum SyncError {
    Gmail(GmailError),
    Storage(StorageError),
    QueueStopped,
    UnknownAccount,
    Failed(String),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Gmail(error) => write!(f, "Gmail request failed: {error}"),
            Self::Storage(error) => write!(f, "storage error: {error}"),
            Self::QueueStopped => write!(f, "sync queue is no longer accepting work"),
            Self::UnknownAccount => write!(f, "unknown account"),
            Self::Failed(message) => write!(f, "{message}"),
        }
    }
}
impl std::error::Error for SyncError {}
impl From<GmailError> for SyncError {
    fn from(error: GmailError) -> Self {
        Self::Gmail(error)
    }
}
impl From<StorageError> for SyncError {
    fn from(error: StorageError) -> Self {
        Self::Storage(error)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncState {
    Idle,
    Syncing,
    Error,
}

#[derive(Clone, Debug, Default)]
struct AccountStatus {
    state: Option<SyncState>,
    last_synced_at: Option<i64>,
    last_error: Option<String>,
}

pub type EventSink = Arc<dyn Fn(&'static str, serde_json::Value) + Send + Sync>;

pub fn noop_event_sink() -> EventSink {
    Arc::new(|_, _| {})
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgressEvent {
    pub account_id: String,
    pub state: SyncState,
}

pub fn emit_progress(sink: &EventSink, event: SyncProgressEvent) {
    sink(
        crate::events::SYNC_PROGRESS,
        serde_json::to_value(event).expect("SyncProgressEvent always serializes"),
    );
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCompleteEvent {
    pub account_id: String,
    pub history_id: i64,
    pub added_count: u32,
    pub changed: bool,
    pub completed_at: i64,
}

pub fn emit_complete(sink: &EventSink, event: SyncCompleteEvent) {
    sink(
        crate::events::SYNC_COMPLETE,
        serde_json::to_value(event).expect("SyncCompleteEvent always serializes"),
    );
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailArrival {
    pub thread_id: String,
    pub sender: String,
    pub subject: String,
    pub snippet: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMailEvent {
    pub account_id: String,
    pub thread_ids: Vec<String>,
    pub arrivals: Vec<MailArrival>,
}

pub fn emit_new_mail(sink: &EventSink, event: NewMailEvent) {
    sink(
        crate::events::MAIL_NEW,
        serde_json::to_value(event).expect("NewMailEvent always serializes"),
    );
}

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
    account_id: &'a str,
    history_id: i64,
    added_count: u32,
    now: i64,
    changed: bool,
}

struct IncrementalTarget<'a> {
    account_id: &'a str,
    checkpoint: i64,
}

pub struct SyncEngine {
    storage: Storage,
    queue: Arc<QueueEngine>,
    registry: Arc<WorkRegistry>,
    events: EventSink,
    status: AsyncMutex<std::collections::HashMap<String, AccountStatus>>,
    operation_counter: Arc<AtomicU64>,
    pending: AsyncMutex<mutations::PendingMutations>,
    gmail_limiters: GmailRateLimiters,
    active_backfills: Arc<AsyncMutex<std::collections::HashSet<String>>>,
    attachment_cache: std::sync::OnceLock<crate::attachments::AttachmentCache>,
    ai_catch_up: std::sync::OnceLock<Arc<dyn Fn(String) + Send + Sync>>,
    clock: fn() -> chrono::DateTime<chrono::Utc>,
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
            Box::new(move || {
                Box::pin(async move { future.await.map_err(|_| QueueError::Permanent) })
            }),
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

    pub async fn enqueue_backfill(&self, account_id: &str, client: GmailClient) {
        {
            let mut active = self.active_backfills.lock().await;
            if !active.insert(account_id.to_owned()) {
                return;
            }
        }
        let cursor = self
            .storage
            .run({
                let account = account_id.to_owned();
                move |connection| {
                    crate::storage::TraversalCursorRepository::get(
                        connection,
                        &account,
                        crate::storage::TraversalKind::Backfill,
                    )
                }
            })
            .await
            .ok()
            .flatten();
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
        let storage = self.storage.clone();
        let traversal_queue = Arc::clone(&self.queue);
        let traversal_registry = Arc::clone(&self.registry);
        let reconciliation_events = Arc::clone(&self.events);
        let account_owned = target.account_id.to_owned();
        let cache = self.attachment_cache().cloned();
        let reconciliation_cache = cache.clone();
        let now = (self.clock)();
        let checkpoint = target.checkpoint;
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
            async move {
                let context = SyncContext {
                    storage: &storage,
                    client: &client,
                    account_id: &account_owned,
                    cache: cache,
                };
                match incremental_body(context, checkpoint, now).await? {
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
                    IncrementalOutcome::Expired => {
                        let reconciliation_client = client.traversal_scoped();
                        let reconciliation_storage = storage.clone();
                        let reconciliation_account = account_owned.clone();
                        run_via_queue_on(
                            QueueDispatch {
                                queue: &traversal_queue,
                                registry: &traversal_registry,
                            },
                            QueuedWork {
                                account_id: account_owned.clone(),
                                operation_id: format!("reconcile:{account_owned}:{checkpoint}"),
                                route: QueueRoute::traversal(
                                    &account_owned,
                                    "Traverse mailbox history",
                                ),
                            },
                            {
                                let reconciliation_queue = Arc::clone(&traversal_queue);
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
                                }
                            },
                        )
                        .await
                    }
                }
            },
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
        self.storage
            .run({
                let account_id = account_id.to_owned();
                move |connection| {
                    AccountRepository::set_history_id(connection, &account_id, history_id)
                }
            })
            .await?;
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

struct BackfillRequest {
    account_id: String,
    client: GmailClient,
    resumed: bool,
}

fn enqueue_backfill_step(
    handles: BackfillHandles,
    request: BackfillRequest,
) -> Pin<Box<dyn Future<Output = ()> + Send>> {
    Box::pin(async move {
        let BackfillHandles {
            queue,
            registry,
            storage,
            events,
            operation_counter,
            active_backfills,
            attachment_cache,
        } = handles;
        let BackfillRequest {
            account_id,
            client,
            resumed,
        } = request;
        let operation_id = format!(
            "traversal:{account_id}:{}",
            operation_counter.fetch_add(1, Ordering::Relaxed)
        );
        let step_storage = storage.clone();
        let step_events = Arc::clone(&events);
        let step_account = account_id.clone();
        let step_client = client.clone();
        let step_attachment_cache = attachment_cache.clone();
        let (step_queue, step_registry, step_operation_counter, step_active_backfills) = (
            Arc::clone(&queue),
            Arc::clone(&registry),
            Arc::clone(&operation_counter),
            Arc::clone(&active_backfills),
        );
        registry.register(
            operation_id.clone(),
            Box::new(move || {
                Box::pin(async move {
                    let traversal_client = step_client.traversal_scoped();
                    let step_result =
                        traversal::run_backfill_step(traversal::BackfillStepContext {
                            storage: &step_storage,
                            client: &traversal_client,
                            account_id: &step_account,
                            events: &step_events,
                            resumed: resumed,
                            cache: step_attachment_cache.clone(),
                        })
                        .await;
                    let completed = match step_result {
                        Ok(completed) => completed,
                        Err(_) => {
                            step_active_backfills.lock().await.remove(&step_account);
                            return Err(QueueError::Permanent);
                        }
                    };
                    if completed {
                        step_active_backfills.lock().await.remove(&step_account);
                        return Ok(());
                    }
                    enqueue_backfill_step(
                        BackfillHandles {
                            queue: step_queue,
                            registry: step_registry,
                            storage: step_storage,
                            events: step_events,
                            operation_counter: step_operation_counter,
                            active_backfills: step_active_backfills,
                            attachment_cache: attachment_cache,
                        },
                        BackfillRequest {
                            account_id: step_account,
                            client: step_client,
                            resumed: resumed,
                        },
                    )
                    .await;
                    Ok(())
                })
            }),
        );
        let enqueue_result = queue
            .enqueue(QueueOperation::new(
                operation_id,
                account_id.clone(),
                QueueRoute::traversal(&account_id, "Backfill mailbox history"),
            ))
            .await;
        if enqueue_result.is_err() {
            active_backfills.lock().await.remove(&account_id);
        }
    })
}

struct BackfillHandles {
    queue: Arc<QueueEngine>,
    registry: Arc<WorkRegistry>,
    storage: Storage,
    events: EventSink,
    operation_counter: Arc<AtomicU64>,
    active_backfills: Arc<AsyncMutex<std::collections::HashSet<String>>>,
    attachment_cache: Option<crate::attachments::AttachmentCache>,
}

struct SyncContext<'a> {
    storage: &'a Storage,
    client: &'a GmailClient,
    account_id: &'a str,
    cache: Option<crate::attachments::AttachmentCache>,
}

pub(crate) struct FullSyncOutcome {
    history_id: i64,
    added_count: u32,
    thread_ids: Vec<String>,
    changed: bool,
    arrivals: Vec<MailArrival>,
}

async fn full_sync_body(context: SyncContext<'_>) -> Result<FullSyncOutcome, SyncError> {
    let profile = context.client.profile().await?;
    let gmail_labels = context.client.labels().await?;
    let inbox_labels = ["INBOX".to_owned()];
    let refs = context
        .client
        .list_all_messages_matching(MessageListQuery {
            label_ids: &inbox_labels,
            query_filter: Some("newer_than:30d"),
            page_token: None,
            options: crate::gmail::ListOptions::default(),
        })
        .await?;
    let messages = concurrency::fetch_messages(
        context.client,
        refs.into_iter().map(|message_ref| message_ref.id).collect(),
    )
    .await?;
    let added_count = messages.len() as u32;
    let thread_ids: HashSet<String> = messages
        .iter()
        .map(|message| message.thread_id.clone())
        .collect();

    tracing::info!(
        target: "sync",
        "{}: full sync fetched {added_count} message(s) across {} thread(s), profile checkpoint {}",
        context.account_id,
        thread_ids.len(),
        profile.history_id,
    );
    let account_owned = context.account_id.to_owned();
    let cache = context.cache;
    context
        .storage
        .run(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            transaction.execute("DELETE FROM messages WHERE account_id=?1", [&account_owned])?;
            transaction.execute("DELETE FROM threads WHERE account_id=?1", [&account_owned])?;
            sync_labels(
                &transaction,
                LabelSyncTarget {
                    account_id: &account_owned,
                    gmail_labels: &gmail_labels,
                },
                &mut HashSet::new(),
            )?;
            write_messages_and_recompute(
                &transaction,
                WriteTarget {
                    account_id: &account_owned,
                    cache: cache.as_ref(),
                },
                &messages,
            )?;
            transaction.commit()
        })
        .await?;

    Ok(FullSyncOutcome {
        history_id: profile.history_id,
        added_count: added_count,
        thread_ids: thread_ids.into_iter().collect(),
        changed: true,
        arrivals: Vec::new(),
    })
}

const INBOX_PROBE_SIZE: u32 = 25;

struct UnknownFetch<'a> {
    candidates: Vec<String>,
    already: &'a [GmailMessage],
    source: &'a str,
}

async fn probe_inbox(
    context: &SyncContext<'_>,
    already: &[GmailMessage],
) -> Result<Vec<GmailMessage>, SyncError> {
    let inbox_labels = ["INBOX".to_owned()];
    let page = context
        .client
        .list_messages_page_matching(MessageListQuery {
            label_ids: &inbox_labels,
            query_filter: None,
            page_token: None,
            options: crate::gmail::ListOptions {
                include_spam_and_trash: false,
                page_size: INBOX_PROBE_SIZE,
            },
        })
        .await?;
    let candidates = page
        .items
        .into_iter()
        .map(|reference| reference.id)
        .collect();
    fetch_unknown(
        context,
        UnknownFetch {
            candidates: candidates,
            already: already,
            source: "inbox probe",
        },
    )
    .await
}

async fn fetch_unknown(
    context: &SyncContext<'_>,
    request: UnknownFetch<'_>,
) -> Result<Vec<GmailMessage>, SyncError> {
    let seen: HashSet<&str> = request
        .already
        .iter()
        .map(|message| message.id.as_str())
        .collect();
    let candidates: Vec<String> = request
        .candidates
        .into_iter()
        .filter(|id| !seen.contains(id.as_str()))
        .collect();
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let account_owned = context.account_id.to_owned();
    let unknown = context
        .storage
        .run(move |connection| {
            MessageRepository::missing_ids(connection, &account_owned, candidates)
        })
        .await?;
    if unknown.is_empty() {
        return Ok(Vec::new());
    }

    tracing::info!(
        target: "sync",
        "{}: {} found {} message(s) no delta reported: {}",
        context.account_id,
        request.source,
        unknown.len(),
        unknown.join(", "),
    );
    concurrency::fetch_messages(context.client, unknown).await
}

pub(crate) struct MaterializedBatch {
    thread_ids: Vec<String>,
    arrivals: Vec<MailArrival>,
    added_count: u32,
}

struct ArrivalWindow<'a> {
    account_id: &'a str,
    now: chrono::DateTime<chrono::Utc>,
}

fn compute_arrivals(
    connection: &rusqlite::Connection,
    window: ArrivalWindow<'_>,
    messages: &[GmailMessage],
) -> rusqlite::Result<Vec<MailArrival>> {
    let mut missing: HashSet<String> = MessageRepository::missing_ids(
        connection,
        window.account_id,
        messages.iter().map(|message| message.id.clone()).collect(),
    )?
    .into_iter()
    .collect();
    Ok(messages
        .iter()
        .filter(|message| {
            let has = |label: &str| message.label_ids.iter().any(|id| id == label);
            missing.remove(&message.id)
                && has("INBOX")
                && has("UNREAD")
                && chrono::DateTime::from_timestamp(message.sent_at, 0).is_some_and(|sent_at| {
                    window.now.signed_duration_since(sent_at)
                        <= chrono::Duration::minutes(FRESH_ARRIVAL_MINUTES)
                })
        })
        .map(|message| MailArrival {
            thread_id: message.thread_id.clone(),
            sender: message.sender.clone(),
            subject: message.subject.clone(),
            snippet: message.snippet.clone(),
        })
        .collect())
}

struct NewMailNotice<'a> {
    account_id: &'a str,
    thread_ids: Vec<String>,
    arrivals: Vec<MailArrival>,
    added_count: u32,
}

fn emit_new_mail_if_present(events: &EventSink, notice: NewMailNotice<'_>) {
    if notice.added_count > 0 {
        emit_new_mail(
            events,
            NewMailEvent {
                account_id: notice.account_id.to_owned(),
                thread_ids: notice.thread_ids,
                arrivals: notice.arrivals,
            },
        );
    }
}

async fn probe_only_body(
    context: SyncContext<'_>,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<MaterializedBatch, SyncError> {
    let messages = probe_inbox(&context, &[]).await?;
    let added_count = messages.len() as u32;
    if messages.is_empty() {
        return Ok(MaterializedBatch {
            thread_ids: Vec::new(),
            arrivals: Vec::new(),
            added_count: 0,
        });
    }
    let thread_ids: HashSet<String> = messages
        .iter()
        .map(|message| message.thread_id.clone())
        .collect();
    let account_owned = context.account_id.to_owned();
    let cache = context.cache;
    let arrivals = context
        .storage
        .run(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            let arrivals = compute_arrivals(
                &transaction,
                ArrivalWindow {
                    account_id: &account_owned,
                    now: now,
                },
                &messages,
            )?;
            write_messages_and_recompute(
                &transaction,
                WriteTarget {
                    account_id: &account_owned,
                    cache: cache.as_ref(),
                },
                &messages,
            )?;
            transaction.commit()?;
            Ok(arrivals)
        })
        .await?;
    Ok(MaterializedBatch {
        thread_ids: thread_ids.into_iter().collect(),
        arrivals: arrivals,
        added_count: added_count,
    })
}

enum IncrementalOutcome {
    Updated {
        history_id: i64,
        added_count: u32,
        thread_ids: Vec<String>,
        changed: bool,
        arrivals: Vec<MailArrival>,
    },
    Expired,
}

async fn incremental_body(
    context: SyncContext<'_>,
    start_history_id: i64,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<IncrementalOutcome, SyncError> {
    let gmail_labels = context.client.labels().await?;
    let mut token = None;
    let mut records = Vec::new();
    loop {
        let page = match context
            .client
            .history_page(start_history_id, token.as_deref())
            .await
        {
            Ok(page) => page,
            Err(GmailError::HistoryExpired) => return Ok(IncrementalOutcome::Expired),
            Err(error) => return Err(error.into()),
        };
        records.extend(page.records);
        if page.next_page_token.is_none() {
            break;
        }
        token = page.next_page_token;
    }

    let final_history_id = records
        .iter()
        .map(|record| record.id)
        .max()
        .unwrap_or(start_history_id);

    let mut added_messages = concurrency::fetch_messages(
        context.client,
        records
            .iter()
            .flat_map(|record| {
                record
                    .messages_added
                    .iter()
                    .map(|reference| reference.id.clone())
            })
            .collect(),
    )
    .await?;
    tracing::info!(
        target: "sync",
        "{}: history {start_history_id} -> {final_history_id}: {} record(s), {} added, {} label change(s), {} deleted",
        context.account_id,
        records.len(),
        added_messages.len(),
        records.iter().map(|record| record.labels_added.len() + record.labels_removed.len()).sum::<usize>(),
        records.iter().map(|record| record.messages_deleted.len()).sum::<usize>(),
    );

    let untyped = fetch_unknown(
        &context,
        UnknownFetch {
            candidates: records
                .iter()
                .flat_map(|record| record.messages.iter().map(|item| item.id.clone()))
                .collect(),
            already: &added_messages,
            source: "history record",
        },
    )
    .await?;
    added_messages.extend(untyped);

    match probe_inbox(&context, &added_messages).await {
        Ok(probed) => added_messages.extend(probed),
        Err(error) => {
            tracing::warn!(target: "sync", "{}: inbox probe failed, relying on history alone: {error}", context.account_id);
        }
    }
    let added_count = added_messages.len() as u32;
    let history_changed = !records.is_empty() || added_count > 0;

    let added_thread_ids: HashSet<String> = added_messages
        .iter()
        .map(|message| message.thread_id.clone())
        .collect();

    let account_owned = context.account_id.to_owned();
    let cache = context.cache;
    let (labels_changed, arrivals) = context
        .storage
        .run(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            let arrivals = compute_arrivals(
                &transaction,
                ArrivalWindow {
                    account_id: &account_owned,
                    now: now,
                },
                &added_messages,
            )?;
            let mut touched = HashSet::new();
            let target = WriteTarget {
                account_id: &account_owned,
                cache: cache.as_ref(),
            };
            for message in &added_messages {
                touched.insert(message.thread_id.clone());
                write_message(&transaction, target, message)?;
            }
            for record in &records {
                for change in &record.labels_added {
                    for label_id in &change.label_ids {
                        LabelRepository::ensure_placeholder(
                            &transaction,
                            &account_owned,
                            label_id,
                        )?;
                        MessageRepository::set_label_membership(
                            &transaction,
                            MessageKey {
                                account_id: &account_owned,
                                message_id: &change.message.id,
                            },
                            LabelMembershipChange {
                                label_id: label_id,
                                present: true,
                            },
                        )?;
                    }
                    touched.insert(change.message.thread_id.clone());
                }
                for change in &record.labels_removed {
                    for label_id in &change.label_ids {
                        MessageRepository::set_label_membership(
                            &transaction,
                            MessageKey {
                                account_id: &account_owned,
                                message_id: &change.message.id,
                            },
                            LabelMembershipChange {
                                label_id: label_id,
                                present: false,
                            },
                        )?;
                    }
                    touched.insert(change.message.thread_id.clone());
                }
                for deleted in &record.messages_deleted {
                    match MessageRepository::delete(&transaction, &account_owned, &deleted.id)? {
                        Some(thread_id) => {
                            touched.insert(thread_id);
                        }
                        None => {
                            touched.insert(deleted.thread_id.clone());
                        }
                    }
                }
            }
            let labels_changed = sync_labels(
                &transaction,
                LabelSyncTarget {
                    account_id: &account_owned,
                    gmail_labels: &gmail_labels,
                },
                &mut touched,
            )?;
            ThreadRepository::recompute_many(&transaction, &account_owned, &touched)?;
            transaction.commit()?;
            Ok((labels_changed, arrivals))
        })
        .await?;
    let changed = history_changed || labels_changed;

    Ok(IncrementalOutcome::Updated {
        history_id: final_history_id,
        added_count: added_count,
        thread_ids: added_thread_ids.into_iter().collect(),
        changed: changed,
        arrivals: arrivals,
    })
}

const USER_LABEL_ID_PREFIX: &str = "Label_";

pub(crate) struct LabelSyncTarget<'a> {
    pub account_id: &'a str,
    pub gmail_labels: &'a [GmailLabel],
}

pub(crate) fn sync_labels(
    connection: &rusqlite::Connection,
    target: LabelSyncTarget<'_>,
    touched_threads: &mut HashSet<String>,
) -> rusqlite::Result<bool> {
    let desired: Vec<Label> = target
        .gmail_labels
        .iter()
        .map(|label| to_label(target.account_id, label))
        .collect();
    let remote_ids: HashSet<&str> = desired.iter().map(|label| label.id.as_str()).collect();
    let existing = LabelRepository::list(connection, target.account_id)?;
    let stale: Vec<&str> = existing
        .iter()
        .filter(|label| {
            (label.kind == "user" || label.id.starts_with(USER_LABEL_ID_PREFIX))
                && !remote_ids.contains(label.id.as_str())
        })
        .map(|label| label.id.as_str())
        .collect();
    let existing_by_id: HashMap<&str, &Label> = existing
        .iter()
        .map(|label| (label.id.as_str(), label))
        .collect();
    let changed = !stale.is_empty()
        || desired
            .iter()
            .any(|label| existing_by_id.get(label.id.as_str()) != Some(&label));
    tracing::info!(
        target: "sync",
        "{}: labels — {} remote, {} local, pruning {:?}",
        target.account_id,
        desired.len(),
        existing.len(),
        stale,
    );
    for label_id in &stale {
        touched_threads.extend(LabelRepository::threads_with_label(
            connection,
            target.account_id,
            label_id,
        )?);
        LabelRepository::delete(connection, target.account_id, label_id)?;
    }
    for label in &desired {
        LabelRepository::upsert(connection, label)?;
    }
    Ok(changed)
}

pub(crate) fn to_label(account_id: &str, label: &GmailLabel) -> Label {
    let color = (label.kind == "user")
        .then_some(label.color.as_ref())
        .flatten()
        .map(|pair| LabelColor {
            text: pair.text_color.clone(),
            background: pair.background_color.clone(),
        });
    Label {
        account_id: account_id.to_owned(),
        id: label.id.clone(),
        name: label.name.clone(),
        kind: label.kind.clone(),
        color: color,
        message_count: label.message_count,
    }
}

#[derive(Clone, Copy)]
struct WriteTarget<'a> {
    account_id: &'a str,
    cache: Option<&'a crate::attachments::AttachmentCache>,
}

fn write_messages_and_recompute(
    connection: &rusqlite::Connection,
    target: WriteTarget<'_>,
    messages: &[GmailMessage],
) -> rusqlite::Result<HashSet<String>> {
    let mut touched = HashSet::new();
    for message in messages {
        touched.insert(message.thread_id.clone());
        write_message(connection, target, message)?;
    }
    ThreadRepository::recompute_many(connection, target.account_id, &touched)?;
    Ok(touched)
}

fn write_message(
    connection: &rusqlite::Connection,
    target: WriteTarget<'_>,
    message: &GmailMessage,
) -> rusqlite::Result<()> {
    materialize::persist(connection, target.account_id, message)?;
    if let Some(cache) = target.cache {
        crate::attachments::seed_cache(
            cache,
            MessageTarget {
                account_id: target.account_id,
                message_id: &message.id,
            },
            &message.attachment_parts,
        );
    }
    Ok(())
}

pub struct SyncScheduler {
    interval_sender: watch::Sender<Duration>,
}

impl SyncScheduler {
    pub fn start<F, Fut>(initial_interval: Duration, run_immediately: bool, tick: F) -> Arc<Self>
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let (sender, mut receiver) = watch::channel(initial_interval);
        tokio::spawn(async move {
            let mut first = true;
            loop {
                let wait = *receiver.borrow();
                if !(first && run_immediately) {
                    tokio::select! {
                        _ = tokio::time::sleep(wait) => {}
                        _ = receiver.changed() => {
                            first = false;
                            continue;
                        }
                    }
                }
                first = false;
                tick().await;
            }
        });
        Arc::new(Self {
            interval_sender: sender,
        })
    }

    pub fn set_interval(&self, interval: Duration) {
        let _ = self.interval_sender.send(interval);
    }

    pub fn interval(&self) -> Duration {
        *self.interval_sender.borrow()
    }
}

pub const FAST_PROBE_INTERVAL_SECS: u64 = 30;

#[derive(Clone)]
pub struct SyncSchedulers {
    pub fast: Arc<SyncScheduler>,
    pub periodic: Arc<SyncScheduler>,
}

struct CadenceServices<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    auth: &'a AuthService,
    engine: &'a Arc<SyncEngine>,
}

async fn for_each_cadence_account<R, Action, Output>(
    services: CadenceServices<'_, R>,
    mut action: Action,
) where
    R: Runtime,
    Action: FnMut(String, GmailClient) -> Output,
    Output: std::future::Future<Output = ()>,
{
    if services.engine.queue.suspended() {
        return;
    }
    let Ok(accounts) = services.auth.accounts().await else {
        return;
    };
    for account in accounts {
        if services.engine.queue.suspended() || account.needs_reauthentication {
            continue;
        }
        let Ok(client) = commands::gmail_client_for(
            commands::GmailClientDeps {
                app: services.app,
                auth: services.auth,
                engine: services.engine,
            },
            &account.id,
        )
        .await
        else {
            continue;
        };
        if services.engine.queue.suspended() {
            continue;
        }
        action(account.id, client).await;
    }
}

pub async fn run_fast_cadence<R: Runtime>(
    app: &AppHandle<R>,
    auth: &AuthService,
    engine: &Arc<SyncEngine>,
) {
    for_each_cadence_account(
        CadenceServices {
            app: app,
            auth: auth,
            engine: engine,
        },
        |account_id, client| async move {
            let _ = engine.probe_only(&account_id, client).await;
        },
    )
    .await;
}

pub async fn run_periodic_cadence<R: Runtime>(
    app: &AppHandle<R>,
    auth: &AuthService,
    engine: &Arc<SyncEngine>,
) {
    for_each_cadence_account(
        CadenceServices {
            app: app,
            auth: auth,
            engine: engine,
        },
        |account_id, client| async move {
            if engine.run_sync(&account_id, client.clone()).await.is_ok() {
                engine.enqueue_backfill(&account_id, client).await;
                return;
            }
            auth.invalidate_access_token(&account_id);
        },
    )
    .await;
}

pub fn emitting_event_sink<R: Runtime>(handle: AppHandle<R>) -> EventSink {
    Arc::new(move |event, payload| {
        if event != crate::events::QUEUE_SUMMARY {
            let payload_bytes = payload.to_string().len();
            tracing::info!(target: "events", "emit {event} ({payload_bytes} bytes)");
        }
        if let Err(error) = handle.emit(event, payload) {
            tracing::error!(target: "events", "emit {event} failed: {error}");
        }
    })
}

pub struct SyncInitializer<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    storage: Storage,
    directory: PathBuf,
    registry: Arc<WorkRegistry>,
    events: EventSink,
    staging: Option<Arc<crate::compose::staging::Staging>>,
    attachment_cache: Option<crate::attachments::AttachmentCache>,
    coalescer: Option<Arc<crate::compose::drafts::SaveCoalescer>>,
    queue: Option<Arc<QueueEngine>>,
    engine: Option<Arc<SyncEngine>>,
}

impl<'a, R: Runtime> SyncInitializer<'a, R> {
    fn new(app: &'a AppHandle<R>, storage: Storage) -> Result<Self, String> {
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        Ok(Self {
            app: app,
            storage: storage,
            directory: directory,
            registry: WorkRegistry::new(),
            events: emitting_event_sink(app.clone()),
            staging: None,
            attachment_cache: None,
            coalescer: None,
            queue: None,
            engine: None,
        })
    }

    fn init_staging(mut self) -> Self {
        let staging = Arc::new(crate::compose::staging::Staging::new(
            self.directory.join("compose-staging"),
        ));
        self.app.manage(Arc::clone(&staging));
        self.staging = Some(staging);
        self
    }

    fn init_attachment_cache(mut self) -> Result<Self, String> {
        let cache =
            crate::attachments::AttachmentCache::new(self.directory.join("attachment-cache"))
                .map_err(|error| error.to_string())?;
        self.app.manage(cache.clone());
        let sweep_cache = cache.clone();
        tauri::async_runtime::spawn(async move {
            let _ = tokio::task::spawn_blocking(move || {
                sweep_cache.sweep(crate::attachments::CACHE_CEILING_BYTES)
            })
            .await;
        });
        self.attachment_cache = Some(cache);
        Ok(self)
    }

    fn init_coalescer(mut self) -> Self {
        let coalescer = Arc::new(crate::compose::drafts::SaveCoalescer::new());
        self.app.manage(Arc::clone(&coalescer));
        self.coalescer = Some(coalescer);
        self
    }

    fn init_queue(mut self) -> Self {
        let registry_exec = registry_executor(Arc::clone(&self.registry));
        let compose_exec = crate::compose::drafts::build_executor(DraftExecutorContext {
            app: self.app.clone(),
            storage: self.storage.clone(),
            staging: Arc::clone(self.staging.as_ref().expect("staging initialized")),
            coalescer: Arc::clone(self.coalescer.as_ref().expect("coalescer initialized")),
            base_url: gmail_base_url(),
        });
        let executor: Executor = Arc::new(move |operation: QueueOperation| -> OperationFuture {
            let is_compose = matches!(operation.kind, OperationKind::Draft | OperationKind::Send);
            if is_compose {
                return compose_exec(operation);
            }
            registry_exec(operation)
        });
        let queue = QueueEngine::with_config(
            QueueConfig {
                rate_per_second: crate::queue::DEFAULT_RATE_PER_SECOND,
                burst: crate::queue::DEFAULT_BURST,
                events: Arc::clone(&self.events),
                cancellation_hook: build_cancellation_hook(self.app, Arc::clone(&self.registry)),
            },
            executor,
        );
        self.app.manage(Arc::clone(&queue));
        self.queue = Some(queue);
        self
    }

    fn init_engine(mut self) -> Self {
        let engine = SyncEngine::new(SyncEngineDeps {
            storage: self.storage.clone(),
            queue: Arc::clone(self.queue.as_ref().expect("queue initialized")),
            registry: Arc::clone(&self.registry),
            events: Arc::clone(&self.events),
        });
        engine.set_attachment_cache(
            self.attachment_cache
                .clone()
                .expect("attachment cache initialized"),
        );
        self.app.manage(Arc::clone(&engine));
        self.engine = Some(engine);
        self
    }

    fn wire_ai_indexing(self) -> Self {
        let Some(ai) = self.app.try_state::<crate::ai::AiService>() else {
            return self;
        };
        let engine = Arc::clone(self.engine.as_ref().expect("engine initialized"));
        let ai = ai.inner().clone();
        let catch_up_app = self.app.clone();
        let catch_up_ai = ai.clone();
        let catch_up_engine = Arc::clone(&engine);
        engine.set_ai_catch_up(Arc::new(move |account_id| {
            let context = crate::ai::index::IndexContext {
                app: catch_up_app.clone(),
                service: catch_up_ai.clone(),
                sync: Arc::clone(&catch_up_engine),
            };
            tauri::async_runtime::spawn(async move {
                if context
                    .service
                    .index_ready(&account_id)
                    .await
                    .unwrap_or(false)
                {
                    let _ = crate::ai::index::enqueue(context, account_id).await;
                }
            });
        }));
        let startup_app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            let Ok(configs) = ai.configs().await else {
                return;
            };
            for config in configs {
                if !ai.index_ready(&config.account_id).await.unwrap_or(false) {
                    continue;
                }
                let _ = crate::ai::index::enqueue(
                    crate::ai::index::IndexContext {
                        app: startup_app.clone(),
                        service: ai.clone(),
                        sync: Arc::clone(&engine),
                    },
                    config.account_id,
                )
                .await;
            }
        });
        self
    }

    fn start_schedulers(self) -> Self {
        start_scheduler(
            self.app.clone(),
            Arc::clone(self.engine.as_ref().expect("engine initialized")),
        );
        self
    }

    fn spawn_recovery(self) {
        let Ok(connection) = self.storage.connection() else {
            return;
        };
        let Ok(recovered) = crate::queue::recover_durable_operations(&connection) else {
            return;
        };
        drop(connection);
        let app = self.app.clone();
        let queue = self.queue.expect("queue initialized");
        let engine = self.engine.expect("engine initialized");
        let events = self.events;
        tauri::async_runtime::spawn(async move {
            for operation in &recovered.pending {
                if let Some(queue_operation) = crate::queue::recovered_queue_operation(operation) {
                    let _ = queue.enqueue(queue_operation).await;
                }
            }
            if recovered.uncertain_accounts.is_empty() {
                return;
            }
            let auth = app.state::<AuthService>().inner().clone();
            for account_id in recovered.uncertain_accounts {
                (events)(
                    crate::events::SEND_UNCERTAIN,
                    serde_json::to_value(crate::queue::uncertain_send_event(account_id.clone()))
                        .expect("UncertainSendEvent serializes"),
                );
                if let Ok(client) = commands::gmail_client_for(
                    commands::GmailClientDeps {
                        app: &app,
                        auth: &auth,
                        engine: &engine,
                    },
                    &account_id,
                )
                .await
                {
                    let _ = engine.run_sync(&account_id, client).await;
                }
            }
        });
    }
}

fn build_cancellation_hook<R: Runtime>(
    app: &AppHandle<R>,
    hook_registry: Arc<WorkRegistry>,
) -> crate::queue::CancellationHook {
    let cancelled_ai = app
        .try_state::<crate::ai::AiService>()
        .map(|state| state.inner().clone());
    let cancellation_app = app.clone();
    Arc::new(move |operation| {
        hook_registry.take(&operation.id);
        if operation.kind != OperationKind::Embed {
            return;
        }
        let Some(ai) = &cancelled_ai else {
            return;
        };
        if ai.is_removing(&operation.account_id).unwrap_or(true)
            || ai.is_reconfiguring(&operation.account_id).unwrap_or(true)
        {
            return;
        }
        let _ = ai.set_index_state(&operation.account_id, crate::ai::IndexState::Interrupted);
        let app = cancellation_app.clone();
        let ai = ai.clone();
        let account_id = operation.account_id.clone();
        tauri::async_runtime::spawn(async move {
            let _ = crate::ai::index::emit_status(&app, &ai, account_id).await;
        });
    })
}

pub fn initialize<R: Runtime>(app: &AppHandle<R>, storage: Storage) -> Result<(), String> {
    SyncInitializer::new(app, storage)?
        .init_staging()
        .init_attachment_cache()?
        .init_coalescer()
        .init_queue()
        .init_engine()
        .wire_ai_indexing()
        .start_schedulers()
        .spawn_recovery();
    Ok(())
}

fn start_scheduler<R: Runtime>(app: AppHandle<R>, engine: Arc<SyncEngine>) {
    let auth = app.state::<AuthService>().inner().clone();
    let settings = app.state::<SettingsService>().inner().clone();
    tauri::async_runtime::spawn(async move {
        let preferences = settings.read().await.unwrap_or_default();

        let periodic_interval = Duration::from_secs(
            u64::from(preferences.sync_interval_seconds)
                .max(crate::settings::MIN_SYNC_INTERVAL_SECS),
        );
        let app_for_manage = app.clone();

        let fast_app = app.clone();
        let fast_auth = auth.clone();
        let fast_engine = Arc::clone(&engine);
        let fast = SyncScheduler::start(
            Duration::from_secs(FAST_PROBE_INTERVAL_SECS),
            true,
            move || {
                let app = fast_app.clone();
                let auth = fast_auth.clone();
                let engine = Arc::clone(&fast_engine);
                async move {
                    run_fast_cadence(&app, &auth, &engine).await;
                }
            },
        );

        let periodic_auth = auth.clone();
        let periodic_engine = Arc::clone(&engine);
        let periodic =
            SyncScheduler::start(periodic_interval, preferences.sync_on_startup, move || {
                let app = app.clone();
                let auth = periodic_auth.clone();
                let engine = Arc::clone(&periodic_engine);
                async move {
                    run_periodic_cadence(&app, &auth, &engine).await;
                }
            });
        app_for_manage.manage(SyncSchedulers { fast, periodic });
    });
}
