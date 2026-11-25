use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::Runtime;

use crate::{
    compose::staging::{OwnerScope, StagedPart},
    ipc::{AppServices, CommandPayload},
    storage::AttachmentRepository,
};

use super::{
    cache::{AttachmentDescriptor, AttachmentRef, CachedAttachment},
    RefetchRequest,
};

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentKey {
    pub account_id: String,
    pub message_id: String,
    pub attachment_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAttachmentRequest {
    pub account_id: String,
    pub message_id: String,
    pub attachment_id: String,
    pub destination: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageAttachmentIntoDraftRequest {
    pub account_id: String,
    pub message_id: String,
    pub attachment_id: String,
    pub owner: String,
}

async fn ensure_cached<R: Runtime>(
    services: &AppServices<'_, R>,
    key: &AttachmentKey,
) -> Result<CachedAttachment, String> {
    let storage = services.storage()?;
    let cache = services.attachment_cache()?;
    let account = key.account_id.clone();
    let message = key.message_id.clone();
    let attachment = key.attachment_id.clone();
    let record = storage
        .run(move |connection| {
            AttachmentRepository::get(
                connection,
                crate::storage::MessageKey {
                    account_id: &account,
                    message_id: &message,
                },
                &attachment,
            )
        })
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Attachment metadata is unavailable".to_owned())?;
    let client = services.gmail_client(&key.account_id).await?;
    let descriptor = AttachmentDescriptor {
        target: AttachmentRef {
            account_id: &key.account_id,
            message_id: &key.message_id,
            attachment_id: &key.attachment_id,
        },
        filename: &record.filename,
        mime_type: &record.mime_type,
    };
    match cache.ensure(&client, descriptor).await {
        Ok(cached) => Ok(cached),
        Err(error) => super::refetch(
            cache.inner(),
            &client,
            RefetchRequest {
                account_id: &key.account_id,
                message_id: &key.message_id,
                record: &record,
            },
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

async fn load_cached_dto<R: Runtime>(
    services: AppServices<'_, R>,
    key: AttachmentKey,
) -> Result<CachedAttachmentDto, String> {
    Ok(ensure_cached(&services, &key).await?.into())
}

async fn load_attachment_bytes<R: Runtime>(
    services: AppServices<'_, R>,
    key: AttachmentKey,
) -> Result<tauri::ipc::Response, String> {
    let cached = ensure_cached(&services, &key).await?;
    Ok(tauri::ipc::Response::new(read_cached_bytes(cached).await?))
}

async fn load_attachment_text<R: Runtime>(
    services: AppServices<'_, R>,
    key: AttachmentKey,
) -> Result<String, String> {
    let cached = ensure_cached(&services, &key).await?;
    Ok(super::decode_text(&read_cached_bytes(cached).await?))
}

async fn save_attachment<R: Runtime>(
    services: AppServices<'_, R>,
    request: SaveAttachmentRequest,
) -> Result<(), String> {
    let key = AttachmentKey {
        account_id: request.account_id,
        message_id: request.message_id,
        attachment_id: request.attachment_id,
    };
    let cached = ensure_cached(&services, &key).await?;
    tokio::task::spawn_blocking(move || std::fs::copy(cached.cache_path, request.destination))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    Ok(())
}

async fn stage_into_draft<R: Runtime>(
    services: AppServices<'_, R>,
    request: StageAttachmentIntoDraftRequest,
) -> Result<crate::sync::StagedAttachmentDto, String> {
    let staging = Arc::clone(services.staging()?.inner());
    let key = AttachmentKey {
        account_id: request.account_id,
        message_id: request.message_id,
        attachment_id: request.attachment_id,
    };
    let cached = ensure_cached(&services, &key).await?;
    let descriptor = StagedPart {
        id: crate::compose::drafts::generate_id("staged"),
        filename: cached.filename.clone(),
        mime_type: cached.mime_type.clone(),
        path: std::path::PathBuf::new(),
        content_id: None,
        size: 0,
    };
    let account_id = key.account_id;
    let owner = request.owner;
    let part = tokio::task::spawn_blocking(move || {
        let bytes = std::fs::read(cached.cache_path)?;
        staging.stage_bytes(crate::compose::staging::StageBytesRequest {
            scope: OwnerScope {
                account_id: &account_id,
                owner: &owner,
            },
            descriptor: &descriptor,
            bytes: &bytes,
        })
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;
    Ok(part.into())
}

#[tauri::command]
pub async fn ensure_attachment_cached<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(key): CommandPayload<AttachmentKey>,
) -> Result<CachedAttachmentDto, String> {
    load_cached_dto(services, key).await
}

#[tauri::command]
pub async fn read_attachment_bytes<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(key): CommandPayload<AttachmentKey>,
) -> Result<tauri::ipc::Response, String> {
    load_attachment_bytes(services, key).await
}

#[tauri::command]
pub async fn read_attachment_text<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(key): CommandPayload<AttachmentKey>,
) -> Result<String, String> {
    load_attachment_text(services, key).await
}

#[tauri::command]
pub async fn save_attachment_to_path<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<SaveAttachmentRequest>,
) -> Result<(), String> {
    save_attachment(services, request).await
}

#[tauri::command]
pub async fn stage_attachment_into_draft<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(request): CommandPayload<StageAttachmentIntoDraftRequest>,
) -> Result<crate::sync::StagedAttachmentDto, String> {
    stage_into_draft(services, request).await
}
