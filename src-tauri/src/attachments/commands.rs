use std::sync::Arc;

use serde::Serialize;
use tauri::{
    ipc::{CommandArg, CommandItem, InvokeError},
    AppHandle, Manager, Runtime, State,
};

use crate::{
    storage::AttachmentRepository,
    sync::services::{managed, GmailServices},
};

use super::{cache::CachedAttachment, AttachmentCache};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CachedAttachmentDto {
    pub cache_path: String,
    pub display_path: String,
    pub mime_type: String,
    pub filename: String,
    pub size: u64,
}

impl From<CachedAttachment> for CachedAttachmentDto {
    fn from(value: CachedAttachment) -> Self {
        Self {
            cache_path: value.cache_path.to_string_lossy().into_owned(),
            display_path: value.display_path.to_string_lossy().into_owned(),
            mime_type: value.mime_type,
            filename: value.filename,
            size: value.size,
        }
    }
}

pub struct AttachmentServices<'a, R: Runtime> {
    gmail: GmailServices<'a, R>,
    cache: State<'a, AttachmentCache>,
}

impl<'a, R: Runtime> AttachmentServices<'a, R> {
    pub fn new(app: &'a AppHandle<R>) -> Result<Self, String> {
        Ok(Self {
            gmail: GmailServices::new(app)?,
            cache: managed(app)?,
        })
    }
}

impl<'a, R: Runtime> CommandArg<'a, R> for AttachmentServices<'a, R> {
    fn from_command(command: CommandItem<'a, R>) -> Result<Self, InvokeError> {
        Self::new(command.message.webview_ref().app_handle()).map_err(InvokeError::from)
    }
}

pub struct AttachmentKey {
    pub account_id: String,
    pub message_id: String,
    pub attachment_id: String,
}

async fn ensure_cached<R: Runtime>(
    services: &AttachmentServices<'_, R>,
    key: &AttachmentKey,
) -> Result<CachedAttachment, String> {
    let account = key.account_id.clone();
    let message = key.message_id.clone();
    let attachment = key.attachment_id.clone();
    let record = services
        .gmail
        .storage
        .run(move |connection| {
            AttachmentRepository::get(connection, &account, &message, &attachment)
        })
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Attachment metadata is unavailable".to_owned())?;
    let client = services.gmail.client(&key.account_id).await?;
    match services
        .cache
        .ensure(
            &client,
            &key.account_id,
            &key.message_id,
            &key.attachment_id,
            &record.filename,
            &record.mime_type,
        )
        .await
    {
        Ok(cached) => Ok(cached),
        Err(error) => super::refetch(
            &services.cache,
            &client,
            &key.account_id,
            &key.message_id,
            &record,
        )
        .await
        .map_err(|_| error),
    }
}

async fn read_cached_bytes(cached: CachedAttachment) -> Result<Vec<u8>, String> {
    tokio::task::spawn_blocking(move || std::fs::read(cached.cache_path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn ensure_attachment_cached<R: Runtime>(
    services: AttachmentServices<'_, R>,
    account_id: String,
    message_id: String,
    attachment_id: String,
) -> Result<CachedAttachmentDto, String> {
    let key = AttachmentKey {
        account_id,
        message_id,
        attachment_id,
    };
    let cached = ensure_cached(&services, &key).await?;
    Ok(cached.into())
}

#[tauri::command]
pub async fn read_attachment_bytes<R: Runtime>(
    services: AttachmentServices<'_, R>,
    account_id: String,
    message_id: String,
    attachment_id: String,
) -> Result<tauri::ipc::Response, String> {
    let key = AttachmentKey {
        account_id,
        message_id,
        attachment_id,
    };
    let cached = ensure_cached(&services, &key).await?;
    let bytes = read_cached_bytes(cached).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn read_attachment_text<R: Runtime>(
    services: AttachmentServices<'_, R>,
    account_id: String,
    message_id: String,
    attachment_id: String,
) -> Result<String, String> {
    let key = AttachmentKey {
        account_id,
        message_id,
        attachment_id,
    };
    let cached = ensure_cached(&services, &key).await?;
    let bytes = read_cached_bytes(cached).await?;
    Ok(super::decode_text(&bytes))
}

#[tauri::command]
pub async fn save_attachment_to_path<R: Runtime>(
    services: AttachmentServices<'_, R>,
    account_id: String,
    message_id: String,
    attachment_id: String,
    destination: String,
) -> Result<(), String> {
    let key = AttachmentKey {
        account_id,
        message_id,
        attachment_id,
    };
    let cached = ensure_cached(&services, &key).await?;
    tokio::task::spawn_blocking(move || std::fs::copy(cached.cache_path, destination))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn stage_attachment_into_draft<R: Runtime>(
    services: AttachmentServices<'_, R>,
    staging: State<'_, Arc<crate::compose::staging::Staging>>,
    account_id: String,
    message_id: String,
    attachment_id: String,
    owner: String,
) -> Result<crate::sync::StagedAttachmentDto, String> {
    let key = AttachmentKey {
        account_id,
        message_id,
        attachment_id,
    };
    let cached = ensure_cached(&services, &key).await?;
    let descriptor = crate::compose::staging::StagedPart {
        id: crate::compose::drafts::generate_id("staged"),
        filename: cached.filename.clone(),
        mime_type: cached.mime_type.clone(),
        path: std::path::PathBuf::new(),
        content_id: None,
        size: 0,
    };
    let staging = Arc::clone(staging.inner());
    let account_id = key.account_id;
    let part = tokio::task::spawn_blocking(move || {
        let bytes = std::fs::read(cached.cache_path)?;
        staging.stage_bytes(&account_id, &owner, &descriptor, &bytes)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;
    Ok(part.into())
}
