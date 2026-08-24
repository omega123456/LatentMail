use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use rusqlite::{params, Connection};
use tauri::{AppHandle, Runtime};

use crate::{
    auth::AuthService,
    storage::{MessageRepository, Storage},
};

use super::{dto::MutationResultDto, gmail_base_url, MutationOutcome, SyncEngine};

pub const REMOVABLE_SYSTEM_FOLDER_LABELS: [&str; 3] = ["INBOX", "SPAM", "TRASH"];
pub const MOVE_DESTINATIONS: [&str; 3] = ["INBOX", "SPAM", "TRASH"];

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
    let add = HashSet::from(["TRASH".to_owned()]);
    let remove = REMOVABLE_SYSTEM_FOLDER_LABELS
        .iter()
        .filter(|label| **label != "TRASH" && membership.contains(**label))
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

#[derive(Clone)]
enum Intent {
    Delete,
    Move(String),
}

fn compute_labels(
    intent: &Intent,
    membership: &HashSet<String>,
) -> (HashSet<String>, HashSet<String>) {
    match intent {
        Intent::Delete => delete_labels(membership),
        Intent::Move(destination) => move_labels(membership, destination),
    }
}

async fn apply_thread_intent<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    thread_ids: Vec<String>,
    intent: Intent,
) -> Result<Vec<MutationResultDto>, String> {
    let token = auth.refresh_access_token(&app, &account_id).await?;
    let base_url = gmail_base_url();
    let client = engine.gmail_client(&account_id, token, base_url).await;
    let drafts_by_thread =
        super::mutations::draft_message_ids(engine.storage(), &account_id, &thread_ids).await?;
    let membership_by_thread =
        thread_raw_membership_many(engine.storage(), &account_id, &thread_ids).await?;

    let mut results = Vec::with_capacity(thread_ids.len());
    let mut tasks = tokio::task::JoinSet::new();
    for thread_id in thread_ids {
        let drafts = drafts_by_thread
            .get(&thread_id)
            .cloned()
            .unwrap_or_default();
        if !drafts.is_empty() {
            for message_id in drafts {
                super::mutations::delete_draft(engine.storage(), &client, &account_id, &message_id)
                    .await?;
            }
            results.push(MutationResultDto {
                thread_id,
                outcome: MutationOutcome::Applied.into(),
            });
            continue;
        }
        let engine_ref = Arc::clone(&engine);
        let client = client.clone();
        let account = account_id.clone();
        let intent = intent.clone();
        let membership = membership_by_thread
            .get(&thread_id)
            .cloned()
            .unwrap_or_default();
        tasks.spawn(async move {
            let (add, remove) = compute_labels(&intent, &membership);
            if let Err(error) = super::commands::reject_protected_label_mutation(
                &add.iter().cloned().collect::<Vec<_>>(),
                &remove.iter().cloned().collect::<Vec<_>>(),
            ) {
                return (thread_id, Err(error));
            }
            let outcome = engine_ref
                .mutate(&account, client, thread_id.clone(), add, remove)
                .await;
            (thread_id, outcome.map_err(|error| error.to_string()))
        });
    }
    while let Some(outcome) = tasks.join_next().await {
        let (thread_id, outcome) = outcome.map_err(|error| error.to_string())?;
        let outcome = outcome?;
        results.push(MutationResultDto {
            thread_id,
            outcome: outcome.into(),
        });
    }
    Ok(results)
}

async fn apply_message_intent<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    message_ids: Vec<String>,
    intent: Intent,
) -> Result<(), String> {
    let token = auth.refresh_access_token(&app, &account_id).await?;
    let base_url = gmail_base_url();
    let client = engine.gmail_client(&account_id, token, base_url).await;
    let membership_by_message =
        message_raw_membership_many(engine.storage(), &account_id, &message_ids).await?;
    let mut tasks = tokio::task::JoinSet::new();
    for message_id in message_ids {
        let engine_ref = Arc::clone(&engine);
        let client = client.clone();
        let account = account_id.clone();
        let intent = intent.clone();
        let membership = membership_by_message
            .get(&message_id)
            .cloned()
            .unwrap_or_default();
        tasks.spawn(async move {
            let (add, remove) = compute_labels(&intent, &membership);
            super::commands::reject_protected_label_mutation(
                &add.iter().cloned().collect::<Vec<_>>(),
                &remove.iter().cloned().collect::<Vec<_>>(),
            )?;
            engine_ref
                .mutate_message(&account, client, message_id, add, remove)
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
    apply_thread_intent(app, auth, engine, account_id, thread_ids, Intent::Delete).await
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
    validate_destination(&destination)?;
    apply_thread_intent(
        app,
        auth,
        engine,
        account_id,
        thread_ids,
        Intent::Move(destination),
    )
    .await
}

#[tauri::command]
pub async fn delete_messages<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    message_ids: Vec<String>,
) -> Result<(), String> {
    apply_message_intent(app, auth, engine, account_id, message_ids, Intent::Delete).await
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
    validate_destination(&destination)?;
    apply_message_intent(
        app,
        auth,
        engine,
        account_id,
        message_ids,
        Intent::Move(destination),
    )
    .await
}
