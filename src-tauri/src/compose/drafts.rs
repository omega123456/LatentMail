use std::{
    collections::hash_map::RandomState,
    hash::{BuildHasher, Hasher},
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::Mutex;

use crate::{
    gmail::{GmailClient, GmailError, GmailMessage},
    queue::{
        self, Executor, Lane, OperationFuture, OperationKind, QueueEngine, QueueError,
        QueueOperation,
    },
    storage::{
        ComposeDraftMetadata, ComposeDraftMetadataRepository, MessageRepository,
        OperationRepository, Storage, ThreadRepository,
    },
    sync::materialize,
};

use super::{
    mime::{self, OutgoingMessage},
    staging::Staging,
};

pub fn generate_id(prefix: &str) -> String {
    let random = RandomState::new().build_hasher().finish();
    format!(
        "{prefix}-{}-{random:x}",
        chrono::Utc::now().timestamp_millis()
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DraftOperationMode {
    Create,
    Update,
    Send,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftOperationPayload {
    pub mode: DraftOperationMode,
    pub draft_id: Option<String>,
    pub thread_id: Option<String>,
    pub from: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub html: String,
    pub quote_html: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub metadata_mode: String,
    pub original_message_id: Option<String>,
    pub original_gmail_message_id: Option<String>,
    pub editable_body_fingerprint: Option<String>,
    pub quote_plain: Option<String>,
    #[serde(default)]
    pub coalescing_generation: u64,
}

#[derive(Default)]
pub struct SaveCoalescer {
    generations: Mutex<std::collections::HashMap<String, u64>>,
    draft_ids: Mutex<std::collections::HashMap<String, String>>,
}
impl SaveCoalescer {
    pub fn new() -> Self {
        Self::default()
    }
    pub async fn schedule(&self, key: &str) -> u64 {
        let mut generations = self.generations.lock().await;
        let generation = generations.entry(key.to_owned()).or_insert(0);
        *generation += 1;
        *generation
    }
    pub async fn is_current(&self, key: &str, generation: u64) -> bool {
        let generations = self.generations.lock().await;
        generations.get(key).copied() == Some(generation)
    }
    pub async fn set_draft_id(&self, key: &str, draft_id: String) {
        self.draft_ids.lock().await.insert(key.to_owned(), draft_id);
    }
    pub async fn draft_id(&self, key: &str) -> Option<String> {
        self.draft_ids.lock().await.get(key).cloned()
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn admit(
    engine: &Arc<QueueEngine>,
    storage: &Storage,
    staging: &Staging,
    coalescer: &SaveCoalescer,
    id: String,
    account_id: String,
    entity_key: String,
    mut payload: DraftOperationPayload,
    parts: &[super::staging::StagedPart],
) -> Result<u64, String> {
    staging
        .snapshot(&id, parts)
        .map_err(|error| error.to_string())?;
    let generation = coalescer.schedule(&entity_key).await;
    payload.coalescing_generation = generation;
    let kind = match payload.mode {
        DraftOperationMode::Send => OperationKind::Send,
        DraftOperationMode::Create | DraftOperationMode::Update => OperationKind::Draft,
    };
    let description = match kind {
        OperationKind::Send => format!("Send: {}", payload.subject),
        _ => format!("Draft: {}", payload.subject),
    };
    let payload_json = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
    queue::admit_durable(
        engine,
        storage,
        QueueOperation {
            id,
            account_id,
            lane: Lane::Interactive,
            kind,
            entity_key,
            cost: 0,
            attempts: 0,
            description,
        },
        payload_json,
    )
    .await
    .map(|()| generation)
    .map_err(str::to_owned)
}

pub async fn delete(
    client: &GmailClient,
    storage: &Storage,
    account_id: &str,
    draft_id: &str,
) -> Result<(), String> {
    client
        .delete_draft(draft_id)
        .await
        .map_err(|error| error.to_string())?;
    let account = account_id.to_owned();
    let draft = draft_id.to_owned();
    storage
        .run(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            if let Some(thread_id) =
                MessageRepository::delete_by_draft_id(&transaction, &account, &draft)?
            {
                ThreadRepository::recompute(&transaction, &account, &thread_id)?;
            }
            ComposeDraftMetadataRepository::remove(&transaction, &account, &draft)?;
            transaction.commit()
        })
        .await
        .map_err(|error| error.to_string())
}

pub fn build_executor<R: Runtime>(
    app: AppHandle<R>,
    storage: Storage,
    staging: Arc<Staging>,
    coalescer: Arc<SaveCoalescer>,
    base_url: String,
) -> Executor {
    Arc::new(move |operation: QueueOperation| -> OperationFuture {
        let app = app.clone();
        let storage = storage.clone();
        let staging = Arc::clone(&staging);
        let coalescer = Arc::clone(&coalescer);
        let base_url = base_url.clone();
        Box::pin(
            async move { run(&app, &storage, &staging, &coalescer, &base_url, operation).await },
        )
    })
}

async fn terminal_failed<R: Runtime>(
    app: &AppHandle<R>,
    storage: &Storage,
    operation: &QueueOperation,
    error: &str,
) {
    tracing::error!(target: "compose", "operation {} failed: {error}", operation.id);
    let id = operation.id.clone();
    let owned = error.to_owned();
    let _ = storage
        .run(move |connection| {
            OperationRepository::mark_terminal(connection, &id, "failed", Some(&owned))
        })
        .await;
    let _ = app.emit(
        "compose://failed",
        serde_json::json!({
            "accountId": operation.account_id,
            "sessionId": operation.entity_key,
            "kind": if operation.kind == OperationKind::Send { "send" } else { "draft" },
            "error": error,
        }),
    );
}

fn classify(error: &GmailError) -> QueueError {
    match error {
        GmailError::Network(_) => QueueError::Network,
        GmailError::Http(code @ (429 | 500..=599)) => QueueError::Http(*code),
        _ => QueueError::Permanent,
    }
}

async fn run<R: Runtime>(
    app: &AppHandle<R>,
    storage: &Storage,
    staging: &Staging,
    coalescer: &SaveCoalescer,
    base_url: &str,
    operation: QueueOperation,
) -> Result<(), QueueError> {
    let id = operation.id.clone();
    let row = {
        let id = id.clone();
        storage
            .run(move |connection| OperationRepository::get(connection, &id))
            .await
            .map_err(|_| QueueError::Permanent)?
    };
    let Some(row) = row else {
        return Ok(());
    };
    if row.status == "discarded" {
        let _ = staging.release_snapshot(&id);
        return Ok(());
    }
    let mut payload: DraftOperationPayload = match serde_json::from_str(&row.payload) {
        Ok(payload) => payload,
        Err(error) => {
            terminal_failed(app, storage, &operation, &error.to_string()).await;
            return Err(QueueError::Permanent);
        }
    };
    {
        let id = id.clone();
        let _ = storage
            .run(move |connection| OperationRepository::mark_active(connection, &id))
            .await;
    }

    if !coalescer
        .is_current(&operation.entity_key, payload.coalescing_generation)
        .await
    {
        let _ = staging.release_snapshot(&id);
        let id = id.clone();
        let _ = storage
            .run(move |connection| {
                OperationRepository::mark_terminal(connection, &id, "superseded", None)
            })
            .await;
        return Ok(());
    }

    let created_server_draft = matches!(payload.mode, DraftOperationMode::Create);
    if created_server_draft {
        if let Some(draft_id) = coalescer.draft_id(&operation.entity_key).await {
            payload.mode = DraftOperationMode::Update;
            payload.draft_id = Some(draft_id);
        }
    }

    let manifest = match staging.snapshot_manifest(&id) {
        Ok(manifest) => manifest,
        Err(error) => {
            terminal_failed(app, storage, &operation, &error.to_string()).await;
            return Err(QueueError::Permanent);
        }
    };
    let mut inline = Vec::new();
    let mut attachments = Vec::new();
    for part in &manifest.parts {
        match part.read() {
            Ok(read) if part.content_id.is_some() => inline.push(read),
            Ok(read) => attachments.push(read),
            Err(error) => {
                terminal_failed(app, storage, &operation, &error.to_string()).await;
                return Err(QueueError::Permanent);
            }
        }
    }

    let (quote_html, original_inline) = if let Some(original_id) = &payload.original_message_id {
        let account_id = operation.account_id.clone();
        let original_id = original_id.clone();
        storage
            .run(move |connection| {
                let message = MessageRepository::get(connection, &account_id, &original_id)?;
                let parts = MessageRepository::inline_parts(connection, &account_id, &original_id)?;
                Ok::<_, rusqlite::Error>((message, parts))
            })
            .await
            .ok()
            .and_then(|(message, parts)| {
                message.map(|message| {
                    let body = message
                        .html_body
                        .or(message
                            .plain_body
                            .map(|plain| format!("<pre>{plain}</pre>")))
                        .unwrap_or_default();
                    let attribution = chrono::DateTime::from_timestamp(message.sent_at, 0)
                        .map(|value| value.format("%b %-d, %Y at %H:%M").to_string())
                        .unwrap_or_default();
                    (
                        Some(format!(
                            "<p>On {attribution}, {} wrote:</p><blockquote>{body}</blockquote>",
                            message.sender
                        )),
                        parts,
                    )
                })
            })
            .unwrap_or((None, Vec::new()))
    } else {
        (None, Vec::new())
    };
    inline.extend(original_inline.into_iter().map(|part| super::mime::Part {
        filename: part.content_id.clone(),
        mime_type: part.mime_type,
        bytes: part.bytes,
        content_id: Some(part.content_id),
    }));

    let outgoing = OutgoingMessage {
        from: payload.from.clone(),
        to: payload.to.clone(),
        cc: payload.cc.clone(),
        bcc: payload.bcc.clone(),
        subject: payload.subject.clone(),
        html: payload.html.clone(),
        quote_html: quote_html.clone(),
        in_reply_to: payload.in_reply_to.clone(),
        references: payload.references.clone(),
        inline,
        attachments,
    };
    let raw = match mime::assemble(&outgoing) {
        Ok(raw) => raw,
        Err(error) => {
            terminal_failed(app, storage, &operation, &error.to_string()).await;
            return Err(QueueError::Permanent);
        }
    };

    let auth = app.state::<crate::auth::AuthService>().inner().clone();
    let token = match auth.refresh_access_token(app, &operation.account_id).await {
        Ok(token) => token,
        Err(error) => {
            terminal_failed(app, storage, &operation, &error).await;
            return Err(QueueError::Network);
        }
    };
    let client = GmailClient::with_base_url(token, base_url.to_owned());

    let (message, consumed, draft_id) = match execute_gmail(&client, &payload, &raw).await {
        Ok(outcome) => outcome,
        Err(error) => {
            let queue_error = classify(&error);

            terminal_failed(app, storage, &operation, &error.to_string()).await;
            return Err(queue_error);
        }
    };

    if created_server_draft && !consumed && payload.draft_id.is_none() {
        coalescer
            .set_draft_id(&operation.entity_key, draft_id.clone())
            .await;
    }

    let discarded = {
        let id = id.clone();
        storage
            .run(move |connection| {
                Ok::<_, rusqlite::Error>(
                    crate::storage::OperationRepository::get(connection, &id)?
                        .map(|row| row.status == "discarded")
                        .unwrap_or(false),
                )
            })
            .await
            .unwrap_or(false)
    };
    if discarded {
        let _ = client.delete_draft(&draft_id).await;
        let _ = staging.release_snapshot(&id);
        let _ = staging.release_owner(&operation.account_id, &operation.entity_key);
        return Ok(());
    }

    if created_server_draft
        && payload.draft_id.is_none()
        && !consumed
        && !operation.entity_key.starts_with("draft:")
    {
        if let Err(error) =
            staging.move_owner(&operation.account_id, &operation.entity_key, &draft_id)
        {
            terminal_failed(app, storage, &operation, &error.to_string()).await;
            return Err(QueueError::Permanent);
        }
    }

    let account_id = operation.account_id.clone();
    let metadata = ComposeDraftMetadata {
        account_id: account_id.clone(),
        draft_id: draft_id.clone(),
        mode: payload.metadata_mode.clone(),
        original_message_id: payload.original_message_id.clone(),
        original_gmail_message_id: payload.original_gmail_message_id.clone(),
        target_thread_id: payload.thread_id.clone(),
        in_reply_to: payload.in_reply_to.clone(),
        rfc_references: (!payload.references.is_empty()).then(|| payload.references.join(" ")),
        boundary_version: 1,
        editable_body_fingerprint: payload.editable_body_fingerprint.clone(),

        quote_html: quote_html.clone(),
        quote_plain: payload.quote_plain.clone(),
    };
    let persisted = {
        let account_id = account_id.clone();
        let draft_id = draft_id.clone();
        storage
            .run(move |connection| {
                let transaction = connection.unchecked_transaction()?;
                materialize::replace_draft_rows(
                    &transaction,
                    &account_id,
                    &draft_id,
                    &message,
                    consumed,
                )?;
                if !consumed {
                    ComposeDraftMetadataRepository::upsert(&transaction, &metadata)?;
                } else {
                    crate::contacts::observe_now(&transaction, &account_id, &message.sender)?;
                    for mailbox in message
                        .to_recipients
                        .split(',')
                        .chain(message.cc_recipients.split(','))
                        .map(str::trim)
                        .filter(|mailbox| !mailbox.is_empty())
                    {
                        crate::contacts::observe_now(&transaction, &account_id, mailbox)?;
                    }
                }
                transaction.commit()
            })
            .await
    };
    if let Err(error) = persisted {
        terminal_failed(app, storage, &operation, &error.to_string()).await;

        return Err(QueueError::Permanent);
    }

    let _ = staging.release_snapshot(&id);
    if consumed {
        let _ = staging.release_owner(&account_id, &draft_id);

        if payload.draft_id.is_none() {
            let _ = staging.release_owner(&account_id, &operation.entity_key);
        }
    }
    let id_for_terminal = id.clone();
    let _ = storage
        .run(move |connection| {
            OperationRepository::mark_terminal(connection, &id_for_terminal, "done", None)
        })
        .await;
    let event = if consumed {
        "send://complete"
    } else {
        "draft://saved"
    };
    let _ = app.emit(event, serde_json::json!({ "accountId": account_id, "sessionId": operation.entity_key, "draftId": draft_id }));
    Ok(())
}

async fn execute_gmail(
    client: &GmailClient,
    payload: &DraftOperationPayload,
    raw: &[u8],
) -> Result<(GmailMessage, bool, String), GmailError> {
    match payload.mode {
        DraftOperationMode::Create => {
            let draft_id = client
                .create_draft(raw, payload.thread_id.as_deref())
                .await?;
            let full = client.draft(&draft_id).await?;
            Ok((full.message, false, full.id))
        }
        DraftOperationMode::Update => {
            let draft_id = payload
                .draft_id
                .clone()
                .expect("update carries an existing draft id");
            client
                .update_draft(&draft_id, raw, payload.thread_id.as_deref())
                .await?;
            let full = client.draft(&draft_id).await?;
            Ok((full.message, false, full.id))
        }
        DraftOperationMode::Send => {
            let draft_id = match &payload.draft_id {
                Some(draft_id) => {
                    client
                        .update_draft(draft_id, raw, payload.thread_id.as_deref())
                        .await?;
                    draft_id.clone()
                }
                None => {
                    client
                        .create_draft(raw, payload.thread_id.as_deref())
                        .await?
                }
            };
            let sent_id = client.send_draft(&draft_id).await?;

            let message = client.message(&sent_id).await?;
            Ok((message, true, draft_id))
        }
    }
}

pub async fn hydrate(
    client: &GmailClient,
    draft_id: &str,
) -> Result<crate::gmail::GmailDraft, GmailError> {
    client.draft(draft_id).await
}
