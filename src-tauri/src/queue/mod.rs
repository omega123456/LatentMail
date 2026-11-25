use std::{
    collections::{HashMap, HashSet},
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Weak,
    },
    time::Duration,
};

use tokio::{
    sync::{mpsc, Mutex, Notify, Semaphore},
    time::Instant,
};

use crate::storage::{Operation, OperationRepository, Storage};

pub const DEFAULT_RATE_PER_SECOND: u32 = 250;
pub const DEFAULT_BURST: u32 = 250;
const INTERACTIVE_LANE_SLOTS: usize = 4;
const SINGLE_LANE_SLOT: usize = 1;
const MAX_RETRY_BACKOFF_EXPONENT: u8 = 6;
const MAX_RETRY_DELAY_SECONDS: u64 = 60;

pub mod commands;
pub mod registry;

pub use registry::{
    AccountQueueSnapshot, LaneSnapshot, LaneState, LaneTarget, OperationRecord, OperationStatus,
    PauseScope, QueueRegistry, TerminalTransition,
};

const LANE_CAPACITY: usize = 512;
const MAX_ATTEMPTS: u8 = 10;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Lane {
    Interactive,
    Background,
    Traversal,
    Embedding,
}

impl Lane {
    pub const ALL: [Lane; 4] = [
        Lane::Interactive,
        Lane::Background,
        Lane::Traversal,
        Lane::Embedding,
    ];

    pub fn capacity(self) -> usize {
        match self {
            Self::Interactive => INTERACTIVE_LANE_SLOTS,
            Self::Background => SINGLE_LANE_SLOT,
            Self::Traversal => SINGLE_LANE_SLOT,
            Self::Embedding => SINGLE_LANE_SLOT,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationKind {
    Noop,
    LabelMutation,
    Send,
    Draft,
    Sync,
    Star,
    Unstar,
    MarkRead,
    MarkUnread,
    Delete,
    Move,
    Spam,
    NotSpam,
    Traversal,
    Embed,
}

impl OperationKind {
    pub fn persists(self) -> bool {
        matches!(self, Self::Send | Self::Draft)
    }

    fn retries(self) -> bool {
        !matches!(
            self,
            Self::Send | Self::Sync | Self::Traversal | Self::Embed
        )
    }
}

#[derive(Clone, Debug)]
pub struct QueueOperation {
    pub id: String,
    pub account_id: String,
    pub lane: Lane,
    pub kind: OperationKind,
    pub entity_key: String,
    pub cost: u32,
    pub attempts: u8,
    pub description: String,
}

pub struct QueueRoute {
    pub lane: Lane,
    pub kind: OperationKind,
    pub entity_key: String,
    pub description: String,
}

impl QueueOperation {
    pub fn new(id: String, account_id: String, route: QueueRoute) -> Self {
        Self {
            id: id,
            account_id: account_id,
            lane: route.lane,
            kind: route.kind,
            entity_key: route.entity_key,
            cost: 0,
            attempts: 0,
            description: route.description,
        }
    }

    pub fn will_retry(&self, error: QueueError) -> bool {
        self.kind.retries() && error.retryable() && self.attempts + 1 < MAX_ATTEMPTS
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QueueError {
    Network,
    Http(u16),
    Permanent,
}

impl QueueError {
    fn retryable(self) -> bool {
        match self {
            Self::Network => true,
            Self::Http(status) => crate::is_retryable_status(status),
            Self::Permanent => false,
        }
    }
}

pub type OperationFuture = Pin<Box<dyn Future<Output = Result<(), QueueError>> + Send>>;
pub type Executor = Arc<dyn Fn(QueueOperation) -> OperationFuture + Send + Sync>;
pub type QueueEventSink = Arc<dyn Fn(&'static str, serde_json::Value) + Send + Sync>;
pub type CancellationHook = Arc<dyn Fn(&OperationRecord) + Send + Sync>;

pub struct QueueConfig {
    pub rate_per_second: u32,
    pub burst: u32,
    pub events: QueueEventSink,
    pub cancellation_hook: CancellationHook,
}

impl Default for QueueConfig {
    fn default() -> Self {
        Self {
            rate_per_second: DEFAULT_RATE_PER_SECOND,
            burst: DEFAULT_BURST,
            events: Arc::new(|_, _| {}),
            cancellation_hook: Arc::new(|_| {}),
        }
    }
}

pub struct DurableSubmission {
    pub operation: QueueOperation,
    pub payload: String,
}

pub struct RecoveredOperations {
    pub pending: Vec<Operation>,
    pub uncertain_accounts: Vec<String>,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueSummary {
    pub pending: usize,
    pub active: usize,
    pub failed: usize,
    pub done: usize,
    pub paused: bool,
    pub suspended: bool,
}

struct QueueItemEvent<'a> {
    id: &'a str,
    account_id: &'a str,
    lane: Lane,
    status: &'static str,
}

#[derive(Default)]
struct Counters {
    pending: AtomicUsize,
    active: AtomicUsize,
    failed: AtomicUsize,
    done: AtomicUsize,
}

struct AccountQueue {
    interactive: mpsc::Sender<QueueOperation>,
    background: mpsc::Sender<QueueOperation>,
    traversal: mpsc::Sender<QueueOperation>,
    embedding: mpsc::Sender<QueueOperation>,
}

struct TokenBucket {
    tokens: Mutex<(f64, Instant)>,
    rate: f64,
    capacity: f64,
}

impl TokenBucket {
    fn new(rate: u32, capacity: u32) -> Self {
        Self {
            tokens: Mutex::new((f64::from(capacity), Instant::now())),
            rate: f64::from(rate),
            capacity: f64::from(capacity),
        }
    }

    async fn try_consume(&self, cost: f64) -> Option<Duration> {
        let mut state = self.tokens.lock().await;
        let now = Instant::now();
        state.0 = (state.0 + (now - state.1).as_secs_f64() * self.rate).min(self.capacity);
        state.1 = now;
        if state.0 >= cost {
            state.0 -= cost;
            return None;
        }
        Some(Duration::from_secs_f64((cost - state.0) / self.rate))
    }

    async fn acquire(&self, cost: u32) {
        let cost = f64::from(cost);
        while let Some(wait) = self.try_consume(cost).await {
            tokio::time::sleep(wait).await;
        }
    }
}

type EntityLocks = Mutex<HashMap<(String, String), Arc<Mutex<()>>>>;

pub struct QueueEngine {
    accounts: Mutex<HashMap<String, AccountQueue>>,
    entity_locks: EntityLocks,
    paused: AtomicBool,
    suspended: AtomicBool,
    resumed: Notify,
    interactive_pending: Mutex<HashMap<String, usize>>,
    interactive_drained: Notify,
    buckets: Mutex<HashMap<String, Arc<TokenBucket>>>,
    rate_per_second: u32,
    burst: u32,
    counters: Counters,
    executor: Executor,
    events: QueueEventSink,
    registry: QueueRegistry,
    cancellation_hook: CancellationHook,
}

enum AttemptOutcome {
    Finished,
    RetryAfter(Duration),
}

struct OperationRunner {
    engine: Arc<QueueEngine>,
    operation: QueueOperation,
    permits: Arc<Semaphore>,
}

impl OperationRunner {
    async fn run(mut self) {
        let lock = self.engine.entity_lock(&self.operation).await;
        let _entity = lock.lock().await;
        let permits = Arc::clone(&self.permits);
        let _permit = permits.acquire().await.expect("semaphore remains open");
        loop {
            if !self.prepare_attempt().await {
                return;
            }
            match self.execute_attempt().await {
                AttemptOutcome::Finished => return,
                AttemptOutcome::RetryAfter(delay) => tokio::time::sleep(delay).await,
            }
        }
    }

    async fn prepare_attempt(&self) -> bool {
        self.engine.wait_until_resumed_for(&self.operation).await;
        self.engine.wait_for_interactive(&self.operation).await;
        self.engine.wait_until_resumed_for(&self.operation).await;
        self.engine
            .bucket_for(&self.operation.account_id)
            .await
            .acquire(self.operation.cost)
            .await;
        self.engine.wait_until_resumed_for(&self.operation).await;
        self.engine
            .registry
            .try_mark_active(&self.operation.id, self.operation.attempts)
    }

    async fn execute_attempt(&mut self) -> AttemptOutcome {
        self.engine.counters.pending.fetch_sub(1, Ordering::Relaxed);
        self.engine.counters.active.fetch_add(1, Ordering::Relaxed);
        self.engine.emit(QueueItemEvent {
            id: &self.operation.id,
            account_id: &self.operation.account_id,
            lane: self.operation.lane,
            status: "active",
        });
        if self.operation.lane == Lane::Interactive {
            self.engine
                .finish_interactive(&self.operation.account_id)
                .await;
            self.engine.interactive_drained.notify_waiters();
        }
        let result = (self.engine.executor)(self.operation.clone()).await;
        self.engine.counters.active.fetch_sub(1, Ordering::Relaxed);
        self.resolve_outcome(result)
    }

    fn resolve_outcome(&mut self, result: Result<(), QueueError>) -> AttemptOutcome {
        match result {
            Ok(()) => {
                self.engine.counters.done.fetch_add(1, Ordering::Relaxed);
                self.engine.registry.transition_terminal(
                    &self.operation,
                    TerminalTransition {
                        status: OperationStatus::Done,
                        error: None,
                    },
                );
                self.engine.emit(QueueItemEvent {
                    id: &self.operation.id,
                    account_id: &self.operation.account_id,
                    lane: self.operation.lane,
                    status: "done",
                });
                AttemptOutcome::Finished
            }
            Err(error) if self.operation.will_retry(error) => {
                self.operation.attempts += 1;
                self.engine.counters.pending.fetch_add(1, Ordering::Relaxed);
                self.engine.registry.transition_retrying(&self.operation);
                self.engine.emit(QueueItemEvent {
                    id: &self.operation.id,
                    account_id: &self.operation.account_id,
                    lane: self.operation.lane,
                    status: "retrying",
                });
                AttemptOutcome::RetryAfter(retry_delay(self.operation.attempts))
            }
            Err(error) => {
                self.engine.counters.failed.fetch_add(1, Ordering::Relaxed);
                self.engine.registry.transition_terminal(
                    &self.operation,
                    TerminalTransition {
                        status: OperationStatus::Failed,
                        error: Some(format!("{error:?}")),
                    },
                );
                self.engine.emit(QueueItemEvent {
                    id: &self.operation.id,
                    account_id: &self.operation.account_id,
                    lane: self.operation.lane,
                    status: "failed",
                });
                AttemptOutcome::Finished
            }
        }
    }
}

impl QueueEngine {
    pub fn new(rate_per_second: u32, burst: u32, executor: Executor) -> Arc<Self> {
        Self::with_config(
            QueueConfig {
                rate_per_second: rate_per_second,
                burst: burst,
                ..QueueConfig::default()
            },
            executor,
        )
    }

    pub fn with_config(config: QueueConfig, executor: Executor) -> Arc<Self> {
        Arc::new(Self {
            accounts: Mutex::new(HashMap::new()),
            entity_locks: Mutex::new(HashMap::new()),
            paused: AtomicBool::new(false),
            suspended: AtomicBool::new(false),
            resumed: Notify::new(),
            interactive_pending: Mutex::new(HashMap::new()),
            interactive_drained: Notify::new(),
            buckets: Mutex::new(HashMap::new()),
            rate_per_second: config.rate_per_second,
            burst: config.burst,
            counters: Counters::default(),
            executor: executor,
            events: config.events,
            registry: QueueRegistry::new(),
            cancellation_hook: config.cancellation_hook,
        })
    }

    pub fn no_op() -> Arc<Self> {
        Self::new(
            DEFAULT_RATE_PER_SECOND,
            DEFAULT_BURST,
            Arc::new(|_| Box::pin(async { Ok(()) })),
        )
    }

    pub async fn enqueue(self: &Arc<Self>, operation: QueueOperation) -> Result<(), &'static str> {
        let lane = operation.lane;
        let account_id = operation.account_id.clone();
        let id = operation.id.clone();
        self.registry.record_enqueued(&operation);
        let queue = self.account_queue(&operation.account_id).await;
        if lane == Lane::Interactive {
            *self
                .interactive_pending
                .lock()
                .await
                .entry(account_id.clone())
                .or_default() += 1;
        }
        self.counters.pending.fetch_add(1, Ordering::Relaxed);
        let sender = match lane {
            Lane::Interactive => queue.interactive,
            Lane::Background => queue.background,
            Lane::Traversal => queue.traversal,
            Lane::Embedding => queue.embedding,
        };
        if sender.send(operation).await.is_err() {
            if lane == Lane::Interactive {
                self.finish_interactive(&account_id).await;
            }
            self.counters.pending.fetch_sub(1, Ordering::Relaxed);
            self.registry.discard(&id);
            return Err("queue stopped");
        }
        self.emit(QueueItemEvent {
            id: &id,
            account_id: &account_id,
            lane: lane,
            status: "queued",
        });
        Ok(())
    }

    pub fn pause(&self) {
        if !self.paused.swap(true, Ordering::AcqRel) {
            tracing::info!(target: "queue", "queue paused by the user");
        }
    }

    pub fn resume(&self) {
        if self.paused.swap(false, Ordering::AcqRel) {
            tracing::info!(target: "queue", "queue resumed by the user");
        }
        self.resumed.notify_waiters();
    }

    pub fn suspended(&self) -> bool {
        self.suspended.load(Ordering::Acquire)
    }

    pub fn set_suspended(&self, suspended: bool) -> bool {
        let changed = self.suspended.swap(suspended, Ordering::AcqRel) != suspended;
        if changed {
            self.resumed.notify_waiters();
            self.interactive_drained.notify_waiters();
            self.emit_summary();
        }
        changed
    }

    pub fn executing_sends(&self) -> usize {
        self.registry
            .count(OperationKind::Send, OperationStatus::Active)
    }

    fn set_global_paused(&self, paused: bool) -> bool {
        let was_paused = self.paused.load(Ordering::Acquire);
        if paused {
            self.pause();
            return was_paused != paused;
        }
        self.resume();
        was_paused != paused
    }

    pub async fn set_paused(&self, scope: &PauseScope, paused: bool) -> bool {
        let changed = match scope {
            PauseScope::Global => self.set_global_paused(paused),
            PauseScope::Account { account_id } => {
                let changed = self.registry.set_account_paused(account_id, paused);
                if changed && !paused {
                    self.resumed.notify_waiters();
                }
                changed
            }
            PauseScope::Lane { account_id, lane } => {
                let changed = self.registry.set_lane_paused(
                    LaneTarget {
                        account_id: account_id,
                        lane: *lane,
                    },
                    paused,
                );
                if changed && !paused {
                    self.resumed.notify_waiters();
                }
                changed
            }
        };
        if changed {
            self.interactive_drained.notify_waiters();
            self.emit_summary();
        }
        changed
    }

    pub async fn cancel(self: &Arc<Self>, id: &str) -> Option<OperationRecord> {
        let cancelled = self.registry.try_cancel(id)?;
        self.counters.pending.fetch_sub(1, Ordering::Relaxed);
        if cancelled.lane == Lane::Interactive {
            self.finish_interactive(&cancelled.account_id).await;
        }
        (self.cancellation_hook)(&cancelled);
        self.emit(QueueItemEvent {
            id: id,
            account_id: &cancelled.account_id,
            lane: cancelled.lane,
            status: "cancelled",
        });
        Some(cancelled)
    }

    pub async fn cancel_durable(
        self: &Arc<Self>,
        storage: &Storage,
        operation_id: String,
    ) -> Result<bool, String> {
        let Some(cancelled) = self.cancel(&operation_id).await else {
            return Ok(false);
        };
        if !cancelled.kind.persists() {
            return Ok(true);
        }
        storage
            .run(move |connection| {
                OperationRepository::mark_terminal(
                    connection,
                    &operation_id,
                    crate::storage::TerminalOutcome {
                        status: "cancelled",
                        error: None,
                    },
                )
            })
            .await
            .map_err(|error| error.to_string())?;
        Ok(true)
    }

    pub async fn retry_durable(
        self: &Arc<Self>,
        storage: &Storage,
        operation_id: String,
    ) -> Result<bool, String> {
        let row = storage
            .run(move |connection| OperationRepository::get(connection, &operation_id))
            .await
            .map_err(|error| error.to_string())?;
        let Some(row) = row else {
            return Ok(false);
        };
        if row.status != "failed" {
            return Ok(false);
        }
        let Some(operation) = recovered_queue_operation(&row) else {
            return Ok(false);
        };
        self.enqueue(operation)
            .await
            .map_err(|error| error.to_owned())?;
        Ok(true)
    }

    pub async fn retry_all_failed(
        self: &Arc<Self>,
        storage: &Storage,
        account_id: Option<String>,
    ) -> Result<usize, String> {
        let rows = storage
            .run(move |connection| {
                OperationRepository::failed_durable(connection, account_id.as_deref())
            })
            .await
            .map_err(|error| error.to_string())?;
        let mut retried = 0usize;
        for row in rows {
            if let Some(operation) = recovered_queue_operation(&row) {
                if self.enqueue(operation).await.is_ok() {
                    retried += 1;
                }
            }
        }
        Ok(retried)
    }

    pub async fn cancel_account_operations(self: &Arc<Self>, account_id: &str) {
        let snapshot = self.snapshot().await;
        let Some(account) = snapshot
            .into_iter()
            .find(|account| account.account_id == account_id)
        else {
            return;
        };
        for lane in account.lanes {
            for operation in lane.operations {
                if matches!(
                    operation.status,
                    OperationStatus::Queued | OperationStatus::Retrying
                ) {
                    self.cancel(&operation.id).await;
                }
            }
        }
    }

    pub async fn cancel_account_lane_operations(self: &Arc<Self>, account_id: &str, lane: Lane) {
        let snapshot = self.snapshot().await;
        let Some(account) = snapshot
            .into_iter()
            .find(|account| account.account_id == account_id)
        else {
            return;
        };
        let Some(lane) = account
            .lanes
            .into_iter()
            .find(|candidate| candidate.lane == lane)
        else {
            return;
        };
        for operation in lane.operations {
            self.cancel(&operation.id).await;
        }
    }

    pub async fn wait_for_account_lane(self: &Arc<Self>, account_id: &str, lane: Lane) {
        loop {
            let active = self
                .snapshot()
                .await
                .into_iter()
                .find(|account| account.account_id == account_id)
                .and_then(|account| {
                    account
                        .lanes
                        .into_iter()
                        .find(|snapshot| snapshot.lane == lane)
                })
                .is_some_and(|snapshot| snapshot.active > 0 || snapshot.backlog > 0);
            if !active {
                return;
            }
            tokio::task::yield_now().await;
        }
    }

    pub fn clear_history(&self, account_id: Option<&str>) {
        self.registry.clear_history(account_id);
        self.emit_summary();
    }

    pub async fn snapshot(&self) -> Vec<AccountQueueSnapshot> {
        let interactive_outstanding: HashSet<String> = self
            .interactive_pending
            .lock()
            .await
            .iter()
            .filter(|(_, count)| **count > 0)
            .map(|(account_id, _)| account_id.clone())
            .collect();
        let global_paused = self.paused.load(Ordering::Acquire);
        self.registry
            .snapshot(global_paused, &interactive_outstanding)
    }

    fn emit(&self, event: QueueItemEvent<'_>) {
        (self.events)(
            crate::events::QUEUE_ITEM,
            serde_json::json!({
                "id": event.id,
                "status": event.status,
                "accountId": event.account_id,
                "lane": event.lane,
            }),
        );
        self.emit_summary();
    }

    fn emit_summary(&self) {
        (self.events)(
            crate::events::QUEUE_SUMMARY,
            serde_json::to_value(self.summary()).expect("QueueSummary serializes"),
        );
    }

    pub fn summary(&self) -> QueueSummary {
        QueueSummary {
            pending: self.counters.pending.load(Ordering::Relaxed),
            active: self.counters.active.load(Ordering::Relaxed),
            failed: self.counters.failed.load(Ordering::Relaxed),
            done: self.counters.done.load(Ordering::Relaxed),
            paused: self.paused.load(Ordering::Acquire),
            suspended: self.suspended(),
        }
    }

    async fn account_queue(self: &Arc<Self>, account_id: &str) -> AccountQueue {
        let mut accounts = self.accounts.lock().await;
        if !accounts.contains_key(account_id) {
            let (interactive, interactive_receiver) = mpsc::channel(LANE_CAPACITY);
            let (background, background_receiver) = mpsc::channel(LANE_CAPACITY);
            let (traversal, traversal_receiver) = mpsc::channel(LANE_CAPACITY);
            let (embedding, embedding_receiver) = mpsc::channel(LANE_CAPACITY);
            self.spawn_lane(interactive_receiver, Lane::Interactive);
            self.spawn_lane(background_receiver, Lane::Background);
            self.spawn_lane(traversal_receiver, Lane::Traversal);
            self.spawn_lane(embedding_receiver, Lane::Embedding);
            accounts.insert(
                account_id.to_owned(),
                AccountQueue {
                    interactive,
                    background,
                    traversal,
                    embedding,
                },
            );
        }
        let queue = accounts.get(account_id).expect("account queue inserted");
        AccountQueue {
            interactive: queue.interactive.clone(),
            background: queue.background.clone(),
            traversal: queue.traversal.clone(),
            embedding: queue.embedding.clone(),
        }
    }

    fn spawn_lane(self: &Arc<Self>, mut receiver: mpsc::Receiver<QueueOperation>, lane: Lane) {
        let engine = Arc::downgrade(self);
        tokio::spawn(async move {
            let permits = Arc::new(Semaphore::new(lane.capacity()));
            while let Some(operation) = receiver.recv().await {
                let Some(engine) = Weak::upgrade(&engine) else {
                    break;
                };
                engine.wait_until_resumed().await;
                let runner = OperationRunner {
                    engine: Arc::clone(&engine),
                    operation: operation,
                    permits: Arc::clone(&permits),
                };
                tokio::spawn(runner.run());
            }
        });
    }

    async fn entity_lock(&self, operation: &QueueOperation) -> Arc<Mutex<()>> {
        let mut locks = self.entity_locks.lock().await;
        Arc::clone(
            locks
                .entry((operation.account_id.clone(), operation.entity_key.clone()))
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    }

    pub async fn wait_until_resumed(&self) {
        loop {
            let notified = self.resumed.notified();
            if !self.paused.load(Ordering::Acquire) && !self.suspended() {
                return;
            }
            notified.await;
        }
    }

    async fn wait_until_resumed_for(&self, operation: &QueueOperation) {
        loop {
            let notified = self.resumed.notified();
            let paused = self.paused.load(Ordering::Acquire)
                || self.suspended()
                || self
                    .registry
                    .is_scope_paused(&operation.account_id, operation.lane);
            if !paused {
                return;
            }
            notified.await;
        }
    }

    async fn wait_for_interactive(&self, operation: &QueueOperation) {
        if matches!(
            operation.lane,
            Lane::Background | Lane::Traversal | Lane::Embedding
        ) {
            loop {
                let notified = self.interactive_drained.notified();
                if self
                    .registry
                    .is_scope_paused(&operation.account_id, Lane::Interactive)
                    || !self.has_interactive(&operation.account_id).await
                {
                    return;
                }
                notified.await;
            }
        }
    }

    async fn bucket_for(&self, account_id: &str) -> Arc<TokenBucket> {
        let mut buckets = self.buckets.lock().await;
        Arc::clone(
            buckets
                .entry(account_id.to_owned())
                .or_insert_with(|| Arc::new(TokenBucket::new(self.rate_per_second, self.burst))),
        )
    }

    async fn has_interactive(&self, account_id: &str) -> bool {
        self.interactive_pending
            .lock()
            .await
            .get(account_id)
            .copied()
            .unwrap_or(0)
            > 0
    }

    async fn finish_interactive(&self, account_id: &str) {
        let mut pending = self.interactive_pending.lock().await;
        if let Some(count) = pending.get_mut(account_id) {
            *count -= 1;
            if *count == 0 {
                pending.remove(account_id);
            }
        }
        self.interactive_drained.notify_waiters();
    }
}

pub fn retry_delay(attempt: u8) -> Duration {
    Duration::from_secs(
        (1_u64 << attempt.saturating_sub(1).min(MAX_RETRY_BACKOFF_EXPONENT))
            .min(MAX_RETRY_DELAY_SECONDS),
    )
}

pub fn recover_durable_operations(
    connection: &rusqlite::Connection,
) -> rusqlite::Result<RecoveredOperations> {
    let transaction = connection.unchecked_transaction()?;
    let uncertain_accounts = OperationRepository::mark_interrupted_sends_uncertain(&transaction)?;
    OperationRepository::requeue_interrupted_drafts(&transaction)?;
    let pending = OperationRepository::pending_durable(&transaction)?;
    transaction.commit()?;
    Ok(RecoveredOperations {
        pending: pending,
        uncertain_accounts: uncertain_accounts,
    })
}

pub async fn admit_durable(
    engine: &Arc<QueueEngine>,
    storage: &Storage,
    submission: DurableSubmission,
) -> Result<(), &'static str> {
    let DurableSubmission { operation, payload } = submission;
    debug_assert!(
        operation.kind.persists(),
        "admit_durable is only for Send/Draft operations"
    );
    let row = Operation {
        id: operation.id.clone(),
        account_id: operation.account_id.clone(),
        lane: match operation.lane {
            Lane::Interactive => "interactive".to_owned(),
            Lane::Background => "background".to_owned(),
            Lane::Traversal => "traversal".to_owned(),
            Lane::Embedding => "embedding".to_owned(),
        },
        kind: match operation.kind {
            OperationKind::Draft => "draft".to_owned(),
            OperationKind::Send => "send".to_owned(),
            _ => return Err("only Draft/Send operations are durable"),
        },
        entity_key: operation.entity_key.clone(),
        payload: payload,
        status: "queued".to_owned(),
        attempts: 0,
        next_attempt_at: None,
        error: None,
        created_at: chrono::Utc::now().timestamp(),
        updated_at: chrono::Utc::now().timestamp(),
    };
    storage
        .run(move |connection| OperationRepository::upsert(connection, &row))
        .await
        .map_err(|_| "failed to persist durable operation")?;
    engine.enqueue(operation).await
}

fn recovered_lane(lane: &str) -> Lane {
    if lane == "background" {
        return Lane::Background;
    }
    Lane::Interactive
}

pub fn recovered_queue_operation(operation: &Operation) -> Option<QueueOperation> {
    let kind = match operation.kind.as_str() {
        "draft" => OperationKind::Draft,
        "send" => OperationKind::Send,
        _ => return None,
    };
    let lane = recovered_lane(&operation.lane);
    let description = match kind {
        OperationKind::Send => "Resumed send".to_owned(),
        _ => "Resumed draft".to_owned(),
    };
    Some(QueueOperation {
        id: operation.id.clone(),
        account_id: operation.account_id.clone(),
        lane: lane,
        kind: kind,
        entity_key: operation.entity_key.clone(),
        cost: 0,
        attempts: operation.attempts.try_into().unwrap_or_default(),
        description: description,
    })
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UncertainSendEvent {
    pub account_id: String,
}

pub fn uncertain_send_event(account_id: impl Into<String>) -> UncertainSendEvent {
    UncertainSendEvent {
        account_id: account_id.into(),
    }
}
