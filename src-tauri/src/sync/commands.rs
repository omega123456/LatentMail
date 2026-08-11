//! The Mail read commands and the Sync trigger/status commands (Phase 17's
//! IPC surface — Phase 18 wires the UI against these).

use std::{collections::HashMap, sync::Arc};

use tauri::{AppHandle, Runtime};

use crate::{
    auth::AuthService,
    gmail::GmailClient,
    sanitize::{self, CidPart},
    storage::{LabelRepository, MessageRepository, Storage, ThreadRepository},
};

use super::{
    dto::message_dto, ConversationDto, LabelDto, SyncEngine, SyncStatusDto, ThreadCursor,
    ThreadDto, ThreadPage,
};

const DEFAULT_PAGE_SIZE: i64 = 50;

#[tauri::command]
pub async fn list_labels(
    storage: tauri::State<'_, Storage>,
    account_id: String,
) -> Result<Vec<LabelDto>, String> {
    storage
        .run(move |connection| LabelRepository::list(connection, &account_id))
        .await
        .map(|labels| labels.into_iter().map(LabelDto::from).collect())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn list_threads(
    storage: tauri::State<'_, Storage>,
    account_id: String,
    label_id: Option<String>,
    cursor: Option<ThreadCursor>,
    limit: Option<u32>,
) -> Result<ThreadPage, String> {
    let limit = limit.map_or(DEFAULT_PAGE_SIZE, |value| value as i64).max(1);
    let cursor_pair = cursor.map(|cursor| (cursor.latest_at, cursor.id));
    let mut threads = storage
        .run(move |connection| {
            ThreadRepository::list_paginated(
                connection,
                &account_id,
                label_id.as_deref(),
                cursor_pair,
                limit + 1,
            )
        })
        .await
        .map_err(|error| error.to_string())?;
    let next_cursor = if threads.len() as i64 > limit {
        threads.truncate(limit as usize);
        threads.last().map(|thread| ThreadCursor {
            latest_at: thread.latest_at,
            id: thread.id.clone(),
        })
    } else {
        None
    };
    Ok(ThreadPage {
        items: threads.into_iter().map(ThreadDto::from).collect(),
        next_cursor,
    })
}

#[tauri::command]
pub async fn load_conversation(
    storage: tauri::State<'_, Storage>,
    account_id: String,
    thread_id: String,
) -> Result<ConversationDto, String> {
    let (account_for_read, thread_for_read) = (account_id.clone(), thread_id.clone());
    let (messages, thread_subject) = storage
        .run(move |connection| {
            let messages =
                MessageRepository::list_by_thread(connection, &account_for_read, &thread_for_read)?;
            let subject = ThreadRepository::get(connection, &account_for_read, &thread_for_read)?
                .map(|thread| thread.subject)
                .unwrap_or_default();
            Ok((messages, subject))
        })
        .await
        .map_err(|error| error.to_string())?;

    let mut message_dtos = Vec::with_capacity(messages.len());
    for message in messages {
        let (account_for_labels, id_for_labels) = (account_id.clone(), message.id.clone());
        let (account_for_parts, id_for_parts) = (account_id.clone(), message.id.clone());
        let label_ids = storage
            .run(move |connection| {
                MessageRepository::label_ids(connection, &account_for_labels, &id_for_labels)
            })
            .await
            .map_err(|error| error.to_string())?;
        let sanitized_html = match &message.html_body {
            Some(html) => {
                let inline_parts = storage
                    .run(move |connection| {
                        MessageRepository::inline_parts(
                            connection,
                            &account_for_parts,
                            &id_for_parts,
                        )
                    })
                    .await
                    .map_err(|error| error.to_string())?;
                let cid_map: HashMap<String, CidPart> = inline_parts
                    .into_iter()
                    .map(|part| {
                        (
                            part.content_id,
                            CidPart {
                                bytes: part.bytes,
                                mime_type: part.mime_type,
                            },
                        )
                    })
                    .collect();
                Some(sanitize::sanitize(html, &cid_map).html)
            }
            None => None,
        };
        message_dtos.push(message_dto(message, label_ids, sanitized_html));
    }

    Ok(ConversationDto {
        thread_id,
        subject: thread_subject,
        messages: message_dtos,
    })
}

async fn mutate_thread<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    thread_id: String,
    label_id: &'static str,
    present: bool,
) -> Result<(), String> {
    let token = auth.refresh_access_token(&app, &account_id).await?;
    let client = match std::env::var("LATENTMAIL_GMAIL_BASE_URL") {
        Ok(url) => GmailClient::with_base_url(token, url),
        Err(_) => GmailClient::new(token),
    };
    engine
        .mutate_thread(&account_id, client, thread_id, label_id, present)
        .await
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn star_thread<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    thread_id: String,
) -> Result<(), String> {
    mutate_thread(app, auth, engine, account_id, thread_id, "STARRED", true).await
}
#[tauri::command]
pub async fn unstar_thread<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    thread_id: String,
) -> Result<(), String> {
    mutate_thread(app, auth, engine, account_id, thread_id, "STARRED", false).await
}
#[tauri::command]
pub async fn mark_thread_read<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    thread_id: String,
) -> Result<(), String> {
    mutate_thread(app, auth, engine, account_id, thread_id, "UNREAD", false).await
}
#[tauri::command]
pub async fn mark_thread_unread<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    thread_id: String,
) -> Result<(), String> {
    mutate_thread(app, auth, engine, account_id, thread_id, "UNREAD", true).await
}

#[tauri::command]
pub async fn trigger_sync<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
) -> Result<SyncStatusDto, String> {
    let token = auth.refresh_access_token(&app, &account_id).await?;
    // Mirrors the `LATENTMAIL_GOOGLE_TOKEN_URL`-style override in `auth`:
    // lets integration tests point this at a local fake Gmail server
    // instead of the real API.
    let client = match std::env::var("LATENTMAIL_GMAIL_BASE_URL") {
        Ok(base_url) => GmailClient::with_base_url(token, base_url),
        Err(_) => GmailClient::new(token),
    };
    let engine = Arc::clone(&engine);
    let result = engine.run_sync(&account_id, client).await;
    let status = engine.status(&account_id).await;
    result.map_err(|error| error.to_string())?;
    Ok(status)
}

#[tauri::command]
pub async fn read_sync_status(
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
) -> Result<SyncStatusDto, String> {
    Ok(engine.status(&account_id).await)
}
