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
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperationKind {
    Noop,
    LabelMutation,
    Send,
    Draft,
    /// A sync engine run (initial, incremental poll or full re-sync). The
    /// Gmail client already retries transient failures (429/5xx/network)
    /// internally with its own backoff, so a sync run is retried by the
    /// scheduler's next poll tick rather than by the queue.
    Sync,
    Star,
    Unstar,
    MarkRead,
    MarkUnread,
}

impl OperationKind {
    pub fn persists(self) -> bool {
        matches!(self, Self::Send | Self::Draft)
    }

    fn retries(self) -> bool {
        !matches!(self, Self::Send | Self::Sync)
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
}

/// A small token bucket; callers supply Gmail's endpoint cost rather than the queue knowing it.
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
            match wait {
                Some(wait) => tokio::time::sleep(wait).await,
                None => return,
            }
        }
    }
}

/// Per-(account, entity) mutex ensuring same-entity operations serialize.
type EntityLocks = Mutex<HashMap<(String, String), Arc<Mutex<()>>>>;

pub struct QueueEngine {
    accounts: Mutex<HashMap<String, AccountQueue>>,
    entity_locks: EntityLocks,
    paused: AtomicBool,
    resumed: Notify,
    counters: Counters,
    bucket: TokenBucket,
    executor: Executor,
}

impl QueueEngine {
    pub fn new(rate_per_second: u32, burst: u32, executor: Executor) -> Arc<Self> {
        Arc::new(Self {
            accounts: Mutex::new(HashMap::new()),
            entity_locks: Mutex::new(HashMap::new()),
            paused: AtomicBool::new(false),
            resumed: Notify::new(),
            counters: Counters::default(),
            bucket: TokenBucket::new(rate_per_second, burst),
            executor,
        })
    }

    pub fn no_op() -> Arc<Self> {
        Self::new(250, 250, Arc::new(|_| Box::pin(async { Ok(()) })))
    }

    pub async fn enqueue(self: &Arc<Self>, operation: QueueOperation) -> Result<(), &'static str> {
        let lane = operation.lane;
        let queue = self.account_queue(&operation.account_id).await;
        self.counters.pending.fetch_add(1, Ordering::Relaxed);
        let sender = match lane {
            Lane::Interactive => queue.interactive,
            Lane::Background => queue.background,
        };
        sender.send(operation).await.map_err(|_| "queue stopped")
    }

    pub fn pause(&self) {
        self.paused.store(true, Ordering::Release);
    }
    pub fn resume(&self) {
        self.paused.store(false, Ordering::Release);
        self.resumed.notify_waiters();
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
            self.spawn_lane(interactive_rx, 4);
            self.spawn_lane(background_rx, 2);
            accounts.insert(
                account_id.to_owned(),
                AccountQueue {
                    interactive,
                    background,
                },
            );
        }
        let queue = accounts.get(account_id).expect("account queue inserted");
        AccountQueue {
            interactive: queue.interactive.clone(),
            background: queue.background.clone(),
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
        let _entity = lock.lock().await; // lock first: same-entity bursts never consume all permits.
        let _permit = permits.acquire().await.expect("semaphore remains open");
        loop {
            self.wait_until_resumed().await;
            self.bucket.acquire(operation.cost).await;
            self.counters.pending.fetch_sub(1, Ordering::Relaxed);
            self.counters.active.fetch_add(1, Ordering::Relaxed);
            let result = (self.executor)(operation.clone()).await;
            self.counters.active.fetch_sub(1, Ordering::Relaxed);
            match result {
                Ok(()) => {
                    self.counters.done.fetch_add(1, Ordering::Relaxed);
                    return;
                }
                Err(error)
                    if operation.kind.retries()
                        && error.retryable()
                        && operation.attempts + 1 < MAX_ATTEMPTS =>
                {
                    operation.attempts += 1;
                    self.counters.pending.fetch_add(1, Ordering::Relaxed);
                    tokio::time::sleep(retry_delay(operation.attempts)).await;
                }
                Err(_) => {
                    self.counters.failed.fetch_add(1, Ordering::Relaxed);
                    return;
                }
            }
        }
    }

    async fn wait_until_resumed(&self) {
        while self.paused.load(Ordering::Acquire) {
            self.resumed.notified().await;
        }
    }
}

pub fn retry_delay(attempt: u8) -> Duration {
    Duration::from_secs(1_u64 << attempt.saturating_sub(1).min(5))
}

/// Startup recovery reads the durable subset once; the queue never polls SQLite for work.
pub fn recover_durable_operations(
    connection: &rusqlite::Connection,
) -> rusqlite::Result<Vec<Operation>> {
    OperationRepository::mark_interrupted_sends_uncertain(connection)?;
    OperationRepository::pending_durable(connection)
}
