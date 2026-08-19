use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Runtime, State};

use crate::{
    auth::AuthService,
    storage::{AttachmentRepository, Storage},
    sync::{commands::gmail_client_for, SyncEngine},
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

#[allow(clippy::too_many_arguments)]
async fn ensure_cached<R: Runtime>(
    app: &AppHandle<R>,
    auth: &State<'_, AuthService>,
    engine: &State<'_, Arc<SyncEngine>>,
    storage: &State<'_, Storage>,
    cache: &State<'_, AttachmentCache>,
    account_id: &str,
    message_id: &str,
    attachment_id: &str,
) -> Result<CachedAttachment, String> {
    let account = account_id.to_owned();
    let message = message_id.to_owned();
    let attachment = attachment_id.to_owned();
    let record = storage
        .run(move |connection| {
            AttachmentRepository::get(connection, &account, &message, &attachment)
        })
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Attachment metadata is unavailable".to_owned())?;
    let client = gmail_client_for(app, auth, engine, account_id).await?;
    cache
        .ensure(
            &client,
            account_id,
            message_id,
            attachment_id,
            &record.filename,
            &record.mime_type,
        )
        .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ensure_attachment_cached<R: Runtime>(
    app: AppHandle<R>,
    auth: State<'_, AuthService>,
    engine: State<'_, Arc<SyncEngine>>,
    storage: State<'_, Storage>,
    cache: State<'_, AttachmentCache>,
    account_id: String,
    message_id: String,
    attachment_id: String,
) -> Result<CachedAttachmentDto, String> {
    let cached = ensure_cached(
        &app,
        &auth,
        &engine,
        &storage,
        &cache,
        &account_id,
        &message_id,
        &attachment_id,
    )
    .await?;
    Ok(cached.into())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn read_attachment_bytes<R: Runtime>(
    app: AppHandle<R>,
    auth: State<'_, AuthService>,
    engine: State<'_, Arc<SyncEngine>>,
    storage: State<'_, Storage>,
    cache: State<'_, AttachmentCache>,
    account_id: String,
    message_id: String,
    attachment_id: String,
) -> Result<tauri::ipc::Response, String> {
    let cached = ensure_cached(
        &app,
        &auth,
        &engine,
        &storage,
        &cache,
        &account_id,
        &message_id,
        &attachment_id,
    )
    .await?;
    let bytes = std::fs::read(&cached.cache_path).map_err(|error| error.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn read_attachment_text<R: Runtime>(
    app: AppHandle<R>,
    auth: State<'_, AuthService>,
    engine: State<'_, Arc<SyncEngine>>,
    storage: State<'_, Storage>,
    cache: State<'_, AttachmentCache>,
    account_id: String,
    message_id: String,
    attachment_id: String,
) -> Result<String, String> {
    let cached = ensure_cached(
        &app,
        &auth,
        &engine,
        &storage,
        &cache,
        &account_id,
        &message_id,
        &attachment_id,
    )
    .await?;
    let bytes = std::fs::read(&cached.cache_path).map_err(|error| error.to_string())?;
    Ok(super::decode_text(&bytes))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn save_attachment_to_path<R: Runtime>(
    app: AppHandle<R>,
    auth: State<'_, AuthService>,
    engine: State<'_, Arc<SyncEngine>>,
    storage: State<'_, Storage>,
    cache: State<'_, AttachmentCache>,
    account_id: String,
    message_id: String,
    attachment_id: String,
    destination: String,
) -> Result<(), String> {
    let cached = ensure_cached(
        &app,
        &auth,
        &engine,
        &storage,
        &cache,
        &account_id,
        &message_id,
        &attachment_id,
    )
    .await?;
    std::fs::copy(&cached.cache_path, &destination).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn stage_attachment_into_draft<R: Runtime>(
    app: AppHandle<R>,
    auth: State<'_, AuthService>,
    engine: State<'_, Arc<SyncEngine>>,
    storage: State<'_, Storage>,
    cache: State<'_, AttachmentCache>,
    staging: State<'_, Arc<crate::compose::staging::Staging>>,
    account_id: String,
    message_id: String,
    attachment_id: String,
    owner: String,
) -> Result<crate::sync::StagedAttachmentDto, String> {
    let cached = ensure_cached(
        &app,
        &auth,
        &engine,
        &storage,
        &cache,
        &account_id,
        &message_id,
        &attachment_id,
    )
    .await?;
    let bytes = std::fs::read(&cached.cache_path).map_err(|error| error.to_string())?;
    let descriptor = crate::compose::staging::StagedPart {
        id: crate::compose::drafts::generate_id("staged"),
        filename: cached.filename.clone(),
        mime_type: cached.mime_type.clone(),
        path: std::path::PathBuf::new(),
        content_id: None,
        size: 0,
    };
    let part = staging
        .stage_bytes(&account_id, &owner, &descriptor, &bytes)
        .map_err(|error| error.to_string())?;
    Ok(part.into())
}
