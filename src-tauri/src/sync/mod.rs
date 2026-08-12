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
        AccountRepository, HtmlPresence, InlinePart, Label, LabelColor, LabelRepository, Message,
        MessageRepository, Storage, StorageError, ThreadRepository,
    },
};

pub mod commands;
mod dto;
mod mutations;
mod reconcile;
pub mod traversal;

pub use dto::{
    ConversationDto, LabelColorDto, LabelDto, MessageDto, MutationOutcomeDto, MutationResultDto,
    SyncStatusDto, ThreadCursor, ThreadDto, ThreadPage, TraversalKind, TraversalState,
    TraversalStatusDto,
};
pub use mutations::{MutationOutcome, BATCH_MODIFY_CHUNK_SIZE};

// ---------------------------------------------------------------------
// Queue wiring
// ---------------------------------------------------------------------

type BoxFuture = Pin<Box<dyn Future<Output = Result<(), QueueError>> + Send>>;
type OneShotWork = Box<dyn FnOnce() -> BoxFuture + Send>;

struct QueueRoute {
    lane: Lane,
    kind: OperationKind,
    entity_key: String,
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
    run_via_queue_on(
        queue,
        registry,
        account_id,
        op_id,
        QueueRoute {
            lane: Lane::Background,
            kind: OperationKind::Sync,
            entity_key: format!("sync:{account_id}"),
        },
        future,
    )
    .await
}

/// Like [`run_via_queue`], but for a traversal task which must share
/// backfill's lane and entity key. Kept separate from the ordinary sync
/// route so initial and incremental sync retain their established routing.
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

/// Best-effort classification of a mutation request's `OperationKind`,
/// used only for the enqueued flush operation's retry bookkeeping. A flush
/// now carries heterogeneous deltas once entities are grouped by
/// `sync::mutations`, so a single label-shaped kind can no longer be
/// authoritative for the whole flush — every branch here retries
/// identically regardless (`OperationKind::retries`), so this is purely
/// informational. Kept here (sync's own star/read vocabulary) rather than
/// in the generic delta-map machinery in `sync::mutations`.
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

pub struct SyncEngine {
    storage: Storage,
    queue: Arc<QueueEngine>,
    registry: Arc<WorkRegistry>,
    events: EventSink,
    status: AsyncMutex<std::collections::HashMap<String, AccountStatus>>,
    op_counter: Arc<AtomicU64>,
    /// The per-account, per-entity pending mutation delta map (D5) — see
    /// `sync::mutations` for the coalescing/flush mechanism built on top of
    /// it.
    pending: AsyncMutex<mutations::PendingMutations>,
    gmail_limiters: GmailRateLimiters,
    /// Account ids with a backfill chain currently live (enqueued but not
    /// yet terminal). Guards [`SyncEngine::enqueue_backfill`] against
    /// starting a second concurrent chain for the same account — the
    /// scheduler calls it unconditionally on every tick, and a fresh
    /// backfill routinely spans more than one `sync_interval_minutes`
    /// window. This is *in addition to* the queue's own entity-lock
    /// serialization (`queue::mod`), not a replacement for it: that lock
    /// only serializes operations once they run, it does not stop a second
    /// chain from being kicked off and interleaved with the first.
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
        // Cloned before `client` moves into the queued closure below — kept
        // around purely to hand to `enqueue_backfill` afterward.
        // `full_sync_body` itself is untouched by any of this (Phase 4 AC5).
        let backfill_client = client.clone();
        let outcome = run_via_queue(&self.queue, &self.registry, account_id, op_id, async move {
            full_sync_body(&storage, &client, &account_owned).await
        })
        .await;
        let result = self.finish(account_id, outcome).await;
        if result.is_ok() {
            // Whole-mailbox backfill begins only once initial sync has
            // produced its full-body Inbox (Functional Requirements /
            // D1) — never in parallel with it, and never in place of it.
            self.enqueue_backfill(account_id, backfill_client).await;
        }
        result
    }

    /// Enqueues whole-mailbox backfill's first discrete unit of work — one
    /// page — as a traversal-lane operation under the entity key backfill
    /// and reconciliation (Phase 5) share ([`traversal::traversal_entity_key`],
    /// D3), so the queue's per-account entity lock keeps the two mutually
    /// exclusive. Called right after initial sync completes, and again from
    /// every scheduler tick (see `start_scheduler`) as the resumption path
    /// for an app restart that lands mid-backfill: once the account already
    /// has a checkpoint, every later `run_sync` takes the `incremental_sync`
    /// branch, which never calls this — the scheduler is what re-offers
    /// backfill a chance to finish. Cheap to call unconditionally either
    /// way: [`traversal::run_backfill_step`] itself detects an
    /// already-complete cursor and returns immediately without any Gmail
    /// request.
    ///
    /// Plan-adherence audit item 5 fix: each call to this only enqueues
    /// *one page's* worth of work rather than the whole multi-hour backfill
    /// as a single operation. Once that page's step completes, the
    /// registered closure re-enqueues the next step as a brand-new queue
    /// operation before returning — so the traversal lane permit and the
    /// account's entity lock are released between every page, exactly the
    /// "every unit of work is a discrete operation" requirement, and every
    /// page automatically gets the queue's own per-operation
    /// `wait_until_resumed`/`wait_for_interactive` checks (previously only
    /// evaluated once, before the whole backfill started). Fire-and-forget
    /// — nothing here awaits backfill's own completion, so this never
    /// lengthens a sync run it's called after.
    pub async fn enqueue_backfill(&self, account_id: &str, client: GmailClient) {
        // Guard against a second concurrent chain: the scheduler calls this
        // unconditionally every tick, and a fresh backfill routinely
        // outlives one `sync_interval_minutes` window. If a chain is
        // already live for this account, skip — the live chain's own
        // recursive `enqueue_backfill_step` calls will keep resuming until
        // it's done. See `active_backfills`'s doc comment.
        {
            let mut active = self.active_backfills.lock().await;
            if !active.insert(account_id.to_owned()) {
                return;
            }
        }
        // Snapshotted once, right here, at the moment this logical backfill
        // run begins — *not* re-derived from the cursor's `position` on
        // every later page. `position` becomes non-null the instant this
        // very run's own first page commits, so deriving "resumed" from it
        // live would make an uninterrupted run's status bar read "Resuming
        // backfill" from page 2 onward. `resumed` is true only when this
        // run is genuinely picking up a checkpoint a *previous* process/run
        // left behind — exactly what a non-null `position` here, before
        // this run has written anything of its own, means.
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
                } => Ok(FullSyncOutcome {
                    history_id,
                    added_count,
                    thread_ids,
                }),
                IncrementalOutcome::Expired => {
                    // ponytail: this still enqueues reconciliation onto the
                    // traversal lane from *inside* the current background-lane
                    // operation and awaits it here — if backfill is mid-run and
                    // holding the traversal entity lock, this await blocks
                    // until backfill yields that lock, pinning a background-
                    // lane permit for however long that takes (plan-adherence
                    // audit item 5, second half; not fully fixed this phase).
                    // The blast radius is now much smaller than before backfill
                    // was split into discrete per-page operations (this phase's
                    // main item 5 fix): the longest a background permit can be
                    // pinned is one backfill page, not the whole multi-hour
                    // run. Upgrade path: give incremental sync's expired-
                    // checkpoint branch its own fire-and-forget enqueue (mirroring
                    // `enqueue_backfill`) instead of awaiting reconciliation
                    // inline, if this ever proves to still starve background
                    // work in practice.
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

/// Enqueues exactly one traversal-lane [`traversal::run_backfill_step`] as
/// its own `QueueOperation`, and — once that step's closure runs and
/// reports backfill isn't finished yet — enqueues the *next* step the same
/// way before the closure returns. A free function (not a `SyncEngine`
/// method) because the registered closure is `'static` and needs its own
/// owned/`Arc`'d handles rather than a borrow of `&self`; recursion needs
/// boxing since `async fn` can't otherwise refer to itself. See
/// [`SyncEngine::enqueue_backfill`]'s documentation for why this exists.
///
/// `resumed` is fixed for the whole logical run this call chain drives — it
/// is computed exactly once, by [`SyncEngine::enqueue_backfill`], before the
/// first step, and every recursive call here simply forwards the same value
/// unchanged. See [`traversal::run_backfill_step`]'s documentation for why
/// it must *not* be recomputed per page.
///
/// `handles` bundles the `'static`, `Arc`'d/cloneable state every step
/// needs (kept as one struct rather than five loose parameters purely to
/// stay under clippy's argument-count lint — there's no other reason these
/// five are grouped).
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
                            // Terminal (permanent failure): no next step
                            // will be enqueued, so this account's chain is
                            // no longer live.
                            step_active_backfills.lock().await.remove(&step_account);
                            return Err(QueueError::Permanent);
                        }
                    };
                    if completed {
                        // Terminal (finished): clear before returning so a
                        // later scheduler tick's `enqueue_backfill` is free
                        // to start a brand-new chain (e.g. after new mail
                        // extends the mailbox again).
                        step_active_backfills.lock().await.remove(&step_account);
                    } else {
                        // Enqueuing the next step here — *before* this
                        // operation's own closure returns — is what keeps
                        // each page a genuinely discrete unit: the queue
                        // only releases this operation's traversal-lane
                        // permit and the account's entity lock once this
                        // future resolves, and the next page's operation
                        // then has to re-acquire both from scratch rather
                        // than the same operation just looping internally.
                        // The guard stays set — the chain is still live.
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
            })
            .await;
        if enqueue_result.is_err() {
            // The registered closure above will never run (the queue
            // rejected/dropped this step outright), so it will never get a
            // chance to clear the guard itself — do it here instead, or a
            // permanently stopped queue would wedge this account's backfill
            // out forever.
            active_backfills.lock().await.remove(&account_id);
        }
    })
}

/// The `'static`, cloneable handles [`enqueue_backfill_step`] threads
/// through its recursive queue-operation chain.
struct BackfillHandles {
    queue: Arc<QueueEngine>,
    registry: Arc<WorkRegistry>,
    storage: Storage,
    events: EventSink,
    op_counter: Arc<AtomicU64>,
    /// Cleared of this account's id the moment the chain this handles bundle
    /// belongs to reaches a terminal state (completed, permanently failed,
    /// or fails to enqueue its next step) — see
    /// [`SyncEngine::active_backfills`].
    active_backfills: Arc<AsyncMutex<std::collections::HashSet<String>>>,
}

// ---------------------------------------------------------------------
// Full sync (initial sync + the D13 full re-sync fallback share this body)
// ---------------------------------------------------------------------

pub(crate) struct FullSyncOutcome {
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
        .list_all_messages_matching(
            &["INBOX".to_owned()],
            Some("newer_than:30d"),
            crate::gmail::ListOptions::default(),
        )
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

pub(crate) fn to_label(account_id: &str, label: &GmailLabel) -> Label {
    // Colour is a user-label-only concept (D10) — Gmail generally never
    // sends one for a system label, but a defensive kind check keeps that
    // invariant true regardless.
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
        // Initial/incremental sync always fetches a message in full (the
        // client's `MESSAGE_FIELDS` always includes `payload`), so presence
        // is already known and never "never fetched" on this path. The
        // truncated body is a whole-mailbox-backfill concept (Phase 4);
        // a fully fetched message doesn't need one.
        truncated_body: None,
        html_presence: HtmlPresence::from_fetched_body(message.html_body.as_deref()),
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
                    if engine.run_sync(&account.id, client.clone()).await.is_ok() {
                        // Restart-resumption safety net (Phase 4 scope: wire
                        // traversal into scheduling): an app restart mid-
                        // backfill re-enters through `incremental_sync`
                        // (the account already has a checkpoint), which
                        // never calls `enqueue_backfill` itself — every
                        // scheduler tick gets its own chance to resume an
                        // incomplete cursor instead. See
                        // `SyncEngine::enqueue_backfill` for why this is
                        // cheap to call unconditionally.
                        engine.enqueue_backfill(&account.id, client).await;
                    }
                }
            }
        });
        app_for_manage.manage(scheduler);
    });
}
