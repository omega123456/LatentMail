use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;

use crate::queue::{Lane, OperationKind, QueueOperation};

const HISTORY_CAP: usize = 200;

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationStatus {
    Queued,
    Active,
    Retrying,
    Done,
    Failed,
    Cancelled,
}

impl OperationStatus {
    fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LaneState {
    Paused,
    Blocked,
    Running,
    Idle,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRecord {
    pub id: String,
    pub account_id: String,
    pub lane: Lane,
    pub kind: OperationKind,
    pub description: String,
    pub status: OperationStatus,
    pub attempts: u8,
    pub error: Option<String>,
    pub retryable: bool,
    pub next_attempt_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneSnapshot {
    pub lane: Lane,
    pub capacity: usize,
    pub active: usize,
    pub backlog: usize,
    pub state: LaneState,
    pub operations: Vec<OperationRecord>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountQueueSnapshot {
    pub account_id: String,
    pub active: usize,
    pub queued: usize,
    pub failed: usize,
    pub lanes: Vec<LaneSnapshot>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "scope", rename_all = "camelCase")]
pub enum PauseScope {
    Global,
    Account {
        #[serde(rename = "accountId")]
        account_id: String,
    },
    Lane {
        #[serde(rename = "accountId")]
        account_id: String,
        lane: Lane,
    },
}

#[derive(Default)]
struct Inner {
    operations: HashMap<String, OperationRecord>,
    history: HashMap<String, VecDeque<OperationRecord>>,
    account_paused: HashSet<String>,
    lane_paused: HashSet<(String, Lane)>,
}

impl Inner {
    fn push_history(&mut self, record: OperationRecord) {
        let queue = self.history.entry(record.account_id.clone()).or_default();
        queue.push_back(record);
        while queue.len() > HISTORY_CAP {
            queue.pop_front();
        }
    }

    fn is_scope_paused(&self, account_id: &str, lane: Lane) -> bool {
        self.account_paused.contains(account_id)
            || self.lane_paused.contains(&(account_id.to_owned(), lane))
    }
}

#[derive(Default)]
pub struct QueueRegistry {
    inner: Mutex<Inner>,
}

impl QueueRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().expect("queue registry lock poisoned")
    }

    pub fn record_enqueued(&self, operation: &QueueOperation) {
        let now = chrono::Utc::now().timestamp();
        let record = OperationRecord {
            id: operation.id.clone(),
            account_id: operation.account_id.clone(),
            lane: operation.lane,
            kind: operation.kind,
            description: operation.description.clone(),
            status: OperationStatus::Queued,
            attempts: operation.attempts,
            error: None,
            retryable: false,
            next_attempt_at: None,
            created_at: now,
            updated_at: now,
        };
        let mut inner = self.lock();
        if let Some(history) = inner.history.get_mut(&operation.account_id) {
            history.retain(|existing| existing.id != operation.id);
        }
        inner.operations.insert(operation.id.clone(), record);
    }

    pub fn discard(&self, id: &str) {
        self.lock().operations.remove(id);
    }

    pub fn try_mark_active(&self, id: &str, attempts: u8) -> bool {
        let mut inner = self.lock();
        let Some(record) = inner.operations.get_mut(id) else {
            return false;
        };
        if record.status == OperationStatus::Cancelled {
            return false;
        }
        record.status = OperationStatus::Active;
        record.attempts = attempts;
        record.next_attempt_at = None;
        record.updated_at = chrono::Utc::now().timestamp();
        true
    }

    pub fn transition_retrying(&self, operation: &QueueOperation) {
        let mut inner = self.lock();
        let Some(record) = inner.operations.get_mut(&operation.id) else {
            return;
        };
        let now = chrono::Utc::now();
        let delay =
            chrono::Duration::from_std(super::retry_delay(operation.attempts)).unwrap_or_default();
        record.status = OperationStatus::Retrying;
        record.attempts = operation.attempts;
        record.next_attempt_at = Some((now + delay).timestamp());
        record.updated_at = now.timestamp();
    }

    pub fn transition_terminal(
        &self,
        operation: &QueueOperation,
        status: OperationStatus,
        error: Option<String>,
    ) {
        let mut inner = self.lock();
        let Some(mut record) = inner.operations.remove(&operation.id) else {
            return;
        };
        let now = chrono::Utc::now().timestamp();
        record.status = status;
        record.attempts = operation.attempts;
        record.error = error;
        record.retryable = status == OperationStatus::Failed && operation.kind.persists();
        record.next_attempt_at = None;
        record.updated_at = now;
        inner.push_history(record);
    }

    pub fn try_cancel(&self, id: &str) -> Option<OperationRecord> {
        let mut inner = self.lock();
        let record = inner.operations.get(id)?;
        if record.status.is_terminal() || record.status == OperationStatus::Active {
            return None;
        }
        let mut record = inner.operations.remove(id)?;
        record.status = OperationStatus::Cancelled;
        record.retryable = false;
        record.next_attempt_at = None;
        record.updated_at = chrono::Utc::now().timestamp();
        inner.push_history(record.clone());
        Some(record)
    }

    pub fn is_scope_paused(&self, account_id: &str, lane: Lane) -> bool {
        self.lock().is_scope_paused(account_id, lane)
    }

    pub fn set_account_paused(&self, account_id: &str, paused: bool) -> bool {
        let mut inner = self.lock();
        if paused {
            inner.account_paused.insert(account_id.to_owned())
        } else {
            inner.account_paused.remove(account_id)
        }
    }

    pub fn set_lane_paused(&self, account_id: &str, lane: Lane, paused: bool) -> bool {
        let mut inner = self.lock();
        let key = (account_id.to_owned(), lane);
        if paused {
            inner.lane_paused.insert(key)
        } else {
            inner.lane_paused.remove(&key)
        }
    }

    pub fn clear_history(&self, account_id: Option<&str>) {
        let mut inner = self.lock();
        match account_id {
            Some(account_id) => {
                inner.history.remove(account_id);
            }
            None => {
                inner.history.clear();
            }
        }
    }

    pub fn snapshot(
        &self,
        global_paused: bool,
        interactive_outstanding: &HashSet<String>,
    ) -> Vec<AccountQueueSnapshot> {
        let inner = self.lock();
        let mut accounts: HashSet<String> = inner
            .operations
            .values()
            .map(|record| record.account_id.clone())
            .collect();
        accounts.extend(inner.history.keys().cloned());
        accounts.extend(inner.account_paused.iter().cloned());
        accounts.extend(inner.lane_paused.iter().map(|(account, _)| account.clone()));

        let mut snapshots: Vec<AccountQueueSnapshot> = accounts
            .into_iter()
            .map(|account_id| {
                let empty_history = VecDeque::new();
                let history = inner.history.get(&account_id).unwrap_or(&empty_history);
                let interactive_paused =
                    global_paused || inner.is_scope_paused(&account_id, Lane::Interactive);
                let blocked_by_interactive =
                    !interactive_paused && interactive_outstanding.contains(&account_id);

                let lanes: Vec<LaneSnapshot> = Lane::ALL
                    .into_iter()
                    .map(|lane| {
                        let mut operations: Vec<OperationRecord> = inner
                            .operations
                            .values()
                            .filter(|record| record.account_id == account_id && record.lane == lane)
                            .cloned()
                            .collect();
                        operations
                            .extend(history.iter().filter(|record| record.lane == lane).cloned());

                        let active = operations
                            .iter()
                            .filter(|record| record.status == OperationStatus::Active)
                            .count();
                        let backlog = operations
                            .iter()
                            .filter(|record| {
                                matches!(
                                    record.status,
                                    OperationStatus::Queued | OperationStatus::Retrying
                                )
                            })
                            .count();

                        let paused = global_paused || inner.is_scope_paused(&account_id, lane);
                        let blocked =
                            !paused && lane != Lane::Interactive && blocked_by_interactive;
                        let running = !paused && !blocked && active > 0;
                        let state = if paused {
                            LaneState::Paused
                        } else if blocked {
                            LaneState::Blocked
                        } else if running {
                            LaneState::Running
                        } else {
                            LaneState::Idle
                        };

                        LaneSnapshot {
                            lane,
                            capacity: lane.capacity(),
                            active,
                            backlog,
                            state,
                            operations,
                        }
                    })
                    .collect();

                let active = lanes.iter().map(|lane| lane.active).sum();
                let queued = lanes.iter().map(|lane| lane.backlog).sum();
                let failed = lanes
                    .iter()
                    .flat_map(|lane| &lane.operations)
                    .filter(|record| record.status == OperationStatus::Failed)
                    .count();

                AccountQueueSnapshot {
                    account_id,
                    active,
                    queued,
                    failed,
                    lanes,
                }
            })
            .collect();
        snapshots.sort_by(|a, b| a.account_id.cmp(&b.account_id));
        snapshots
    }
}
