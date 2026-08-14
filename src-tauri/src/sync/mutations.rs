//! The generalized triage mutation path (D5/D6): every label-mutating
//! action — star/unstar, mark read/unread, and future move/spam/label
//! changes — funnels through [`SyncEngine::mutate`] as an owned add/remove
//! label set over a thread.
//!
//! **Stage one** accumulates a per-account, per-entity (thread) pending
//! delta — [`LabelDelta`] — merging each new request with last-write-wins
//! per entity-and-label. The first request for an otherwise-empty account
//! becomes the window's leader and, after a short coalescing sleep, drains
//! every entity accumulated during that window.
//!
//! **Stage two** resolves each request against its entity's *final* delta:
//! a request none of whose labels survived into the final delta was
//! overwritten by a later request before ever reaching Gmail, and is told
//! so explicitly — [`MutationOutcome::Superseded`] — rather than left to
//! see a dropped reply channel. Surviving entities are then grouped by
//! identical delta and dispatched as one `batchModify` call per group,
//! chunked at Gmail's 1,000-identifier limit, through the queue's
//! interactive lane.

use std::{
    collections::{HashMap, HashSet},
    sync::atomic::Ordering,
    time::Duration,
};

macro_rules! string_try {
    ($result:expr) => {
        match $result {
            Ok(value) => value,
            Err(error) => return Err(error.to_string()),
        }
    };
}

use tokio::sync::oneshot;

use crate::{
    gmail::GmailClient,
    queue::{Lane, QueueError, QueueOperation},
    storage::{Message, MessageRepository, Storage, ThreadRepository},
};

use super::{SyncEngine, SyncError};

// ---------------------------------------------------------------------
// Draft deletion — the one documented exception to the coalescing
// mutation path above (Gmail rejects label modification on drafts, so a
// draft can only be deleted, never re-labelled). Lives here per the plan's
// architecture note that `sync::mutations` "also owns the narrow
// draft-deletion path" — `sync::commands::delete_draft` is a thin IPC
// wrapper around [`delete_draft`] below.
// ---------------------------------------------------------------------

/// Deletes a draft message: resolves its *real* Gmail draft id (never the
/// message id — see the module doc on [`crate::gmail::GmailClient::list_draft_ids`]
/// for why those are different identifiers), calls Gmail's dedicated drafts
/// endpoint with it, then removes the local row and recomputes its thread.
///
/// The draft id is cached on the message row (migration
/// `V5__message_draft_id`) the first time it's resolved, so a repeat
/// deletion attempt (e.g. a retried mutation) never re-pages the whole
/// drafts list. `ponytail`: resolution only happens lazily, at delete time
/// — a draft's id is not proactively fetched and persisted during
/// initial/incremental/traversal sync. Upgrade path: populate `draft_id`
/// eagerly wherever a message carrying `DRAFT` is written, if the lazy
/// resolve-on-delete round trip ever proves too slow in practice.
pub(super) async fn delete_draft(
    storage: &Storage,
    client: &GmailClient,
    account_id: &str,
    message_id: &str,
) -> Result<(), String> {
    let draft_id = resolve_draft_id(storage, client, account_id, message_id).await?;
    string_try!(client.delete_draft(&draft_id).await);
    let account = account_id.to_owned();
    let id = message_id.to_owned();
    string_try!(
        storage
            .run(move |connection| {
                let transaction = connection.unchecked_transaction()?;
                if let Some(thread_id) = MessageRepository::delete(&transaction, &account, &id)? {
                    ThreadRepository::recompute(&transaction, &account, &thread_id)?;
                }
                transaction.commit()
            })
            .await
    );
    Ok(())
}

/// Returns `message_id`'s already-persisted Gmail draft id, or resolves it
/// via [`GmailClient::list_draft_ids`] and caches the result for next time.
/// Errors rather than falling back to the message id if Gmail reports no
/// draft for this message — sending the wrong id would 404 against real
/// Gmail (the bug this whole path exists to fix).
async fn resolve_draft_id(
    storage: &Storage,
    client: &GmailClient,
    account_id: &str,
    message_id: &str,
) -> Result<String, String> {
    let account = account_id.to_owned();
    let id = message_id.to_owned();
    let cached = string_try!(
        storage
            .run(move |connection| MessageRepository::draft_id(connection, &account, &id))
            .await
    );
    if let Some(draft_id) = cached {
        return Ok(draft_id);
    }
    let mapping = string_try!(client.list_draft_ids().await);
    let draft_id = mapping
        .get(message_id)
        .cloned()
        .ok_or_else(|| format!("Gmail has no draft for message {message_id}"))?;
    let account = account_id.to_owned();
    let id = message_id.to_owned();
    let resolved = draft_id.clone();
    string_try!(
        storage
            .run(move |connection| MessageRepository::set_draft_id(
                connection, &account, &id, &resolved
            ))
            .await
    );
    Ok(draft_id)
}

/// Every message id in the requested threads currently carrying the `DRAFT` label —
/// `sync::commands::mutate_threads`'s own check for whether a thread-level
/// triage action is actually a draft deletion in disguise.
pub(super) async fn draft_message_ids(
    storage: &Storage,
    account_id: &str,
    thread_ids: &[String],
) -> Result<HashMap<String, Vec<String>>, String> {
    let account = account_id.to_owned();
    let threads = thread_ids.to_vec();
    let ids = string_try!(
        storage
            .run(move |connection| {
                MessageRepository::draft_message_ids_by_thread(connection, &account, &threads)
            })
            .await
    );
    Ok(ids)
}

/// The coalescing window: how long the leader waits for concurrently
/// dispatched mutations to join before flushing. Kept tiny — it only needs
/// to catch requests dispatched essentially simultaneously (a bulk action,
/// or a rapid double-click) — and driven by Tokio's mock clock in tests.
const COALESCE_WINDOW: Duration = Duration::from_millis(1);

/// Gmail's `batchModify` accepts at most this many identifiers per request
/// (D5). A group whose combined message count exceeds this is split into
/// multiple calls carrying the same add/remove sets.
pub const BATCH_MODIFY_CHUNK_SIZE: usize = 1_000;

/// The outcome of a single mutation request once its entity's window has
/// closed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MutationOutcome {
    /// The request's direction survived into the flushed delta and was
    /// sent to Gmail (and, on success, written back to storage).
    Applied,
    /// A later request in the same coalescing window overwrote every label
    /// this request touched, so it never reached Gmail. Not an error — the
    /// caller's intent was correctly superseded by a subsequent action on
    /// the same thread.
    Superseded,
}

/// A per-account, per-thread pending delta map: `entity -> {additions,
/// removals}` (D5). `pub(super)` so `SyncEngine` can name the field type;
/// internals stay private to this module.
pub(super) type PendingMutations = HashMap<String, HashMap<String, EntityAccumulator>>;

/// The additions/removals a thread's messages should end up with, folded
/// from every request that has touched this entity in the current window
/// with last-write-wins per label.
#[derive(Clone, Debug, Default)]
struct LabelDelta {
    additions: HashSet<String>,
    removals: HashSet<String>,
}

impl LabelDelta {
    /// Folds a new request's add/remove sets in, per label overwriting
    /// whichever direction that label previously held — the mechanism that
    /// makes star-then-unstar on one thread converge to unstarred rather
    /// than racing.
    fn merge(&mut self, add: &HashSet<String>, remove: &HashSet<String>) {
        for label in add {
            self.removals.remove(label);
            self.additions.insert(label.clone());
        }
        for label in remove {
            self.additions.remove(label);
            self.removals.insert(label.clone());
        }
    }

    /// A canonical, hashable form of this delta so entities carrying an
    /// identical delta can be grouped into a single `batchModify` call.
    fn signature(&self) -> (Vec<String>, Vec<String>) {
        let mut additions: Vec<String> = self.additions.iter().cloned().collect();
        additions.sort_unstable();
        let mut removals: Vec<String> = self.removals.iter().cloned().collect();
        removals.sort_unstable();
        (additions, removals)
    }
}

struct PendingRequest {
    add: HashSet<String>,
    remove: HashSet<String>,
    reply: oneshot::Sender<Result<MutationOutcome, SyncError>>,
}

impl PendingRequest {
    /// Whether this request's own direction for at least one of its labels
    /// still matches the entity's final, flushed delta. A request touching
    /// only labels whose direction was later overwritten never had any
    /// surviving contribution and is superseded, not applied.
    fn survives(&self, delta: &LabelDelta) -> bool {
        self.add.iter().any(|label| delta.additions.contains(label))
            || self
                .remove
                .iter()
                .any(|label| delta.removals.contains(label))
    }
}

/// Per-thread accumulator: the folded delta and every request still waiting
/// to hear an outcome. Deliberately does *not* resolve which messages the
/// thread comprises — doing that here, before the entity is even inserted
/// into the pending map, would race a concurrently dispatched request for
/// the same window against real OS-thread scheduling (`Storage::run` is a
/// `spawn_blocking` call) and make coalescing order non-deterministic.
/// Messages are resolved once per entity instead, at flush time.
#[derive(Default)]
pub(super) struct EntityAccumulator {
    target: Option<MutationTarget>,
    delta: LabelDelta,
    requests: Vec<PendingRequest>,
}

#[derive(Clone)]
enum MutationTarget {
    Thread(String),
    Message(String),
}

impl SyncEngine {
    /// Applies a label delta to exactly one message. Message-level delete,
    /// move, spam and user-label controls must not widen to sibling messages
    /// in the conversation; star/read deliberately use [`Self::mutate`].
    pub async fn mutate_message(
        &self,
        account_id: &str,
        client: GmailClient,
        message_id: String,
        add: HashSet<String>,
        remove: HashSet<String>,
    ) -> Result<(), SyncError> {
        self.submit(
            account_id,
            client,
            MutationTarget::Message(message_id),
            add,
            remove,
        )
        .await
        .map(|_| ())
    }

    /// Submits a label mutation — an owned set of labels to add and a set
    /// to remove — over every message in `thread_id`. Coalesces with any
    /// other mutation for the same account arriving within
    /// [`COALESCE_WINDOW`], then dispatches through the queue's
    /// interactive lane. See the module documentation for the two-stage
    /// mechanism.
    pub async fn mutate(
        &self,
        account_id: &str,
        client: GmailClient,
        thread_id: String,
        add: HashSet<String>,
        remove: HashSet<String>,
    ) -> Result<MutationOutcome, SyncError> {
        self.submit(
            account_id,
            client,
            MutationTarget::Thread(thread_id),
            add,
            remove,
        )
        .await
    }

    async fn submit(
        &self,
        account_id: &str,
        client: GmailClient,
        target: MutationTarget,
        add: HashSet<String>,
        remove: HashSet<String>,
    ) -> Result<MutationOutcome, SyncError> {
        // Derivation lives in `sync/mod.rs` — it's sync's own star/read
        // vocabulary, not something this generic delta machinery needs to
        // know (see that module's queue-wiring documentation).
        let kind = super::derive_operation_kind(&add, &remove);
        let (reply_tx, reply_rx) = oneshot::channel();
        let is_leader = {
            let mut pending = self.pending.lock().await;
            let account_map = pending.entry(account_id.to_owned()).or_default();
            let is_leader = account_map.is_empty();
            let key = match &target {
                MutationTarget::Thread(id) => format!("thread:{id}"),
                MutationTarget::Message(id) => format!("message:{id}"),
            };
            let entry = account_map.entry(key).or_default();
            entry.target = Some(target);
            entry.delta.merge(&add, &remove);
            entry.requests.push(PendingRequest {
                add,
                remove,
                reply: reply_tx,
            });
            is_leader
        };
        if !is_leader {
            return reply_rx.await.map_err(|_| SyncError::QueueStopped)?;
        }

        // A tiny coalescing window lets concurrently dispatched mutations
        // for this account join this flush; tests drive it with Tokio's
        // mock clock.
        tokio::time::sleep(COALESCE_WINDOW).await;
        let drained: HashMap<String, EntityAccumulator> = {
            let mut pending = self.pending.lock().await;
            pending.remove(account_id).unwrap_or_default()
        };

        // Resolve superseded vs. surviving requests per entity now, while
        // the final merged delta is known — a superseded caller hears so
        // immediately rather than waiting on a network round trip its
        // request was never part of (AC 7b).
        let mut surviving: HashMap<String, EntityAccumulator> = HashMap::new();
        for (entity_thread_id, mut accumulator) in drained {
            let delta = accumulator.delta.clone();
            let mut requests = Vec::with_capacity(accumulator.requests.len());
            for request in accumulator.requests.drain(..) {
                if request.survives(&delta) {
                    requests.push(request);
                } else {
                    let _ = request.reply.send(Ok(MutationOutcome::Superseded));
                }
            }
            if !requests.is_empty() {
                accumulator.requests = requests;
                surviving.insert(entity_thread_id, accumulator);
            }
        }
        if surviving.is_empty() {
            // Every request in this window (including, potentially, the
            // leader's own) was superseded above; nothing to dispatch.
            return reply_rx.await.map_err(|_| SyncError::QueueStopped)?;
        }

        let storage = self.storage.clone();
        let account_owned = account_id.to_owned();
        let op_id = format!(
            "mutation:{account_id}:{}",
            self.op_counter.fetch_add(1, Ordering::Relaxed)
        );
        self.registry.register(
            op_id.clone(),
            Box::new(move || Box::pin(execute_flush(storage, client, account_owned, surviving))),
        );
        self.queue
            .enqueue(QueueOperation {
                id: op_id,
                account_id: account_id.to_owned(),
                lane: Lane::Interactive,
                kind,
                entity_key: format!("mutation-batch:{account_id}"),
                cost: 0,
                attempts: 0,
            })
            .await
            .map_err(|_| SyncError::QueueStopped)?;
        reply_rx.await.map_err(|_| SyncError::QueueStopped)?
    }
}

/// A surviving entity once its messages have been resolved at flush time:
/// thread id, its messages, and its delta/waiting-requests accumulator.
type ResolvedEntity = (String, Vec<Message>, EntityAccumulator);

/// Dispatches every surviving entity's mutation to Gmail, grouping entities
/// whose final delta is identical into one `batchModify` call per group
/// (chunked at Gmail's 1,000-identifier limit — D5), then writes the
/// confirmed state back and replies to every waiting request.
///
/// Resolves each entity's messages here — once per entity, at flush time —
/// rather than when the request first arrives; see [`EntityAccumulator`]'s
/// documentation for why.
async fn execute_flush(
    storage: Storage,
    client: GmailClient,
    account_id: String,
    surviving: HashMap<String, EntityAccumulator>,
) -> Result<(), QueueError> {
    let mut any_failed = false;
    let entities: Vec<(MutationTarget, EntityAccumulator)> = surviving
        .into_values()
        .map(|entity| {
            (
                entity
                    .target
                    .clone()
                    .expect("mutation target is set on submission"),
                entity,
            )
        })
        .collect();
    let thread_ids = entities
        .iter()
        .filter_map(|(target, _)| match target {
            MutationTarget::Thread(id) => Some(id.clone()),
            MutationTarget::Message(_) => None,
        })
        .collect::<Vec<_>>();
    let message_ids = entities
        .iter()
        .filter_map(|(target, _)| match target {
            MutationTarget::Message(id) => Some(id.clone()),
            MutationTarget::Thread(_) => None,
        })
        .collect::<Vec<_>>();
    let account = account_id.clone();
    let loaded = storage
        .run(move |connection| {
            Ok((
                MessageRepository::list_by_threads(connection, &account, &thread_ids)?,
                MessageRepository::get_many(connection, &account, &message_ids)?,
            ))
        })
        .await;
    let mut resolved: Vec<ResolvedEntity> = Vec::new();
    match loaded {
        Ok((mut threads, mut messages)) => {
            for (target, entity) in entities {
                let resolved_data = match target {
                    MutationTarget::Thread(thread_id) => threads
                        .remove(&thread_id)
                        .map(|messages| (thread_id, messages)),
                    MutationTarget::Message(message_id) => messages
                        .remove(&message_id)
                        .map(|message| (message.thread_id.clone(), vec![message])),
                };
                if let Some((thread_id, messages)) = resolved_data {
                    resolved.push((thread_id, messages, entity));
                    continue;
                }
                any_failed = true;
                for request in entity.requests {
                    let _ = request.reply.send(Err(SyncError::Failed(
                        "mutation target is no longer available".into(),
                    )));
                }
            }
        }
        Err(error) => {
            any_failed = true;
            let message = SyncError::from(error).to_string();
            for (_, entity) in entities {
                for request in entity.requests {
                    let _ = request.reply.send(Err(SyncError::Failed(message.clone())));
                }
            }
        }
    }

    let mut groups: HashMap<(Vec<String>, Vec<String>), Vec<ResolvedEntity>> = HashMap::new();
    for item in resolved {
        let signature = item.2.delta.signature();
        groups.entry(signature).or_default().push(item);
    }

    for entities in groups.into_values() {
        let add: Vec<String> = entities[0].2.delta.additions.iter().cloned().collect();
        let remove: Vec<String> = entities[0].2.delta.removals.iter().cloned().collect();
        let ids: Vec<String> = entities
            .iter()
            .flat_map(|(_, messages, _)| messages.iter().map(|message| message.id.clone()))
            .collect();

        let mut failure = None;
        for chunk in ids.chunks(BATCH_MODIFY_CHUNK_SIZE) {
            if let Err(error) = client.batch_modify(chunk, &add, &remove).await {
                failure = Some(SyncError::from(error).to_string());
                break;
            }
        }
        if let Some(message) = failure {
            // Every waiter in the group has to hear the real error:
            // returning early instead would drop their reply channels, and
            // each caller would see the misleading `QueueStopped` message.
            any_failed = true;
            for (_, _, entity) in entities {
                for request in entity.requests {
                    let _ = request.reply.send(Err(SyncError::Failed(message.clone())));
                }
            }
            continue;
        }

        // Likewise, writing each entity's confirmed state back is
        // independent per entity — run those concurrently too.
        let mut write_tasks = tokio::task::JoinSet::new();
        for (thread_id, messages, entity) in entities {
            let storage = storage.clone();
            let client = client.clone();
            let account = account_id.clone();
            write_tasks.spawn(async move {
                let result = write_entity(&storage, &client, &account, &thread_id, &messages).await;
                (result, entity)
            });
        }
        while let Some(outcome) = write_tasks.join_next().await {
            let (result, entity) = outcome.expect("write task panicked");
            any_failed |= result.is_err();
            for request in entity.requests {
                let outcome = match &result {
                    Ok(()) => Ok(MutationOutcome::Applied),
                    Err(error) => Err(SyncError::Failed(error.to_string())),
                };
                let _ = request.reply.send(outcome);
            }
        }
    }

    if any_failed {
        Err(QueueError::Permanent)
    } else {
        Ok(())
    }
}

/// Re-reads each of the entity's messages (Gmail's batch endpoint returns
/// nothing useful) to capture the returned `historyId` for the strict
/// stale-read gate, writes the confirmed label membership, and recomputes
/// the thread once.
///
/// Membership comes from the re-read message's own `labelIds`, not from the
/// delta we sent: Gmail applies side effects of its own, and adding `TRASH`
/// or `SPAM` drops `INBOX` server-side. Applying only the delta left the
/// local copy still carrying `INBOX`, so a deleted or moved conversation
/// stayed in the mailbox it had just left until the next full sync
/// overwrote it.
async fn write_entity(
    storage: &Storage,
    client: &GmailClient,
    account_id: &str,
    thread_id: &str,
    messages: &[Message],
) -> Result<(), SyncError> {
    let mut updates = Vec::with_capacity(messages.len());
    for message in messages {
        let updated = client.message(&message.id).await?;
        updates.push((message.id.clone(), updated.history_id, updated.label_ids));
    }
    let account = account_id.to_owned();
    let thread = thread_id.to_owned();
    storage
        .run(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            for (id, history_id, label_ids) in updates {
                MessageRepository::write_mutation_history(
                    &transaction,
                    &account,
                    std::slice::from_ref(&id),
                    history_id,
                )?;
                MessageRepository::overwrite_membership(&transaction, &account, &id, &label_ids)?;
            }
            ThreadRepository::recompute(&transaction, &account, &thread)?;
            transaction.commit()
        })
        .await?;
    Ok(())
}
