use std::{collections::HashSet, sync::Arc};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

use crate::{
    auth::AuthService,
    gmail::labels::resolve_color,
    sanitize,
    storage::{
        addresses::split_addresses, ConversationEntryScope, LabelColor, LabelRepository,
        MessageRepository, Storage, ThreadRepository, TraversalCursorRepository, TraversalKind,
    },
};

use super::{
    announce::MailChangeAnnouncer,
    triage::{self, LabelChange},
    dto::{message_body_dto, message_dto, ImagePolicy, MessageBodyDto, MessageBodyFetchedDto},
    gmail_base_url, ConversationDto, LabelDto, MutationResultDto, SyncEngine, SyncStatusDto,
    ThreadCursor, ThreadDto, ThreadPage, ThreadPageDirection, TraversalStatusDto,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeDraftRequest {
    session_id: String,
    account_id: String,
    draft_id: Option<String>,
    from: String,
    to: Vec<String>,
    cc: Vec<String>,
    bcc: Vec<String>,
    subject: String,
    html: String,
    mode: String,
    thread_id: Option<String>,
    in_reply_to: Option<String>,
    references: Vec<String>,
    original_message_id: Option<String>,
    original_gmail_message_id: Option<String>,
    quote_html: Option<String>,
    quote_plain: Option<String>,
    editable_body_fingerprint: Option<String>,
    attachments: Vec<ComposeAttachmentRequest>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeAttachmentRequest {
    id: String,
    filename: String,
    mime_type: String,
    content_id: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeQueueAcceptance {
    operation_id: String,
    draft_id: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedComposeDraft {
    session_id: String,
    account_id: String,
    draft_id: String,
    from: String,
    to: Vec<String>,
    cc: Vec<String>,
    bcc: Vec<String>,
    subject: String,
    html: String,
    quote_html: Option<String>,
    quote_plain: Option<String>,
    mode: String,
    thread_id: Option<String>,
    in_reply_to: Option<String>,
    references: Vec<String>,
    original_message_id: Option<String>,
    original_gmail_message_id: Option<String>,
    attachments: Vec<super::dto::StagedAttachmentDto>,
}

fn compose_operation_prefix(send: bool) -> &'static str {
    if send {
        return "send";
    }
    "draft"
}

fn compose_operation_mode(
    send: bool,
    has_draft_id: bool,
) -> crate::compose::drafts::DraftOperationMode {
    if send {
        return crate::compose::drafts::DraftOperationMode::Send;
    }
    if has_draft_id {
        return crate::compose::drafts::DraftOperationMode::Update;
    }
    crate::compose::drafts::DraftOperationMode::Create
}

async fn admit_compose(
    queue: &std::sync::Arc<crate::queue::QueueEngine>,
    storage: &Storage,
    staging: &std::sync::Arc<crate::compose::staging::Staging>,
    coalescer: &std::sync::Arc<crate::compose::drafts::SaveCoalescer>,
    request: ComposeDraftRequest,
    send: bool,
) -> Result<ComposeQueueAcceptance, String> {
    let operation_id = crate::compose::drafts::generate_id(compose_operation_prefix(send));

    let owners: Vec<&str> = request
        .draft_id
        .as_deref()
        .into_iter()
        .chain(std::iter::once(request.session_id.as_str()))
        .collect();
    let parts = request
        .attachments
        .iter()
        .map(|part| {
            staging.part(
                &request.account_id,
                &owners,
                &part.id,
                part.filename.clone(),
                part.mime_type.clone(),
                part.content_id.clone(),
            )
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let payload = crate::compose::drafts::DraftOperationPayload {
        mode: compose_operation_mode(send, request.draft_id.is_some()),
        draft_id: request.draft_id.clone(),
        thread_id: request.thread_id,
        from: request.from,
        to: request.to,
        cc: request.cc,
        bcc: request.bcc,
        subject: request.subject,
        html: request.html,
        quote_html: request.quote_html,
        in_reply_to: request.in_reply_to,
        references: request.references,
        metadata_mode: request.mode,
        original_message_id: request.original_message_id,
        original_gmail_message_id: request.original_gmail_message_id,
        editable_body_fingerprint: request.editable_body_fingerprint,
        quote_plain: request.quote_plain,
        coalescing_generation: 0,
    };
    let services = crate::compose::drafts::AdmissionServices {
        queue,
        storage,
        staging,
        coalescer,
    };
    let admission = crate::compose::drafts::DraftAdmission {
        id: operation_id.clone(),
        account_id: request.account_id,
        entity_key: request
            .draft_id
            .clone()
            .unwrap_or(request.session_id.clone()),
        payload: payload,
    };
    crate::compose::drafts::admit(&services, admission, &parts).await?;
    Ok(ComposeQueueAcceptance {
        operation_id: operation_id,
        draft_id: request.draft_id,
    })
}

#[tauri::command]
pub async fn save_compose_draft(
    queue: tauri::State<'_, std::sync::Arc<crate::queue::QueueEngine>>,
    storage: tauri::State<'_, Storage>,
    staging: tauri::State<'_, std::sync::Arc<crate::compose::staging::Staging>>,
    coalescer: tauri::State<'_, std::sync::Arc<crate::compose::drafts::SaveCoalescer>>,
    draft: ComposeDraftRequest,
) -> Result<ComposeQueueAcceptance, String> {
    admit_compose(&queue, &storage, &staging, &coalescer, draft, false).await
}

#[tauri::command]
pub async fn send_compose_draft(
    queue: tauri::State<'_, std::sync::Arc<crate::queue::QueueEngine>>,
    storage: tauri::State<'_, Storage>,
    staging: tauri::State<'_, std::sync::Arc<crate::compose::staging::Staging>>,
    coalescer: tauri::State<'_, std::sync::Arc<crate::compose::drafts::SaveCoalescer>>,
    draft: ComposeDraftRequest,
) -> Result<ComposeQueueAcceptance, String> {
    admit_compose(&queue, &storage, &staging, &coalescer, draft, true).await
}

#[tauri::command]
pub async fn discard_compose_draft<R: Runtime>(
    services: super::services::GmailServices<'_, R>,
    staging: tauri::State<'_, Arc<crate::compose::staging::Staging>>,
    account_id: String,
    draft_id: Option<String>,
    session_id: String,
) -> Result<(), String> {
    services
        .storage
        .run({
            let account_id = account_id.clone();
            let session_id = session_id.clone();
            move |connection| {
                crate::storage::OperationRepository::discard_session_creates(
                    connection,
                    &account_id,
                    &session_id,
                )
            }
        })
        .await
        .map_err(|error| error.to_string())?;
    let Some(draft_id) = draft_id else {
        let _ = staging.release_owner(&account_id, &session_id);
        return Ok(());
    };
    let client = services.client(&account_id).await?;
    crate::compose::drafts::delete(&client, &services.storage, &account_id, &draft_id).await?;
    let _ = staging.release_owner(&account_id, &draft_id);
    let _ = staging.release_owner(&account_id, &session_id);
    Ok(())
}

#[tauri::command]
pub async fn hydrate_compose_draft<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    storage: tauri::State<'_, Storage>,
    staging: tauri::State<'_, Arc<crate::compose::staging::Staging>>,
    account_id: String,
    draft_id: String,
) -> Result<HydratedComposeDraft, String> {
    let client = gmail_client_for(&app, &auth, &engine, &account_id).await?;
    let draft = crate::compose::drafts::hydrate(&client, &draft_id)
        .await
        .map_err(|error| error.to_string())?;
    let metadata = storage
        .run({
            let account_id = account_id.clone();
            let draft_id = draft_id.clone();
            move |connection| {
                crate::storage::ComposeDraftMetadataRepository::get(
                    connection,
                    &account_id,
                    &draft_id,
                )
            }
        })
        .await
        .map_err(|error| error.to_string())?;
    let mut attachments = Vec::new();
    for part in &draft.message.attachment_parts {
        let staged = stage_hydrated_attachment(
            staging.as_ref(),
            &client,
            &account_id,
            &draft_id,
            &draft.message.id,
            part,
        )
        .await?;
        attachments.push(staged.into());
    }
    let quote_html = metadata.as_ref().and_then(|value| value.quote_html.clone());
    let remote_html = draft.message.html_body.unwrap_or_default();
    let boundary_matches = metadata.as_ref().is_some_and(|value| {
        value.boundary_version == 1
            && quote_html
                .as_ref()
                .and_then(|quote| remote_html.strip_suffix(quote))
                .is_some_and(|editable| {
                    value.editable_body_fingerprint.as_deref() == Some(editable)
                })
    });
    if metadata.is_some() && !boundary_matches {
        let account = account_id.clone();
        let draft = draft_id.clone();
        storage
            .run(move |connection| {
                crate::storage::ComposeDraftMetadataRepository::remove(connection, &account, &draft)
            })
            .await
            .map_err(|error| error.to_string())?;
    }

    let metadata = boundary_matches.then_some(metadata).flatten();
    let html = hydrated_editable_html(boundary_matches, quote_html.as_deref(), &remote_html);
    Ok(HydratedComposeDraft {
        session_id: crate::compose::drafts::generate_id("compose"),
        account_id: account_id,
        draft_id: draft_id,
        from: draft.message.sender,
        to: split_addresses(&draft.message.to_recipients),
        cc: split_addresses(&draft.message.cc_recipients),
        bcc: split_addresses(&draft.message.bcc_recipients),
        subject: draft.message.subject,
        html: html,
        quote_html: boundary_matches.then_some(quote_html).flatten(),
        quote_plain: metadata
            .as_ref()
            .and_then(|value| value.quote_plain.clone()),
        mode: metadata
            .as_ref()
            .map_or_else(|| "draft".into(), |value| value.mode.clone()),
        thread_id: metadata
            .as_ref()
            .and_then(|value| value.target_thread_id.clone()),
        in_reply_to: metadata
            .as_ref()
            .and_then(|value| value.in_reply_to.clone()),
        references: metadata
            .as_ref()
            .and_then(|value| value.rfc_references.clone())
            .map(|value| value.split_whitespace().map(str::to_owned).collect())
            .unwrap_or_default(),
        original_message_id: metadata
            .as_ref()
            .and_then(|value| value.original_message_id.clone()),
        original_gmail_message_id: metadata.and_then(|value| value.original_gmail_message_id),
        attachments: attachments,
    })
}

async fn stage_hydrated_attachment(
    staging: &crate::compose::staging::Staging,
    client: &crate::gmail::GmailClient,
    account_id: &str,
    draft_id: &str,
    message_id: &str,
    part: &crate::gmail::AttachmentPart,
) -> Result<crate::compose::staging::StagedPart, String> {
    if let Some(bytes) = &part.inline_bytes {
        let descriptor = crate::compose::staging::StagedPart {
            id: crate::compose::drafts::generate_id("staged"),
            filename: part.filename.clone(),
            mime_type: part.mime_type.clone(),
            path: std::path::PathBuf::new(),
            content_id: None,
            size: 0,
        };
        return staging
            .stage_bytes(account_id, draft_id, &descriptor, bytes)
            .map_err(|error| error.to_string());
    }
    staging
        .stage_attachment(
            client,
            account_id,
            draft_id,
            crate::compose::staging::GmailAttachmentSource {
                message_id: message_id,
                attachment_id: &part.attachment_id,
            },
            crate::compose::staging::NewStagedPart {
                id: crate::compose::drafts::generate_id("staged"),
                filename: part.filename.clone(),
                mime_type: part.mime_type.clone(),
                content_id: None,
            },
        )
        .await
}

fn hydrated_editable_html(
    boundary_matches: bool,
    quote_html: Option<&str>,
    remote_html: &str,
) -> String {
    if boundary_matches {
        return quote_html
            .and_then(|quote| remote_html.strip_suffix(quote))
            .unwrap_or(remote_html)
            .to_owned();
    }
    remote_html.to_owned()
}

#[tauri::command]
pub async fn list_labels(
    storage: tauri::State<'_, Storage>,
    account_id: String,
) -> Result<Vec<LabelDto>, String> {
    let (labels, unread_counts) = string_try!(
        storage
            .run(move |connection| Ok((
                LabelRepository::list(connection, &account_id)?,
                LabelRepository::unread_thread_counts(connection, &account_id)?
            )))
            .await
    );
    Ok(labels
        .into_iter()
        .map(|label| {
            let unread_count = unread_counts.get(&label.id).copied().unwrap_or_default();
            LabelDto::new(label, unread_count)
        })
        .collect())
}

#[tauri::command]
pub async fn lookup_contacts(
    storage: tauri::State<'_, Storage>,
    account_id: String,
    query: String,
) -> Result<Vec<super::dto::ContactSuggestionDto>, String> {
    if query.trim().chars().count() < 2 {
        return Ok(Vec::new());
    }
    let contacts = string_try!(
        storage
            .run(move |connection| crate::contacts::lookup(connection, &account_id, &query))
            .await
    );
    Ok(contacts
        .into_iter()
        .map(|contact| super::dto::ContactSuggestionDto {
            address: contact.address,
            display_name: contact.display_name,
        })
        .collect())
}

#[tauri::command]
pub async fn reply_context(
    storage: tauri::State<'_, Storage>,
    account_id: String,
    message_id: String,
    account_email: String,
    reply_all: bool,
    forward: bool,
) -> Result<crate::compose::context::ReplyContext, String> {
    let context = string_try!(
        storage
            .run(move |connection| {
                MessageRepository::compose_context(connection, &account_id, &message_id)?
                    .ok_or(rusqlite::Error::QueryReturnedNoRows)
            })
            .await
    );
    if forward {
        let attachments = context
            .attachments
            .iter()
            .map(|attachment| crate::compose::context::ReplyAttachment {
                id: attachment.attachment_id.clone(),
                filename: attachment.filename.clone(),
                mime_type: attachment.mime_type.clone(),
                size: attachment.size,
            })
            .collect::<Vec<_>>();
        return Ok(crate::compose::context::forward(
            &context.message,
            attachments,
        ));
    }
    Ok(crate::compose::context::reply(
        &context.message,
        &context.recipient_roles.0,
        &context.recipient_roles.1,
        &account_email,
        reply_all,
        context.references.as_deref(),
        Vec::new(),
    ))
}

#[tauri::command]
pub async fn stage_attachment_from_path(
    staging: tauri::State<'_, Arc<crate::compose::staging::Staging>>,
    account_id: String,
    owner: String,
    path: String,
    mime_type: String,
    content_id: Option<String>,
) -> Result<super::dto::StagedAttachmentDto, String> {
    let id = crate::compose::drafts::generate_id("staged");
    let part = string_try!(staging.stage_path(
        &account_id,
        &owner,
        std::path::Path::new(&path),
        &id,
        mime_type,
        content_id,
    ));
    Ok(part.into())
}

#[tauri::command]
pub async fn stage_attachment_from_bytes(
    staging: tauri::State<'_, Arc<crate::compose::staging::Staging>>,
    account_id: String,
    owner: String,
    filename: String,
    mime_type: String,
    content_id: Option<String>,
    bytes: Vec<u8>,
) -> Result<super::dto::StagedAttachmentDto, String> {
    let id = crate::compose::drafts::generate_id("staged");
    let descriptor = crate::compose::staging::StagedPart {
        id: id,
        filename: filename,
        mime_type: mime_type,
        path: std::path::PathBuf::new(),
        content_id: content_id,

        size: 0,
    };
    let part = string_try!(staging.stage_bytes(&account_id, &owner, &descriptor, &bytes));
    Ok(part.into())
}

#[tauri::command]
pub async fn release_staged_attachment(
    staging: tauri::State<'_, Arc<crate::compose::staging::Staging>>,
    account_id: String,
    owner: String,
    id: String,
) -> Result<(), String> {
    string_try!(staging.remove_part(&account_id, &owner, &id));
    Ok(())
}

#[tauri::command]
pub async fn list_threads(
    storage: tauri::State<'_, Storage>,
    account_id: String,
    label_id: Option<String>,
    cursor: Option<ThreadCursor>,
    direction: Option<ThreadPageDirection>,
    limit: Option<u32>,
) -> Result<ThreadPage, String> {
    let limit = crate::sync::thread_page_limit(limit);
    let page_size = usize::try_from(limit).unwrap_or(usize::MAX);
    let cursor_pair = cursor.map(|cursor| (cursor.latest_at, cursor.id));
    let has_cursor = cursor_pair.is_some();
    let direction = direction.unwrap_or_default();
    let mut rows = string_try!(
        storage
            .run(move |connection| {
                ThreadRepository::list_paginated_with_direction(
                    connection,
                    &account_id,
                    label_id.as_deref(),
                    cursor_pair,
                    i64::from(limit) + 1,
                    direction,
                )
            })
            .await
    );
    let has_more = rows.len() > page_size;
    if has_more {
        match direction {
            ThreadPageDirection::Forward => rows.truncate(page_size),
            ThreadPageDirection::Backward => {
                rows.drain(..rows.len() - page_size);
            }
        }
    }
    let cursor_for = |row: &crate::storage::ThreadListRow| ThreadCursor {
        latest_at: row.thread.latest_at,
        id: row.thread.id.clone(),
    };
    let next_cursor = (direction == ThreadPageDirection::Forward && has_more)
        .then(|| rows.last().map(cursor_for))
        .flatten();
    let previous_cursor = ((direction == ThreadPageDirection::Backward && has_more)
        || (direction == ThreadPageDirection::Forward && has_cursor))
        .then(|| rows.first().map(cursor_for))
        .flatten();
    let items = rows
        .into_iter()
        .map(|row| {
            ThreadDto::from(row.thread).with_row_details(
                row.snippet,
                row.label_indicators,
                row.system_label_ids,
            )
        })
        .collect();
    Ok(ThreadPage {
        items,
        next_cursor,
        previous_cursor,
    })
}

#[tauri::command]
pub async fn load_conversation(
    storage: tauri::State<'_, Storage>,
    account_id: String,
    thread_id: String,
    image_policy: Option<ImagePolicy>,
    entry_scope: Option<ConversationEntryScope>,
) -> Result<ConversationDto, String> {
    let image_policy = image_policy.unwrap_or_default();
    let (account_for_read, thread_for_read) = (account_id.clone(), thread_id.clone());
    let (messages, thread_subject, newest_body) = string_try!(
        storage
            .run(move |connection| {
                let messages = MessageRepository::list_conversation_metadata(
                    connection,
                    &account_for_read,
                    &thread_for_read,
                    entry_scope.as_ref(),
                )?;
                let subject =
                    ThreadRepository::get(connection, &account_for_read, &thread_for_read)?
                        .map(|thread| thread.subject)
                        .unwrap_or_default();
                let newest_body = messages
                    .last()
                    .map(|stored| {
                        MessageRepository::conversation_body(
                            connection,
                            &account_for_read,
                            &stored.message.id,
                            entry_scope.as_ref(),
                        )
                        .map(|body| (stored.message.id.clone(), stored.label_ids.clone(), body))
                    })
                    .transpose()?;
                Ok((messages, subject, newest_body))
            })
            .await
    );

    let mut message_dtos = Vec::with_capacity(messages.len());
    for stored in messages {
        let allow_remote = image_policy.allows(
            &stored.label_ids,
            &stored.message.id,
            &stored.message.sender,
        );
        message_dtos.push(message_dto(
            stored.message,
            stored.recipient_roles,
            stored.label_ids,
            None,
            allow_remote,
            stored.draft_id,
            stored.attachments,
        ));
    }
    if let Some((message_id, label_ids, Some((message, content_ids)))) = newest_body {
        let allow_remote = image_policy.allows(&label_ids, &message.id, &message.sender);
        let body = message_body_dto(&message, &content_ids, allow_remote, &account_id);
        if let Some(dto) = message_dtos.iter_mut().find(|dto| dto.id == message_id) {
            dto.html_body = body.html_body;
            dto.plain_body = body.plain_body;
            dto.truncated = body.truncated;
            dto.remote_images_blocked = body.remote_images_blocked;
            dto.remote_images_allowed = body.remote_images_allowed;
            dto.inline_images_pending = body.inline_images_pending;
        }
    }

    Ok(ConversationDto {
        thread_id: thread_id,
        subject: thread_subject,
        messages: message_dtos,
    })
}

#[tauri::command]
pub async fn load_message_body(
    storage: tauri::State<'_, Storage>,
    account_id: String,
    message_id: String,
    image_policy: Option<ImagePolicy>,
    entry_scope: Option<ConversationEntryScope>,
) -> Result<MessageBodyDto, String> {
    let image_policy = image_policy.unwrap_or_default();
    let account_for_read = account_id.clone();
    let id_for_read = message_id.clone();
    let body = string_try!(
        storage
            .run(move |connection| {
                let labels =
                    MessageRepository::label_ids(connection, &account_for_read, &id_for_read)?;
                let body = MessageRepository::conversation_body(
                    connection,
                    &account_for_read,
                    &id_for_read,
                    entry_scope.as_ref(),
                )?;
                Ok((labels, body))
            })
            .await
    );
    let (label_ids, Some((message, content_ids))) = body else {
        return Err("Message is unavailable".to_owned());
    };
    let allow_remote = image_policy.allows(&label_ids, &message.id, &message.sender);
    Ok(message_body_dto(
        &message,
        &content_ids,
        allow_remote,
        &account_id,
    ))
}

async fn download_inline_images(
    client: &crate::gmail::GmailClient,
    message_id: &str,
    html: Option<&str>,
    attachment_parts: &[crate::gmail::AttachmentPart],
    parts: &mut Vec<crate::storage::InlinePart>,
) {
    let referenced = html
        .map(sanitize::referenced_content_ids)
        .unwrap_or_default();
    for part in attachment_parts {
        let Some(content_id) = part
            .content_id
            .clone()
            .filter(|id| referenced.iter().any(|value| value == id))
        else {
            continue;
        };
        match client.attachment(message_id, &part.attachment_id).await {
            Ok(bytes) => parts.push(crate::storage::InlinePart {
                content_id: content_id,
                mime_type: part.mime_type.clone(),
                bytes: bytes,
            }),
            Err(error) => {
                tracing::debug!("inline image {content_id} of {message_id} failed: {error}");
            }
        }
    }
}

#[tauri::command]
pub async fn fetch_message_body<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    storage: tauri::State<'_, Storage>,
    account_id: String,
    message_id: String,
) -> Result<(), String> {
    let account = account_id.clone();
    let id = message_id.clone();
    let stored = string_try!(
        storage
            .run(move |connection| {
                let Some(message) = MessageRepository::get(connection, &account, &id)? else {
                    return Ok(None);
                };
                let held = MessageRepository::inline_content_ids(connection, &account, &id)?;
                let inline_images_pending = message
                    .html_body
                    .as_deref()
                    .map(sanitize::referenced_content_ids)
                    .unwrap_or_default()
                    .iter()
                    .any(|referenced| !held.iter().any(|content_id| content_id == referenced));
                Ok(Some((
                    message.html_presence,
                    message.body_is_empty(),
                    inline_images_pending,
                )))
            })
            .await
    )
    .ok_or_else(|| "Message is unavailable".to_owned())?;

    let already_complete = matches!(stored.0, crate::storage::HtmlPresence::TooLarge)
        || (!matches!(stored.0, crate::storage::HtmlPresence::NeverFetched)
            && !stored.1
            && !stored.2);
    if already_complete {
        return Ok(());
    }
    let client = gmail_client_for(&app, &auth, &engine, &account_id).await?;
    let message = string_try!(client.message(&message_id).await);
    let html_presence = fetched_html_presence(message.oversize, message.html_body.as_deref());
    let html_body = message.html_body;
    let plain_body = message.plain_body;
    let mut parts = message
        .inline_parts
        .into_iter()
        .map(|part| crate::storage::InlinePart {
            content_id: part.content_id,
            mime_type: part.mime_type,
            bytes: part.bytes,
        })
        .collect::<Vec<_>>();
    download_inline_images(
        &client,
        &message_id,
        html_body.as_deref(),
        &message.attachment_parts,
        &mut parts,
    )
    .await;
    let attachments =
        crate::sync::materialize::attachment_records_from_parts(&message.attachment_parts);
    if let Some(cache) = engine.attachment_cache() {
        crate::attachments::seed_cache(cache, &account_id, &message_id, &message.attachment_parts);
    }
    let account_for_persist = account_id.clone();
    let message_for_persist = message_id.clone();
    string_try!(
        storage
            .run(move |connection| {
                let transaction = connection.unchecked_transaction()?;
                MessageRepository::set_body(
                    &transaction,
                    &account_for_persist,
                    &message_for_persist,
                    html_body.as_deref(),
                    plain_body.as_deref(),
                    html_presence,
                )?;
                MessageRepository::replace_inline_parts(
                    &transaction,
                    &account_for_persist,
                    &message_for_persist,
                    &parts,
                )?;
                crate::storage::AttachmentRepository::replace_for_message(
                    &transaction,
                    &account_for_persist,
                    &message_for_persist,
                    &attachments,
                )?;
                transaction.commit()
            })
            .await
    );
    app.emit(
        crate::events::MESSAGE_BODY_FETCHED,
        MessageBodyFetchedDto {
            account_id,
            message_id,
        },
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn fetched_html_presence(
    oversize: bool,
    html_body: Option<&str>,
) -> crate::storage::HtmlPresence {
    if oversize {
        return crate::storage::HtmlPresence::TooLarge;
    }
    crate::storage::HtmlPresence::from_fetched_body(html_body)
}

fn single_label_delta(label_id: &'static str, present: bool) -> (HashSet<String>, HashSet<String>) {
    if present {
        return (HashSet::from([label_id.to_owned()]), HashSet::new());
    }
    (HashSet::new(), HashSet::from([label_id.to_owned()]))
}

async fn mutate_thread<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    thread_id: String,
    label_id: &'static str,
    present: bool,
) -> Result<(), String> {
    let client = gmail_client_for(&app, &auth, &engine, &account_id).await?;

    let (add, remove) = single_label_delta(label_id, present);
    string_try!(
        engine
            .mutate(&account_id, client, thread_id, add, remove)
            .await
    );
    Ok(())
}
#[tauri::command]
pub async fn star_thread<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    thread_id: String,
) -> Result<(), String> {
    mutate_thread(app, auth, engine, account_id, thread_id, "STARRED", true).await
}
#[tauri::command]
pub async fn unstar_thread<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    thread_id: String,
) -> Result<(), String> {
    mutate_thread(app, auth, engine, account_id, thread_id, "STARRED", false).await
}
#[tauri::command]
pub async fn mark_thread_read<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    thread_id: String,
) -> Result<(), String> {
    mutate_thread(app, auth, engine, account_id, thread_id, "UNREAD", false).await
}
#[tauri::command]
pub async fn mark_thread_unread<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    thread_id: String,
) -> Result<(), String> {
    mutate_thread(app, auth, engine, account_id, thread_id, "UNREAD", true).await
}

#[tauri::command]
pub async fn trigger_sync<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
) -> Result<SyncStatusDto, String> {
    let client = gmail_client_for(&app, &auth, &engine, &account_id).await?;
    let engine = Arc::clone(&engine);
    tracing::info!(target: "sync", "{account_id}: manual sync requested");
    let result = engine.run_sync(&account_id, client).await;
    if result.is_err() {
        auth.invalidate_access_token(&account_id);
    }
    let status = engine.status(&account_id).await;
    string_try!(result);
    Ok(status)
}

#[tauri::command]
pub async fn read_sync_status(
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
) -> Result<SyncStatusDto, String> {
    Ok(engine.status(&account_id).await)
}

#[tauri::command]
pub async fn mutate_threads<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    thread_ids: Vec<String>,
    add: Vec<String>,
    remove: Vec<String>,
) -> Result<Vec<MutationResultDto>, String> {
    let announcer = MailChangeAnnouncer::new(&app, &account_id);
    let outcome =
        apply_mutate_threads(app, auth, engine, account_id, thread_ids, add, remove).await;
    announcer.announce(outcome)
}

async fn apply_mutate_threads<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    thread_ids: Vec<String>,
    add: Vec<String>,
    remove: Vec<String>,
) -> Result<Vec<MutationResultDto>, String> {
    let change = LabelChange::explicit(add, remove)?;
    triage::apply_to_threads(app, auth, engine, account_id, thread_ids, change).await
}

#[tauri::command]
pub async fn mutate_messages<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    message_ids: Vec<String>,
    add: Vec<String>,
    remove: Vec<String>,
) -> Result<(), String> {
    let announcer = MailChangeAnnouncer::new(&app, &account_id);
    let outcome =
        apply_mutate_messages(app, auth, engine, account_id, message_ids, add, remove).await;
    announcer.announce(outcome)
}

async fn apply_mutate_messages<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    account_id: String,
    message_ids: Vec<String>,
    add: Vec<String>,
    remove: Vec<String>,
) -> Result<(), String> {
    let change = LabelChange::explicit(add, remove)?;
    triage::apply_to_messages(app, auth, engine, account_id, message_ids, change).await
}

#[tauri::command]
pub async fn delete_draft<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    storage: tauri::State<'_, Storage>,
    account_id: String,
    message_id: String,
) -> Result<(), String> {
    let client = gmail_client_for(&app, &auth, &engine, &account_id).await?;
    super::mutations::delete_draft(&storage, &client, &account_id, &message_id).await
}

pub(crate) async fn gmail_client_for<R: Runtime>(
    app: &AppHandle<R>,
    auth: &AuthService,
    engine: &SyncEngine,
    account_id: &str,
) -> Result<crate::gmail::GmailClient, String> {
    let token = auth.refresh_access_token(app, account_id).await?;
    let base_url = gmail_base_url();
    Ok(engine.gmail_client(account_id, token, base_url).await)
}

fn resolve_color_or_error(color_id: Option<&str>) -> Result<Option<LabelColor>, String> {
    match color_id {
        None => Ok(None),
        Some(id) => resolve_color(id)
            .map(|pair| {
                Some(LabelColor {
                    text: pair.text_color,
                    background: pair.background_color,
                })
            })
            .ok_or_else(|| format!("'{id}' is not a recognised label colour")),
    }
}

async fn read_label_dto(
    storage: &Storage,
    account_id: String,
    label_id: String,
) -> Result<Option<LabelDto>, String> {
    storage
        .run(move |connection| {
            let unread_counts = LabelRepository::unread_thread_counts(connection, &account_id)?;
            Ok(
                LabelRepository::get(connection, &account_id, &label_id)?.map(|label| {
                    let unread_count = unread_counts.get(&label.id).copied().unwrap_or_default();
                    LabelDto::new(label, unread_count)
                }),
            )
        })
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn create_label<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    storage: tauri::State<'_, Storage>,
    account_id: String,
    name: String,
    color_id: Option<String>,
) -> Result<LabelDto, String> {
    let announcer = MailChangeAnnouncer::new(&app, &account_id);
    let outcome = apply_create_label(app, auth, engine, storage, account_id, name, color_id).await;
    announcer.announce(outcome)
}

async fn apply_create_label<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    storage: tauri::State<'_, Storage>,
    account_id: String,
    name: String,
    color_id: Option<String>,
) -> Result<LabelDto, String> {
    let color = resolve_color_or_error(color_id.as_deref())?;
    let account = account_id.clone();
    let trimmed = storage
        .run(move |connection| {
            Ok(LabelRepository::validate_name(
                connection, &account, &name, None,
            ))
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;

    let client = gmail_client_for(&app, &auth, &engine, &account_id).await?;
    let gmail_color = color.as_ref().map(|color| crate::gmail::LabelColorPair {
        text_color: color.text.clone(),
        background_color: color.background.clone(),
    });
    let created = client
        .create_label(&trimmed, gmail_color.as_ref())
        .await
        .map_err(|error| error.to_string())?;

    let stored = super::to_label(&account_id, &created);
    storage
        .run(move |connection| LabelRepository::upsert(connection, &stored))
        .await
        .map_err(|error| error.to_string())?;
    read_label_dto(&storage, account_id, created.id)
        .await?
        .ok_or_else(|| "label vanished immediately after creation".to_owned())
}

#[tauri::command]
pub async fn rename_label<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    storage: tauri::State<'_, Storage>,
    account_id: String,
    label_id: String,
    name: String,
) -> Result<LabelDto, String> {
    let announcer = MailChangeAnnouncer::new(&app, &account_id);
    let outcome = apply_rename_label(app, auth, engine, storage, account_id, label_id, name).await;
    announcer.announce(outcome)
}

async fn apply_rename_label<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    storage: tauri::State<'_, Storage>,
    account_id: String,
    label_id: String,
    name: String,
) -> Result<LabelDto, String> {
    let (account_for_validate, id_for_validate) = (account_id.clone(), label_id.clone());
    let trimmed = storage
        .run(move |connection| {
            Ok(LabelRepository::validate_name(
                connection,
                &account_for_validate,
                &name,
                Some(&id_for_validate),
            ))
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;

    let client = gmail_client_for(&app, &auth, &engine, &account_id).await?;
    client
        .update_label(&label_id, Some(&trimmed), None)
        .await
        .map_err(|error| error.to_string())?;

    let (account, id, new_name) = (account_id.clone(), label_id.clone(), trimmed);
    storage
        .run(move |connection| LabelRepository::rename(connection, &account, &id, &new_name))
        .await
        .map_err(|error| error.to_string())?;
    read_label_dto(&storage, account_id, label_id)
        .await?
        .ok_or_else(|| "label not found".to_owned())
}

#[tauri::command]
pub async fn recolor_label<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    storage: tauri::State<'_, Storage>,
    account_id: String,
    label_id: String,
    color_id: String,
) -> Result<LabelDto, String> {
    let announcer = MailChangeAnnouncer::new(&app, &account_id);
    let outcome =
        apply_recolor_label(app, auth, engine, storage, account_id, label_id, color_id).await;
    announcer.announce(outcome)
}

async fn apply_recolor_label<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    storage: tauri::State<'_, Storage>,
    account_id: String,
    label_id: String,
    color_id: String,
) -> Result<LabelDto, String> {
    let color = resolve_color(&color_id)
        .map(|pair| LabelColor {
            text: pair.text_color,
            background: pair.background_color,
        })
        .ok_or_else(|| format!("'{color_id}' is not a recognised label colour"))?;

    let client = gmail_client_for(&app, &auth, &engine, &account_id).await?;
    let gmail_color = crate::gmail::LabelColorPair {
        text_color: color.text.clone(),
        background_color: color.background.clone(),
    };
    client
        .update_label(&label_id, None, Some(&gmail_color))
        .await
        .map_err(|error| error.to_string())?;

    let (account, id, stored_color) = (account_id.clone(), label_id.clone(), color);
    storage
        .run(move |connection| {
            LabelRepository::set_color(connection, &account, &id, Some(&stored_color))
        })
        .await
        .map_err(|error| error.to_string())?;
    read_label_dto(&storage, account_id, label_id)
        .await?
        .ok_or_else(|| "label not found".to_owned())
}

#[tauri::command]
pub async fn delete_label<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    storage: tauri::State<'_, Storage>,
    account_id: String,
    label_id: String,
) -> Result<(), String> {
    let announcer = MailChangeAnnouncer::new(&app, &account_id);
    let outcome = apply_delete_label(app, auth, engine, storage, account_id, label_id).await;
    announcer.announce(outcome)
}

async fn apply_delete_label<R: Runtime>(
    app: AppHandle<R>,
    auth: tauri::State<'_, AuthService>,
    engine: tauri::State<'_, Arc<SyncEngine>>,
    storage: tauri::State<'_, Storage>,
    account_id: String,
    label_id: String,
) -> Result<(), String> {
    let client = gmail_client_for(&app, &auth, &engine, &account_id).await?;
    client
        .delete_label(&label_id)
        .await
        .map_err(|error| error.to_string())?;
    storage
        .run(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            let touched: std::collections::HashSet<String> =
                LabelRepository::threads_with_label(&transaction, &account_id, &label_id)?
                    .into_iter()
                    .collect();
            LabelRepository::delete(&transaction, &account_id, &label_id)?;
            ThreadRepository::recompute_many(&transaction, &account_id, &touched)?;
            transaction.commit()
        })
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn read_traversal_status(
    storage: tauri::State<'_, Storage>,
    account_id: String,
) -> Result<TraversalStatusDto, String> {
    let account = account_id.clone();
    let (backfill, reconciliation) = storage
        .run(move |connection| {
            let backfill =
                TraversalCursorRepository::get(connection, &account, TraversalKind::Backfill)?;
            let reconciliation = TraversalCursorRepository::get(
                connection,
                &account,
                TraversalKind::Reconciliation,
            )?;
            Ok((backfill, reconciliation))
        })
        .await
        .map_err(|error| error.to_string())?;
    Ok(TraversalStatusDto::most_recent(
        account_id,
        backfill,
        reconciliation,
    ))
}
