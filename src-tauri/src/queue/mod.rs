use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use tokio::{
    sync::{mpsc, Mutex, Notify, Semaphore},
    time::Instant,
};

use crate::storage::{Operation, OperationRepository};

const LANE_CAPACITY: usize = 512;
const MAX_ATTEMPTS: u8 = 10;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Lane {
    Interactive,
    Background,

    Traversal,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
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
}

impl OperationKind {
    pub fn persists(self) -> bool {
        matches!(self, Self::Send | Self::Draft)
    }

    fn retries(self) -> bool {

        !matches!(self, Self::Send | Self::Sync | Self::Traversal)
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
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QueueError {
    Network,
    Http(u16),
    Permanent,
}

impl QueueError {
    fn retryable(self) -> bool {
        matches!(self, Self::Network | Self::Http(429 | 500..=599))
    }
}

pub type OperationFuture = Pin<Box<dyn Future<Output = Result<(), QueueError>> + Send>>;
pub type Executor = Arc<dyn Fn(QueueOperation) -> OperationFuture + Send + Sync>;
pub type QueueEventSink = Arc<dyn Fn(&'static str, serde_json::Value) + Send + Sync>;

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueSummary {
    pub pending: usize,
    pub active: usize,
    pub failed: usize,
    pub done: usize,
    pub paused: bool,
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
}

struct TokenBucket {
    tokens: Mutex<(f64, Instant)>,
    rate: f64,
    capacity: f64,
}
impl TokenBucket {
    fn new(rate: u32, capacity: u32) -> Self {
        Self {
            tokens: Mutex::new((capacity as f64, Instant::now())),
            rate: rate as f64,
            capacity: capacity as f64,
        }
    }
    async fn acquire(&self, cost: u32) {
        let cost = cost as f64;
        loop {
            let wait = {
                let mut state = self.tokens.lock().await;
                let now = Instant::now();
                state.0 = (state.0 + (now - state.1).as_secs_f64() * self.rate).min(self.capacity);
                state.1 = now;
                if state.0 >= cost {
                    state.0 -= cost;
                    None
                } else {
                    Some(Duration::from_secs_f64((cost - state.0) / self.rate))
                }
            };
            if let Some(wait) = wait {
                tokio::time::sleep(wait).await;
            } else {
                return;
            }
        }
    }
}


type EntityLocks = Mutex<HashMap<(String, String), Arc<Mutex<()>>>>;

pub struct QueueEngine {
    accounts: Mutex<HashMap<String, AccountQueue>>,
    entity_locks: EntityLocks,
    paused: AtomicBool,
    resumed: Notify,
    interactive_pending: Mutex<HashMap<String, usize>>,
    interactive_drained: Notify,
    buckets: Mutex<HashMap<String, Arc<TokenBucket>>>,
    rate_per_second: u32,
    burst: u32,
    counters: Counters,
    executor: Executor,
    events: QueueEventSink,
}

impl QueueEngine {
    pub fn new(rate_per_second: u32, burst: u32, executor: Executor) -> Arc<Self> {
        Self::new_with_events(rate_per_second, burst, executor, Arc::new(|_, _| {}))
    }

    pub fn new_with_events(
        rate_per_second: u32,
        burst: u32,
        executor: Executor,
        events: QueueEventSink,
    ) -> Arc<Self> {
        Arc::new(Self {
            accounts: Mutex::new(HashMap::new()),
            entity_locks: Mutex::new(HashMap::new()),
            paused: AtomicBool::new(false),
            resumed: Notify::new(),
            interactive_pending: Mutex::new(HashMap::new()),
            interactive_drained: Notify::new(),
            buckets: Mutex::new(HashMap::new()),
            rate_per_second,
            burst,
            counters: Counters::default(),
            executor,
            events,
        })
    }

    pub fn no_op() -> Arc<Self> {
        Self::new(250, 250, Arc::new(|_| Box::pin(async { Ok(()) })))
    }

    pub async fn enqueue(self: &Arc<Self>, operation: QueueOperation) -> Result<(), &'static str> {
        let lane = operation.lane;
        let account_id = operation.account_id.clone();
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
        };
        let id = operation.id.clone();
        if sender.send(operation).await.is_err() {
            if lane == Lane::Interactive {
                self.finish_interactive(&account_id).await;
            }
            return Err("queue stopped");
        }
        self.emit(&id, "queued");
        Ok(())
    }

    pub fn pause(&self) {
        self.paused.store(true, Ordering::Release);
    }
    pub fn resume(&self) {
        self.paused.store(false, Ordering::Release);
        self.resumed.notify_waiters();
    }

    fn emit(&self, id: &str, status: &'static str) {
        (self.events)(
            "queue://item",
            serde_json::json!({ "id": id, "status": status }),
        );
        (self.events)(
            "queue://summary",
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
        }
    }

    async fn account_queue(self: &Arc<Self>, account_id: &str) -> AccountQueue {
        let mut accounts = self.accounts.lock().await;
        if !accounts.contains_key(account_id) {
            let (interactive, interactive_rx) = mpsc::channel(LANE_CAPACITY);
            let (background, background_rx) = mpsc::channel(LANE_CAPACITY);
            let (traversal, traversal_rx) = mpsc::channel(LANE_CAPACITY);
            self.spawn_lane(interactive_rx, 4);
            self.spawn_lane(background_rx, 2);

            self.spawn_lane(traversal_rx, 1);
            accounts.insert(
                account_id.to_owned(),
                AccountQueue {
                    interactive,
                    background,
                    traversal,
                },
            );
        }
        let queue = accounts.get(account_id).expect("account queue inserted");
        AccountQueue {
            interactive: queue.interactive.clone(),
            background: queue.background.clone(),
            traversal: queue.traversal.clone(),
        }
    }

    fn spawn_lane(self: &Arc<Self>, mut receiver: mpsc::Receiver<QueueOperation>, limit: usize) {
        let engine = Arc::clone(self);
        tokio::spawn(async move {
            let permits = Arc::new(Semaphore::new(limit));
            while let Some(operation) = receiver.recv().await {
                engine.wait_until_resumed().await;
                let engine = Arc::clone(&engine);
                let permits = Arc::clone(&permits);
                tokio::spawn(async move {
                    engine.run(operation, permits).await;
                });
            }
        });
    }

    async fn run(self: Arc<Self>, mut operation: QueueOperation, permits: Arc<Semaphore>) {
        let lock = {
            let mut locks = self.entity_locks.lock().await;
            Arc::clone(
                locks
                    .entry((operation.account_id.clone(), operation.entity_key.clone()))
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        let _entity = lock.lock().await;
        let _permit = permits.acquire().await.expect("semaphore remains open");
        loop {
            self.wait_until_resumed().await;
            self.wait_for_interactive(&operation).await;
            self.bucket_for(&operation.account_id)
                .await
                .acquire(operation.cost)
                .await;
            self.counters.pending.fetch_sub(1, Ordering::Relaxed);
            self.counters.active.fetch_add(1, Ordering::Relaxed);
            self.emit(&operation.id, "active");
            if operation.lane == Lane::Interactive {
                self.finish_interactive(&operation.account_id).await;
                self.interactive_drained.notify_waiters();
            }
            let result = (self.executor)(operation.clone()).await;
            self.counters.active.fetch_sub(1, Ordering::Relaxed);
            match result {
                Ok(()) => {
                    self.counters.done.fetch_add(1, Ordering::Relaxed);
                    self.emit(&operation.id, "done");
                    return;
                }
                Err(error)
                    if operation.kind.retries()
                        && error.retryable()
                        && operation.attempts + 1 < MAX_ATTEMPTS =>
                {
                    operation.attempts += 1;
                    self.counters.pending.fetch_add(1, Ordering::Relaxed);
                    self.emit(&operation.id, "retrying");
                    tokio::time::sleep(retry_delay(operation.attempts)).await;
                }
                Err(_) => {
                    self.counters.failed.fetch_add(1, Ordering::Relaxed);
                    self.emit(&operation.id, "failed");
                    return;
                }
            }
        }
    }


    pub async fn wait_until_resumed(&self) {
        loop {

            let notified = self.resumed.notified();
            if !self.paused.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }

    async fn wait_for_interactive(&self, operation: &QueueOperation) {
        if matches!(operation.lane, Lane::Background | Lane::Traversal) {
            loop {

                let notified = self.interactive_drained.notified();
                if !self.has_interactive(&operation.account_id).await {
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
    Duration::from_secs((1_u64 << attempt.saturating_sub(1).min(6)).min(60))
}


pub fn recover_durable_operations(
    connection: &rusqlite::Connection,
) -> rusqlite::Result<(Vec<Operation>, Vec<String>)> {
    let transaction = connection.unchecked_transaction()?;
    let uncertain_accounts = OperationRepository::mark_interrupted_sends_uncertain(&transaction)?;
    OperationRepository::requeue_interrupted_drafts(&transaction)?;
    let recovered = OperationRepository::pending_durable(&transaction)?;
    transaction.commit()?;
    Ok((recovered, uncertain_accounts))
}


pub async fn admit_durable(
    engine: &Arc<QueueEngine>,
    storage: &crate::storage::Storage,
    operation: QueueOperation,
    payload: String,
) -> Result<(), &'static str> {
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
        },
        kind: match operation.kind {
            OperationKind::Draft => "draft".to_owned(),
            OperationKind::Send => "send".to_owned(),
            _ => return Err("only Draft/Send operations are durable"),
        },
        entity_key: operation.entity_key.clone(),
        payload,
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


pub fn recovered_queue_operation(operation: &Operation) -> Option<QueueOperation> {
    let kind = match operation.kind.as_str() {
        "draft" => OperationKind::Draft,
        "send" => OperationKind::Send,
        _ => return None,
    };
    let lane = if operation.lane == "background" {
        Lane::Background
    } else {
        Lane::Interactive
    };
    Some(QueueOperation {
        id: operation.id.clone(),
        account_id: operation.account_id.clone(),
        lane,
        kind,
        entity_key: operation.entity_key.clone(),
        cost: 0,
        attempts: operation.attempts.try_into().unwrap_or_default(),
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
