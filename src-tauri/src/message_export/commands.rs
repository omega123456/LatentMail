use serde::{Deserialize, Serialize};
use tauri::Runtime;

use crate::{
    gmail::GmailError,
    ipc::{AccountMessageRequest, AppServices, CommandPayload},
    storage::{AttachmentRepository, Message, MessageRepository, Storage},
    sync::to_millis,
};

use super::{
    authentication_results, collapse_encoded_bodies, export_document, ExportAttachments,
    RecipientRoles,
};

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMessageRequest {
    pub account_id: String,
    pub message_id: String,
    pub destination: String,
}

struct StoredExportMessage {
    message: Message,
    to: String,
    cc: String,
}

async fn stored_message(
    storage: &Storage,
    account_id: &str,
    message_id: &str,
) -> Result<StoredExportMessage, String> {
    let account = account_id.to_owned();
    let id = message_id.to_owned();
    storage
        .run(move |connection| {
            let Some(message) = MessageRepository::get(connection, &account, &id)? else {
                return Ok(None);
            };
            let roles = MessageRepository::recipient_roles(connection, &account, &id)?;
            Ok(Some(StoredExportMessage {
                message: message,
                to: roles.to,
                cc: roles.cc,
            }))
        })
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| MESSAGE_UNAVAILABLE.to_owned())
}

async fn raw_source<R: Runtime>(
    services: &AppServices<'_, R>,
    account_id: &str,
    message_id: &str,
) -> Result<Vec<u8>, String> {
    let client = services.gmail_client(account_id).await?;
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

fn resolve_to_header(to: String, fallback_recipients: String) -> String {
    if to.is_empty() {
        return fallback_recipients;
    }
    to
}

async fn load_source<R: Runtime>(
    services: AppServices<'_, R>,
    request: AccountMessageRequest,
) -> Result<MessageSourceDto, String> {
    let stored = stored_message(
        services.storage()?.inner(),
        &request.account_id,
        &request.message_id,
    )
    .await?;
    let bytes = raw_source(&services, &request.account_id, &request.message_id).await?;
    let raw = String::from_utf8_lossy(&bytes).into_owned();
    Ok(MessageSourceDto {
        message_id: stored.message.rfc_message_id,
        sent_at: to_millis(stored.message.sent_at),
        sender: stored.message.sender,
        to: resolve_to_header(stored.to, stored.message.recipients),
        cc: stored.cc,
        subject: stored.message.subject,
        authentication_results: authentication_results(&raw),
        size_bytes: bytes.len() as u64,
        display: collapse_encoded_bodies(&raw),
        raw: raw,
    })
}

async fn save_source<R: Runtime>(
    services: AppServices<'_, R>,
    request: SaveMessageRequest,
) -> Result<(), String> {
    let bytes = raw_source(&services, &request.account_id, &request.message_id).await?;
    write_file(request.destination, bytes).await
}

async fn save_html<R: Runtime>(
    services: AppServices<'_, R>,
    request: SaveMessageRequest,
) -> Result<(), String> {
    let storage = services.storage()?;
    let stored = stored_message(storage.inner(), &request.account_id, &request.message_id).await?;
    let account_id = request.account_id;
    let message_id = request.message_id;
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
        &stored.message,
        &RecipientRoles {
            to: &stored.to,
            cc: &stored.cc,
        },
        ExportAttachments {
            attachments: &attachments,
            inline_parts: &inline_parts,
        },
    )
    .ok_or_else(|| BODY_NOT_LOADED.to_owned())?;
    write_file(request.destination, document.into_bytes()).await
}

#[tauri::command]
pub async fn read_message_source<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<AccountMessageRequest>,
) -> Result<MessageSourceDto, String> {
    load_source(services, request).await
}

#[tauri::command]
pub async fn save_message_source_to_path<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<SaveMessageRequest>,
) -> Result<(), String> {
    save_source(services, request).await
}

#[tauri::command]
pub async fn save_message_html_to_path<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<SaveMessageRequest>,
) -> Result<(), String> {
    save_html(services, request).await
}
