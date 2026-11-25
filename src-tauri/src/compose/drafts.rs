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
        self, DurableSubmission, Executor, Lane, OperationFuture, OperationKind, QueueEngine,
        QueueError, QueueOperation, QueueRoute,
    },
    storage::{
        addresses::split_addresses, ComposeDraftMetadata, ComposeDraftMetadataRepository,
        MessageRepository, OperationRepository, Storage, ThreadRepository,
    },
    sync::materialize,
};

use super::{
    mime::{self, OutgoingMessage},
    staging::{OwnerTransfer, Staging},
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

pub struct AdmissionServices<'a> {
    pub queue: &'a Arc<QueueEngine>,
    pub storage: &'a Storage,
    pub staging: &'a Staging,
    pub coalescer: &'a SaveCoalescer,
}

pub struct DraftAdmission {
    pub id: String,
    pub account_id: String,
    pub entity_key: String,
    pub payload: DraftOperationPayload,
}

pub struct DraftTarget<'a> {
    pub account_id: &'a str,
    pub draft_id: &'a str,
}

pub struct DraftExecutorContext<R: Runtime> {
    pub app: AppHandle<R>,
    pub storage: Storage,
    pub staging: Arc<Staging>,
    pub coalescer: Arc<SaveCoalescer>,
    pub base_url: String,
}

struct OriginalQuote {
    html: Option<String>,
    inline_parts: Vec<super::mime::Part>,
}

struct GmailDraftOutcome {
    message: GmailMessage,
    consumed: bool,
    draft_id: String,
}

struct PostReplaceRow<'a> {
    account_id: &'a str,
    message: &'a GmailMessage,
    metadata: &'a ComposeDraftMetadata,
    consumed: bool,
}

pub async fn admit(
    services: &AdmissionServices<'_>,
    admission: DraftAdmission,
    parts: &[super::staging::StagedPart],
) -> Result<u64, String> {
    let DraftAdmission {
        id,
        account_id,
        entity_key,
        mut payload,
    } = admission;
    services
        .staging
        .snapshot(&id, parts)
        .map_err(|error| error.to_string())?;
    let generation = services.coalescer.schedule(&entity_key).await;
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
        services.queue,
        services.storage,
        DurableSubmission {
            operation: QueueOperation::new(
                id,
                account_id,
                QueueRoute {
                    lane: Lane::Interactive,
                    kind: kind,
                    entity_key: entity_key,
                    description: description,
                },
            ),
            payload: payload_json,
        },
    )
    .await
    .map(|()| generation)
    .map_err(str::to_owned)
}

pub async fn delete(
    client: &GmailClient,
    storage: &Storage,
    target: DraftTarget<'_>,
) -> Result<(), String> {
    client
        .delete_draft(target.draft_id)
        .await
        .map_err(|error| error.to_string())?;
    let account = target.account_id.to_owned();
    let draft = target.draft_id.to_owned();
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

pub fn build_executor<R: Runtime>(context: DraftExecutorContext<R>) -> Executor {
    Arc::new(move |operation: QueueOperation| -> OperationFuture {
        let run = DraftRun {
            app: context.app.clone(),
            storage: context.storage.clone(),
            staging: Arc::clone(&context.staging),
            coalescer: Arc::clone(&context.coalescer),
            base_url: context.base_url.clone(),
            operation: operation,
        };
        Box::pin(async move { run.execute().await })
    })
}

fn operation_kind_label(kind: OperationKind) -> &'static str {
    if kind == OperationKind::Send {
        return "send";
    }
    "draft"
}

fn completion_event(consumed: bool) -> &'static str {
    if consumed {
        return crate::events::SEND_COMPLETE;
    }
    crate::events::DRAFT_SAVED
}

async fn load_original_quote(
    storage: &Storage,
    account_id: &str,
    original_message_id: Option<&str>,
) -> OriginalQuote {
    let Some(original_id) = original_message_id else {
        return OriginalQuote {
            html: None,
            inline_parts: Vec::new(),
        };
    };
    let account_id = account_id.to_owned();
    let original_id = original_id.to_owned();
    let loaded = storage
        .run(move |connection| {
            let message = MessageRepository::get(connection, &account_id, &original_id)?;
            let parts = MessageRepository::inline_parts(connection, &account_id, &original_id)?;
            Ok::<_, rusqlite::Error>((message, parts))
        })
        .await
        .ok();
    let Some((Some(message), parts)) = loaded else {
        return OriginalQuote {
            html: None,
            inline_parts: Vec::new(),
        };
    };
    let mime_parts = parts
        .into_iter()
        .map(|part| super::mime::Part {
            filename: part.content_id.clone(),
            mime_type: part.mime_type,
            bytes: part.bytes,
            content_id: Some(part.content_id),
        })
        .collect();
    OriginalQuote {
        html: Some(super::context::outgoing_quote(&message)),
        inline_parts: mime_parts,
    }
}

fn record_post_replace_rows(
    transaction: &rusqlite::Transaction<'_>,
    row: PostReplaceRow<'_>,
) -> rusqlite::Result<()> {
    if !row.consumed {
        return ComposeDraftMetadataRepository::upsert(transaction, row.metadata);
    }
    crate::contacts::observe_now(transaction, row.account_id, &row.message.sender)?;
    for mailbox in split_addresses(&row.message.to_recipients)
        .into_iter()
        .chain(split_addresses(&row.message.cc_recipients))
    {
        crate::contacts::observe_now(transaction, row.account_id, &mailbox)?;
    }
    Ok(())
}

fn classify(error: &GmailError) -> QueueError {
    match error {
        GmailError::Network(_) => QueueError::Network,
        GmailError::Http(status) if crate::is_retryable_status(*status) => {
            QueueError::Http(*status)
        }
        _ => QueueError::Permanent,
    }
}

enum LoadedPayload {
    Skip,
    Ready(Box<DraftOperationPayload>),
}

struct AssembledDraft {
    raw: Vec<u8>,
    quote_html: Option<String>,
}

struct LocalPersistInput<'a> {
    payload: &'a DraftOperationPayload,
    assembled: &'a AssembledDraft,
    outcome: &'a GmailDraftOutcome,
}

struct DraftRun<R: Runtime> {
    app: AppHandle<R>,
    storage: Storage,
    staging: Arc<Staging>,
    coalescer: Arc<SaveCoalescer>,
    base_url: String,
    operation: QueueOperation,
}

impl<R: Runtime> DraftRun<R> {
    async fn execute(self) -> Result<(), QueueError> {
        let mut payload = match self.load_and_claim_payload().await? {
            LoadedPayload::Skip => return Ok(()),
            LoadedPayload::Ready(payload) => *payload,
        };
        let created_server_draft = matches!(payload.mode, DraftOperationMode::Create);
        if created_server_draft {
            if let Some(draft_id) = self.coalescer.draft_id(&self.operation.entity_key).await {
                payload.mode = DraftOperationMode::Update;
                payload.draft_id = Some(draft_id);
            }
        }
        let assembled = self.assemble_draft(&payload).await?;
        let client = self.authorized_client().await?;
        let outcome = match execute_gmail(&client, &payload, &assembled.raw).await {
            Ok(outcome) => outcome,
            Err(error) => return self.fail(&error.to_string(), classify(&error)).await,
        };
        if created_server_draft && !outcome.consumed && payload.draft_id.is_none() {
            self.coalescer
                .set_draft_id(&self.operation.entity_key, outcome.draft_id.clone())
                .await;
        }
        if self.was_discarded().await {
            self.cleanup_discarded(&client, &outcome.draft_id).await;
            return Ok(());
        }
        if created_server_draft {
            self.rehome_staging_if_needed(&payload, &outcome).await?;
        }
        self.persist_local(LocalPersistInput {
            payload: &payload,
            assembled: &assembled,
            outcome: &outcome,
        })
        .await?;
        self.finish(&payload, &outcome).await;
        Ok(())
    }

    async fn load_and_claim_payload(&self) -> Result<LoadedPayload, QueueError> {
        let id = self.operation.id.clone();
        let row = self
            .storage
            .run(move |connection| OperationRepository::get(connection, &id))
            .await
            .map_err(|_| QueueError::Permanent)?;
        let Some(row) = row else {
            return Ok(LoadedPayload::Skip);
        };
        if row.status == "discarded" {
            let _ = self.staging.release_snapshot(&self.operation.id);
            return Ok(LoadedPayload::Skip);
        }
        let payload: DraftOperationPayload = match serde_json::from_str(&row.payload) {
            Ok(payload) => payload,
            Err(error) => return self.fail(&error.to_string(), QueueError::Permanent).await,
        };
        let active_id = self.operation.id.clone();
        let _ = self
            .storage
            .run(move |connection| OperationRepository::mark_active(connection, &active_id))
            .await;
        if !self
            .coalescer
            .is_current(&self.operation.entity_key, payload.coalescing_generation)
            .await
        {
            let _ = self.staging.release_snapshot(&self.operation.id);
            let superseded_id = self.operation.id.clone();
            let _ = self
                .storage
                .run(move |connection| {
                    OperationRepository::mark_terminal(
                        connection,
                        &superseded_id,
                        crate::storage::TerminalOutcome {
                            status: "superseded",
                            error: None,
                        },
                    )
                })
                .await;
            return Ok(LoadedPayload::Skip);
        }
        Ok(LoadedPayload::Ready(Box::new(payload)))
    }

    async fn assemble_draft(
        &self,
        payload: &DraftOperationPayload,
    ) -> Result<AssembledDraft, QueueError> {
        let manifest = match self.staging.snapshot_manifest(&self.operation.id) {
            Ok(manifest) => manifest,
            Err(error) => return self.fail(&error.to_string(), QueueError::Permanent).await,
        };
        let mut inline = Vec::new();
        let mut attachments = Vec::new();
        for part in &manifest.parts {
            match part.read() {
                Ok(read) if part.content_id.is_some() => inline.push(read),
                Ok(read) => attachments.push(read),
                Err(error) => return self.fail(&error.to_string(), QueueError::Permanent).await,
            }
        }
        let quote = load_original_quote(
            &self.storage,
            &self.operation.account_id,
            payload.original_message_id.as_deref(),
        )
        .await;
        inline.extend(quote.inline_parts);
        let outgoing = OutgoingMessage {
            from: payload.from.clone(),
            to: payload.to.clone(),
            cc: payload.cc.clone(),
            bcc: payload.bcc.clone(),
            subject: payload.subject.clone(),
            html: payload.html.clone(),
            quote_html: quote.html.clone(),
            in_reply_to: payload.in_reply_to.clone(),
            references: payload.references.clone(),
            inline: inline,
            attachments: attachments,
        };
        let raw = match mime::assemble(&outgoing) {
            Ok(raw) => raw,
            Err(error) => return self.fail(&error.to_string(), QueueError::Permanent).await,
        };
        Ok(AssembledDraft {
            raw: raw,
            quote_html: quote.html,
        })
    }

    async fn authorized_client(&self) -> Result<GmailClient, QueueError> {
        let auth = self.app.state::<crate::auth::AuthService>().inner().clone();
        let token = match auth
            .refresh_access_token(&self.app, &self.operation.account_id)
            .await
        {
            Ok(token) => token,
            Err(error) => return self.fail(&error, QueueError::Network).await,
        };
        Ok(GmailClient::with_base_url(token, self.base_url.clone()))
    }

    async fn was_discarded(&self) -> bool {
        let id = self.operation.id.clone();
        self.storage
            .run(move |connection| {
                Ok::<_, rusqlite::Error>(
                    OperationRepository::get(connection, &id)?
                        .map(|row| row.status == "discarded")
                        .unwrap_or(false),
                )
            })
            .await
            .unwrap_or(false)
    }

    async fn cleanup_discarded(&self, client: &GmailClient, draft_id: &str) {
        let _ = client.delete_draft(draft_id).await;
        let _ = self.staging.release_snapshot(&self.operation.id);
        let _ = self
            .staging
            .release_owner(&self.operation.account_id, &self.operation.entity_key);
    }

    async fn rehome_staging_if_needed(
        &self,
        payload: &DraftOperationPayload,
        outcome: &GmailDraftOutcome,
    ) -> Result<(), QueueError> {
        let should_move = payload.draft_id.is_none()
            && !outcome.consumed
            && !self.operation.entity_key.starts_with("draft:");
        if !should_move {
            return Ok(());
        }
        if let Err(error) = self.staging.move_owner(OwnerTransfer {
            account_id: &self.operation.account_id,
            from: &self.operation.entity_key,
            to: &outcome.draft_id,
        }) {
            return self.fail(&error.to_string(), QueueError::Permanent).await;
        }
        Ok(())
    }

    async fn persist_local(&self, input: LocalPersistInput<'_>) -> Result<(), QueueError> {
        let LocalPersistInput {
            payload,
            assembled,
            outcome,
        } = input;
        let account_id = self.operation.account_id.clone();
        let draft_id = outcome.draft_id.clone();
        let message = outcome.message.clone();
        let consumed = outcome.consumed;
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
            quote_html: assembled.quote_html.clone(),
            quote_plain: payload.quote_plain.clone(),
        };
        let persisted = self
            .storage
            .run(move |connection| {
                let transaction = connection.unchecked_transaction()?;
                materialize::replace_draft_rows(
                    &transaction,
                    materialize::DraftReplacement {
                        account_id: &account_id,
                        draft_id: &draft_id,
                        replacement: &message,
                        consumed: consumed,
                    },
                )?;
                record_post_replace_rows(
                    &transaction,
                    PostReplaceRow {
                        account_id: &account_id,
                        message: &message,
                        metadata: &metadata,
                        consumed: consumed,
                    },
                )?;
                transaction.commit()
            })
            .await;
        if let Err(error) = persisted {
            if !outcome.consumed {
                return self.fail(&error.to_string(), QueueError::Permanent).await;
            }
            tracing::warn!(
                target: "compose",
                "operation {} sent but its local copy was not written: {error}",
                self.operation.id
            );
        }
        Ok(())
    }

    async fn finish(&self, payload: &DraftOperationPayload, outcome: &GmailDraftOutcome) {
        let _ = self.staging.release_snapshot(&self.operation.id);
        if outcome.consumed {
            let _ = self
                .staging
                .release_owner(&self.operation.account_id, &outcome.draft_id);
            if payload.draft_id.is_none() {
                let _ = self
                    .staging
                    .release_owner(&self.operation.account_id, &self.operation.entity_key);
            }
        }
        let id_for_terminal = self.operation.id.clone();
        let _ = self
            .storage
            .run(move |connection| {
                OperationRepository::mark_terminal(
                    connection,
                    &id_for_terminal,
                    crate::storage::TerminalOutcome {
                        status: "done",
                        error: None,
                    },
                )
            })
            .await;
        let event = completion_event(outcome.consumed);
        let _ = self.app.emit(
            event,
            serde_json::json!({
                "accountId": self.operation.account_id,
                "sessionId": self.operation.entity_key,
                "draftId": outcome.draft_id,
            }),
        );
    }

    async fn fail<T>(&self, error: &str, queue_error: QueueError) -> Result<T, QueueError> {
        if !self.operation.will_retry(queue_error) {
            tracing::error!(
                target: "compose",
                "operation {} failed: {error}",
                self.operation.id
            );
            let id = self.operation.id.clone();
            let owned = error.to_owned();
            let _ = self
                .storage
                .run(move |connection| {
                    OperationRepository::mark_terminal(
                        connection,
                        &id,
                        crate::storage::TerminalOutcome {
                            status: "failed",
                            error: Some(&owned),
                        },
                    )
                })
                .await;
            let _ = self.app.emit(
                crate::events::COMPOSE_FAILED,
                serde_json::json!({
                    "accountId": self.operation.account_id,
                    "sessionId": self.operation.entity_key,
                    "kind": operation_kind_label(self.operation.kind),
                    "error": error,
                }),
            );
        }
        Err(queue_error)
    }
}

async fn execute_gmail(
    client: &GmailClient,
    payload: &DraftOperationPayload,
    raw: &[u8],
) -> Result<GmailDraftOutcome, GmailError> {
    match payload.mode {
        DraftOperationMode::Create => {
            let draft_id = client
                .create_draft(raw, payload.thread_id.as_deref())
                .await?;
            let full = client.draft(&draft_id).await?;
            Ok(GmailDraftOutcome {
                message: full.message,
                consumed: false,
                draft_id: full.id,
            })
        }
        DraftOperationMode::Update => {
            let draft_id = payload
                .draft_id
                .clone()
                .expect("update carries an existing draft id");
            client
                .update_draft(
                    &draft_id,
                    crate::gmail::DraftContent {
                        raw: raw,
                        thread_id: payload.thread_id.as_deref(),
                    },
                )
                .await?;
            let full = client.draft(&draft_id).await?;
            Ok(GmailDraftOutcome {
                message: full.message,
                consumed: false,
                draft_id: full.id,
            })
        }
        DraftOperationMode::Send => {
            let draft_id = match &payload.draft_id {
                Some(draft_id) => {
                    client
                        .update_draft(
                            draft_id,
                            crate::gmail::DraftContent {
                                raw: raw,
                                thread_id: payload.thread_id.as_deref(),
                            },
                        )
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
            Ok(GmailDraftOutcome {
                message: message,
                consumed: true,
                draft_id: draft_id,
            })
        }
    }
}

pub async fn hydrate(
    client: &GmailClient,
    draft_id: &str,
) -> Result<crate::gmail::GmailDraft, GmailError> {
    client.draft(draft_id).await
}
