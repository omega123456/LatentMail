
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
    queue::{Lane, OperationKind, QueueError, QueueOperation},
    storage::{Message, MessageRepository, Storage, ThreadRepository},
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


#[derive(Clone, Debug, Default)]
struct LabelDelta {
    additions: HashSet<String>,
    removals: HashSet<String>,
}

impl LabelDelta {

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

    fn survives(&self, delta: &LabelDelta) -> bool {
        self.add.iter().any(|label| delta.additions.contains(label))
            || self
                .remove
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


        tokio::time::sleep(COALESCE_WINDOW).await;
        let drained: HashMap<String, EntityAccumulator> = {
            let mut pending = self.pending.lock().await;
            pending.remove(account_id).unwrap_or_default()
        };


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
                description: mutation_description(kind),
            })
            .await
            .map_err(|_| SyncError::QueueStopped)?;
        reply_rx.await.map_err(|_| SyncError::QueueStopped)?
    }
}


type ResolvedEntity = (String, Vec<Message>, EntityAccumulator);


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

            any_failed = true;
            for (_, _, entity) in entities {
                for request in entity.requests {
                    let _ = request.reply.send(Err(SyncError::Failed(message.clone())));
                }
            }
            continue;
        }


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
