use serde::Deserialize;
use tauri::Runtime;

use crate::ipc::{AppServices, CommandPayload};

use super::{
    chat::{self, ChatBeginRequest},
    index::{self, IndexContext, PauseUpdate},
    provider::ProviderModel,
    AiConfigDto, ApiKeyUpdate, BaseUrlUpdate, ChatModelUpdate, EnabledUpdate,
    SelectEmbeddingRequest,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAiEnabledPayload {
    pub account_id: String,
    pub enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAiBaseUrlPayload {
    pub account_id: String,
    pub base_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAiApiKeyPayload {
    pub account_id: String,
    pub api_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectAiChatModelPayload {
    pub account_id: String,
    pub model: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectAiEmbeddingModelPayload {
    pub account_id: String,
    pub model: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAiChatPayload {
    pub account_id: String,
    pub session_id: String,
    pub question: String,
}

fn index_context<R: Runtime>(services: &AppServices<'_, R>) -> Result<IndexContext<R>, String> {
    Ok(IndexContext {
        app: services.app().clone(),
        service: services.ai()?.inner().clone(),
        sync: services.sync()?.inner().clone(),
    })
}

#[tauri::command]
pub async fn read_ai_configs<R: Runtime>(
    services: AppServices<'_, R>,
) -> Result<Vec<AiConfigDto>, String> {
    services.ai()?.configs().await
}

#[tauri::command]
pub async fn set_ai_enabled<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(payload): CommandPayload<SetAiEnabledPayload>,
) -> Result<(), String> {
    services
        .ai()?
        .set_enabled(
            services.app(),
            EnabledUpdate {
                account_id: payload.account_id,
                enabled: payload.enabled,
            },
        )
        .await
}

#[tauri::command]
pub async fn set_ai_base_url<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(payload): CommandPayload<SetAiBaseUrlPayload>,
) -> Result<(), String> {
    services
        .ai()?
        .set_base_url(
            services.app(),
            BaseUrlUpdate {
                account_id: payload.account_id,
                base_url: payload.base_url,
            },
        )
        .await
}

#[tauri::command]
pub async fn set_ai_api_key<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(payload): CommandPayload<SetAiApiKeyPayload>,
) -> Result<(), String> {
    services
        .ai()?
        .set_api_key(
            services.app(),
            ApiKeyUpdate {
                account_id: payload.account_id,
                api_key: payload.api_key,
            },
        )
        .await
}

#[tauri::command]
pub async fn clear_ai_api_key<R: Runtime>(
    services: AppServices<'_, R>,
    account_id: String,
) -> Result<(), String> {
    services
        .ai()?
        .clear_api_key(services.app(), &account_id)
        .await
}

#[tauri::command]
pub async fn test_ai_connection<R: Runtime>(
    services: AppServices<'_, R>,
    account_id: String,
) -> Result<usize, String> {
    services.ai()?.test_connection(&account_id).await
}

#[tauri::command]
pub async fn list_ai_models<R: Runtime>(
    services: AppServices<'_, R>,
    account_id: String,
) -> Result<Vec<ProviderModel>, String> {
    services.ai()?.list_models(&account_id).await
}

#[tauri::command]
pub async fn select_ai_chat_model<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(payload): CommandPayload<SelectAiChatModelPayload>,
) -> Result<(), String> {
    services
        .ai()?
        .set_chat_model(
            services.app(),
            ChatModelUpdate {
                account_id: payload.account_id,
                model: payload.model,
            },
        )
        .await
}

#[tauri::command]
pub async fn select_ai_embedding_model<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(payload): CommandPayload<SelectAiEmbeddingModelPayload>,
) -> Result<(), String> {
    services
        .ai()?
        .select_embedding_model(
            index_context(&services)?,
            SelectEmbeddingRequest {
                account_id: payload.account_id,
                model: payload.model,
            },
        )
        .await
}

#[tauri::command]
pub async fn read_ai_index_status<R: Runtime>(
    services: AppServices<'_, R>,
) -> Result<Vec<index::IndexStatus>, String> {
    index::statuses(services.ai()?.inner()).await
}

#[tauri::command]
pub async fn start_ai_index<R: Runtime>(
    services: AppServices<'_, R>,
    account_id: String,
) -> Result<(), String> {
    index::start(index_context(&services)?, account_id).await
}

#[tauri::command]
pub async fn cancel_ai_index<R: Runtime>(
    services: AppServices<'_, R>,
    account_id: String,
) -> Result<(), String> {
    index::set_paused(
        services.app(),
        services.ai()?.inner(),
        PauseUpdate {
            account_id: account_id,
            paused: true,
        },
    )
    .await
}

#[tauri::command]
pub async fn rebuild_ai_index<R: Runtime>(
    services: AppServices<'_, R>,
    account_id: String,
) -> Result<(), String> {
    index::request_rebuild(index_context(&services)?, account_id).await
}

#[tauri::command]
pub async fn start_ai_chat<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(payload): CommandPayload<StartAiChatPayload>,
) -> Result<String, String> {
    chat::start(
        services.app().clone(),
        services.ai()?.inner(),
        ChatBeginRequest {
            account_id: &payload.account_id,
            session_id: &payload.session_id,
            question: &payload.question,
        },
    )
    .await
}

#[tauri::command]
pub async fn cancel_ai_chat<R: Runtime>(
    services: AppServices<'_, R>,
    request_id: String,
) -> Result<bool, String> {
    services.ai()?.chat().cancel(&request_id)
}
