use std::{collections::HashMap, sync::Arc, time::Duration};

use tokio::{sync::Mutex, time::Instant};

pub const ACCOUNT_RATE_PER_SECOND: f64 = 100.0;

pub const TRAVERSAL_SHARE: f64 = 0.4;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QuotaClass {
    Standard,
    Traversal,
}

pub(super) struct BucketState {
    pub(super) tokens: f64,
    pub(super) refreshed_at: Instant,
}

pub(super) struct Bucket {
    pub(super) state: Mutex<BucketState>,
    pub(super) rate: f64,
    pub(super) capacity: f64,
}

impl Bucket {
    pub(super) fn new(rate: f64, capacity: f64) -> Self {
        Self {
            state: Mutex::new(BucketState {
                tokens: capacity,
                refreshed_at: Instant::now(),
            }),
            rate: rate,
            capacity: capacity,
        }
    }
    pub(super) async fn acquire(&self, cost: u32) {
        let cost = f64::from(cost);
        while let Some(wait) = self.try_take_or_wait(cost).await {
            tokio::time::sleep(wait).await;
        }
    }

    async fn try_take_or_wait(&self, cost: f64) -> Option<Duration> {
        let mut state = self.state.lock().await;
        let now = Instant::now();
        state.tokens = (state.tokens + (now - state.refreshed_at).as_secs_f64() * self.rate)
            .min(self.capacity);
        state.refreshed_at = now;
        if state.tokens >= cost {
            state.tokens -= cost;
            return None;
        }
        Some(Duration::from_secs_f64((cost - state.tokens) / self.rate))
    }
}

pub(super) struct AccountBuckets {
    pub(super) shared: Bucket,
    pub(super) traversal: Bucket,
}

impl AccountBuckets {
    pub(super) fn new() -> Self {
        Self::with_limits(ACCOUNT_RATE_PER_SECOND, ACCOUNT_RATE_PER_SECOND)
    }

    fn with_limits(rate: f64, capacity: f64) -> Self {
        Self {
            shared: Bucket::new(rate, capacity),
            traversal: Bucket::new(rate * TRAVERSAL_SHARE, capacity * TRAVERSAL_SHARE),
        }
    }
}

pub struct GmailRateLimiters {
    pub(super) accounts: Mutex<HashMap<String, Arc<AccountBuckets>>>,
    pub(super) rate: f64,
    pub(super) capacity: f64,
}

impl Default for GmailRateLimiters {
    fn default() -> Self {
        Self {
            accounts: Mutex::new(HashMap::new()),
            rate: ACCOUNT_RATE_PER_SECOND,
            capacity: ACCOUNT_RATE_PER_SECOND,
        }
    }
}

impl GmailRateLimiters {
    #[cfg(feature = "test-utils")]
    pub fn unmetered() -> Self {
        Self {
            accounts: Mutex::new(HashMap::new()),
            rate: f64::MAX,
            capacity: f64::MAX,
        }
    }

    pub(super) async fn for_account(&self, account_id: &str) -> Arc<AccountBuckets> {
        let mut accounts = self.accounts.lock().await;
        Arc::clone(
            accounts
                .entry(account_id.to_owned())
                .or_insert_with(|| Arc::new(AccountBuckets::with_limits(self.rate, self.capacity))),
        )
    }
}
