//! The Mail read commands and the Sync trigger/status commands (Phase 17's
//! IPC surface — Phase 18 wires the UI against these).

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use tauri::{AppHandle, Runtime};

use crate::{
    auth::AuthService,
    gmail::labels::resolve_color,
    sanitize::{self, CidPart},
    storage::{
        LabelColor, LabelRepository, MessageRepository, Storage, ThreadRepository,
        TraversalCursorRepository, TraversalKind,
    },
};

use super::{
    dto::message_dto, ConversationDto, LabelDto, MutationResultDto, SyncEngine, SyncStatusDto,
    ThreadCursor, ThreadDto, ThreadPage, TraversalStatusDto,
};

const DEFAULT_PAGE_SIZE: i64 = 50;

macro_rules! string_try {
    ($result:expr) => {
        match $result {
            Ok(value) => value,
            Err(error) => return Err(error.to_string()),
        }
    };
}

#[tauri::command]
pub async fn list_labels(
    storage: tauri::State<'_, Storage>,
    account_id: String,
) -> Result<Vec<LabelDto>, String> {
    let labels = string_try!(storage
        .run(move |connection| LabelRepository::list(connection, &account_id))
        .await);
    Ok(labels.into_iter().map(LabelDto::from).collect())
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
    let mut threads = string_try!(storage
        .run(move |connection| {
            ThreadRepository::list_paginated(
                connection,
                &account_id,
                label_id.as_deref(),
                cursor_pair,
                limit + 1,
            )
        })
        .await);
    let next_cursor = if threads.len() as i64 > limit {
        threads.truncate(limit as usize);
        threads.last().map(|thread| ThreadCursor {
            latest_at: thread.latest_at,
            id: thread.id.clone(),
        })
    } else {
        None
    };
    let items = string_try!(storage
        .run(move |connection| {
            threads
                .into_iter()
                .map(|thread| {
                    let (snippet, labels) =
                        ThreadRepository::row_details(connection, &thread.account_id, &thread.id)?;
                    Ok(ThreadDto::from(thread).with_row_details(snippet, labels))
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .await);
    Ok(ThreadPage { items, next_cursor })
}

#[tauri::command]
pub async fn load_conversation(
    storage: tauri::State<'_, Storage>,
    account_id: String,
    thread_id: String,
) -> Result<ConversationDto, String> {
    let (account_for_read, thread_for_read) = (account_id.clone(), thread_id.clone());
    let (messages, thread_subject) = string_try!(storage
        .run(move |connection| {
            let messages =
                MessageRepository::list_by_thread(connection, &account_for_read, &thread_for_read)?;
            let subject = ThreadRepository::get(connection, &account_for_read, &thread_for_read)?
                .map(|thread| thread.subject)
                .unwrap_or_default();
            Ok((messages, subject))
        })
        .await);

    let mut message_dtos = Vec::with_capacity(messages.len());
    for message in messages {
        let (account_for_labels, id_for_labels) = (account_id.clone(), message.id.clone());
        let (account_for_parts, id_for_parts) = (account_id.clone(), message.id.clone());
        let label_ids = string_try!(storage
            .run(move |connection| {
                MessageRepository::label_ids(connection, &account_for_labels, &id_for_labels)
            })
            .await);
        let (sanitized_html, remote_images_blocked) = match &message.html_body {
            Some(html) => {
                let inline_parts = string_try!(storage
                    .run(move |connection| {
                        MessageRepository::inline_parts(
                            connection,
                            &account_for_parts,
                            &id_for_parts,
                        )
                    })
                    .await);
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
                let sanitized = sanitize::sanitize(html, &cid_map);
                (Some(sanitized.html), sanitized.remote_images_blocked)
            }
            None => (None, false),
        };
        message_dtos.push(message_dto(
            message,
            label_ids,
            sanitized_html,
            remote_images_blocked,
        ));
    }

    Ok(ConversationDto {
        thread_id,
        subject: thread_subject,
        messages: message_dtos,
    })
}

/// Fetches a backfilled message exactly once. The marker, not truncated text,
/// determines whether Gmail is contacted so a cut-off embedding body can
/// never be rendered as a complete email.
#[tauri::command]
pub async fn fetch_message_body<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    storage: tauri::State<'_, Storage>,
    account_id: String,
    message_id: String,
) -> Result<(), String> {
    let account = account_id.clone();
    let id = message_id.clone();
    let presence = string_try!(storage
        .run(move |connection| {
            MessageRepository::get(connection, &account, &id)
                .map(|message| message.map(|value| value.html_presence))
        })
        .await)
        .ok_or_else(|| "Message is unavailable".to_owned())?;
    if !matches!(presence, crate::storage::HtmlPresence::NeverFetched) {
        return Ok(());
    }
    let client = gmail_client_for(&app, &auth, &engine, &account_id).await?;
    let message = string_try!(client
        .message(&message_id)
        .await);
    let html_presence =
        crate::storage::HtmlPresence::from_fetched_body(message.html_body.as_deref());
    let html_body = message.html_body;
    let parts = message
        .inline_parts
        .into_iter()
        .map(|part| crate::storage::InlinePart {
            content_id: part.content_id,
            mime_type: part.mime_type,
            bytes: part.bytes,
        })
        .collect::<Vec<_>>();
    string_try!(storage
        .run(move |connection| {
            MessageRepository::set_html_body(
                connection,
                &account_id,
                &message_id,
                html_body.as_deref(),
                html_presence,
            )?;
            MessageRepository::replace_inline_parts(connection, &account_id, &message_id, &parts)
        })
        .await);
    Ok(())
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
    let base_url = std::env::var("LATENTMAIL_GMAIL_BASE_URL")
        .unwrap_or_else(|_| "https://gmail.googleapis.com/gmail/v1".into());
    let client = engine.gmail_client(&account_id, token, base_url).await;
    // A single label toggling one direction, expressed as the generalized
    // add/remove sets `SyncEngine::mutate` accepts (D6). A superseded
    // outcome is still a success from this command's perspective — the
    // caller's intent was correctly overtaken by a later action.
    let (add, remove) = if present {
        (HashSet::from([label_id.to_owned()]), HashSet::new())
    } else {
        (HashSet::new(), HashSet::from([label_id.to_owned()]))
    };
    string_try!(engine.mutate(&account_id, client, thread_id, add, remove).await);
    Ok(())
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
    let base_url = std::env::var("LATENTMAIL_GMAIL_BASE_URL")
        .unwrap_or_else(|_| "https://gmail.googleapis.com/gmail/v1".into());
    let client = engine.gmail_client(&account_id, token, base_url).await;
    let engine = Arc::clone(&engine);
    let result = engine.run_sync(&account_id, client).await;
    let status = engine.status(&account_id).await;
    string_try!(result);
    Ok(status)
}

#[tauri::command]
pub async fn read_sync_status(
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
) -> Result<SyncStatusDto, String> {
    Ok(engine.status(&account_id).await)
}

// ---------------------------------------------------------------------
// Triage — the whole slice's label-mutating action surface (Phase 3).
// Every one delegates to `SyncEngine::mutate` (Phase 1's coalescing path);
// the drafts exception goes through Gmail's dedicated endpoint instead.
// ---------------------------------------------------------------------

/// The generalized triage command: an owned add/remove label set (D6)
/// applied to every thread in `thread_ids`. Every triage action — delete,
/// move, spam/not-spam, star/unstar, read/unread, and add/remove user
/// labels — is expressible as one call here; callers (Phase 7/8's UI) pick
/// the add/remove sets that express their specific action. Threads are
/// dispatched independently so one thread's outcome never blocks another's.
#[tauri::command]
pub async fn mutate_threads<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    thread_ids: Vec<String>,
    add: Vec<String>,
    remove: Vec<String>,
) -> Result<Vec<MutationResultDto>, String> {
    reject_protected_label_mutation(&add, &remove)?;
    let token = auth.refresh_access_token(&app, &account_id).await?;
    let base_url = std::env::var("LATENTMAIL_GMAIL_BASE_URL")
        .unwrap_or_else(|_| "https://gmail.googleapis.com/gmail/v1".into());
    let client = engine.gmail_client(&account_id, token, base_url).await;
    let add: HashSet<String> = add.into_iter().collect();
    let remove: HashSet<String> = remove.into_iter().collect();

    let mut results = Vec::with_capacity(thread_ids.len());
    let mut tasks = tokio::task::JoinSet::new();
    for thread_id in thread_ids {
        let drafts = super::mutations::draft_message_ids(engine.storage(), &account_id, &thread_id).await?;
        if !drafts.is_empty() {
            if add != HashSet::from(["TRASH".to_owned()]) || !remove.is_empty() {
                return Err("Draft messages cannot be modified; delete them instead.".into());
            }
            for message_id in drafts {
                super::mutations::delete_draft(engine.storage(), &client, &account_id, &message_id).await?;
            }
            results.push(MutationResultDto {
                thread_id,
                outcome: super::MutationOutcome::Applied.into(),
            });
            continue;
        }
        let engine = Arc::clone(&engine);
        let client = client.clone();
        let account_id = account_id.clone();
        let (add, remove) = (add.clone(), remove.clone());
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
            thread_id,
            outcome: outcome.into(),
        });
    }
    Ok(results)
}

/// The narrow message-scoped counterpart to `mutate_threads`.  Only the
/// per-message ribbon uses it for delete/move/spam/labels; star/read remain
/// conversation-wide by design.
#[tauri::command]
pub async fn mutate_messages<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    message_ids: Vec<String>,
    add: Vec<String>,
    remove: Vec<String>,
) -> Result<(), String> {
    reject_protected_label_mutation(&add, &remove)?;
    let token = auth.refresh_access_token(&app, &account_id).await?;
    let base_url = std::env::var("LATENTMAIL_GMAIL_BASE_URL")
        .unwrap_or_else(|_| "https://gmail.googleapis.com/gmail/v1".into());
    let client = engine.gmail_client(&account_id, token, base_url).await;
    let (add, remove): (HashSet<_>, HashSet<_>) =
        (add.into_iter().collect(), remove.into_iter().collect());
    for message_id in message_ids {
        engine
            .mutate_message(
                &account_id,
                client.clone(),
                message_id,
                add.clone(),
                remove.clone(),
            )
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Gmail exposes these as read-only membership states. Keeping the check at
/// the IPC boundary protects keyboard/UI regressions as well as direct IPC.
fn reject_protected_label_mutation(add: &[String], remove: &[String]) -> Result<(), String> {
    if add.iter().chain(remove).any(|label| matches!(label.as_str(), "DRAFT" | "SENT")) {
        return Err("Draft and Sent labels cannot be modified.".into());
    }
    Ok(())
}

/// Deletes a draft — the one documented exception to the coalescing
/// mutation path (Gmail rejects label modification on drafts, so it can
/// only be deleted, never re-labelled). `message_id` doubles as the draft
/// id, which is how Gmail's own drafts endpoint identifies a compose-time
/// message.
#[tauri::command]
pub async fn delete_draft<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    storage: tauri::State<'_, Storage>,
    account_id: String,
    message_id: String,
) -> Result<(), String> {
    let token = auth.refresh_access_token(&app, &account_id).await?;
    let base_url = std::env::var("LATENTMAIL_GMAIL_BASE_URL")
        .unwrap_or_else(|_| "https://gmail.googleapis.com/gmail/v1".into());
    let client = engine.gmail_client(&account_id, token, base_url).await;
    super::mutations::delete_draft(&storage, &client, &account_id, &message_id).await
}

// ---------------------------------------------------------------------
// Label lifecycle — create/rename/recolour/delete, validated and dispatched
// to Gmail before the local row is ever touched, so a rejected write never
// leaves storage and Gmail disagreeing.
// ---------------------------------------------------------------------

async fn gmail_client_for<R: Runtime>(
    app: &AppHandle<R>,
    auth: &tauri::State<'_, AuthService>,
    engine: &tauri::State<'_, Arc<SyncEngine>>,
    account_id: &str,
) -> Result<crate::gmail::GmailClient, String> {
    let token = auth.refresh_access_token(app, account_id).await?;
    let base_url = std::env::var("LATENTMAIL_GMAIL_BASE_URL")
        .unwrap_or_else(|_| "https://gmail.googleapis.com/gmail/v1".into());
    Ok(engine.gmail_client(account_id, token, base_url).await)
}

/// Resolves a palette colour id to Gmail's wire pair, rejecting an
/// off-palette value **before** any network call (D10's pre-flight rule).
fn resolve_color_or_error(color_id: Option<&str>) -> Result<Option<LabelColor>, String> {
    match color_id {
        None => Ok(None),
        Some(id) => resolve_color(id)
            .map(|pair| {
                Some(LabelColor {
                    text: pair.text_color,
                    background: pair.background_color,
                })
            })
            .ok_or_else(|| format!("'{id}' is not a recognised label colour")),
    }
}

#[tauri::command]
pub async fn create_label<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    storage: tauri::State<'_, Storage>,
    account_id: String,
    name: String,
    color_id: Option<String>,
) -> Result<LabelDto, String> {
    let color = resolve_color_or_error(color_id.as_deref())?;
    let account = account_id.clone();
    let trimmed = storage
        .run(move |connection| {
            Ok(LabelRepository::validate_name(
                connection, &account, &name, None,
            ))
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;

    let client = gmail_client_for(&app, &auth, &engine, &account_id).await?;
    let gmail_color = color.as_ref().map(|color| crate::gmail::LabelColorPair {
        text_color: color.text.clone(),
        background_color: color.background.clone(),
    });
    let created = client
        .create_label(&trimmed, gmail_color.as_ref())
        .await
        .map_err(|error| error.to_string())?;

    let stored = super::to_label(&account_id, &created);
    storage
        .run(move |connection| LabelRepository::upsert(connection, &stored))
        .await
        .map_err(|error| error.to_string())?;
    let label = storage
        .run({
            let account_id = account_id.clone();
            let id = created.id.clone();
            move |connection| LabelRepository::get(connection, &account_id, &id)
        })
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "label vanished immediately after creation".to_owned())?;
    Ok(LabelDto::from(label))
}

#[tauri::command]
pub async fn rename_label<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    storage: tauri::State<'_, Storage>,
    account_id: String,
    label_id: String,
    name: String,
) -> Result<LabelDto, String> {
    let (account_for_validate, id_for_validate) = (account_id.clone(), label_id.clone());
    let trimmed = storage
        .run(move |connection| {
            Ok(LabelRepository::validate_name(
                connection,
                &account_for_validate,
                &name,
                Some(&id_for_validate),
            ))
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;

    let client = gmail_client_for(&app, &auth, &engine, &account_id).await?;
    client
        .update_label(&label_id, Some(&trimmed), None)
        .await
        .map_err(|error| error.to_string())?;

    let (account, id, new_name) = (account_id.clone(), label_id.clone(), trimmed);
    storage
        .run(move |connection| LabelRepository::rename(connection, &account, &id, &new_name))
        .await
        .map_err(|error| error.to_string())?;
    let label = storage
        .run(move |connection| LabelRepository::get(connection, &account_id, &label_id))
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "label not found".to_owned())?;
    Ok(LabelDto::from(label))
}

#[tauri::command]
pub async fn recolor_label<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    storage: tauri::State<'_, Storage>,
    account_id: String,
    label_id: String,
    color_id: String,
) -> Result<LabelDto, String> {
    let color = resolve_color_or_error(Some(&color_id))?
        .ok_or_else(|| format!("'{color_id}' is not a recognised label colour"))?;

    let client = gmail_client_for(&app, &auth, &engine, &account_id).await?;
    let gmail_color = crate::gmail::LabelColorPair {
        text_color: color.text.clone(),
        background_color: color.background.clone(),
    };
    client
        .update_label(&label_id, None, Some(&gmail_color))
        .await
        .map_err(|error| error.to_string())?;

    let (account, id, stored_color) = (account_id.clone(), label_id.clone(), color);
    storage
        .run(move |connection| {
            LabelRepository::set_color(connection, &account, &id, Some(&stored_color))
        })
        .await
        .map_err(|error| error.to_string())?;
    let label = storage
        .run(move |connection| LabelRepository::get(connection, &account_id, &label_id))
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "label not found".to_owned())?;
    Ok(LabelDto::from(label))
}

#[tauri::command]
pub async fn delete_label<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    storage: tauri::State<'_, Storage>,
    account_id: String,
    label_id: String,
) -> Result<(), String> {
    let client = gmail_client_for(&app, &auth, &engine, &account_id).await?;
    client
        .delete_label(&label_id)
        .await
        .map_err(|error| error.to_string())?;
    storage
        .run(move |connection| LabelRepository::delete(connection, &account_id, &label_id))
        .await
        .map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------
// Traversal status — a real read against the cursor table Phase 3 stands
// up. Always reports "not started" until Phase 4/5 ever write a row; that
// is correct, not a stub, for a mailbox that hasn't backfilled yet.
// ---------------------------------------------------------------------

#[tauri::command]
pub async fn read_traversal_status(
    storage: tauri::State<'_, Storage>,
    account_id: String,
) -> Result<TraversalStatusDto, String> {
    let account = account_id.clone();
    let (backfill, reconciliation) = storage
        .run(move |connection| {
            let backfill =
                TraversalCursorRepository::get(connection, &account, TraversalKind::Backfill)?;
            let reconciliation = TraversalCursorRepository::get(
                connection,
                &account,
                TraversalKind::Reconciliation,
            )?;
            Ok((backfill, reconciliation))
        })
        .await
        .map_err(|error| error.to_string())?;
    Ok(TraversalStatusDto::most_recent(
        account_id,
        backfill,
        reconciliation,
    ))
}
