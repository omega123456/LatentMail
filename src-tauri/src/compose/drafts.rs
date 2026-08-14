//! The durable, queue-facing draft lifecycle (D1/D3/D15/D19). Every
//! create/update/send admission persists its durable [`Operation`] row and
//! immutable staging snapshot *before* queue admission, and the executor
//! built by [`build_executor`] reconstructs each run purely from that row's
//! payload plus the snapshot manifest — never from an in-memory closure —
//! so an interrupted operation survives a restart. IPC command surfaces for
//! this lifecycle remain Phase 5's responsibility; this module only owns
//! backend correctness.
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

/// Generates a process-local, timestamp-ordered id (an operation id, a
/// staged-part id, ...). No `uuid` dependency is warranted for this: the
/// combination of a millisecond timestamp and one random `u64` is already
/// unique enough for locally generated, non-security-sensitive identifiers.
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

/// Everything the durable executor needs to reassemble and dispatch one
/// create/update/send, aside from attachment/inline bytes (which live in
/// the operation's staging snapshot, keyed by the operation id itself).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftOperationPayload {
    pub mode: DraftOperationMode,
    /// The existing stable Gmail draft id. Required for `Update`/`Send`;
    /// absent for `Create`.
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
    /// Set by [`admit`] immediately before persisting — the generation this
    /// save held at admission time. The executor compares it against the
    /// coalescer's current generation for the same entity key and skips a
    /// Gmail round trip entirely if a newer save has already superseded it.
    #[serde(default)]
    pub coalescing_generation: u64,
}

/// Per-entity (per compose session/draft) save coalescing (D19 / Phase 2
/// scope: "saves ... serialize on a shared key, and a save falling due
/// while an earlier one is unconfirmed is coalesced rather than dropped").
/// The scheduler that decides *when* to call [`admit`] — debounce timing,
/// change detection — is Phase 5's frontend-facing concern; this is the
/// Rust-side primitive it will drive: each [`admit`] call registers a new
/// generation for its key, and the executor only actually contacts Gmail
/// for the latest one, so a rapid run of admissions ends in exactly one
/// live upload rather than one per keystroke-triggered save.
#[derive(Default)]
pub struct SaveCoalescer {
    generations: Mutex<std::collections::HashMap<String, u64>>,
    draft_ids: Mutex<std::collections::HashMap<String, String>>,
}
impl SaveCoalescer {
    pub fn new() -> Self {
        Self::default()
    }
    /// Registers a new save for `key`, returning its generation.
    pub async fn schedule(&self, key: &str) -> u64 {
        let mut generations = self.generations.lock().await;
        let generation = generations.entry(key.to_owned()).or_insert(0);
        *generation += 1;
        *generation
    }
    /// True while `generation` is still the latest one scheduled for `key`.
    pub async fn is_current(&self, key: &str, generation: u64) -> bool {
        let generations = self.generations.lock().await;
        generations.get(key).copied() == Some(generation)
    }
    /// Associates a session serialization key with the stable Gmail draft id
    /// returned by its first create. A later save admitted while that create
    /// was active still carries `Create`; the queue serializes it behind the
    /// create and this mapping promotes it to an update instead of creating a
    /// duplicate server draft.
    pub async fn set_draft_id(&self, key: &str, draft_id: String) {
        self.draft_ids.lock().await.insert(key.to_owned(), draft_id);
    }
    pub async fn draft_id(&self, key: &str) -> Option<String> {
        self.draft_ids.lock().await.get(key).cloned()
    }
}

/// Persists the immutable operation snapshot and durable operation row
/// *before* queue admission (D15), stamping the payload with its
/// coalescing generation first. Returns the generation so a caller can
/// later recognize whether its own save was the one that actually ran.
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
        },
        payload_json,
    )
    .await
    .map(|()| generation)
    .map_err(str::to_owned)
}

/// Reuses the existing draft-deletion endpoint (`gmail::labels`) rather
/// than reimplementing it, then removes the local draft message (if one
/// was ever materialized) and its compose-draft metadata.
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

/// Builds the [`Executor`] the production queue dispatches `Draft`/`Send`
/// operations to. Every invocation reconstructs its work fresh from the
/// operation's persisted payload and staging manifest — nothing about a
/// specific operation is captured here at construction time, which is what
/// makes an interrupted operation recoverable after restart (D15,
/// acceptance criterion 11).
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

/// Marks the durable row failed, logs the reason, and tells the frontend —
/// every failure path in [`run`] routes through here, so a failed
/// save/send can never end silently (the composer is closed on queue
/// acceptance, not on delivery, so a toast is the only remaining channel).
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
        // Already recovered/cleaned up by a previous run — nothing to do.
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

    // A second save can be admitted while the first create is awaiting
    // Gmail, before React receives the stable draft id. Same-entity queue
    // serialization puts this operation after the create; use the id it
    // recorded to make this operation an update.
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

    // The quote is rebuilt from the stored original at send/save time. The
    // display-safe HTML sent to React is deliberately not in this payload.
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
            // ponytail: this records the row `failed` on every attempt,
            // including one the queue will still retry (its own attempt
            // counter, not this row, is authoritative for retry/backoff —
            // see `OperationKind::retries`/`QueueError::retryable`), so a
            // durable-operation reader can observe "last known error" but
            // may see `failed` flip briefly ahead of an eventual retry
            // success. Upgrade path: thread the queue's attempt count back
            // in and only persist `failed` once retries are exhausted.
            terminal_failed(app, storage, &operation, &error.to_string()).await;
            return Err(queue_error);
        }
    };

    if created_server_draft && !consumed && payload.draft_id.is_none() {
        coalescer
            .set_draft_id(&operation.entity_key, draft_id.clone())
            .await;
    }

    // A discard racing an active first create must consume the returned draft
    // before it can be materialized or reported as saved.
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

    if created_server_draft && payload.draft_id.is_none() && !consumed {
        // Current IPC uses a literal session id as its entity key. Legacy
        // `draft:`-namespaced durable rows predate canonical-owner transfer
        // and retain their original compatibility behavior.
        if !operation.entity_key.starts_with("draft:") {
            if let Err(error) =
                staging.move_owner(&operation.account_id, &operation.entity_key, &draft_id)
            {
                terminal_failed(app, storage, &operation, &error.to_string()).await;
                return Err(QueueError::Permanent);
            }
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
        // Persist the exact sent quote snapshot, not the reader-safe display
        // copy that crossed IPC when the composer opened.
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
                    // Local delivery is already confirmed; learn the same
                    // contacts reconciliation would learn on a later sync.
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
        // A retry here risks a duplicate Gmail draft/send; the Gmail side
        // effect already happened, so this is reported rather than retried.
        return Err(QueueError::Permanent);
    }

    let _ = staging.release_snapshot(&id);
    if consumed {
        // A promotion always consumes the stable Gmail draft's canonical
        // parts. The queue entity key is a serialization key (`draft:d1`
        // in recovery/tests), not a staging owner.
        let _ = staging.release_owner(&account_id, &draft_id);
        // A first-click send has no pre-existing draft. Its canonical parts
        // are still under the local compose-session owner while Gmail
        // atomically creates and consumes the transient draft.
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
            // Send always pushes the freshly-assembled document first — the
            // draft Gmail promotes must be this send's own content, not
            // whatever the last autosave happened to persist.
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
            // Promotion returns a partial resource. Materialize the full
            // Gmail message before announcing success to Query listeners.
            let message = client.message(&sent_id).await?;
            Ok((message, true, draft_id))
        }
    }
}

// ---------------------------------------------------------------------
// Thin backend-only wrappers kept for direct (non-queue) Gmail access —
// used by hydration/reopen paths that don't need durability.
// ---------------------------------------------------------------------

pub async fn hydrate(
    client: &GmailClient,
    draft_id: &str,
) -> Result<crate::gmail::GmailDraft, GmailError> {
    client.draft(draft_id).await
}
