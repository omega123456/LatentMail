use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use rusqlite::{params, Connection};
use tauri::{AppHandle, Runtime};

use crate::gmail::system_labels::{SPAM, TRASH};
use crate::{
    auth::AuthService,
    storage::{MessageRepository, Storage},
};

use super::{
    announce::MailChangeAnnouncer, dto::MutationResultDto, MutationOutcome, SyncEngine,
};

pub const REMOVABLE_SYSTEM_FOLDER_LABELS: [&str; 3] = ["INBOX", SPAM, TRASH];
pub const MOVE_DESTINATIONS: [&str; 3] = ["INBOX", SPAM, TRASH];

fn validate_destination(destination: &str) -> Result<(), String> {
    if MOVE_DESTINATIONS.contains(&destination) {
        Ok(())
    } else {
        Err(format!("'{destination}' is not a valid move destination"))
    }
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

pub fn delete_labels(membership: &HashSet<String>) -> (HashSet<String>, HashSet<String>) {
    let add = HashSet::from([TRASH.to_owned()]);
    let remove = REMOVABLE_SYSTEM_FOLDER_LABELS
        .iter()
        .filter(|label| **label != TRASH && membership.contains(**label))
        .map(|label| (*label).to_owned())
        .collect();
    (add, remove)
}

pub fn move_labels(
    membership: &HashSet<String>,
    destination: &str,
) -> (HashSet<String>, HashSet<String>) {
    let add = HashSet::from([destination.to_owned()]);
    let remove = REMOVABLE_SYSTEM_FOLDER_LABELS
        .iter()
        .filter(|label| **label != destination && membership.contains(**label))
        .map(|label| (*label).to_owned())
        .collect();
    (add, remove)
}

const PROTECTED_LABELS: [&str; 2] = ["DRAFT", "SENT"];

#[derive(Clone)]
pub(super) enum LabelChange {
    Explicit {
        add: HashSet<String>,
        remove: HashSet<String>,
    },
    Delete,
    Move(String),
}

impl LabelChange {
    pub(super) fn explicit(add: Vec<String>, remove: Vec<String>) -> Result<Self, String> {
        let change = Self::Explicit {
            add: add.into_iter().collect(),
            remove: remove.into_iter().collect(),
        };
        change.reject_protected_labels()?;
        Ok(change)
    }

    fn moving_to(destination: String) -> Result<Self, String> {
        validate_destination(&destination)?;
        Ok(Self::Move(destination))
    }

    fn reads_membership(&self) -> bool {
        !matches!(self, Self::Explicit { .. })
    }

    fn deletes_drafts(&self) -> bool {
        let Self::Explicit { add, remove } = self else {
            return true;
        };
        let trashes_only = *add == HashSet::from([TRASH.to_owned()]);
        trashes_only && remove.is_empty()
    }

    fn labels_for(&self, membership: &HashSet<String>) -> (HashSet<String>, HashSet<String>) {
        match self {
            Self::Explicit { add, remove } => (add.clone(), remove.clone()),
            Self::Delete => delete_labels(membership),
            Self::Move(destination) => move_labels(membership, destination),
        }
    }

    fn reject_protected_labels(&self) -> Result<(), String> {
        let (add, remove) = self.labels_for(&HashSet::new());
        let touches_protected = add
            .iter()
            .chain(&remove)
            .any(|label| PROTECTED_LABELS.contains(&label.as_str()));
        if touches_protected {
            return Err("Draft and Sent labels cannot be modified.".into());
        }
        Ok(())
    }
}

async fn membership_for_threads(
    storage: &Storage,
    account_id: &str,
    thread_ids: &[String],
    change: &LabelChange,
) -> Result<HashMap<String, HashSet<String>>, String> {
    if !change.reads_membership() {
        return Ok(HashMap::new());
    }
    thread_raw_membership_many(storage, account_id, thread_ids).await
}

async fn membership_for_messages(
    storage: &Storage,
    account_id: &str,
    message_ids: &[String],
    change: &LabelChange,
) -> Result<HashMap<String, HashSet<String>>, String> {
    if !change.reads_membership() {
        return Ok(HashMap::new());
    }
    message_raw_membership_many(storage, account_id, message_ids).await
}

pub(super) async fn apply_to_threads<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    thread_ids: Vec<String>,
    change: LabelChange,
) -> Result<Vec<MutationResultDto>, String> {
    let client = super::commands::gmail_client_for(&app, &auth, &engine, &account_id).await?;
    let drafts_by_thread =
        super::mutations::draft_message_ids(engine.storage(), &account_id, &thread_ids).await?;
    let membership_by_thread =
        membership_for_threads(engine.storage(), &account_id, &thread_ids, &change).await?;

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
                super::mutations::delete_draft(engine.storage(), &client, &account_id, &message_id)
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
        let (add, remove) = change.labels_for(&membership);
        tasks.spawn(async move {
            let outcome = engine
                .mutate(&account_id, client, thread_id.clone(), add, remove)
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
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    message_ids: Vec<String>,
    change: LabelChange,
) -> Result<(), String> {
    let client = super::commands::gmail_client_for(&app, &auth, &engine, &account_id).await?;
    let membership_by_message =
        membership_for_messages(engine.storage(), &account_id, &message_ids, &change).await?;
    let mut tasks = tokio::task::JoinSet::new();
    for message_id in message_ids {
        let engine = Arc::clone(&engine);
        let client = client.clone();
        let account_id = account_id.clone();
        let membership = membership_by_message
            .get(&message_id)
            .cloned()
            .unwrap_or_default();
        let (add, remove) = change.labels_for(&membership);
        tasks.spawn(async move {
            engine
                .mutate_message(&account_id, client, message_id, add, remove)
                .await
                .map_err(|error| error.to_string())
        });
    }
    while let Some(outcome) = tasks.join_next().await {
        outcome.map_err(|error| error.to_string())??;
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_threads<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    thread_ids: Vec<String>,
) -> Result<Vec<MutationResultDto>, String> {
    let announcer = MailChangeAnnouncer::new(&app, &account_id);
    let outcome = apply_delete_threads(app, auth, engine, account_id, thread_ids).await;
    announcer.announce(outcome)
}

async fn apply_delete_threads<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    thread_ids: Vec<String>,
) -> Result<Vec<MutationResultDto>, String> {
    apply_to_threads(app, auth, engine, account_id, thread_ids, LabelChange::Delete).await
}

#[tauri::command]
pub async fn move_threads<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    thread_ids: Vec<String>,
    destination: String,
) -> Result<Vec<MutationResultDto>, String> {
    let announcer = MailChangeAnnouncer::new(&app, &account_id);
    let outcome = apply_move_threads(app, auth, engine, account_id, thread_ids, destination).await;
    announcer.announce(outcome)
}

async fn apply_move_threads<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    thread_ids: Vec<String>,
    destination: String,
) -> Result<Vec<MutationResultDto>, String> {
    let change = LabelChange::moving_to(destination)?;
    apply_to_threads(app, auth, engine, account_id, thread_ids, change).await
}

#[tauri::command]
pub async fn delete_messages<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    message_ids: Vec<String>,
) -> Result<(), String> {
    let announcer = MailChangeAnnouncer::new(&app, &account_id);
    let outcome = apply_delete_messages(app, auth, engine, account_id, message_ids).await;
    announcer.announce(outcome)
}

async fn apply_delete_messages<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    message_ids: Vec<String>,
) -> Result<(), String> {
    apply_to_messages(app, auth, engine, account_id, message_ids, LabelChange::Delete).await
}

#[tauri::command]
pub async fn move_messages<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    message_ids: Vec<String>,
    destination: String,
) -> Result<(), String> {
    let announcer = MailChangeAnnouncer::new(&app, &account_id);
    let outcome =
        apply_move_messages(app, auth, engine, account_id, message_ids, destination).await;
    announcer.announce(outcome)
}

async fn apply_move_messages<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    message_ids: Vec<String>,
    destination: String,
) -> Result<(), String> {
    let change = LabelChange::moving_to(destination)?;
    apply_to_messages(app, auth, engine, account_id, message_ids, change).await
}
