use serde::Deserialize;
use tauri::Runtime;

use crate::ipc::{AppServices, CommandPayload};

use super::{AccountQueueSnapshot, PauseScope};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetQueuePausedPayload {
    pub scope: PauseScope,
    pub paused: bool,
}

#[tauri::command]
pub async fn read_queue_operations<R: Runtime>(
    services: AppServices<'_, R>,
) -> Result<Vec<AccountQueueSnapshot>, String> {
    Ok(services.queue()?.snapshot().await)
}

#[tauri::command]
pub async fn cancel_queue_operation<R: Runtime>(
    services: AppServices<'_, R>,
    operation_id: String,
) -> Result<bool, String> {
    services
        .queue()?
        .cancel_durable(services.storage()?.inner(), operation_id)
        .await
}

#[tauri::command]
pub async fn retry_queue_operation<R: Runtime>(
    services: AppServices<'_, R>,
    operation_id: String,
) -> Result<bool, String> {
    services
        .queue()?
        .retry_durable(services.storage()?.inner(), operation_id)
        .await
}

#[tauri::command]
pub async fn retry_failed_operations<R: Runtime>(
    services: AppServices<'_, R>,
    account_id: Option<String>,
) -> Result<usize, String> {
    services
        .queue()?
        .retry_all_failed(services.storage()?.inner(), account_id)
        .await
}

#[tauri::command]
pub fn clear_queue_history<R: Runtime>(
    services: AppServices<'_, R>,
    account_id: Option<String>,
) -> Result<(), String> {
    services.queue()?.clear_history(account_id.as_deref());
    Ok(())
}

#[tauri::command]
pub async fn set_queue_paused<R: Runtime>(
    services: AppServices<'_, R>,
    CommandPayload(payload): CommandPayload<SetQueuePausedPayload>,
) -> Result<bool, String> {
    Ok(services
        .queue()?
        .set_paused(&payload.scope, payload.paused)
        .await)
}
