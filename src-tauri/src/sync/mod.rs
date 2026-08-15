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

pub use dto::{
    ContactSuggestionDto, ConversationDto, LabelColorDto, LabelDto, MessageDto, MutationOutcomeDto,
    MutationResultDto, StagedAttachmentDto, SyncStatusDto, ThreadCursor, ThreadDto, ThreadPage,
    TraversalKind, TraversalState, TraversalStatusDto,
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
    QueueEngine::new_with_events(rate_per_second, burst, registry_executor(registry), events)
}

/// The `WorkRegistry`-backed executor every non-durable operation kind
/// dispatches through (in-memory, one-shot closures — fine for kinds that
/// are never expected to survive a restart). Extracted so production
/// startup ([`initialize`]) can compose it with
/// `compose::drafts::build_executor`'s payload-reconstructing executor for
/// `Draft`/`Send`, which — unlike this one — must never depend on captured
/// process memory (D15).
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
    pub changed: bool,
}
/// Named emitter for `sync://complete`.
pub fn emit_complete(sink: &EventSink, event: SyncCompleteEvent) {
    sink(
        "sync://complete",
        serde_json::to_value(event).expect("SyncCompleteEvent always serializes"),
    );
}

/// One newly arrived, still-unread Inbox message, carried on `mail://new`
/// so the frontend can raise an OS notification without a round trip.
/// Only the incremental (poll) path fills these in — a full sync's
/// "additions" are the whole mailbox, which must never be announced.
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
    /// backfill routinely spans more than one `sync_interval_seconds`
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
        // `set_syncing` announced the run; without a matching announcement
        // here the frontend keeps rendering "Syncing…" forever, since only
        // `sync://complete` ever clears it.
        emit_progress(
            &self.events,
            SyncProgressEvent {
                account_id: account_id.to_owned(),
                state: SyncState::Error,
            },
        );
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
        // outlives one `sync_interval_seconds` window. If a chain is
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
            Ok(result) => self.complete(account_id, result).await,
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
        if added_count > 0 {
            emit_new_mail(
                &self.events,
                NewMailEvent {
                    account_id: account_id.to_owned(),
                    thread_ids,
                    arrivals,
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
    changed: bool,
    /// See [`MailArrival`] — empty for every full-sync path.
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
            // Wiping and rebuilding (rather than diffing) is what makes this
            // "full" — it's shared by both initial sync (a no-op wipe, since
            // the account has no rows yet) and the D13 re-sync fallback
            // (where it also reconciles messages Gmail deleted while the
            // checkpoint was expired, which incremental delta application
            // alone cannot detect).
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

// ---------------------------------------------------------------------
// Incremental sync (delta application)
// ---------------------------------------------------------------------

/// How deep into a newest-first Inbox listing [`probe_inbox`] looks. One
/// page, sized for "what could plausibly have arrived since the last poll"
/// rather than for completeness — the history stream remains the mechanism
/// that catches everything else.
///
// ponytail: Inbox only, newest 25 — the mailbox users actually watch a sync
// button for. A lagging history record for Spam, an archived label or
// beyond the 25th newest Inbox message still waits for history to catch up.
// Upgrade path: probe the active mailbox instead of a hard-coded INBOX if
// that lag is ever noticed somewhere else.
const INBOX_PROBE_SIZE: u32 = 25;

/// Closes the window where Gmail has already delivered a message — it is
/// listable, and visible in Gmail's own web UI — but no `history.list`
/// record mentions it yet. That stream is only eventually consistent with
/// delivery, so an incremental sync that trusted it alone would report
/// success with nothing new to show and leave the message to surface
/// "randomly" whenever a later poll happened to catch up.
///
/// `messages.list` has no such lag, so one newest-first Inbox page
/// (`MESSAGES_LIST_COST`, once per incremental sync) is enough to notice.
/// Only ids neither this run's history deltas nor the local database
/// already hold cost a `messages.get` — on the overwhelmingly common
/// nothing-new tick that is exactly zero extra fetches.
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

/// Fetches every candidate id that neither this run already holds
/// (`already`) nor the local database does. Shared by the two paths that
/// discover an identifier without a usable delta attached: a history record
/// whose change type we do not model (`HistoryRecord::messages`), and the
/// Inbox freshness probe. `source` only names the caller in the log line.
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

    // The checkpoint advances only as far as a record this run actually
    // applied — deliberately NOT to the response's own `historyId`, which is
    // the mailbox's *current* counter and routinely runs ahead of the
    // records the API is willing to hand back. Adopting that counter is what
    // lets a history record that materializes moments later fall below the
    // checkpoint and be skipped permanently: `history.list` only ever
    // returns records *after* `startHistoryId`, so a record we jumped over
    // is never offered again. Advancing to the highest record we saw makes
    // "everything newer than what we have" literally true — a late record
    // still sorts above the checkpoint and arrives on the next poll,
    // however many of them there are.
    //
    // ponytail: an empty response therefore leaves the checkpoint where it
    // was, so a mailbox with genuinely zero history records for longer than
    // Gmail's retention window (documented as at least a week) expires it.
    // That path is already handled non-destructively by the expired-
    // checkpoint reconciliation below, and any activity at all — a read, a
    // label change, a delete — produces a record that moves it along.
    let final_history_id = records
        .iter()
        .map(|record| record.id)
        .max()
        .unwrap_or(start_history_id);

    let mut added_messages = Vec::new();
    for record in &records {
        for reference in &record.messages_added {
            // History reports the draft message a promotion just deleted as
            // added; fetching it 404s. Skipping keeps one vanished id from
            // aborting the whole incremental run.
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
    // Every message a record touches, including records whose change type
    // the four typed lists above do not express — Gmail does emit those, and
    // reading only the typed lists made such a record a silent no-op that the
    // checkpoint then advanced past. Anything here we do not already hold is
    // fetched like an addition; ids the typed lists already covered are
    // filtered out by `fetch_unknown`.
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

    // A probe failure is never allowed to fail a sync the history stream
    // already applied successfully — it is a safety net over that stream,
    // not a second source of truth. Losing it costs only the freshness this
    // one poll would have gained.
    match probe_inbox(storage, client, account_id, &added_messages).await {
        Ok(probed) => added_messages.extend(probed),
        Err(error) => {
            tracing::warn!(target: "sync", "{account_id}: inbox probe failed, relying on history alone: {error}");
        }
    }
    let added_count = added_messages.len() as u32;
    let changed = !records.is_empty() || !added_messages.is_empty();
    // Announce only what the user would consider "new mail": still in the
    // Inbox and still unread. Sent copies, drafts and anything already read
    // elsewhere (phone) are additions to *us*, not arrivals to them.
    let arrivals: Vec<MailArrival> = added_messages
        .iter()
        .filter(|message| {
            let has = |label: &str| message.label_ids.iter().any(|id| id == label);
            has("INBOX") && has("UNREAD")
        })
        .map(|message| MailArrival {
            sender: message.sender.clone(),
            subject: message.subject.clone(),
        })
        .collect();
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

fn write_message(
    connection: &rusqlite::Connection,
    account_id: &str,
    message: &GmailMessage,
) -> rusqlite::Result<()> {
    materialize::persist(connection, account_id, message)
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

    pub fn interval(&self) -> Duration {
        *self.interval_tx.borrow()
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
    // Every Rust-emitted event funnels through here, so this one line is the
    // whole outbound event log. `queue://summary` is excluded on volume
    // grounds only — it fires on every queue state transition and says
    // nothing a failure investigation needs.
    let events: EventSink = Arc::new(move |event, payload| {
        if event != "queue://summary" {
            tracing::info!(target: "events", "emit {event} {payload}");
        }
        if let Err(error) = handle_for_events.emit(event, payload) {
            tracing::error!(target: "events", "emit {event} failed: {error}");
        }
    });
    // App-private compose staging tree (D3) — the compose commands resolve
    // `State<Arc<Staging>>`, and the durable Draft/Send executor below reads
    // its immutable operation snapshots from the same instance.
    let staging = Arc::new(crate::compose::staging::Staging::new(
        directory.join("compose-staging"),
    ));
    app.manage(Arc::clone(&staging));
    // Managed as state (rather than only captured by the executor below) so
    // a future admission call site — an IPC command, or this module's own
    // tests — schedules generations on the very instance the executor
    // checks against.
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
    let queue = QueueEngine::new_with_events(250, 250, executor, Arc::clone(&events));
    // The read commands (`list_labels`, `list_threads`, `load_conversation`)
    // resolve `State<Storage>`, so it has to be managed and not just buried
    // inside the engine.
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

/// Startup durability recovery (D15): re-enqueues recoverable `Draft`/
/// `Send` work found `queued` (including drafts requeued from an
/// interrupted `active` run — see
/// `OperationRepository::requeue_interrupted_drafts`), and for every
/// account whose promotion was interrupted mid-flight, emits
/// `send://uncertain` and schedules exactly one ordinary reconciling sync —
/// never re-enqueuing the send itself. Runs in the background so it never
/// delays `initialize` returning.
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
        // ponytail: no jitter, no poll-level backoff: a persistently failing
        // account retries every interval. The existing per-request retry and
        // the 3-strike reauth flag are the only brakes.
        let interval = Duration::from_secs(
            u64::from(preferences.sync_interval_seconds)
                .max(crate::settings::MIN_SYNC_INTERVAL_SECS),
        );
        let app_for_manage = app.clone();
        let scheduler = SyncScheduler::start(interval, preferences.sync_on_startup, move || {
            let app = app.clone();
            let auth = auth.clone();
            let engine = Arc::clone(&engine);
            async move {
                let Ok(accounts) = auth.accounts().await else {
                    return;
                };
                // ponytail: all accounts are polled serially in one tick —
                // fine for a handful, not for dozens.
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
                    } else {
                        auth.invalidate_access_token(&account.id);
                    }
                }
            }
        });
        app_for_manage.manage(scheduler);
    });
}
