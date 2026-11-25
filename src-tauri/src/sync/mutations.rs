use std::{
    collections::{HashMap, HashSet},
    sync::atomic::Ordering,
    time::Duration,
};

use tokio::sync::oneshot;

use crate::{
    gmail::{GmailClient, LabelModification},
    queue::{Lane, OperationKind, QueueError, QueueOperation, QueueRoute},
    storage::{
        Message, MessageKey, MessageRepository, MutationHistoryUpdate, Storage, ThreadRepository,
    },
};

use super::{SyncEngine, SyncError};

fn mutation_description(kind: OperationKind) -> String {
    match kind {
        OperationKind::Star => "Star messages".to_owned(),
        OperationKind::Unstar => "Unstar messages".to_owned(),
        OperationKind::MarkRead => "Mark messages read".to_owned(),
        OperationKind::MarkUnread => "Mark messages unread".to_owned(),
        OperationKind::Delete => "Move messages to Trash".to_owned(),
        OperationKind::Move => "Move messages".to_owned(),
        OperationKind::Spam => "Report spam".to_owned(),
        OperationKind::NotSpam => "Mark not spam".to_owned(),
        _ => "Update labels".to_owned(),
    }
}

#[derive(Clone, Copy)]
pub(super) struct DraftMessageRef<'a> {
    pub account_id: &'a str,
    pub message_id: &'a str,
}

pub(super) async fn delete_draft(
    storage: &Storage,
    client: &GmailClient,
    target: DraftMessageRef<'_>,
) -> Result<(), String> {
    let draft_id = resolve_draft_id(storage, client, target).await?;
    string_try!(client.delete_draft(&draft_id).await);
    let account = target.account_id.to_owned();
    let id = target.message_id.to_owned();
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

async fn resolve_draft_id(
    storage: &Storage,
    client: &GmailClient,
    target: DraftMessageRef<'_>,
) -> Result<String, String> {
    let account = target.account_id.to_owned();
    let id = target.message_id.to_owned();
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
        .get(target.message_id)
        .cloned()
        .ok_or_else(|| format!("Gmail has no draft for message {}", target.message_id))?;
    let account = target.account_id.to_owned();
    let id = target.message_id.to_owned();
    let resolved = draft_id.clone();
    string_try!(
        storage
            .run(move |connection| MessageRepository::set_draft_id(
                connection,
                MessageKey {
                    account_id: &account,
                    message_id: &id,
                },
                &resolved,
            ))
            .await
    );
    Ok(draft_id)
}

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

const COALESCE_WINDOW: Duration = Duration::from_millis(1);

pub const BATCH_MODIFY_CHUNK_SIZE: usize = 1_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MutationOutcome {
    Applied,
    Superseded,
}

pub(super) type PendingMutations = HashMap<String, HashMap<String, EntityAccumulator>>;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LabelDelta {
    pub additions: HashSet<String>,
    pub removals: HashSet<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct MutationSignature {
    additions: Vec<String>,
    removals: Vec<String>,
}

impl LabelDelta {
    fn merge(&mut self, incoming: &Self) {
        for label in &incoming.additions {
            self.removals.remove(label);
            self.additions.insert(label.clone());
        }
        for label in &incoming.removals {
            self.additions.remove(label);
            self.removals.insert(label.clone());
        }
    }

    fn signature(&self) -> MutationSignature {
        let mut additions: Vec<String> = self.additions.iter().cloned().collect();
        additions.sort_unstable();
        let mut removals: Vec<String> = self.removals.iter().cloned().collect();
        removals.sort_unstable();
        MutationSignature {
            additions: additions,
            removals: removals,
        }
    }
}

pub struct MessageMutation {
    pub account_id: String,
    pub client: GmailClient,
    pub message_id: String,
    pub labels: LabelDelta,
}

pub struct ThreadMutation {
    pub account_id: String,
    pub client: GmailClient,
    pub thread_id: String,
    pub labels: LabelDelta,
}

struct MutationSubmission {
    account_id: String,
    client: GmailClient,
    target: MutationTarget,
    labels: LabelDelta,
}

struct PendingRequest {
    labels: LabelDelta,
    reply: oneshot::Sender<Result<MutationOutcome, SyncError>>,
}

impl PendingRequest {
    fn survives(&self, delta: &LabelDelta) -> bool {
        self.labels
            .additions
            .iter()
            .any(|label| delta.additions.contains(label))
            || self
                .labels
                .removals
                .iter()
                .any(|label| delta.removals.contains(label))
    }
}

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
    pub async fn mutate_message(&self, mutation: MessageMutation) -> Result<(), SyncError> {
        self.submit(MutationSubmission {
            account_id: mutation.account_id,
            client: mutation.client,
            target: MutationTarget::Message(mutation.message_id),
            labels: mutation.labels,
        })
        .await
        .map(|_| ())
    }

    pub async fn mutate(&self, mutation: ThreadMutation) -> Result<MutationOutcome, SyncError> {
        self.submit(MutationSubmission {
            account_id: mutation.account_id,
            client: mutation.client,
            target: MutationTarget::Thread(mutation.thread_id),
            labels: mutation.labels,
        })
        .await
    }

    async fn submit(&self, submission: MutationSubmission) -> Result<MutationOutcome, SyncError> {
        let kind = super::queue_bridge::derive_operation_kind(&submission.labels);
        let (reply_sender, reply_receiver) = oneshot::channel();
        let account_id = submission.account_id;
        let client = submission.client;
        let is_leader = self
            .record_pending_submission(
                &account_id,
                PendingSubmission {
                    target: submission.target,
                    labels: submission.labels,
                    reply: reply_sender,
                },
            )
            .await;
        if !is_leader {
            return reply_receiver.await.map_err(|_| SyncError::QueueStopped)?;
        }

        tokio::time::sleep(COALESCE_WINDOW).await;
        let drained = self.drain_pending_account(&account_id).await;
        let surviving = retain_surviving_mutations(drained);
        if surviving.is_empty() {
            return reply_receiver.await.map_err(|_| SyncError::QueueStopped)?;
        }

        self.enqueue_flush_batch(
            FlushBatch {
                storage: self.storage.clone(),
                client: client,
                account_id: account_id,
                surviving: surviving,
            },
            kind,
        )
        .await?;
        reply_receiver.await.map_err(|_| SyncError::QueueStopped)?
    }

    async fn record_pending_submission(&self, account_id: &str, entry: PendingSubmission) -> bool {
        let mut pending = self.pending.lock().await;
        let account_map = pending.entry(account_id.to_owned()).or_default();
        let is_leader = account_map.is_empty();
        let key = match &entry.target {
            MutationTarget::Thread(id) => format!("thread:{id}"),
            MutationTarget::Message(id) => format!("message:{id}"),
        };
        let accumulator = account_map.entry(key).or_default();
        accumulator.target = Some(entry.target);
        accumulator.delta.merge(&entry.labels);
        accumulator.requests.push(PendingRequest {
            labels: entry.labels,
            reply: entry.reply,
        });
        is_leader
    }

    async fn drain_pending_account(&self, account_id: &str) -> HashMap<String, EntityAccumulator> {
        let mut pending = self.pending.lock().await;
        pending.remove(account_id).unwrap_or_default()
    }

    async fn enqueue_flush_batch(
        &self,
        batch: FlushBatch,
        kind: OperationKind,
    ) -> Result<(), SyncError> {
        let account_id = batch.account_id.clone();
        let operation_id = format!(
            "mutation:{account_id}:{}",
            self.operation_counter.fetch_add(1, Ordering::Relaxed)
        );
        self.registry.register(
            operation_id.clone(),
            Box::new(move || Box::pin(execute_flush(batch))),
        );
        self.queue
            .enqueue(QueueOperation::new(
                operation_id,
                account_id.clone(),
                QueueRoute {
                    lane: Lane::Interactive,
                    kind: kind,
                    entity_key: format!("mutation-batch:{account_id}"),
                    description: mutation_description(kind),
                },
            ))
            .await
            .map_err(|_| SyncError::QueueStopped)
    }
}

struct PendingSubmission {
    target: MutationTarget,
    labels: LabelDelta,
    reply: oneshot::Sender<Result<MutationOutcome, SyncError>>,
}

fn retain_surviving_mutations(
    drained: HashMap<String, EntityAccumulator>,
) -> HashMap<String, EntityAccumulator> {
    let mut surviving = HashMap::new();
    for (entity_key, mut accumulator) in drained {
        if filter_surviving_requests(&mut accumulator) {
            surviving.insert(entity_key, accumulator);
        }
    }
    surviving
}

fn filter_surviving_requests(accumulator: &mut EntityAccumulator) -> bool {
    let delta = accumulator.delta.clone();
    let mut requests = Vec::with_capacity(accumulator.requests.len());
    for request in accumulator.requests.drain(..) {
        if request.survives(&delta) {
            requests.push(request);
            continue;
        }
        let _ = request.reply.send(Ok(MutationOutcome::Superseded));
    }
    accumulator.requests = requests;
    !accumulator.requests.is_empty()
}

struct FlushBatch {
    storage: Storage,
    client: GmailClient,
    account_id: String,
    surviving: HashMap<String, EntityAccumulator>,
}

struct FlushGroupContext<'a> {
    storage: &'a Storage,
    client: &'a GmailClient,
    account_id: &'a str,
}

struct LoadedTargets {
    threads: HashMap<String, Vec<Message>>,
    messages: HashMap<String, Message>,
}

struct ResolvedBatch {
    entities: Vec<ResolvedEntity>,
    any_failed: bool,
}

struct ResolvedEntity {
    thread_id: String,
    messages: Vec<Message>,
    entity: EntityAccumulator,
}

struct EntityWriteTarget<'a> {
    account_id: &'a str,
    thread_id: &'a str,
    messages: &'a [Message],
}

fn fail_requests(requests: Vec<PendingRequest>, message: &str) {
    for request in requests {
        let _ = request
            .reply
            .send(Err(SyncError::Failed(message.to_owned())));
    }
}

fn resolve_loaded_entities(
    entities: Vec<(MutationTarget, EntityAccumulator)>,
    mut loaded: LoadedTargets,
) -> ResolvedBatch {
    let mut resolved = Vec::new();
    let mut any_failed = false;
    for (target, entity) in entities {
        let resolved_data = match target {
            MutationTarget::Thread(thread_id) => loaded
                .threads
                .remove(&thread_id)
                .map(|messages| (thread_id, messages)),
            MutationTarget::Message(message_id) => loaded
                .messages
                .remove(&message_id)
                .map(|message| (message.thread_id.clone(), vec![message])),
        };
        if let Some((thread_id, messages)) = resolved_data {
            resolved.push(ResolvedEntity {
                thread_id: thread_id,
                messages: messages,
                entity: entity,
            });
            continue;
        }
        any_failed = true;
        fail_requests(entity.requests, "mutation target is no longer available");
    }
    ResolvedBatch {
        entities: resolved,
        any_failed: any_failed,
    }
}

async fn load_and_resolve_entities(
    storage: &Storage,
    account_id: &str,
    entities: Vec<(MutationTarget, EntityAccumulator)>,
) -> ResolvedBatch {
    let thread_ids: Vec<String> = entities
        .iter()
        .filter_map(|(target, _)| match target {
            MutationTarget::Thread(id) => Some(id.clone()),
            MutationTarget::Message(_) => None,
        })
        .collect();
    let message_ids: Vec<String> = entities
        .iter()
        .filter_map(|(target, _)| match target {
            MutationTarget::Message(id) => Some(id.clone()),
            MutationTarget::Thread(_) => None,
        })
        .collect();
    let account = account_id.to_owned();
    let loaded = storage
        .run(move |connection| {
            Ok(LoadedTargets {
                threads: MessageRepository::list_by_threads(connection, &account, &thread_ids)?,
                messages: MessageRepository::get_many(connection, &account, &message_ids)?,
            })
        })
        .await;
    match loaded {
        Ok(targets) => resolve_loaded_entities(entities, targets),
        Err(error) => {
            let message = SyncError::from(error).to_string();
            for (_, entity) in entities {
                fail_requests(entity.requests, &message);
            }
            ResolvedBatch {
                entities: Vec::new(),
                any_failed: true,
            }
        }
    }
}

fn group_entities_by_signature(resolved: Vec<ResolvedEntity>) -> Vec<Vec<ResolvedEntity>> {
    let mut groups: HashMap<MutationSignature, Vec<ResolvedEntity>> = HashMap::new();
    for item in resolved {
        let signature = item.entity.delta.signature();
        groups.entry(signature).or_default().push(item);
    }
    groups.into_values().collect()
}

async fn batch_modify_all(
    client: &GmailClient,
    ids: &[String],
    modification: LabelModification<'_>,
) -> Result<(), SyncError> {
    for chunk in ids.chunks(BATCH_MODIFY_CHUNK_SIZE) {
        client
            .batch_modify(
                chunk,
                LabelModification {
                    add_label_ids: modification.add_label_ids,
                    remove_label_ids: modification.remove_label_ids,
                },
            )
            .await?;
    }
    Ok(())
}

fn reply_to_entity_requests(requests: Vec<PendingRequest>, result: &Result<(), SyncError>) {
    for request in requests {
        let outcome = match result {
            Ok(()) => Ok(MutationOutcome::Applied),
            Err(error) => Err(SyncError::Failed(error.to_string())),
        };
        let _ = request.reply.send(outcome);
    }
}

async fn flush_signature_group(
    context: &FlushGroupContext<'_>,
    entities: Vec<ResolvedEntity>,
) -> bool {
    let add: Vec<String> = entities[0].entity.delta.additions.iter().cloned().collect();
    let remove: Vec<String> = entities[0].entity.delta.removals.iter().cloned().collect();
    let ids: Vec<String> = entities
        .iter()
        .flat_map(|item| item.messages.iter().map(|message| message.id.clone()))
        .collect();
    let modification = LabelModification {
        add_label_ids: &add,
        remove_label_ids: &remove,
    };
    if let Err(error) = batch_modify_all(context.client, &ids, modification).await {
        let message = error.to_string();
        for item in entities {
            fail_requests(item.entity.requests, &message);
        }
        return true;
    }

    let mut write_tasks = tokio::task::JoinSet::new();
    for item in entities {
        let storage = context.storage.clone();
        let client = context.client.clone();
        let account = context.account_id.to_owned();
        write_tasks.spawn(async move {
            let result = write_entity(
                &storage,
                &client,
                EntityWriteTarget {
                    account_id: &account,
                    thread_id: &item.thread_id,
                    messages: &item.messages,
                },
            )
            .await;
            (result, item.entity)
        });
    }
    let mut any_failed = false;
    while let Some(outcome) = write_tasks.join_next().await {
        let (result, entity) = outcome.expect("write task panicked");
        any_failed |= result.is_err();
        reply_to_entity_requests(entity.requests, &result);
    }
    any_failed
}

async fn execute_flush(batch: FlushBatch) -> Result<(), QueueError> {
    let FlushBatch {
        storage,
        client,
        account_id,
        surviving,
    } = batch;
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
    let resolved = load_and_resolve_entities(&storage, &account_id, entities).await;
    let mut any_failed = resolved.any_failed;
    let group_context = FlushGroupContext {
        storage: &storage,
        client: &client,
        account_id: &account_id,
    };
    for group in group_entities_by_signature(resolved.entities) {
        any_failed |= flush_signature_group(&group_context, group).await;
    }
    if any_failed {
        return Err(QueueError::Permanent);
    }
    Ok(())
}

async fn write_entity(
    storage: &Storage,
    client: &GmailClient,
    target: EntityWriteTarget<'_>,
) -> Result<(), SyncError> {
    let mut updates = Vec::with_capacity(target.messages.len());
    for message in target.messages {
        let updated = client.message(&message.id).await?;
        updates.push((message.id.clone(), updated.history_id, updated.label_ids));
    }
    let account = target.account_id.to_owned();
    let thread = target.thread_id.to_owned();
    storage
        .run(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            for (id, history_id, label_ids) in updates {
                MessageRepository::write_mutation_history(
                    &transaction,
                    &account,
                    MutationHistoryUpdate {
                        ids: std::slice::from_ref(&id),
                        history_id: history_id,
                    },
                )?;
                MessageRepository::overwrite_membership(
                    &transaction,
                    MessageKey {
                        account_id: &account,
                        message_id: &id,
                    },
                    &label_ids,
                )?;
            }
            ThreadRepository::recompute(&transaction, &account, &thread)?;
            transaction.commit()
        })
        .await?;
    Ok(())
}
