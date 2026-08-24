use crate::{
    ai::{
        chunker, credentials,
        provider::{Provider, ProviderError},
        AiService, IndexState,
    },
    storage::{AccountAiConfigRepository, EmbeddingRepository, MessageEmbedding},
};
use std::{future::Future, pin::Pin, time::Duration};
use tauri::{AppHandle, Emitter, Runtime};

pub const MAX_CHUNKS_PER_OPERATION: usize = 64;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub account_id: String,
    pub state: IndexState,
    pub indexed: i64,
    pub total: i64,
    pub indexed_messages: i64,
    pub total_eligible_messages: i64,
    pub indexed_passages: i64,
    pub paused: bool,
    pub error: Option<String>,
}

pub async fn status(service: &AiService, account_id: String) -> Result<IndexStatus, String> {
    let error = service.index_error(&account_id)?;
    let has_error = error.is_some();
    let state = service.index_state(&account_id)?;
    service
        .storage()
        .run(move |connection| {
            let config = AccountAiConfigRepository::get(connection, &account_id)?
                .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
            let counts = EmbeddingRepository::counts(connection, &account_id)?;
            Ok(IndexStatus {
                account_id: account_id.clone(),
                indexed: counts.indexed_messages,
                total: counts.total_eligible_messages,
                indexed_messages: counts.indexed_messages,
                total_eligible_messages: counts.total_eligible_messages,
                indexed_passages: counts.indexed_passages,
                paused: config.index_paused,
                error,
                state: if has_error {
                    IndexState::Interrupted
                } else if !config.enabled || config.embedding_model.is_none() {
                    IndexState::Unavailable
                } else if config.index_paused {
                    IndexState::Paused
                } else {
                    state.unwrap_or({
                        if counts.total_eligible_messages == 0 {
                            IndexState::NotStarted
                        } else if counts.indexed_messages < counts.total_eligible_messages {
                            IndexState::Interrupted
                        } else {
                            IndexState::Complete
                        }
                    })
                },
            })
        })
        .await
        .map_err(|error| error.to_string())
}

pub async fn statuses(service: &AiService) -> Result<Vec<IndexStatus>, String> {
    let configs = service.configs().await?;
    let mut statuses = Vec::new();
    for config in configs
        .into_iter()
        .filter(|config| config.enabled && config.embedding_model.is_some())
    {
        statuses.push(status(service, config.account_id).await?);
    }
    Ok(statuses)
}

fn running(service: &AiService, account_id: &str) -> Result<bool, String> {
    Ok(matches!(
        service.index_state(account_id)?,
        Some(IndexState::Preparing) | Some(IndexState::Building)
    ))
}

async fn stall<R: Runtime>(
    app: &AppHandle<R>,
    service: &AiService,
    account_id: String,
) -> Result<(), String> {
    if !running(service, &account_id)? {
        return Ok(());
    }
    let current = status(service, account_id.clone()).await?;
    if current.indexed < current.total {
        service.set_index_state(&account_id, IndexState::Partial)?;
    } else {
        service.set_index_state(&account_id, IndexState::Complete)?;
    }
    emit_status(app, service, account_id).await
}

pub fn enqueue<R: Runtime>(
    app: AppHandle<R>,
    service: AiService,
    sync: std::sync::Arc<crate::sync::SyncEngine>,
    account_id: String,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> {
    Box::pin(enqueue_inner(app, service, sync, account_id))
}

async fn enqueue_inner<R: Runtime>(
    app: AppHandle<R>,
    service: AiService,
    sync: std::sync::Arc<crate::sync::SyncEngine>,
    account_id: String,
) -> Result<(), String> {
    if service.is_removing(&account_id)? || service.is_reconfiguring(&account_id)? {
        return stall(&app, &service, account_id).await;
    }
    let config = service.config_for(&account_id).await?;
    if !config.enabled || config.index_paused || config.embedding_model.is_none() {
        return stall(&app, &service, account_id).await;
    }
    if !running(&service, &account_id)? {
        service.set_index_state(&account_id, IndexState::Preparing)?;
        emit_status(&app, &service, account_id.clone()).await?;
    }
    let queued_account = account_id.clone();
    let queued_service = service.clone();
    let queued_sync = sync.clone();
    sync.enqueue_embedding(
        &account_id.clone(),
        "Build semantic index".to_owned(),
        async move {
            if !service.index_ready(&account_id).await? {
                service.set_index_state(&account_id, IndexState::Unavailable)?;
                emit_status(&app, &service, account_id).await?;
                return Ok(());
            }
            if service.index_state(&account_id)? != Some(IndexState::Building) {
                service.set_index_state(&account_id, IndexState::Building)?;
                emit_status(&app, &service, account_id.clone()).await?;
            }
            if let Err(error) = build(&app, &service, account_id.clone()).await {
                service.set_index_error(&account_id, error)?;
                service.set_index_state(&account_id, IndexState::Interrupted)?;
                emit_status(&app, &service, account_id).await?;
                return Ok(());
            }
            service.clear_index_error(&account_id)?;
            if !service.index_ready(&account_id).await? {
                service.set_index_state(&account_id, IndexState::Unavailable)?;
                emit_status(&app, &service, account_id).await?;
                return Ok(());
            }
            let current = status(&service, account_id.clone()).await?;
            if !current.paused && current.indexed < current.total {
                enqueue(app, queued_service, queued_sync, queued_account).await?;
            } else if !current.paused {
                service.set_index_state(&account_id, IndexState::Complete)?;
                emit_status(&app, &service, account_id).await?;
            } else {
                service.set_index_state(&account_id, IndexState::Paused)?;
                emit_status(&app, &service, account_id).await?;
            }
            Ok(())
        },
    )
    .await
    .map_err(|error| error.to_string())
}

pub async fn build<R: Runtime>(
    app: &AppHandle<R>,
    service: &AiService,
    account_id: String,
) -> Result<(), String> {
    if service.is_removing(&account_id)? || service.is_reconfiguring(&account_id)? {
        return Ok(());
    }
    let config = service.config_for(&account_id).await?;
    if !config.enabled || config.index_paused {
        return Ok(());
    }
    let model = config
        .embedding_model
        .ok_or_else(|| "Select an embedding model first".to_owned())?;
    let dimensions = config
        .embedding_dimensions
        .ok_or_else(|| "Embedding dimensions are missing".to_owned())?;
    let base_url = config
        .base_url
        .ok_or_else(|| "Save an API root first".to_owned())?;
    let storage = service.storage();
    let id = account_id.clone();
    storage
        .run(move |connection| EmbeddingRepository::create(connection, &id, dimensions))
        .await
        .map_err(|error| error.to_string())?;
    let id = account_id.clone();
    let batch = storage
        .run(move |connection| {
            EmbeddingRepository::backlog(connection, &id, MAX_CHUNKS_PER_OPERATION as i64)
        })
        .await
        .map_err(|error| error.to_string())?;
    if batch.is_empty() {
        return Ok(());
    }
    let mut inputs = Vec::new();
    for message in batch {
        let chunks = chunker::chunks(
            &message.sender,
            &message.recipients,
            &message.subject,
            message.truncated_body.as_deref(),
            message.plain_body.as_deref(),
            message.html_body.as_deref(),
        );
        if inputs.len() + chunks.len() > MAX_CHUNKS_PER_OPERATION {
            break;
        }
        inputs.extend(
            chunks
                .into_iter()
                .enumerate()
                .map(|(index, text)| (message.message_seq, index, text)),
        );
    }
    if inputs.is_empty() {
        return Ok(());
    }
    let provider = Provider::new(&base_url, credentials::load(&account_id)?)?;
    let vectors = embed_with_retry(
        &provider,
        &model,
        inputs.iter().map(|(_, _, text)| text.clone()).collect(),
        3,
        |attempt| Duration::from_millis(50 * u64::from(attempt)),
    )
    .await?;
    if vectors.len() != inputs.len() {
        return Err("Provider returned an incomplete embedding batch".to_owned());
    }
    let entries = inputs
        .into_iter()
        .zip(vectors)
        .map(|((message_seq, chunk_index, _), vector)| {
            Ok(MessageEmbedding {
                message_seq,
                chunk_index: i64::try_from(chunk_index)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?,
                vector,
            })
        })
        .collect::<Result<Vec<_>, rusqlite::Error>>()
        .map_err(|error| error.to_string())?;
    let id = account_id.clone();
    storage
        .run(move |connection| EmbeddingRepository::write(connection, &id, &entries))
        .await
        .map_err(|error| error.to_string())?;
    emit_status(app, service, account_id).await?;
    Ok(())
}

pub async fn emit_status<R: Runtime>(
    app: &AppHandle<R>,
    service: &AiService,
    account_id: String,
) -> Result<(), String> {
    let current = status(service, account_id.clone()).await?;
    app.emit(
        "ai://index",
        serde_json::json!({"accountId":account_id,"state":current.state,"indexed":current.indexed,"total":current.total,"indexedMessages":current.indexed_messages,"totalEligibleMessages":current.total_eligible_messages,"indexedPassages":current.indexed_passages,"paused":current.paused,"error":current.error}),
    )
    .map_err(|error| error.to_string())
}

pub async fn embed_with_retry<F>(
    provider: &Provider,
    model: &str,
    input: Vec<String>,
    attempts: u8,
    backoff: F,
) -> Result<Vec<Vec<f32>>, String>
where
    F: Fn(u8) -> Duration,
{
    for attempt in 0..attempts {
        match provider.embed(model, input.clone()).await {
            Ok(vectors) => return Ok(vectors),
            Err(error) if error.transient() && attempt + 1 < attempts => {
                tokio::time::sleep(backoff(attempt + 1)).await;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Err(ProviderError::Response.to_string())
}

pub async fn set_paused<R: Runtime>(
    app: &AppHandle<R>,
    service: &AiService,
    account_id: String,
    paused: bool,
) -> Result<(), String> {
    let id = account_id.clone();
    service
        .storage()
        .run(move |connection| AccountAiConfigRepository::set_index_paused(connection, &id, paused))
        .await
        .map_err(|error| error.to_string())?;
    if !paused {
        service.set_index_state(&account_id, IndexState::NotStarted)?;
    }
    if !paused {
        service.clear_index_error(&account_id)?;
    }
    app.emit("ai://config", serde_json::json!({"accountId":account_id}))
        .map_err(|error| error.to_string())?;
    emit_status(app, service, account_id).await
}

pub async fn rebuild<R: Runtime>(
    app: &AppHandle<R>,
    service: &AiService,
    sync: std::sync::Arc<crate::sync::SyncEngine>,
    account_id: String,
) -> Result<(), String> {
    let config = service.config_for(&account_id).await?;
    let dimensions = config
        .embedding_dimensions
        .ok_or_else(|| "Embedding dimensions are missing".to_owned())?;
    let id = account_id.clone();
    service
        .storage()
        .run(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            EmbeddingRepository::drop(&transaction, &id)?;
            EmbeddingRepository::create(&transaction, &id, dimensions)?;
            AccountAiConfigRepository::set_index_paused(&transaction, &id, false)?;
            transaction.commit()
        })
        .await
        .map_err(|error| error.to_string())?;
    service.clear_index_error(&account_id)?;
    service.set_index_state(&account_id, IndexState::NotStarted)?;
    app.emit("ai://config", serde_json::json!({"accountId":account_id}))
        .map_err(|error| error.to_string())?;
    emit_status(app, service, account_id.clone()).await?;
    enqueue(app.clone(), service.clone(), sync, account_id).await
}

pub async fn cleanup(service: &AiService, account_id: String) -> Result<(), String> {
    let storage = service.storage();
    let id = account_id.clone();
    storage
        .run(move |connection| EmbeddingRepository::drop(connection, &id))
        .await
        .map_err(|error| error.to_string())?;
    credentials::clear(&account_id)
}
