use std::sync::Arc;

use tauri::State;

use crate::storage::{OperationRepository, Storage};

use super::{recovered_queue_operation, AccountQueueSnapshot, PauseScope, QueueEngine};

#[tauri::command]
pub async fn read_queue_operations(
    queue: State<'_, Arc<QueueEngine>>,
) -> Result<Vec<AccountQueueSnapshot>, String> {
    Ok(queue.snapshot().await)
}

#[tauri::command]
pub async fn cancel_queue_operation(
    queue: State<'_, Arc<QueueEngine>>,
    storage: State<'_, Storage>,
    operation_id: String,
) -> Result<bool, String> {
    let Some(cancelled) = queue.cancel(&operation_id).await else {
        return Ok(false);
    };
    if !cancelled.kind.persists() {
        return Ok(true);
    }
    let id = operation_id.clone();
    storage
        .run(move |connection| {
            OperationRepository::mark_terminal(connection, &id, "cancelled", None)
        })
        .await
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn retry_queue_operation(
    queue: State<'_, Arc<QueueEngine>>,
    storage: State<'_, Storage>,
    operation_id: String,
) -> Result<bool, String> {
    let id = operation_id.clone();
    let row = storage
        .run(move |connection| OperationRepository::get(connection, &id))
        .await
        .map_err(|error| error.to_string())?;
    let Some(row) = row else {
        return Ok(false);
    };
    if row.status != "failed" {
        return Ok(false);
    }
    let Some(operation) = recovered_queue_operation(&row) else {
        return Ok(false);
    };
    queue
        .enqueue(operation)
        .await
        .map_err(|error| error.to_owned())?;
    Ok(true)
}

#[tauri::command]
pub async fn retry_failed_operations(
    queue: State<'_, Arc<QueueEngine>>,
    storage: State<'_, Storage>,
    account_id: Option<String>,
) -> Result<usize, String> {
    let rows = storage
        .run(move |connection| {
            OperationRepository::failed_durable(connection, account_id.as_deref())
        })
        .await
        .map_err(|error| error.to_string())?;
    let mut retried = 0usize;
    for row in rows {
        if let Some(operation) = recovered_queue_operation(&row) {
            if queue.enqueue(operation).await.is_ok() {
                retried += 1;
            }
        }
    }
    Ok(retried)
}

#[tauri::command]
pub fn clear_queue_history(queue: State<'_, Arc<QueueEngine>>, account_id: Option<String>) {
    queue.clear_history(account_id.as_deref());
}

#[tauri::command]
pub async fn set_queue_paused(
    queue: State<'_, Arc<QueueEngine>>,
    scope: PauseScope,
    paused: bool,
) -> Result<bool, String> {
    Ok(queue.set_paused(&scope, paused).await)
}
