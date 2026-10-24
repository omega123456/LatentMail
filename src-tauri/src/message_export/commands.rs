use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Runtime, State};

use crate::{
    auth::AuthService,
    gmail::GmailError,
    storage::{AttachmentRepository, Message, MessageRepository, Storage},
    sync::{commands::gmail_client_for, to_millis, SyncEngine},
};

use super::{authentication_results, collapse_encoded_bodies, export_document, RecipientRoles};

const SOURCE_TOO_LARGE: &str = "This message is too large to show its source here.";
const MESSAGE_UNAVAILABLE: &str = "Message is unavailable";
const BODY_NOT_LOADED: &str = "Open the message so its content loads, then try again.";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MessageSourceDto {
    pub message_id: Option<String>,
    pub sent_at: i64,
    pub sender: String,
    pub to: String,
    pub cc: String,
    pub subject: String,
    pub authentication_results: Option<String>,
    pub size_bytes: u64,
    pub raw: String,
    pub display: String,
}

async fn stored_message(
    storage: &State<'_, Storage>,
    account_id: &str,
    message_id: &str,
) -> Result<(Message, (String, String, String)), String> {
    let account = account_id.to_owned();
    let id = message_id.to_owned();
    storage
        .run(move |connection| {
            let Some(message) = MessageRepository::get(connection, &account, &id)? else {
                return Ok(None);
            };
            let roles = MessageRepository::recipient_roles(connection, &account, &id)?;
            Ok(Some((message, roles)))
        })
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| MESSAGE_UNAVAILABLE.to_owned())
}

async fn raw_source<R: Runtime>(
    app: &AppHandle<R>,
    auth: &State<'_, AuthService>,
    engine: &State<'_, Arc<SyncEngine>>,
    account_id: &str,
    message_id: &str,
) -> Result<Vec<u8>, String> {
    let client = gmail_client_for(app, auth, engine, account_id).await?;
    client
        .raw_message(message_id)
        .await
        .map_err(|error| match error {
            GmailError::ResponseTooLarge => SOURCE_TOO_LARGE.to_owned(),
            other => other.to_string(),
        })
}

async fn write_file(destination: String, contents: Vec<u8>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || std::fs::write(destination, contents))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn read_message_source<R: Runtime>(
    app: AppHandle<R>,
    auth: State<'_, AuthService>,
    engine: State<'_, Arc<SyncEngine>>,
    storage: State<'_, Storage>,
    account_id: String,
    message_id: String,
) -> Result<MessageSourceDto, String> {
    let (message, (to, cc, _)) = stored_message(&storage, &account_id, &message_id).await?;
    let bytes = raw_source(&app, &auth, &engine, &account_id, &message_id).await?;
    let raw = String::from_utf8_lossy(&bytes).into_owned();
    Ok(MessageSourceDto {
        message_id: message.rfc_message_id,
        sent_at: to_millis(message.sent_at),
        sender: message.sender,
        to: if to.is_empty() {
            message.recipients
        } else {
            to
        },
        cc,
        subject: message.subject,
        authentication_results: authentication_results(&raw),
        size_bytes: bytes.len() as u64,
        display: collapse_encoded_bodies(&raw),
        raw,
    })
}

#[tauri::command]
pub async fn save_message_source_to_path<R: Runtime>(
    app: AppHandle<R>,
    auth: State<'_, AuthService>,
    engine: State<'_, Arc<SyncEngine>>,
    account_id: String,
    message_id: String,
    destination: String,
) -> Result<(), String> {
    let bytes = raw_source(&app, &auth, &engine, &account_id, &message_id).await?;
    write_file(destination, bytes).await
}

#[tauri::command]
pub async fn save_message_html_to_path(
    storage: State<'_, Storage>,
    account_id: String,
    message_id: String,
    destination: String,
) -> Result<(), String> {
    let (message, (to, cc, _)) = stored_message(&storage, &account_id, &message_id).await?;
    let (attachments, inline_parts) = storage
        .run(move |connection| {
            Ok((
                AttachmentRepository::for_message(connection, &account_id, &message_id)?,
                MessageRepository::inline_parts(connection, &account_id, &message_id)?,
            ))
        })
        .await
        .map_err(|error| error.to_string())?;
    let document = export_document(
        &message,
        &RecipientRoles { to: &to, cc: &cc },
        &attachments,
        &inline_parts,
    )
    .ok_or_else(|| BODY_NOT_LOADED.to_owned())?;
    write_file(destination, document.into_bytes()).await
}
