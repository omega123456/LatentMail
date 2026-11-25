use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use rusqlite::{params, Connection};
use serde::Deserialize;
use tauri::Runtime;

use crate::{
    gmail::system_labels::{SPAM, TRASH},
    ipc::{AppServices, CommandPayload},
    storage::{MessageRepository, Storage},
};

use super::{
    announce::MailChangeAnnouncer,
    dto::MutationResultDto,
    mutations::{DraftMessageRef, LabelDelta, MessageMutation, ThreadMutation},
    MutationOutcome,
};

pub const REMOVABLE_SYSTEM_FOLDER_LABELS: [&str; 3] = ["INBOX", SPAM, TRASH];
pub const MOVE_DESTINATIONS: [&str; 3] = ["INBOX", SPAM, TRASH];

fn validate_destination(destination: &str) -> Result<(), String> {
    if MOVE_DESTINATIONS.contains(&destination) {
        return Ok(());
    }
    Err(format!("'{destination}' is not a valid move destination"))
}

pub fn thread_raw_membership(
    connection: &Connection,
    account_id: &str,
    thread_id: &str,
) -> rusqlite::Result<HashSet<String>> {
    let mut statement = connection.prepare(
        "SELECT DISTINCT ml.label_id
         FROM messages m CROSS JOIN message_labels ml
         WHERE m.account_id=?1 AND m.thread_id=?2
           AND ml.account_id=m.account_id AND ml.message_id=m.id",
    )?;
    let labels = statement
        .query_map(params![account_id, thread_id], |row| row.get(0))?
        .collect();
    labels
}

pub fn message_raw_membership(
    connection: &Connection,
    account_id: &str,
    message_id: &str,
) -> rusqlite::Result<HashSet<String>> {
    Ok(
        MessageRepository::label_ids(connection, account_id, message_id)?
            .into_iter()
            .collect(),
    )
}

async fn thread_raw_membership_many(
    storage: &Storage,
    account_id: &str,
    thread_ids: &[String],
) -> Result<HashMap<String, HashSet<String>>, String> {
    let account = account_id.to_owned();
    let threads = thread_ids.to_vec();
    storage
        .run(move |connection| {
            MessageRepository::label_ids_by_thread(connection, &account, &threads)
        })
        .await
        .map_err(|error| error.to_string())
}

async fn message_raw_membership_many(
    storage: &Storage,
    account_id: &str,
    message_ids: &[String],
) -> Result<HashMap<String, HashSet<String>>, String> {
    let account = account_id.to_owned();
    let messages = message_ids.to_vec();
    storage
        .run(move |connection| {
            MessageRepository::label_ids_by_message(connection, &account, &messages)
        })
        .await
        .map_err(|error| error.to_string())
}

pub fn delete_labels(membership: &HashSet<String>) -> LabelDelta {
    let additions = HashSet::from([TRASH.to_owned()]);
    let removals = REMOVABLE_SYSTEM_FOLDER_LABELS
        .iter()
        .filter(|label| **label != TRASH && membership.contains(**label))
        .map(|label| (*label).to_owned())
        .collect();
    LabelDelta {
        additions: additions,
        removals: removals,
    }
}

pub fn move_labels(membership: &HashSet<String>, destination: &str) -> LabelDelta {
    let additions = HashSet::from([destination.to_owned()]);
    let removals = REMOVABLE_SYSTEM_FOLDER_LABELS
        .iter()
        .filter(|label| **label != destination && membership.contains(**label))
        .map(|label| (*label).to_owned())
        .collect();
    LabelDelta {
        additions: additions,
        removals: removals,
    }
}

const PROTECTED_LABELS: [&str; 2] = ["DRAFT", "SENT"];

#[derive(Clone)]
pub(super) enum LabelChange {
    Explicit(LabelDelta),
    Delete,
    Move(String),
}

impl LabelChange {
    pub(super) fn explicit(add: Vec<String>, remove: Vec<String>) -> Result<Self, String> {
        let change = Self::Explicit(LabelDelta {
            additions: add.into_iter().collect(),
            removals: remove.into_iter().collect(),
        });
        change.reject_protected_labels()?;
        Ok(change)
    }

    fn moving_to(destination: String) -> Result<Self, String> {
        validate_destination(&destination)?;
        Ok(Self::Move(destination))
    }

    fn reads_membership(&self) -> bool {
        !matches!(self, Self::Explicit(_))
    }

    fn deletes_drafts(&self) -> bool {
        let Self::Explicit(delta) = self else {
            return true;
        };
        let trashes_only = delta.additions == HashSet::from([TRASH.to_owned()]);
        trashes_only && delta.removals.is_empty()
    }

    fn labels_for(&self, membership: &HashSet<String>) -> LabelDelta {
        match self {
            Self::Explicit(delta) => delta.clone(),
            Self::Delete => delete_labels(membership),
            Self::Move(destination) => move_labels(membership, destination),
        }
    }

    fn reject_protected_labels(&self) -> Result<(), String> {
        let delta = self.labels_for(&HashSet::new());
        let touches_protected = delta
            .additions
            .iter()
            .chain(&delta.removals)
            .any(|label| PROTECTED_LABELS.contains(&label.as_str()));
        if touches_protected {
            return Err("Draft and Sent labels cannot be modified.".into());
        }
        Ok(())
    }
}

struct AccountIds<'a> {
    account_id: &'a str,
    ids: &'a [String],
}

async fn membership_for_threads(
    storage: &Storage,
    target: AccountIds<'_>,
    change: &LabelChange,
) -> Result<HashMap<String, HashSet<String>>, String> {
    if !change.reads_membership() {
        return Ok(HashMap::new());
    }
    thread_raw_membership_many(storage, target.account_id, target.ids).await
}

async fn membership_for_messages(
    storage: &Storage,
    target: AccountIds<'_>,
    change: &LabelChange,
) -> Result<HashMap<String, HashSet<String>>, String> {
    if !change.reads_membership() {
        return Ok(HashMap::new());
    }
    message_raw_membership_many(storage, target.account_id, target.ids).await
}

pub(super) struct ThreadsChangeRequest {
    pub account_id: String,
    pub thread_ids: Vec<String>,
    pub change: LabelChange,
}

pub(super) struct MessagesChangeRequest {
    pub account_id: String,
    pub message_ids: Vec<String>,
    pub change: LabelChange,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteThreadsRequest {
    pub account_id: String,
    pub thread_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveThreadsRequest {
    pub account_id: String,
    pub thread_ids: Vec<String>,
    pub destination: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteMessagesRequest {
    pub account_id: String,
    pub message_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveMessagesRequest {
    pub account_id: String,
    pub message_ids: Vec<String>,
    pub destination: String,
}

pub(super) async fn apply_to_threads<R: Runtime>(
    services: &AppServices<'_, R>,
    request: ThreadsChangeRequest,
) -> Result<Vec<MutationResultDto>, String> {
    let ThreadsChangeRequest {
        account_id,
        thread_ids,
        change,
    } = request;
    let engine = services.sync()?;
    let client = services.gmail_client(&account_id).await?;
    let drafts_by_thread =
        super::mutations::draft_message_ids(engine.storage(), &account_id, &thread_ids).await?;
    let membership_by_thread = membership_for_threads(
        engine.storage(),
        AccountIds {
            account_id: &account_id,
            ids: &thread_ids,
        },
        &change,
    )
    .await?;

    let mut results = Vec::with_capacity(thread_ids.len());
    let mut tasks = tokio::task::JoinSet::new();
    for thread_id in thread_ids {
        let drafts = drafts_by_thread
            .get(&thread_id)
            .cloned()
            .unwrap_or_default();
        if !drafts.is_empty() {
            if !change.deletes_drafts() {
                return Err("Draft messages cannot be modified; delete them instead.".into());
            }
            for message_id in drafts {
                super::mutations::delete_draft(
                    engine.storage(),
                    &client,
                    DraftMessageRef {
                        account_id: &account_id,
                        message_id: &message_id,
                    },
                )
                .await?;
            }
            results.push(MutationResultDto {
                thread_id: thread_id,
                outcome: MutationOutcome::Applied.into(),
            });
            continue;
        }
        let engine = Arc::clone(&engine);
        let client = client.clone();
        let account_id = account_id.clone();
        let membership = membership_by_thread
            .get(&thread_id)
            .cloned()
            .unwrap_or_default();
        let labels = change.labels_for(&membership);
        tasks.spawn(async move {
            let outcome = engine
                .mutate(ThreadMutation {
                    account_id: account_id,
                    client: client,
                    thread_id: thread_id.clone(),
                    labels: labels,
                })
                .await;
            (thread_id, outcome)
        });
    }
    while let Some(outcome) = tasks.join_next().await {
        let (thread_id, outcome) = outcome.map_err(|error| error.to_string())?;
        let outcome = outcome.map_err(|error| error.to_string())?;
        results.push(MutationResultDto {
            thread_id: thread_id,
            outcome: outcome.into(),
        });
    }
    Ok(results)
}

pub(super) async fn apply_to_messages<R: Runtime>(
    services: &AppServices<'_, R>,
    request: MessagesChangeRequest,
) -> Result<(), String> {
    let MessagesChangeRequest {
        account_id,
        message_ids,
        change,
    } = request;
    let engine = services.sync()?;
    let client = services.gmail_client(&account_id).await?;
    let membership_by_message = membership_for_messages(
        engine.storage(),
        AccountIds {
            account_id: &account_id,
            ids: &message_ids,
        },
        &change,
    )
    .await?;
    let mut tasks = tokio::task::JoinSet::new();
    for message_id in message_ids {
        let engine = Arc::clone(&engine);
        let client = client.clone();
        let account_id = account_id.clone();
        let membership = membership_by_message
            .get(&message_id)
            .cloned()
            .unwrap_or_default();
        let labels = change.labels_for(&membership);
        tasks.spawn(async move {
            engine
                .mutate_message(MessageMutation {
                    account_id: account_id,
                    client: client,
                    message_id: message_id,
                    labels: labels,
                })
                .await
                .map_err(|error| error.to_string())
        });
    }
    while let Some(outcome) = tasks.join_next().await {
        outcome.map_err(|error| error.to_string())??;
    }
    Ok(())
}

async fn run_delete_threads<R: Runtime>(
    services: AppServices<'_, R>,
    request: DeleteThreadsRequest,
) -> Result<Vec<MutationResultDto>, String> {
    let announcer = MailChangeAnnouncer::new(services.app(), &request.account_id);
    let outcome = apply_to_threads(
        &services,
        ThreadsChangeRequest {
            account_id: request.account_id,
            thread_ids: request.thread_ids,
            change: LabelChange::Delete,
        },
    )
    .await;
    announcer.announce(outcome)
}

async fn run_move_threads<R: Runtime>(
    services: AppServices<'_, R>,
    request: MoveThreadsRequest,
) -> Result<Vec<MutationResultDto>, String> {
    let announcer = MailChangeAnnouncer::new(services.app(), &request.account_id);
    let outcome = match LabelChange::moving_to(request.destination) {
        Ok(change) => {
            apply_to_threads(
                &services,
                ThreadsChangeRequest {
                    account_id: request.account_id,
                    thread_ids: request.thread_ids,
                    change: change,
                },
            )
            .await
        }
        Err(error) => Err(error),
    };
    announcer.announce(outcome)
}

async fn run_delete_messages<R: Runtime>(
    services: AppServices<'_, R>,
    request: DeleteMessagesRequest,
) -> Result<(), String> {
    let announcer = MailChangeAnnouncer::new(services.app(), &request.account_id);
    let outcome = apply_to_messages(
        &services,
        MessagesChangeRequest {
            account_id: request.account_id,
            message_ids: request.message_ids,
            change: LabelChange::Delete,
        },
    )
    .await;
    announcer.announce(outcome)
}

async fn run_move_messages<R: Runtime>(
    services: AppServices<'_, R>,
    request: MoveMessagesRequest,
) -> Result<(), String> {
    let announcer = MailChangeAnnouncer::new(services.app(), &request.account_id);
    let outcome = match LabelChange::moving_to(request.destination) {
        Ok(change) => {
            apply_to_messages(
                &services,
                MessagesChangeRequest {
                    account_id: request.account_id,
                    message_ids: request.message_ids,
                    change: change,
                },
            )
            .await
        }
        Err(error) => Err(error),
    };
    announcer.announce(outcome)
}

#[tauri::command]
pub async fn delete_threads<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<DeleteThreadsRequest>,
) -> Result<Vec<MutationResultDto>, String> {
    run_delete_threads(services, request).await
}

#[tauri::command]
pub async fn move_threads<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<MoveThreadsRequest>,
) -> Result<Vec<MutationResultDto>, String> {
    run_move_threads(services, request).await
}

#[tauri::command]
pub async fn delete_messages<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<DeleteMessagesRequest>,
) -> Result<(), String> {
    run_delete_messages(services, request).await
}

#[tauri::command]
pub async fn move_messages<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<MoveMessagesRequest>,
) -> Result<(), String> {
    run_move_messages(services, request).await
}
