//! Synchronization engine: initial sync, incremental (history-based) sync,
//! full re-sync fallback, thread derivation, and the Mail-read / Sync IPC
//! commands that Phase 18 wires the UI against.
//!
//! Design note on queue routing: the queue's `Executor` is a single
//! process-wide closure keyed only by `QueueOperation` (id/kind/entity_key),
//! with no payload or result channel (see `queue::QueueEngine`). To route
//! arbitrary async Gmail work through the queue's background lane while
//! still getting a typed result back, this module registers a one-shot
//! closure per operation id in [`WorkRegistry`] and pairs it with a oneshot
//! channel; [`create_queue_engine`] wires the registry into the engine's
//! executor. `OperationKind::Sync` never retries at the queue layer (the
//! Gmail client already retries 429/5xx/network internally, and a failed
//! sync run is simply retried by the next scheduler tick), so the
//! registered closure is safe to consume as `FnOnce`.

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
        AccountRepository, InlinePart, Label, LabelRepository, Message, MessageRepository, Storage,
        StorageError, ThreadRepository,
    },
};

pub mod commands;
mod dto;

pub use dto::{
    ConversationDto, LabelDto, MessageDto, SyncStatusDto, ThreadCursor, ThreadDto, ThreadPage,
};

// ---------------------------------------------------------------------
// Queue wiring
// ---------------------------------------------------------------------

type BoxFuture = Pin<Box<dyn Future<Output = Result<(), QueueError>> + Send>>;
type OneShotWork = Box<dyn FnOnce() -> BoxFuture + Send>;

struct PendingMutation {
    thread_id: String,
    messages: Vec<Message>,
    reply: oneshot::Sender<Result<(), SyncError>>,
}

/// Holds pending sync work keyed by the `QueueOperation::id` that was
/// enqueued for it, so the queue's single global executor can find and run
/// it. See the module doc for why this indirection exists.
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

/// Builds a `QueueEngine` whose executor dispatches through `registry`.
/// Every module that wants to run work on the queue (this phase: sync;
/// future phases: interactive mutations) shares one engine + registry pair.
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
    let executor: Executor = Arc::new(move |operation: QueueOperation| -> OperationFuture {
        let registry = Arc::clone(&registry);
        Box::pin(async move {
            match registry.take(&operation.id) {
                Some(work) => work().await,
                None => Ok(()),
            }
        })
    });
    QueueEngine::new_with_events(rate_per_second, burst, executor, events)
}

/// Submits `future` as a single background-lane operation for `account_id`
/// and awaits its result. All operations for the same account share the
/// entity key `sync:<account_id>`, so an initial sync, a resync and an
/// incremental poll for the same account can never run concurrently — the
/// queue's entity lock serializes them.
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
        lane: Lane::Background,
        kind: OperationKind::Sync,
        // Shared across every sync op kind for this account so the queue's
        // entity lock serializes initial/incremental/resync runs — see the
        // module doc.
        entity_key: format!("sync:{account_id}"),
        // ponytail: a flat cost stand-in for the whole sync run — Gmail's
        // own per-request quota pacing already lives inside `GmailClient`'s
        // token bucket; this queue-level cost only paces *concurrent sync
        // runs*, so a nominal value is sufficient. Revisit if per-request
        // queue-level pacing is ever required.
        cost: 0,
        attempts: 0,
    };
    queue
        .enqueue(operation)
        .await
        .map_err(|_| SyncError::QueueStopped)?;
    rx.await.map_err(|_| SyncError::QueueStopped)?
}

// ---------------------------------------------------------------------
// Errors and status
// ---------------------------------------------------------------------

#[derive(Debug)]
pub enum SyncError {
    Gmail(GmailError),
    Storage(StorageError),
    QueueStopped,
    UnknownAccount,
    /// A failure fanned out to every waiter of a coalesced batch, kept as a
    /// string because `GmailError`/`StorageError` are not `Clone`.
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

// ---------------------------------------------------------------------
// Events (named emitters)
// ---------------------------------------------------------------------

/// A sink for Rust-emitted events, decoupled from `tauri::AppHandle` so the
/// engine is unit-testable without standing up a real Tauri app. Production
/// wiring (`initialize`) supplies one backed by `AppHandle::emit`.
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
/// Named emitter for `sync://progress`.
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
}
/// Named emitter for `sync://complete`.
pub fn emit_complete(sink: &EventSink, event: SyncCompleteEvent) {
    sink(
        "sync://complete",
        serde_json::to_value(event).expect("SyncCompleteEvent always serializes"),
    );
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMailEvent {
    pub account_id: String,
    pub thread_ids: Vec<String>,
}
/// Named emitter for `mail://new`.
pub fn emit_new_mail(sink: &EventSink, event: NewMailEvent) {
    sink(
        "mail://new",
        serde_json::to_value(event).expect("NewMailEvent always serializes"),
    );
}

// ---------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------

/// Pending label mutations grouped by `(account, label, present)`.
type MutationBatches =
    std::collections::HashMap<(String, &'static str, bool), Vec<PendingMutation>>;

pub struct SyncEngine {
    storage: Storage,
    queue: Arc<QueueEngine>,
    registry: Arc<WorkRegistry>,
    events: EventSink,
    status: AsyncMutex<std::collections::HashMap<String, AccountStatus>>,
    op_counter: AtomicU64,
    mutation_batches: AsyncMutex<MutationBatches>,
    gmail_limiters: GmailRateLimiters,
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
            op_counter: AtomicU64::new(0),
            mutation_batches: AsyncMutex::new(std::collections::HashMap::new()),
            gmail_limiters: GmailRateLimiters::default(),
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

    pub async fn mutate_thread(
        &self,
        account_id: &str,
        client: GmailClient,
        thread_id: String,
        label_id: &'static str,
        present: bool,
    ) -> Result<(), SyncError> {
        let account = account_id.to_owned();
        let messages = self
            .storage
            .run({
                let account = account.clone();
                let thread_id = thread_id.clone();
                move |connection| {
                    MessageRepository::list_by_thread(connection, &account, &thread_id)
                }
            })
            .await?;
        let key = (account_id.to_owned(), label_id, present);
        let (reply, result) = oneshot::channel();
        let leader = {
            let mut batches = self.mutation_batches.lock().await;
            let batch = batches.entry(key.clone()).or_default();
            let leader = batch.is_empty();
            batch.push(PendingMutation {
                thread_id,
                messages,
                reply,
            });
            leader
        };
        if !leader {
            return result.await.map_err(|_| SyncError::QueueStopped)?;
        }
        // A tiny coalescing window lets concurrently dispatched UI mutations
        // join this Gmail batch; tests drive it with Tokio's mock clock.
        tokio::time::sleep(Duration::from_millis(1)).await;
        let pending = self
            .mutation_batches
            .lock()
            .await
            .remove(&key)
            .unwrap_or_default();
        let storage = self.storage.clone();
        let op_id = format!(
            "mutation:{account_id}:{}",
            self.op_counter.fetch_add(1, Ordering::Relaxed)
        );
        self.registry.register(
            op_id.clone(),
            Box::new(move || {
                Box::pin(async move {
                    let result = async {
                        let add = if present {
                            vec![label_id.to_owned()]
                        } else {
                            Vec::new()
                        };
                        let remove = if present {
                            Vec::new()
                        } else {
                            vec![label_id.to_owned()]
                        };
                        // Gmail's batch endpoint returns an empty response, so re-read each
                        // affected message before persisting the mutation. That is the
                        // smallest way to coalesce the label write without losing the
                        // returned historyId required by the strict stale-read gate.
                        let ids = pending
                            .iter()
                            .flat_map(|request| request.messages.iter())
                            .map(|message| message.id.clone())
                            .collect::<Vec<_>>();
                        // Gmail accepts at most 1,000 message IDs per batch request.
                        for ids in ids.chunks(1_000) {
                            if let Err(error) = client.batch_modify(ids, &add, &remove).await {
                                // Every waiter in the batch has to hear the real
                                // error: returning early instead would drop their
                                // reply channels, and each caller would see the
                                // misleading `QueueStopped` message.
                                let message = SyncError::from(error).to_string();
                                for request in pending {
                                    let _ = request
                                        .reply
                                        .send(Err(SyncError::Failed(message.clone())));
                                }
                                return Err(SyncError::Failed(message));
                            }
                        }
                        let mut write_failed = false;
                        for request in pending {
                            let mutation_result = async {
                                for message in request.messages {
                                    let updated = client.message(&message.id).await?;
                                    let account = account.clone();
                                    let id = message.id.clone();
                                    let thread = request.thread_id.clone();
                                    storage
                                        .run(move |connection| {
                                            MessageRepository::write_mutation_history(
                                                connection,
                                                &account,
                                                std::slice::from_ref(&id),
                                                updated.history_id,
                                            )?;
                                            MessageRepository::set_label_membership(
                                                connection, &account, &id, label_id, present,
                                            )?;
                                            ThreadRepository::recompute(
                                                connection, &account, &thread,
                                            )
                                        })
                                        .await?;
                                }
                                Ok::<(), SyncError>(())
                            }
                            .await;
                            write_failed |= mutation_result.is_err();
                            let _ = request.reply.send(mutation_result);
                        }
                        if write_failed {
                            // Each waiter already got its own error above; this
                            // only marks the queue operation as failed.
                            Err(SyncError::Failed("mutation write failed".into()))
                        } else {
                            Ok::<(), SyncError>(())
                        }
                    }
                    .await;
                    if result.is_ok() {
                        Ok(())
                    } else {
                        Err(QueueError::Permanent)
                    }
                })
            }),
        );
        self.queue
            .enqueue(QueueOperation {
                id: op_id,
                account_id: account_id.to_owned(),
                lane: Lane::Interactive,
                kind: match (label_id, present) {
                    ("STARRED", true) => OperationKind::Star,
                    ("STARRED", false) => OperationKind::Unstar,
                    ("UNREAD", true) => OperationKind::MarkUnread,
                    _ => OperationKind::MarkRead,
                },
                entity_key: format!("mutation-batch:{account_id}"),
                cost: 0,
                attempts: 0,
            })
            .await
            .map_err(|_| SyncError::QueueStopped)?;
        result.await.map_err(|_| SyncError::QueueStopped)?
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

    async fn set_idle(&self, account_id: &str, history_id: i64, added_count: u32, now: i64) {
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
            },
        );
    }

    async fn set_error(&self, account_id: &str, error: &SyncError) {
        let mut status = self.status.lock().await;
        let entry = status.entry(account_id.to_owned()).or_default();
        entry.state = Some(SyncState::Error);
        entry.last_error = Some(error.to_string());
    }

    /// Runs whichever sync is appropriate for the account's current
    /// checkpoint: initial sync if none exists yet, otherwise incremental
    /// (which itself falls back to a full re-sync on an expired checkpoint,
    /// per D13).
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
            None => self.initial_sync(account_id, client).await,
            Some(checkpoint) => self.incremental_sync(account_id, client, checkpoint).await,
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
        let outcome = run_via_queue(&self.queue, &self.registry, account_id, op_id, async move {
            full_sync_body(&storage, &client, &account_owned).await
        })
        .await;
        self.finish(account_id, outcome).await
    }

    /// Polls history from `checkpoint` and applies deltas. On an expired
    /// checkpoint (D13: `history.list` 404), falls back to a full re-sync
    /// within the *same* queued operation — the checkpoint's fate (advance
    /// only on success) is identical either way, so both paths funnel
    /// through the same completion/error handling below.
    async fn incremental_sync(
        &self,
        account_id: &str,
        client: GmailClient,
        checkpoint: i64,
    ) -> Result<(), SyncError> {
        self.set_syncing(account_id).await;
        let op_id = self.next_op_id(account_id);
        let storage = self.storage.clone();
        let account_owned = account_id.to_owned();
        let outcome = run_via_queue(&self.queue, &self.registry, account_id, op_id, async move {
            match incremental_body(&storage, &client, &account_owned, checkpoint).await? {
                IncrementalOutcome::Updated {
                    history_id,
                    added_count,
                    thread_ids,
                } => Ok(FullSyncOutcome {
                    history_id,
                    added_count,
                    thread_ids,
                }),
                IncrementalOutcome::Expired => {
                    full_sync_body(&storage, &client, &account_owned).await
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
            Ok(result) => {
                self.complete(
                    account_id,
                    result.history_id,
                    result.added_count,
                    result.thread_ids,
                )
                .await
            }
            Err(error) => {
                self.set_error(account_id, &error).await;
                Err(error)
            }
        }
    }

    /// Advances the checkpoint (completion only, never on acceptance or
    /// failure — see D6/D13) and emits completion/new-mail events.
    async fn complete(
        &self,
        account_id: &str,
        history_id: i64,
        added_count: u32,
        thread_ids: Vec<String>,
    ) -> Result<(), SyncError> {
        self.storage
            .run({
                let account_id = account_id.to_owned();
                move |connection| {
                    AccountRepository::set_history_id(connection, &account_id, history_id)
                }
            })
            .await?;
        let now = chrono::Utc::now().timestamp();
        self.set_idle(account_id, history_id, added_count, now)
            .await;
        if added_count > 0 {
            emit_new_mail(
                &self.events,
                NewMailEvent {
                    account_id: account_id.to_owned(),
                    thread_ids,
                },
            );
        }
        Ok(())
    }

    pub fn storage(&self) -> &Storage {
        &self.storage
    }
}

// ---------------------------------------------------------------------
// Full sync (initial sync + the D13 full re-sync fallback share this body)
// ---------------------------------------------------------------------

struct FullSyncOutcome {
    history_id: i64,
    added_count: u32,
    thread_ids: Vec<String>,
}

async fn full_sync_body(
    storage: &Storage,
    client: &GmailClient,
    account_id: &str,
) -> Result<FullSyncOutcome, SyncError> {
    let profile = client.profile().await?;
    let gmail_labels = client.labels().await?;
    let refs = client
        .list_all_messages_matching(&["INBOX".to_owned()], Some("newer_than:30d"))
        .await?;
    let mut messages = Vec::with_capacity(refs.len());
    for message_ref in &refs {
        messages.push(client.message(&message_ref.id).await?);
    }
    let added_count = messages.len() as u32;
    let thread_ids: Vec<String> = messages
        .iter()
        .map(|message| message.thread_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();

    let account_owned = account_id.to_owned();
    let thread_ids_for_write = thread_ids.clone();
    storage
        .run(move |connection| {
            // Wiping and rebuilding (rather than diffing) is what makes this
            // "full" — it's shared by both initial sync (a no-op wipe, since
            // the account has no rows yet) and the D13 re-sync fallback
            // (where it also reconciles messages Gmail deleted while the
            // checkpoint was expired, which incremental delta application
            // alone cannot detect).
            connection.execute("DELETE FROM messages WHERE account_id=?1", [&account_owned])?;
            connection.execute("DELETE FROM threads WHERE account_id=?1", [&account_owned])?;
            for label in &gmail_labels {
                LabelRepository::upsert(connection, &to_label(&account_owned, label))?;
            }
            for message in &messages {
                write_message(connection, &account_owned, message)?;
            }
            for thread_id in &thread_ids_for_write {
                ThreadRepository::recompute(connection, &account_owned, thread_id)?;
            }
            Ok(())
        })
        .await?;

    Ok(FullSyncOutcome {
        history_id: profile.history_id,
        added_count,
        thread_ids,
    })
}

// ---------------------------------------------------------------------
// Incremental sync (delta application)
// ---------------------------------------------------------------------

enum IncrementalOutcome {
    Updated {
        history_id: i64,
        added_count: u32,
        thread_ids: Vec<String>,
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
    let mut final_history_id = start_history_id;
    loop {
        let page = match client
            .history_page(start_history_id, token.as_deref())
            .await
        {
            Ok(page) => page,
            Err(GmailError::HistoryExpired) => return Ok(IncrementalOutcome::Expired),
            Err(error) => return Err(error.into()),
        };
        final_history_id = final_history_id.max(page.history_id);
        records.extend(page.records);
        if page.next_page_token.is_none() {
            break;
        }
        token = page.next_page_token;
    }

    let mut added_messages = Vec::new();
    for record in &records {
        for reference in &record.messages_added {
            added_messages.push(client.message(&reference.id).await?);
        }
    }
    let added_count = added_messages.len() as u32;
    let added_thread_ids: HashSet<String> = added_messages
        .iter()
        .map(|message| message.thread_id.clone())
        .collect();

    let account_owned = account_id.to_owned();
    storage
        .run(move |connection| {
            for label in &gmail_labels {
                LabelRepository::upsert(connection, &to_label(&account_owned, label))?;
            }
            let mut touched = HashSet::new();
            for message in &added_messages {
                touched.insert(message.thread_id.clone());
                write_message(connection, &account_owned, message)?;
            }
            for record in &records {
                for change in &record.labels_added {
                    for label_id in &change.label_ids {
                        LabelRepository::ensure_placeholder(connection, &account_owned, label_id)?;
                        MessageRepository::set_label_membership(
                            connection,
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
                            connection,
                            &account_owned,
                            &change.message.id,
                            label_id,
                            false,
                        )?;
                    }
                    touched.insert(change.message.thread_id.clone());
                }
                for deleted in &record.messages_deleted {
                    match MessageRepository::delete(connection, &account_owned, &deleted.id)? {
                        Some(thread_id) => {
                            touched.insert(thread_id);
                        }
                        None => {
                            touched.insert(deleted.thread_id.clone());
                        }
                    }
                }
            }
            for thread_id in &touched {
                ThreadRepository::recompute(connection, &account_owned, thread_id)?;
            }
            Ok(())
        })
        .await?;

    Ok(IncrementalOutcome::Updated {
        history_id: final_history_id,
        added_count,
        thread_ids: added_thread_ids.into_iter().collect(),
    })
}

// ---------------------------------------------------------------------
// Gmail -> storage mapping
// ---------------------------------------------------------------------

fn to_label(account_id: &str, label: &GmailLabel) -> Label {
    Label {
        account_id: account_id.to_owned(),
        id: label.id.clone(),
        name: label.name.clone(),
        kind: label.kind.clone(),
        color: label.color.clone(),
        message_count: label.message_count,
        unread_count: label.unread_count,
    }
}

fn to_message(account_id: &str, message: &GmailMessage) -> Message {
    Message {
        account_id: account_id.to_owned(),
        id: message.id.clone(),
        thread_id: message.thread_id.clone(),
        rfc_message_id: message.rfc_message_id.clone(),
        sender: message.sender.clone(),
        recipients: message.recipients.clone(),
        subject: message.subject.clone(),
        sent_at: message.sent_at,
        snippet: message.snippet.clone(),
        html_body: message.html_body.clone(),
        plain_body: message.plain_body.clone(),
        has_attachments: message.has_attachments,
        is_unread: message.label_ids.iter().any(|id| id == "UNREAD"),
        is_starred: message.label_ids.iter().any(|id| id == "STARRED"),
        history_id: message.history_id,
    }
}

fn write_message(
    connection: &rusqlite::Connection,
    account_id: &str,
    message: &GmailMessage,
) -> rusqlite::Result<()> {
    let changed =
        MessageRepository::write_full_state(connection, &to_message(account_id, message))?;
    if changed {
        for label_id in &message.label_ids {
            LabelRepository::ensure_placeholder(connection, account_id, label_id)?;
            MessageRepository::set_label_membership(
                connection,
                account_id,
                &message.id,
                label_id,
                true,
            )?;
        }
        let parts: Vec<InlinePart> = message
            .inline_parts
            .iter()
            .map(|part| InlinePart {
                content_id: part.content_id.clone(),
                mime_type: part.mime_type.clone(),
                bytes: part.bytes.clone(),
            })
            .collect();
        MessageRepository::replace_inline_parts(connection, account_id, &message.id, &parts)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------

/// Drives periodic incremental sync. Interval changes take effect
/// immediately (D-requirement): a change interrupts the current wait rather
/// than being picked up only after the stale interval elapses.
/// `run_immediately` governs whether the very first tick fires right away
/// (the Sync-on-startup preference) or waits out one interval first.
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

    /// Takes effect on the scheduler's next wait cycle, not after the
    /// interval that was already in progress finishes.
    pub fn set_interval(&self, interval: Duration) {
        let _ = self.interval_tx.send(interval);
    }
}

// ---------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------

/// Opens the shared SQLite database, builds the queue + sync engine, manages
/// both as Tauri state, and starts the background poll scheduler. Called
/// from `lib.rs` after `auth::initialize`/`settings::initialize`, which this
/// depends on for the `AuthService`/`SettingsService` state it reads.
///
/// The interval is read once here; later changes reach the running scheduler
/// through `settings::write_setting`, which resolves the managed
/// `Arc<SyncScheduler>` and calls `set_interval`.
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
        let _ = handle_for_events.emit(event, payload);
    });
    let queue =
        create_queue_engine_with_events(250, 250, Arc::clone(&registry), Arc::clone(&events));
    // The read commands (`list_labels`, `list_threads`, `load_conversation`)
    // resolve `State<Storage>`, so it has to be managed and not just buried
    // inside the engine.
    app.manage(storage.clone());
    let engine = SyncEngine::new(storage, Arc::clone(&queue), registry, events);
    app.manage(queue);
    app.manage(Arc::clone(&engine));
    start_scheduler(app.clone(), engine);
    Ok(())
}

fn start_scheduler<R: Runtime>(app: AppHandle<R>, engine: Arc<SyncEngine>) {
    let auth = app.state::<AuthService>().inner().clone();
    let settings = app.state::<SettingsService>().inner().clone();
    tauri::async_runtime::spawn(async move {
        let preferences = settings.read().await.unwrap_or_default();
        let interval =
            Duration::from_secs(u64::from(preferences.sync_interval_minutes.max(1)) * 60);
        let app_for_manage = app.clone();
        let scheduler = SyncScheduler::start(interval, preferences.sync_on_startup, move || {
            let app = app.clone();
            let auth = auth.clone();
            let engine = Arc::clone(&engine);
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
                    let base_url = std::env::var("LATENTMAIL_GMAIL_BASE_URL")
                        .unwrap_or_else(|_| "https://gmail.googleapis.com/gmail/v1".into());
                    let client = engine.gmail_client(&account.id, token, base_url).await;
                    let _ = engine.run_sync(&account.id, client).await;
                }
            }
        });
        app_for_manage.manage(scheduler);
    });
}
