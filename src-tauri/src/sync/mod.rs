use std::{
    collections::HashSet,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::{oneshot, watch, Mutex as AsyncMutex};

use crate::{
    auth::AuthService,
    gmail::{GmailClient, GmailError, GmailLabel, GmailMessage, GmailRateLimiters},
    queue::{
        Executor, Lane, OperationFuture, OperationKind, QueueEngine, QueueError, QueueEventSink,
        QueueOperation,
    },
    settings::SettingsService,
    storage::{
        AccountRepository, Label, LabelColor, LabelRepository, MessageRepository, Storage,
        StorageError, ThreadRepository,
    },
};

pub mod commands;
mod dto;
pub mod materialize;
mod mutations;
mod reconcile;
pub mod traversal;
pub mod triage;

pub use dto::{
    ContactSuggestionDto, ConversationDto, LabelColorDto, LabelDto, MessageDto, MutationOutcomeDto,
    MutationResultDto, ParsedSearchQueryDto, SearchPredicateDto, StagedAttachmentDto, SyncStatusDto,
    ThreadCursor, ThreadDto, ThreadPage, ThreadSearchPage, TraversalKind, TraversalState,
    TraversalStatusDto,
};
pub use mutations::{MutationOutcome, BATCH_MODIFY_CHUNK_SIZE};

type BoxFuture = Pin<Box<dyn Future<Output = Result<(), QueueError>> + Send>>;
type OneShotWork = Box<dyn FnOnce() -> BoxFuture + Send>;

struct QueueRoute {
    lane: Lane,
    kind: OperationKind,
    entity_key: String,
    description: String,
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

pub fn create_queue_engine(
    rate_per_second: u32,
    burst: u32,
    registry: Arc<WorkRegistry>,
) -> Arc<QueueEngine> {
    create_queue_engine_with_events(rate_per_second, burst, registry, Arc::new(|_, _| {}))
}

pub fn create_queue_engine_with_events(
    rate_per_second: u32,
    burst: u32,
    registry: Arc<WorkRegistry>,
    events: QueueEventSink,
) -> Arc<QueueEngine> {
    let hook_registry = Arc::clone(&registry);
    let cancellation_hook: crate::queue::CancellationHook =
        Arc::new(move |id: &str| {
            hook_registry.take(id);
        });
    QueueEngine::new_with_events_and_hook(
        rate_per_second,
        burst,
        registry_executor(registry),
        events,
        cancellation_hook,
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
        .unwrap_or_else(|_| "https://gmail.googleapis.com/gmail/v1".into())
}

async fn run_via_queue<F, T>(
    queue: &Arc<QueueEngine>,
    registry: &Arc<WorkRegistry>,
    account_id: &str,
    op_id: String,
    future: F,
) -> Result<T, SyncError>
where
    F: Future<Output = Result<T, SyncError>> + Send + 'static,
    T: Send + 'static,
{
    run_via_queue_on(
        queue,
        registry,
        account_id,
        op_id,
        QueueRoute {
            lane: Lane::Background,
            kind: OperationKind::Sync,
            entity_key: format!("sync:{account_id}"),
            description: "Sync mailbox".to_owned(),
        },
        future,
    )
    .await
}


async fn run_via_traversal_queue<F, T>(
    queue: &Arc<QueueEngine>,
    registry: &Arc<WorkRegistry>,
    account_id: &str,
    op_id: String,
    future: F,
) -> Result<T, SyncError>
where
    F: Future<Output = Result<T, SyncError>> + Send + 'static,
    T: Send + 'static,
{
    run_via_queue_on(
        queue,
        registry,
        account_id,
        op_id,
        QueueRoute {
            lane: Lane::Traversal,
            kind: OperationKind::Traversal,
            entity_key: traversal::traversal_entity_key(account_id),
            description: "Traverse mailbox history".to_owned(),
        },
        future,
    )
    .await
}

async fn run_via_queue_on<F, T>(
    queue: &Arc<QueueEngine>,
    registry: &Arc<WorkRegistry>,
    account_id: &str,
    op_id: String,
    route: QueueRoute,
    future: F,
) -> Result<T, SyncError>
where
    F: Future<Output = Result<T, SyncError>> + Send + 'static,
    T: Send + 'static,
{
    let (tx, rx) = oneshot::channel::<Result<T, SyncError>>();
    registry.register(
        op_id.clone(),
        Box::new(move || {
            Box::pin(async move {
                let result = future.await;
                let queue_outcome = if result.is_ok() {
                    Ok(())
                } else {
                    Err(QueueError::Permanent)
                };
                let _ = tx.send(result);
                queue_outcome
            })
        }),
    );
    let operation = QueueOperation {
        id: op_id,
        account_id: account_id.to_owned(),
        lane: route.lane,
        kind: route.kind,
        entity_key: route.entity_key,

        cost: 0,
        attempts: 0,
        description: route.description,
    };
    queue
        .enqueue(operation)
        .await
        .map_err(|_| SyncError::QueueStopped)?;
    rx.await.map_err(|_| SyncError::QueueStopped)?
}


fn derive_operation_kind(add: &HashSet<String>, remove: &HashSet<String>) -> OperationKind {
    if add.contains("STARRED") {
        OperationKind::Star
    } else if remove.contains("STARRED") {
        OperationKind::Unstar
    } else if remove.contains("UNREAD") {
        OperationKind::MarkRead
    } else if add.contains("UNREAD") {
        OperationKind::MarkUnread
    } else if add.contains("TRASH") {
        OperationKind::Delete
    } else if add.contains("SPAM") {
        OperationKind::Spam
    } else if remove.contains("SPAM") {
        OperationKind::NotSpam
    } else if !add.is_empty() && !remove.is_empty() {
        OperationKind::Move
    } else {
        OperationKind::LabelMutation
    }
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
        "sync://progress",
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
}

pub fn emit_complete(sink: &EventSink, event: SyncCompleteEvent) {
    sink(
        "sync://complete",
        serde_json::to_value(event).expect("SyncCompleteEvent always serializes"),
    );
}


#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailArrival {
    pub sender: String,
    pub subject: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMailEvent {
    pub account_id: String,
    pub thread_ids: Vec<String>,
    pub arrivals: Vec<MailArrival>,
}

pub fn emit_new_mail(sink: &EventSink, event: NewMailEvent) {
    sink(
        "mail://new",
        serde_json::to_value(event).expect("NewMailEvent always serializes"),
    );
}


pub struct SyncEngine {
    storage: Storage,
    queue: Arc<QueueEngine>,
    registry: Arc<WorkRegistry>,
    events: EventSink,
    status: AsyncMutex<std::collections::HashMap<String, AccountStatus>>,
    op_counter: Arc<AtomicU64>,
    pending: AsyncMutex<mutations::PendingMutations>,
    gmail_limiters: GmailRateLimiters,
    active_backfills: Arc<AsyncMutex<std::collections::HashSet<String>>>,
}

impl SyncEngine {
    pub fn new(
        storage: Storage,
        queue: Arc<QueueEngine>,
        registry: Arc<WorkRegistry>,
        events: EventSink,
    ) -> Arc<Self> {
        Arc::new(Self {
            storage,
            queue,
            registry,
            events,
            status: AsyncMutex::new(std::collections::HashMap::new()),
            op_counter: Arc::new(AtomicU64::new(0)),
            pending: AsyncMutex::new(std::collections::HashMap::new()),
            gmail_limiters: GmailRateLimiters::default(),
            active_backfills: Arc::new(AsyncMutex::new(std::collections::HashSet::new())),
        })
    }

    pub async fn gmail_client(
        &self,
        account_id: &str,
        token: String,
        base_url: String,
    ) -> GmailClient {
        GmailClient::for_account(account_id, token, base_url, &self.gmail_limiters).await
    }

    fn next_op_id(&self, account_id: &str) -> String {
        let n = self.op_counter.fetch_add(1, Ordering::Relaxed);
        format!("sync:{account_id}:{n}")
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

    async fn set_idle(
        &self,
        account_id: &str,
        history_id: i64,
        added_count: u32,
        now: i64,
        changed: bool,
    ) {
        {
            let mut status = self.status.lock().await;
            let entry = status.entry(account_id.to_owned()).or_default();
            entry.state = Some(SyncState::Idle);
            entry.last_synced_at = Some(now);
            entry.last_error = None;
        }
        emit_complete(
            &self.events,
            SyncCompleteEvent {
                account_id: account_id.to_owned(),
                history_id,
                added_count,
                changed,
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
                self.incremental_sync(account_id, client, checkpoint).await
            }
        }
    }

    pub async fn initial_sync(
        &self,
        account_id: &str,
        client: GmailClient,
    ) -> Result<(), SyncError> {
        self.set_syncing(account_id).await;
        let op_id = self.next_op_id(account_id);
        let storage = self.storage.clone();
        let account_owned = account_id.to_owned();
        let backfill_client = client.clone();
        let outcome = run_via_queue(&self.queue, &self.registry, account_id, op_id, async move {
            full_sync_body(&storage, &client, &account_owned).await
        })
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
        let resumed = self
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
            .flatten()
            .is_some_and(|cursor| cursor.position.is_some());
        enqueue_backfill_step(
            BackfillHandles {
                queue: Arc::clone(&self.queue),
                registry: Arc::clone(&self.registry),
                storage: self.storage.clone(),
                events: Arc::clone(&self.events),
                op_counter: Arc::clone(&self.op_counter),
                active_backfills: Arc::clone(&self.active_backfills),
            },
            account_id.to_owned(),
            client,
            resumed,
        )
        .await;
    }

    async fn incremental_sync(
        &self,
        account_id: &str,
        client: GmailClient,
        checkpoint: i64,
    ) -> Result<(), SyncError> {
        self.set_syncing(account_id).await;
        let op_id = self.next_op_id(account_id);
        let storage = self.storage.clone();
        let traversal_queue = Arc::clone(&self.queue);
        let traversal_registry = Arc::clone(&self.registry);
        let reconciliation_events = Arc::clone(&self.events);
        let account_owned = account_id.to_owned();
        let outcome = run_via_queue(&self.queue, &self.registry, account_id, op_id, async move {
            match incremental_body(&storage, &client, &account_owned, checkpoint).await? {
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
                    run_via_traversal_queue(
                        &traversal_queue,
                        &traversal_registry,
                        &account_owned,
                        format!("reconcile:{account_owned}:{checkpoint}"),
                        {
                            let reconciliation_queue = Arc::clone(&traversal_queue);
                            async move {
                                reconcile::run(
                                    &reconciliation_storage,
                                    &reconciliation_client,
                                    &reconciliation_account,
                                    &reconciliation_events,
                                    Some(&reconciliation_queue),
                                )
                                .await
                            }
                        },
                    )
                    .await
                }
            }
        })
        .await;
        self.finish(account_id, outcome).await
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


    async fn complete(
        &self,
        account_id: &str,
        outcome: FullSyncOutcome,
    ) -> Result<(), SyncError> {
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
        self.set_idle(account_id, history_id, added_count, now, changed)
            .await;
        emit_new_mail_if_present(&self.events, account_id, thread_ids, arrivals, added_count);
        Ok(())
    }

    pub fn storage(&self) -> &Storage {
        &self.storage
    }

    pub async fn probe_only(&self, account_id: &str, client: GmailClient) -> Result<(), SyncError> {
        let op_id = self.next_op_id(account_id);
        let storage = self.storage.clone();
        let account_owned = account_id.to_owned();
        let outcome = run_via_queue(&self.queue, &self.registry, account_id, op_id, async move {
            probe_only_body(&storage, &client, &account_owned).await
        })
        .await;
        match outcome {
            Ok(batch) => {
                emit_new_mail_if_present(
                    &self.events,
                    account_id,
                    batch.thread_ids,
                    batch.arrivals,
                    batch.added_count,
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


fn enqueue_backfill_step(
    handles: BackfillHandles,
    account_id: String,
    client: GmailClient,
    resumed: bool,
) -> Pin<Box<dyn Future<Output = ()> + Send>> {
    Box::pin(async move {
        let BackfillHandles {
            queue,
            registry,
            storage,
            events,
            op_counter,
            active_backfills,
        } = handles;
        let op_id = format!(
            "traversal:{account_id}:{}",
            op_counter.fetch_add(1, Ordering::Relaxed)
        );
        let step_storage = storage.clone();
        let step_events = Arc::clone(&events);
        let step_account = account_id.clone();
        let step_client = client.clone();
        let (step_queue, step_registry, step_op_counter, step_active_backfills) = (
            Arc::clone(&queue),
            Arc::clone(&registry),
            Arc::clone(&op_counter),
            Arc::clone(&active_backfills),
        );
        registry.register(
            op_id.clone(),
            Box::new(move || {
                Box::pin(async move {
                    let traversal_client = step_client.traversal_scoped();
                    let step_result = traversal::run_backfill_step(
                        &step_storage,
                        &traversal_client,
                        &step_account,
                        &step_events,
                        resumed,
                    )
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
                    } else {

                        enqueue_backfill_step(
                            BackfillHandles {
                                queue: step_queue,
                                registry: step_registry,
                                storage: step_storage,
                                events: step_events,
                                op_counter: step_op_counter,
                                active_backfills: step_active_backfills,
                            },
                            step_account,
                            step_client,
                            resumed,
                        )
                        .await;
                    }
                    Ok(())
                })
            }),
        );
        let enqueue_result = queue
            .enqueue(QueueOperation {
                id: op_id,
                account_id: account_id.clone(),
                lane: Lane::Traversal,
                kind: OperationKind::Traversal,
                entity_key: traversal::traversal_entity_key(&account_id),
                cost: 0,
                attempts: 0,
                description: "Backfill mailbox history".to_owned(),
            })
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
    op_counter: Arc<AtomicU64>,

    active_backfills: Arc<AsyncMutex<std::collections::HashSet<String>>>,
}


pub(crate) struct FullSyncOutcome {
    history_id: i64,
    added_count: u32,
    thread_ids: Vec<String>,
    changed: bool,

    arrivals: Vec<MailArrival>,
}

async fn full_sync_body(
    storage: &Storage,
    client: &GmailClient,
    account_id: &str,
) -> Result<FullSyncOutcome, SyncError> {
    let profile = client.profile().await?;
    let gmail_labels = client.labels().await?;
    let refs = client
        .list_all_messages_matching(
            &["INBOX".to_owned()],
            Some("newer_than:30d"),
            crate::gmail::ListOptions::default(),
        )
        .await?;
    let mut messages = Vec::with_capacity(refs.len());
    for message_ref in &refs {
        messages.extend(client.message_if_present(&message_ref.id).await?);
    }
    let added_count = messages.len() as u32;
    let thread_ids: HashSet<String> = messages
        .iter()
        .map(|message| message.thread_id.clone())
        .collect();

    tracing::info!(
        target: "sync",
        "{account_id}: full sync fetched {added_count} message(s) across {} thread(s), profile checkpoint {}",
        thread_ids.len(),
        profile.history_id,
    );
    let account_owned = account_id.to_owned();
    let thread_ids_for_write = thread_ids.clone();
    storage
        .run(move |connection| {
            let transaction = connection.unchecked_transaction()?;

            transaction.execute("DELETE FROM messages WHERE account_id=?1", [&account_owned])?;
            transaction.execute("DELETE FROM threads WHERE account_id=?1", [&account_owned])?;
            for label in &gmail_labels {
                LabelRepository::upsert(&transaction, &to_label(&account_owned, label))?;
            }
            for message in &messages {
                write_message(&transaction, &account_owned, message)?;
            }
            ThreadRepository::recompute_many(&transaction, &account_owned, &thread_ids_for_write)?;
            transaction.commit()
        })
        .await?;

    Ok(FullSyncOutcome {
        history_id: profile.history_id,
        added_count,
        thread_ids: thread_ids.into_iter().collect(),
        changed: true,
        arrivals: Vec::new(),
    })
}


const INBOX_PROBE_SIZE: u32 = 25;


async fn probe_inbox(
    storage: &Storage,
    client: &GmailClient,
    account_id: &str,
    already: &[GmailMessage],
) -> Result<Vec<GmailMessage>, SyncError> {
    let page = client
        .list_messages_page_matching(
            &["INBOX".to_owned()],
            None,
            None,
            crate::gmail::ListOptions {
                include_spam_and_trash: false,
                page_size: INBOX_PROBE_SIZE,
            },
        )
        .await?;
    let candidates = page
        .items
        .into_iter()
        .map(|reference| reference.id)
        .collect();
    fetch_unknown(
        storage,
        client,
        account_id,
        candidates,
        already,
        "inbox probe",
    )
    .await
}


async fn fetch_unknown(
    storage: &Storage,
    client: &GmailClient,
    account_id: &str,
    candidates: Vec<String>,
    already: &[GmailMessage],
    source: &str,
) -> Result<Vec<GmailMessage>, SyncError> {
    let seen: HashSet<&str> = already.iter().map(|message| message.id.as_str()).collect();
    let candidates: Vec<String> = candidates
        .into_iter()
        .filter(|id| !seen.contains(id.as_str()))
        .collect();
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let account_owned = account_id.to_owned();
    let unknown = storage
        .run(move |connection| {
            MessageRepository::missing_ids(connection, &account_owned, candidates)
        })
        .await?;
    if unknown.is_empty() {
        return Ok(Vec::new());
    }

    tracing::info!(
        target: "sync",
        "{account_id}: {source} found {} message(s) no delta reported: {}",
        unknown.len(),
        unknown.join(", "),
    );
    let mut messages = Vec::with_capacity(unknown.len());
    for id in &unknown {
        messages.extend(client.message_if_present(id).await?);
    }
    Ok(messages)
}

pub(crate) struct MaterializedBatch {
    thread_ids: Vec<String>,
    arrivals: Vec<MailArrival>,
    added_count: u32,
}

fn compute_arrivals(messages: &[GmailMessage]) -> Vec<MailArrival> {
    messages
        .iter()
        .filter(|message| {
            let has = |label: &str| message.label_ids.iter().any(|id| id == label);
            has("INBOX") && has("UNREAD")
        })
        .map(|message| MailArrival {
            sender: message.sender.clone(),
            subject: message.subject.clone(),
        })
        .collect()
}

fn emit_new_mail_if_present(
    events: &EventSink,
    account_id: &str,
    thread_ids: Vec<String>,
    arrivals: Vec<MailArrival>,
    added_count: u32,
) {
    if added_count > 0 {
        emit_new_mail(
            events,
            NewMailEvent {
                account_id: account_id.to_owned(),
                thread_ids,
                arrivals,
            },
        );
    }
}

async fn probe_only_body(
    storage: &Storage,
    client: &GmailClient,
    account_id: &str,
) -> Result<MaterializedBatch, SyncError> {
    let messages = probe_inbox(storage, client, account_id, &[]).await?;
    let added_count = messages.len() as u32;
    if messages.is_empty() {
        return Ok(MaterializedBatch {
            thread_ids: Vec::new(),
            arrivals: Vec::new(),
            added_count: 0,
        });
    }
    let arrivals = compute_arrivals(&messages);
    let thread_ids: HashSet<String> = messages.iter().map(|message| message.thread_id.clone()).collect();
    let account_owned = account_id.to_owned();
    let thread_ids_for_write = thread_ids.clone();
    storage
        .run(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            for message in &messages {
                write_message(&transaction, &account_owned, message)?;
            }
            ThreadRepository::recompute_many(&transaction, &account_owned, &thread_ids_for_write)?;
            transaction.commit()
        })
        .await?;
    Ok(MaterializedBatch {
        thread_ids: thread_ids.into_iter().collect(),
        arrivals,
        added_count,
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
    storage: &Storage,
    client: &GmailClient,
    account_id: &str,
    start_history_id: i64,
) -> Result<IncrementalOutcome, SyncError> {
    let gmail_labels = client.labels().await?;
    let mut token = None;
    let mut records = Vec::new();
    loop {
        let page = match client
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

    let mut added_messages = Vec::new();
    for record in &records {
        for reference in &record.messages_added {

            added_messages.extend(client.message_if_present(&reference.id).await?);
        }
    }
    tracing::info!(
        target: "sync",
        "{account_id}: history {start_history_id} -> {final_history_id}: {} record(s), {} added, {} label change(s), {} deleted",
        records.len(),
        added_messages.len(),
        records.iter().map(|record| record.labels_added.len() + record.labels_removed.len()).sum::<usize>(),
        records.iter().map(|record| record.messages_deleted.len()).sum::<usize>(),
    );

    let untyped = fetch_unknown(
        storage,
        client,
        account_id,
        records
            .iter()
            .flat_map(|record| record.messages.iter().map(|item| item.id.clone()))
            .collect(),
        &added_messages,
        "history record",
    )
    .await?;
    added_messages.extend(untyped);


    match probe_inbox(storage, client, account_id, &added_messages).await {
        Ok(probed) => added_messages.extend(probed),
        Err(error) => {
            tracing::warn!(target: "sync", "{account_id}: inbox probe failed, relying on history alone: {error}");
        }
    }
    let added_count = added_messages.len() as u32;
    let changed = !records.is_empty() || !added_messages.is_empty();

    let arrivals = compute_arrivals(&added_messages);
    let added_thread_ids: HashSet<String> = added_messages
        .iter()
        .map(|message| message.thread_id.clone())
        .collect();

    let account_owned = account_id.to_owned();
    storage
        .run(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            for label in &gmail_labels {
                LabelRepository::upsert(&transaction, &to_label(&account_owned, label))?;
            }
            let mut touched = HashSet::new();
            for message in &added_messages {
                touched.insert(message.thread_id.clone());
                write_message(&transaction, &account_owned, message)?;
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
                            &account_owned,
                            &change.message.id,
                            label_id,
                            true,
                        )?;
                    }
                    touched.insert(change.message.thread_id.clone());
                }
                for change in &record.labels_removed {
                    for label_id in &change.label_ids {
                        MessageRepository::set_label_membership(
                            &transaction,
                            &account_owned,
                            &change.message.id,
                            label_id,
                            false,
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
            ThreadRepository::recompute_many(&transaction, &account_owned, &touched)?;
            transaction.commit()
        })
        .await?;

    Ok(IncrementalOutcome::Updated {
        history_id: final_history_id,
        added_count,
        thread_ids: added_thread_ids.into_iter().collect(),
        changed,
        arrivals,
    })
}


pub(crate) fn to_label(account_id: &str, label: &GmailLabel) -> Label {

    let color = if label.kind == "user" {
        label.color.as_ref().map(|pair| LabelColor {
            text: pair.text_color.clone(),
            background: pair.background_color.clone(),
        })
    } else {
        None
    };
    Label {
        account_id: account_id.to_owned(),
        id: label.id.clone(),
        name: label.name.clone(),
        kind: label.kind.clone(),
        color,
        message_count: label.message_count,
    }
}

fn write_message(
    connection: &rusqlite::Connection,
    account_id: &str,
    message: &GmailMessage,
) -> rusqlite::Result<()> {
    materialize::persist(connection, account_id, message)
}


pub struct SyncScheduler {
    interval_tx: watch::Sender<Duration>,
}

impl SyncScheduler {
    pub fn start<F, Fut>(initial_interval: Duration, run_immediately: bool, tick: F) -> Arc<Self>
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let (tx, mut rx) = watch::channel(initial_interval);
        tokio::spawn(async move {
            let mut first = true;
            loop {
                let wait = *rx.borrow();
                if !(first && run_immediately) {
                    tokio::select! {
                        _ = tokio::time::sleep(wait) => {}
                        _ = rx.changed() => {
                            first = false;
                            continue;
                        }
                    }
                }
                first = false;
                tick().await;
            }
        });
        Arc::new(Self { interval_tx: tx })
    }


    pub fn set_interval(&self, interval: Duration) {
        let _ = self.interval_tx.send(interval);
    }

    pub fn interval(&self) -> Duration {
        *self.interval_tx.borrow()
    }
}

pub const FAST_PROBE_INTERVAL_SECS: u64 = 30;

#[derive(Clone)]
pub struct SyncSchedulers {
    pub fast: Arc<SyncScheduler>,
    pub periodic: Arc<SyncScheduler>,
}


pub fn initialize<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let storage =
        Storage::open(directory.join("latentmail.sqlite")).map_err(|error| error.to_string())?;
    let registry = WorkRegistry::new();
    let handle_for_events = app.clone();

    let events: EventSink = Arc::new(move |event, payload| {
        if event != "queue://summary" {
            tracing::info!(target: "events", "emit {event} {payload}");
        }
        if let Err(error) = handle_for_events.emit(event, payload) {
            tracing::error!(target: "events", "emit {event} failed: {error}");
        }
    });

    let staging = Arc::new(crate::compose::staging::Staging::new(
        directory.join("compose-staging"),
    ));
    app.manage(Arc::clone(&staging));

    let coalescer = Arc::new(crate::compose::drafts::SaveCoalescer::new());
    app.manage(Arc::clone(&coalescer));

    let registry_exec = registry_executor(Arc::clone(&registry));
    let compose_exec = crate::compose::drafts::build_executor(
        app.clone(),
        storage.clone(),
        Arc::clone(&staging),
        Arc::clone(&coalescer),
        gmail_base_url(),
    );
    let executor: Executor = Arc::new(move |operation: QueueOperation| -> OperationFuture {
        if matches!(operation.kind, OperationKind::Draft | OperationKind::Send) {
            compose_exec(operation)
        } else {
            registry_exec(operation)
        }
    });
    let hook_registry = Arc::clone(&registry);
    let cancellation_hook: crate::queue::CancellationHook =
        Arc::new(move |id: &str| {
            hook_registry.take(id);
        });
    let queue = QueueEngine::new_with_events_and_hook(
        250,
        250,
        executor,
        Arc::clone(&events),
        cancellation_hook,
    );

    app.manage(storage.clone());
    let engine = SyncEngine::new(
        storage.clone(),
        Arc::clone(&queue),
        registry,
        Arc::clone(&events),
    );
    app.manage(Arc::clone(&queue));
    app.manage(Arc::clone(&engine));
    start_scheduler(app.clone(), Arc::clone(&engine));
    spawn_startup_recovery(app.clone(), storage, queue, engine, events);
    Ok(())
}


fn spawn_startup_recovery<R: Runtime>(
    app: AppHandle<R>,
    storage: Storage,
    queue: Arc<QueueEngine>,
    engine: Arc<SyncEngine>,
    events: EventSink,
) {
    tauri::async_runtime::spawn(async move {
        let Ok((recovered, uncertain_accounts)) =
            storage.run(crate::queue::recover_durable_operations).await
        else {
            return;
        };
        for operation in &recovered {
            if let Some(queue_operation) = crate::queue::recovered_queue_operation(operation) {
                let _ = queue.enqueue(queue_operation).await;
            }
        }
        if uncertain_accounts.is_empty() {
            return;
        }
        let auth = app.state::<AuthService>().inner().clone();
        for account_id in uncertain_accounts {
            (events)(
                "send://uncertain",
                serde_json::to_value(crate::queue::uncertain_send_event(account_id.clone()))
                    .expect("UncertainSendEvent serializes"),
            );
            if let Ok(token) = auth.refresh_access_token(&app, &account_id).await {
                let client = engine
                    .gmail_client(&account_id, token, gmail_base_url())
                    .await;
                let _ = engine.run_sync(&account_id, client).await;
            }
        }
    });
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
                    let Ok(accounts) = auth.accounts().await else {
                        return;
                    };
                    for account in accounts {
                        if account.needs_reauthentication {
                            continue;
                        }
                        let Ok(token) = auth.refresh_access_token(&app, &account.id).await else {
                            continue;
                        };
                        let client = engine.gmail_client(&account.id, token, gmail_base_url()).await;
                        let _ = engine.probe_only(&account.id, client).await;
                    }
                }
            },
        );

        let periodic_auth = auth.clone();
        let periodic_engine = Arc::clone(&engine);
        let periodic = SyncScheduler::start(
            periodic_interval,
            preferences.sync_on_startup,
            move || {
                let app = app.clone();
                let auth = periodic_auth.clone();
                let engine = Arc::clone(&periodic_engine);
                async move {
                    let Ok(accounts) = auth.accounts().await else {
                        return;
                    };

                    for account in accounts {
                        if account.needs_reauthentication {
                            continue;
                        }
                        let Ok(token) = auth.refresh_access_token(&app, &account.id).await else {
                            continue;
                        };
                        let client = engine.gmail_client(&account.id, token, gmail_base_url()).await;
                        if engine.run_sync(&account.id, client.clone()).await.is_ok() {
                            engine.enqueue_backfill(&account.id, client).await;
                        } else {
                            auth.invalidate_access_token(&account.id);
                        }
                    }
                }
            },
        );
        app_for_manage.manage(SyncSchedulers { fast, periodic });
    });
}
