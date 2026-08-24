use super::{
    credentials,
    provider::{Provider, ProviderModel},
    AiConfigDto, AiService,
};
use tauri::{AppHandle, Runtime, State};
#[tauri::command]
pub async fn read_ai_configs(service: State<'_, AiService>) -> Result<Vec<AiConfigDto>, String> {
    service.configs().await
}
#[tauri::command]
pub async fn set_ai_enabled<R: Runtime>(
    app: AppHandle<R>,
    service: State<'_, AiService>,
    account_id: String,
    enabled: bool,
) -> Result<(), String> {
    service.set_enabled(&app, account_id, enabled).await
}
#[tauri::command]
pub async fn set_ai_base_url<R: Runtime>(
    app: AppHandle<R>,
    service: State<'_, AiService>,
    account_id: String,
    base_url: String,
) -> Result<(), String> {
    service.set_base_url(&app, account_id, base_url).await
}
#[tauri::command]
pub async fn set_ai_api_key<R: Runtime>(
    app: AppHandle<R>,
    service: State<'_, AiService>,
    account_id: String,
    api_key: String,
) -> Result<(), String> {
    if api_key.is_empty() {
        return Err("API key cannot be empty".to_owned());
    }
    service.require_account(&account_id).await?;
    credentials::save(&account_id, &api_key)?;
    tauri::Emitter::emit(
        &app,
        "ai://config",
        serde_json::json!({"accountId":account_id}),
    )
    .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn clear_ai_api_key<R: Runtime>(
    app: AppHandle<R>,
    service: State<'_, AiService>,
    account_id: String,
) -> Result<(), String> {
    service.require_account(&account_id).await?;
    credentials::clear(&account_id)?;
    tauri::Emitter::emit(
        &app,
        "ai://config",
        serde_json::json!({"accountId":account_id}),
    )
    .map_err(|error| error.to_string())
}
async fn provider_for(service: &AiService, account_id: &str) -> Result<Provider, String> {
    let config = service.config_for(account_id).await?;
    let base_url = config
        .base_url
        .ok_or_else(|| "Save an API root first".to_owned())?;
    Provider::new(&base_url, credentials::load(account_id)?)
}
#[tauri::command]
pub async fn test_ai_connection(
    service: State<'_, AiService>,
    account_id: String,
) -> Result<usize, String> {
    Ok(provider_for(&service, &account_id)
        .await?
        .models()
        .await
        .map_err(|error| error.to_string())?
        .len())
}
#[tauri::command]
pub async fn list_ai_models(
    service: State<'_, AiService>,
    account_id: String,
) -> Result<Vec<ProviderModel>, String> {
    provider_for(&service, &account_id)
        .await?
        .models()
        .await
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn select_ai_chat_model<R: Runtime>(
    app: AppHandle<R>,
    service: State<'_, AiService>,
    account_id: String,
    model: Option<String>,
) -> Result<(), String> {
    service.set_chat_model(&app, account_id, model).await
}
#[tauri::command]
pub async fn select_ai_embedding_model<R: Runtime>(
    app: AppHandle<R>,
    service: State<'_, AiService>,
    sync: State<'_, std::sync::Arc<crate::sync::SyncEngine>>,
    account_id: String,
    model: String,
) -> Result<(), String> {
    let vector = provider_for(&service, &account_id)
        .await?
        .embed(&model, vec!["LatentMail embedding validation".to_owned()])
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .next()
        .ok_or_else(|| "Provider returned no embedding".to_owned())?;
    if vector.is_empty() {
        return Err("Provider returned an empty embedding".to_owned());
    }
    let dimensions =
        i64::try_from(vector.len()).map_err(|_| "Embedding dimension is too large".to_owned())?;
    let service = service.inner().clone();
    service.begin_reconfiguration(&account_id)?;
    sync.cancel_embedding(&account_id).await;
    let queued_service = service.clone();
    let control_service = service.clone();
    let queued_sync = sync.inner().clone();
    let queued_account = account_id.clone();
    let control_account = account_id.clone();
    let queued = sync
        .enqueue_embedding(
            &account_id.clone(),
            "Change embedding model".to_owned(),
            async move {
                let changed = service
                    .set_embedding_model(&app, account_id.clone(), model, dimensions)
                    .await;
                service.finish_reconfiguration(&queued_account)?;
                changed?;
                super::index::enqueue(app, queued_service, queued_sync, queued_account).await
            },
        )
        .await
        .map_err(|error| error.to_string());
    if queued.is_err() {
        control_service.finish_reconfiguration(&control_account)?;
    }
    queued
}
#[tauri::command]
pub async fn read_ai_index_status(
    service: State<'_, AiService>,
) -> Result<Vec<super::index::IndexStatus>, String> {
    super::index::statuses(&service).await
}
#[tauri::command]
pub async fn start_ai_index<R: Runtime>(
    app: AppHandle<R>,
    service: State<'_, AiService>,
    sync: State<'_, std::sync::Arc<crate::sync::SyncEngine>>,
    account_id: String,
) -> Result<(), String> {
    super::index::set_paused(&app, &service, account_id.clone(), false).await?;
    super::index::enqueue(
        app,
        service.inner().clone(),
        sync.inner().clone(),
        account_id,
    )
    .await
}
#[tauri::command]
pub async fn cancel_ai_index<R: Runtime>(
    app: AppHandle<R>,
    service: State<'_, AiService>,
    account_id: String,
) -> Result<(), String> {
    super::index::set_paused(&app, &service, account_id, true).await
}
#[tauri::command]
pub async fn rebuild_ai_index<R: Runtime>(
    app: AppHandle<R>,
    service: State<'_, AiService>,
    sync: State<'_, std::sync::Arc<crate::sync::SyncEngine>>,
    account_id: String,
) -> Result<(), String> {
    service.require_account(&account_id).await?;
    let service = service.inner().clone();
    sync.cancel_embedding(&account_id).await;
    let queued_sync = sync.inner().clone();
    sync.enqueue_embedding(
        &account_id.clone(),
        "Rebuild semantic index".to_owned(),
        async move { super::index::rebuild(&app, &service, queued_sync, account_id).await },
    )
    .await
    .map_err(|error| error.to_string())
}
